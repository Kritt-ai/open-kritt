"""Opt-in PostgreSQL acceptance tests; never use a scan/runtime database.

Set OPEN_KRITT_TEST_DATABASE_URL to a disposable loopback/Docker-host database whose name ends
in _test, after applying migrations. No provider or engine process is started.
OPEN_KRITT_TEST_MIGRATIONS=1 additionally runs the backend migration runner twice.
"""

import json
import os
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
from psycopg.conninfo import conninfo_to_dict
from psycopg.types.json import Jsonb

from open_kritt_engine.db import Database, now_utc

PATH_TABLE = "workflows.discovery_paths"
FINDING = {
    "summary": "Fixture finding",
    "explanation": "Fixture evidence",
    "file_path": "src/parser.py",
    "line": 1,
    "malicious_input_example": "fixture",
    "trigger_flow": ["fixture"],
    "vulnerability_type": "fixture",
    "malicious_actor": "fixture",
}


class Case:
    def __init__(self, database, scan, workflow):
        self.database = database
        self.scan = scan
        self.workflow = workflow

    def snapshot(self):
        with self.database.connect() as conn:
            value = self.database.discovery_snapshot(conn, self.scan, self.workflow)
            conn.commit()
        return value

    def claim(self, path_id):
        with self.database.connect() as conn:
            value = self.database.claim_discovery_metadata(
                conn,
                scan_id=self.scan["id"],
                workflow_id=self.workflow.id,
                step_id=self.workflow.steps[0].id,
                prev_id=path_id,
                prev_table=PATH_TABLE,
                repeat_run=1,
                prompt_template="offline test",
                prompt_filled="",
                checked_out_commit="fixture",
                run_started_at=now_utc(),
                model="offline-test",
                harness="codex",
                model_provider="codex",
            )
            conn.commit()
        return value

    def complete(self, path_id, metadata_id, proposals=(), results=(), *, rollback=False):
        with self.database.connect() as conn:
            self.database.lock_discovery(conn, self.scan["id"])
            self.database.update_metadata(
                conn,
                metadata_id,
                status="completed",
                error=None,
                run_time_ms=1,
                raw_token_usage=None,
                output_json=payload(results, proposals),
                phase="completed",
            )
            for row in results:
                self.database.insert_step_result(
                    conn,
                    scan_id=self.scan["id"],
                    workflow_id=self.workflow.id,
                    step_id=self.workflow.steps[0].id,
                    depth=0,
                    prev_id=path_id,
                    prev_table=PATH_TABLE,
                    repeat_run=1,
                    json_answer=row,
                )
            self.database.complete_discovery_path(
                conn,
                self.scan["id"],
                path_id,
                metadata_id,
                payload(results, proposals)["discovery"],
            )
            if rollback:
                raise RuntimeError("simulated failure before commit")
            conn.commit()

    def rows(self, table):
        assert table in {"step_metadata", "step_results", "discovery_paths", "discovery_frontiers"}
        with self.database.connect() as conn:
            return conn.execute(
                f"SELECT * FROM workflows.{table} WHERE scan_id = %s ORDER BY 1", (self.scan["id"],)
            ).fetchall()


def proposal(scope="src/parser", question="Check validation"):
    return {"scope": scope, "question": question, "rationale": "Observed delegation"}


def payload(results=(), proposals=()):
    return {
        "_kritt_extractor_helper": True,
        "stub": not bool(results),
        "stub_explanation": "No supported result" if not results else "",
        "results": list(results),
        "discovery": {"status": "completed", "reason": "Investigated current path", "next_paths": list(proposals)},
    }


@pytest.fixture
def case(monkeypatch):
    url = os.environ.get("OPEN_KRITT_TEST_DATABASE_URL")
    if not url:
        pytest.skip("requires an explicit disposable OPEN_KRITT_TEST_DATABASE_URL")
    settings = conninfo_to_dict(url)
    if settings.get("host") not in {"127.0.0.1", "localhost", "::1", "host.docker.internal"} or not settings.get(
        "dbname", ""
    ).endswith("_test"):
        pytest.fail("acceptance tests require a loopback/Docker-host database named *_test")
    monkeypatch.setenv("PGCONNECT_TIMEOUT", "5")
    monkeypatch.setenv("PGOPTIONS", "-c statement_timeout=15000 -c lock_timeout=10000")
    database = Database(url)
    with database.connect() as conn:
        conn.execute("SET statement_timeout = '15s'")
        workflow_id = conn.execute(
            "INSERT INTO public.llm_workflows (name) VALUES ('adaptive-discovery-offline-test') RETURNING id"
        ).fetchone()["id"]
        root_id = conn.execute(
            """INSERT INTO public.steps
               (content, output_format, name, depth, multi_output, is_last_step, output_table)
               VALUES ('Review {{repo_full}}', '{"candidate":"string"}', 'discovery-test', 0, true, false,
                       'workflows.step_results') RETURNING id"""
        ).fetchone()["id"]
        terminal_id = conn.execute(
            """INSERT INTO public.steps
               (content, output_format, name, depth, multi_output, is_last_step, output_table, consume_all_previous)
               VALUES ('Reconcile {{multi_output_depth_0}}', %s, 'terminal-test', 1, true, true,
                       'workflows.vulnerabilities', true) RETURNING id""",
            (
                json.dumps(
                    {
                        key: "number" if key == "line" else "array" if key == "trigger_flow" else "string"
                        for key in FINDING
                    }
                ),
            ),
        ).fetchone()["id"]
        conn.execute(
            "UPDATE public.llm_workflows SET step_ids = %s WHERE id = %s", ([root_id, terminal_id], workflow_id)
        )
        config = {
            "repeat_runs": 1,
            "adaptive_discovery": {
                "enabled": True,
                "step_id": root_id,
                "max_paths": 8,
                "wall_time_seconds": 600,
            },
        }
        scan = conn.execute(
            """INSERT INTO public.scans
               (workflow_id, post_script_id, repo_full, commit_sha, repo_scope, dependencies,
                configuration, model, model_provider, harness, status, scopes)
               VALUES (%s, 0, 'offline/fixture', 'fixture', 'source review', '{}', %s,
                       'offline-test', 'codex', 'codex', 'running', '{}') RETURNING *""",
            (workflow_id, Jsonb(config)),
        ).fetchone()
        conn.commit()
    with database.connect() as conn:
        workflow = database.load_workflow(conn, workflow_id)
    value = Case(database, scan, workflow)
    try:
        yield value
    finally:
        with database.connect() as conn:
            for table in [
                "discovery_paths",
                "discovery_frontiers",
                "step_results",
                "vulnerabilities",
                "post_process_metadata",
                "step_metadata",
            ]:
                conn.execute(f"DELETE FROM workflows.{table} WHERE scan_id = %s", (scan["id"],))
            conn.execute("DELETE FROM public.scans WHERE id = %s", (scan["id"],))
            conn.execute("DELETE FROM public.llm_workflows WHERE id = %s", (workflow_id,))
            conn.execute("DELETE FROM public.steps WHERE id = ANY(%s::bigint[])", ([root_id, terminal_id],))
            conn.commit()


def race(functions):
    barrier = threading.Barrier(len(functions))

    def invoke(function):
        barrier.wait(timeout=10)
        return function()

    with ThreadPoolExecutor(max_workers=len(functions)) as pool:
        futures = [pool.submit(invoke, function) for function in functions]
        return [future.result(timeout=20) for future in futures]


def test_concurrent_claim_dispatches_one_native_attempt(case):
    path = case.snapshot()["paths"][0]
    claimed = race([lambda: case.claim(path["id"]), lambda: case.claim(path["id"])])
    assert sum(value is not None for value in claimed) == 1
    assert len(case.rows("step_metadata")) == 1
    with case.database.connect() as conn:
        assert case.database.load_scan(conn, case.scan["id"])["jobs_started"] == 1


def test_empty_findings_continue_and_restart_keeps_deadline(case):
    first = case.snapshot()
    seed = first["paths"][0]
    case.complete(seed["id"], case.claim(seed["id"]), [proposal()])
    case.database = Database(case.database.database_url)
    resumed = case.snapshot()
    assert resumed["status"] == "running"
    assert resumed["deadline_at"] == first["deadline_at"]
    assert case.rows("step_results") == []
    pending = [path for path in resumed["paths"] if path["status"] == "pending"]
    assert len(pending) == 1
    case.complete(pending[0]["id"], case.claim(pending[0]["id"]))
    assert case.snapshot()["status"] == "exhausted"
    assert case.rows("step_results") == []


def test_concurrent_parents_admit_one_exact_normalized_child(case):
    seed = case.snapshot()["paths"][0]
    case.complete(seed["id"], case.claim(seed["id"]), [proposal("src/a"), proposal("src/b")])
    parents = [path for path in case.snapshot()["paths"] if path["status"] == "pending"]
    metadata = [case.claim(path["id"]) for path in parents]
    proposals = [proposal("./src/shared", "Check   validation"), proposal("src/shared", "check validation")]
    race(
        [
            lambda index=index: case.complete(parents[index]["id"], metadata[index], [proposals[index]])
            for index in range(2)
        ]
    )
    current = case.snapshot()
    children = [path for path in current["paths"] if path["scope"] == "src/shared"]
    assert len(children) == 1
    receipts = [path["proposals"][0] for path in current["paths"] if path["id"] in {p["id"] for p in parents}]
    assert sorted(row["status"] for row in receipts) == ["admitted", "duplicate"]
    assert {row["path_id"] for row in receipts} == {children[0]["id"]}


def test_result_and_frontier_completion_roll_back_together(case):
    seed = case.snapshot()["paths"][0]
    metadata = case.claim(seed["id"])
    with pytest.raises(RuntimeError, match="before commit"):
        case.complete(seed["id"], metadata, [proposal()], [{"candidate": "evidence"}], rollback=True)
    assert case.rows("step_results") == []
    assert case.rows("step_metadata")[0]["status"] == "running"
    assert len(case.snapshot()["paths"]) == 1
    case.complete(seed["id"], metadata, [proposal()], [{"candidate": "evidence"}])
    assert len(case.rows("step_results")) == 1
    assert len(case.snapshot()["paths"]) == 2


def test_late_completion_preserves_results_but_admits_no_new_path(case):
    seed = case.snapshot()["paths"][0]
    metadata = case.claim(seed["id"])
    with case.database.connect() as conn:
        conn.execute(
            "UPDATE workflows.discovery_frontiers SET deadline_at = clock_timestamp() - interval '1 second' "
            "WHERE scan_id = %s",
            (case.scan["id"],),
        )
        conn.commit()
    case.complete(seed["id"], metadata, [proposal()], [{"candidate": "late evidence"}])
    final = case.snapshot()
    assert final["status"] == "budget_stopped"
    assert len(final["paths"]) == 1
    assert final["paths"][0]["proposals"][0]["status"] == "budget_stopped"
    assert case.rows("step_results")[0]["json_answer"] == {"candidate": "late evidence"}


def test_migrations_twice_preserve_existing_discovery_records(case):
    if os.environ.get("OPEN_KRITT_TEST_MIGRATIONS") != "1":
        pytest.skip("set OPEN_KRITT_TEST_MIGRATIONS=1 to run the local backend migration runner")
    seed = case.snapshot()["paths"][0]
    case.complete(seed["id"], case.claim(seed["id"]), [proposal()], [{"candidate": "sentinel"}])
    tables = ["discovery_paths", "discovery_frontiers", "step_metadata", "step_results"]
    before = {table: case.rows(table) for table in tables}
    backend = Path(__file__).resolve().parents[2] / "backend"
    env = {**os.environ, "DATABASE_URL": case.database.database_url}
    for _ in range(2):
        result = subprocess.run(
            ["node", "prisma/migrate.js"], cwd=backend, env=env, capture_output=True, text=True, timeout=90, check=False
        )
        assert result.returncode == 0, result.stdout + result.stderr
        assert {table: case.rows(table) for table in tables} == before


@pytest.fixture
def worker_environment(case, monkeypatch, tmp_path):
    pytest.importorskip("fcntl", reason="Worker uses POSIX workspace locking; run this acceptance case on Linux")
    from open_kritt_engine import worker as worker_module
    from open_kritt_engine.queue import build_pending_jobs
    from open_kritt_engine.worker import Worker

    prepared = SimpleNamespace(
        workspace=SimpleNamespace(env={}),
        repo_dir=str(tmp_path),
        checked_out_commit="fixture",
        layout="Offline fixture",
        manifest_json='{"dependencies":[]}',
    )
    monkeypatch.setattr(worker_module, "prepare_dependency_workspace", lambda **kwargs: prepared)
    monkeypatch.setattr(worker_module, "provider_account_lease", lambda *args, **kwargs: nullcontext())
    monkeypatch.setattr(worker_module, "cleanup_workspace", lambda workspace: None)
    monkeypatch.setattr(worker_module, "mark_provider_account_available", lambda *args: None)
    monkeypatch.setattr(worker_module, "workspace_context", lambda workspace: {})
    config = SimpleNamespace(retry_count=0, data_dir=str(tmp_path), github_token=None)

    def fresh_worker():
        worker = Worker(config, db=Database(case.database.database_url))
        monkeypatch.setattr(worker, "_new_scan_container_allowed", lambda scan_id: True)
        monkeypatch.setattr(worker, "_worker_can_pick_job", lambda worker_id: True)
        monkeypatch.setattr(worker, "runtime_retry_count", lambda: 0)
        monkeypatch.setattr(worker, "runtime_cyber_safety_retry_count", lambda: 0)
        return worker

    def pending():
        frontier = case.snapshot()
        with case.database.connect() as conn:
            return build_pending_jobs(
                scan=case.scan,
                workflow=case.workflow,
                discovery_frontier=frontier,
                completed=case.database.load_completed_metadata(conn, case.scan["id"]),
                claimed=case.database.load_claimed_metadata(conn, case.scan["id"]),
                step_results=case.database.load_step_results(conn, case.scan["id"]),
            )

    return SimpleNamespace(fresh_worker=fresh_worker, pending=pending)


def test_worker_empty_findings_restart_then_finding_and_native_dedupe(case, worker_environment, monkeypatch):
    from open_kritt_engine.harnesses import HarnessResult

    terminal_payload = payload(results=[FINDING])
    del terminal_payload["discovery"]
    replies = [payload(proposals=[proposal()]), payload(results=[{"candidate": "supported"}]), terminal_payload]
    calls = []

    def run(**kwargs):
        calls.append(kwargs)
        return HarnessResult(payload=replies.pop(0), usage={"total_tokens": 3})

    for index in range(2):
        jobs = worker_environment.pending()
        assert len(jobs) == 1 and jobs[0].depth == 0
        # Each iteration uses a new Worker and a new Database connection factory.
        worker = worker_environment.fresh_worker()
        assert worker.execute_job(
            scan=case.scan, workflow_id=case.workflow.id, job=jobs[0], harness=SimpleNamespace(run=run)
        )
        if index == 0:
            assert case.rows("step_results") == []
            assert case.snapshot()["status"] == "running"
    batch = worker_environment.pending()
    assert len(calls) == 2
    assert case.snapshot()["status"] == "exhausted"
    assert len(batch) == 1 and batch[0].depth == 1
    assert batch[0].state.context["multi_output_depth_0"] == [{"candidate": "supported"}]
    assert '"scope": "src/parser"' in calls[1]["prompt"]
    worker = worker_environment.fresh_worker()
    assert worker.execute_job(
        scan=case.scan, workflow_id=case.workflow.id, job=batch[0], harness=SimpleNamespace(run=run)
    )
    assert worker_environment.pending() == []
    assert len(calls) == 3
    assert "discovery" not in calls[2]["schema"]["properties"]
    with case.database.connect() as conn:
        findings = case.database.load_vulnerabilities(conn, case.scan["id"])
        assert len(findings) == 1 and findings[0]["json_answer"] == FINDING
        case.database.set_scan_status_if_current(conn, case.scan["id"], "running", "post_processing")
        conn.commit()
    dedupe_calls = []

    def dedupe_response(**kwargs):
        dedupe_calls.append(kwargs)
        return (
            {
                "_kritt_extractor_helper": True,
                "clusters": [{"ids": [findings[0]["id"]], "reason": "Fixture singleton"}],
            },
            {"total_tokens": 1},
            None,
            "fixture",
        )

    monkeypatch.setattr(worker.post_processor, "_run_harness_with_retries", dedupe_response)
    assert worker.post_processor._run_next_dedupe_batch(case.scan, object())
    with case.database.connect() as conn:
        final = case.database.load_vulnerabilities(conn, case.scan["id"])
    assert final[0]["dedupe_is_canonical"] is True
    assert len(dedupe_calls) == 1
    assert "discovery" not in dedupe_calls[0]["schema"]["properties"]
    assert case.snapshot()["status"] == "exhausted"


def test_worker_malformed_discovery_does_not_admit_or_store_results(case, worker_environment):
    from open_kritt_engine.harnesses import HarnessResult

    invalid = payload(results=[{"candidate": "must not persist"}], proposals=[proposal("../escape")])
    calls = []

    def run(**kwargs):
        calls.append(kwargs)
        return HarnessResult(payload=invalid, usage={"total_tokens": 3})

    worker = worker_environment.fresh_worker()
    job = worker_environment.pending()[0]
    assert worker.execute_job(scan=case.scan, workflow_id=case.workflow.id, job=job, harness=SimpleNamespace(run=run))
    frontier = case.snapshot()
    assert len(calls) == 1
    assert frontier["status"] == "blocked"
    assert len(frontier["paths"]) == 1 and frontier["paths"][0]["status"] == "blocked"
    assert case.rows("step_results") == []
    assert all(row["status"] == "failed" for row in case.rows("step_metadata"))
    assert worker_environment.pending() == []


def test_process_scan_prewarms_then_initializes_frontier_and_dispatches(case, worker_environment, monkeypatch):
    from open_kritt_engine.harnesses import HarnessResult

    with case.database.connect() as conn:
        conn.execute("UPDATE public.scans SET status = 'prewarming_cache' WHERE id = %s", (case.scan["id"],))
        conn.commit()
    worker = worker_environment.fresh_worker()
    transitions = []
    calls = []

    def prewarm(scan, *, restore_status):
        transitions.append((scan["status"], restore_status))
        if scan["status"] != "prewarming_cache":
            return False
        with case.database.connect() as conn:
            case.database.set_scan_status_if_current(conn, case.scan["id"], "prewarming_cache", restore_status)
            conn.commit()
        return True

    def run(**kwargs):
        calls.append(kwargs)
        return HarnessResult(payload=payload(proposals=[proposal()]), usage={"total_tokens": 1})

    monkeypatch.setattr(worker, "_ensure_scan_cache_prewarmed", prewarm)
    monkeypatch.setattr(worker, "_harness_for_model_selection", lambda selection: SimpleNamespace(run=run))
    assert worker.process_scan(case.scan)
    assert transitions[0] == ("prewarming_cache", "running")
    assert len(calls) == 1
    assert [path["status"] for path in case.snapshot()["paths"]] == ["completed", "pending"]


def test_restart_marks_interrupted_path_blocked_without_provider_replay(case, worker_environment, monkeypatch):
    seed = case.snapshot()["paths"][0]
    metadata = case.claim(seed["id"])
    with case.database.connect() as conn:
        case.database.update_metadata(
            conn,
            metadata,
            status="interrupted",
            error="simulated restart",
            run_time_ms=1,
            raw_token_usage=None,
            phase="interrupted",
        )
        conn.commit()
    worker = worker_environment.fresh_worker()
    monkeypatch.setattr(worker, "_ensure_scan_cache_prewarmed", lambda scan, **kwargs: False)
    monkeypatch.setattr(worker, "_harness_for_model_selection", lambda selection: object())
    monkeypatch.setattr(worker.post_processor, "process_once", lambda scan, harness: False)
    monkeypatch.setattr(worker, "execute_job", lambda **kwargs: pytest.fail("replayed interrupted discovery"))
    worker.process_scan(case.scan)
    final = case.snapshot()
    assert final["status"] == "blocked"
    assert len(final["paths"]) == 1
    assert final["paths"][0]["metadata_id"] == metadata
    assert len(case.rows("step_metadata")) == 1


def test_restart_recovery_persists_blocked_frontier_without_snapshot(case, worker_environment, monkeypatch):
    seed = case.snapshot()["paths"][0]
    metadata = case.claim(seed["id"])
    assert case.rows("discovery_paths")[0]["status"] == "running"
    worker = worker_environment.fresh_worker()
    monkeypatch.setattr(worker, "_harness_for_model_selection", lambda selection: pytest.fail("provider requested"))

    counts = worker.recover_orphaned_metadata(now_utc() + timedelta(minutes=1))

    # Read raw rows: the recovery hook itself must persist reconciliation.
    assert counts["step"] >= 1
    native = case.rows("step_metadata")[0]
    path = case.rows("discovery_paths")[0]
    frontier = case.rows("discovery_frontiers")[0]
    assert native["id"] == metadata and native["status"] == "stopped"
    assert native["phase"] == "interrupted"
    assert path["metadata_id"] == metadata and path["status"] == "blocked"
    assert frontier["status"] == "blocked"
    assert "stopped" in path["reason"]


def test_stopped_scan_early_return_persists_blocked_frontier(case, worker_environment, monkeypatch):
    seed = case.snapshot()["paths"][0]
    metadata = case.claim(seed["id"])
    with case.database.connect() as conn:
        case.database.update_metadata(
            conn,
            metadata,
            status="stopped",
            error="fixture stop",
            run_time_ms=1,
            raw_token_usage=None,
            phase="interrupted",
        )
        case.database.set_scan_status_if_current(conn, case.scan["id"], "running", "stopped")
        conn.commit()
    assert case.rows("discovery_frontiers")[0]["status"] == "running"
    worker = worker_environment.fresh_worker()
    monkeypatch.setattr(worker, "_harness_for_model_selection", lambda selection: pytest.fail("provider requested"))
    monkeypatch.setattr(worker, "execute_job", lambda **kwargs: pytest.fail("stopped scan dispatched a job"))

    assert worker.process_scan(case.scan) is False

    # Do not call discovery_snapshot: it would mask a missing early-return hook.
    assert case.rows("discovery_frontiers")[0]["status"] == "blocked"
    path = case.rows("discovery_paths")[0]
    assert path["metadata_id"] == metadata and path["status"] == "blocked"
    assert case.rows("step_metadata")[0]["status"] == "stopped"


def test_prewarming_without_progress_has_no_frontier_or_dispatch(case, worker_environment, monkeypatch):
    with case.database.connect() as conn:
        case.database.set_scan_status_if_current(conn, case.scan["id"], "running", "prewarming_cache")
        conn.commit()
    worker = worker_environment.fresh_worker()
    prewarm_calls = []

    def no_progress(scan, *, restore_status):
        prewarm_calls.append((scan["status"], restore_status))
        return False

    monkeypatch.setattr(worker, "_ensure_scan_cache_prewarmed", no_progress)
    monkeypatch.setattr(worker, "_harness_for_model_selection", lambda selection: pytest.fail("provider requested"))
    monkeypatch.setattr(worker, "execute_job", lambda **kwargs: pytest.fail("prewarming scan dispatched a job"))

    assert worker.process_scan(case.scan) is False

    assert prewarm_calls == [("prewarming_cache", "running")]
    assert case.rows("discovery_frontiers") == []
    assert case.rows("discovery_paths") == []
    assert case.rows("step_metadata") == []
    with case.database.connect() as conn:
        assert case.database.load_scan(conn, case.scan["id"])["status"] == "prewarming_cache"

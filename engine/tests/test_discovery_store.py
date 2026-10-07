"""Offline state-transition tests; SQL/concurrency is covered by PostgreSQL integration tests."""

from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from open_kritt_engine.discovery_store import DISCOVERY_PATH_TABLE, DiscoveryStore


class Rows:
    def __init__(self, rows=()):
        self.rows = deepcopy(list(rows))

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class MemoryConnection:
    """A transactional test double, deliberately rejecting unknown statements."""

    def __init__(self, *, max_paths=10, job_limit=None):
        self.now = datetime(2026, 10, 7, tzinfo=timezone.utc)
        self.scan = {
            "id": 1,
            "status": "running",
            "job_limit": job_limit,
            "jobs_started": 0,
            "configuration": {
                "adaptive_discovery": {
                    "enabled": True,
                    "step_id": 7,
                    "max_paths": max_paths,
                    "wall_time_seconds": 60,
                }
            },
        }
        self.frontier = None
        self.paths = {}
        self.metadata = {}
        self.findings = []
        self.queries = []

    @contextmanager
    def transaction(self):
        saved = deepcopy((self.scan, self.frontier, self.paths, self.metadata, self.findings))
        try:
            yield
        except Exception:
            self.scan, self.frontier, self.paths, self.metadata, self.findings = saved
            raise

    def execute(self, sql, args=()):
        q = " ".join(sql.split())
        self.queries.append((q, args))
        if q.startswith("SELECT pg_advisory_xact_lock"):
            return Rows()
        if q.startswith("SELECT scan_id FROM workflows.discovery_frontiers"):
            return Rows(
                [{"scan_id": self.frontier["scan_id"]}]
                if self.frontier and self.frontier["status"] == "running"
                else []
            )
        if q.startswith("SELECT * FROM public.scans"):
            return Rows([self.scan] if args[0] == self.scan["id"] else [])
        if q.startswith("SELECT *, clock_timestamp()"):
            return Rows([{**self.frontier, "observed_at": self.now}] if self.frontier else [])
        if q.startswith("SELECT p.*"):
            rows = []
            for p in self.paths.values():
                if p["scan_id"] != args[0]:
                    continue
                m = self.metadata.get(p["metadata_id"], {})
                matched = all(
                    m.get(k) == v
                    for k, v in {
                        "scan_id": p["scan_id"],
                        "step_id": p["step_id"],
                        "prev_id": p["id"],
                        "prev_table": DISCOVERY_PATH_TABLE,
                    }.items()
                )
                rows.append({**p, "metadata_status": m.get("status") if matched else None})
            return Rows(rows)
        if q.startswith("SELECT greatest"):
            return Rows(
                [{"remaining_seconds": max(0, (self.frontier["deadline_at"] - self.now).total_seconds())}]
                if self.frontier and self.frontier["status"] == "running"
                else []
            )
        if q.startswith("INSERT INTO workflows.discovery_frontiers"):
            scan_id, workflow_id, step_id, max_paths, wall_time, _ = args
            self.frontier = {
                "scan_id": scan_id,
                "workflow_id": workflow_id,
                "step_id": step_id,
                "max_paths": max_paths,
                "wall_time_seconds": wall_time,
                "deadline_at": self.now + timedelta(seconds=wall_time),
                "started_at": self.now,
                "status": "running",
                "reason": None,
                "budget_reason": None,
            }
            return Rows()
        if q.startswith("INSERT INTO workflows.discovery_paths"):
            if "parent_path_id" in q:
                scan_id, step_id, parent, key, scope, question, rationale = args
            else:
                scan_id, step_id, key, scope, question, rationale = args
                parent = None
            existing = next((p for p in self.paths.values() if p["scan_id"] == scan_id and p["path_key"] == key), None)
            if existing:
                return Rows([{"id": existing["id"]}])
            new_id = len(self.paths) + 1
            self.paths[new_id] = {
                "id": new_id,
                "scan_id": scan_id,
                "step_id": step_id,
                "parent_path_id": parent,
                "path_key": key,
                "scope": scope,
                "question": question,
                "rationale": rationale,
                "status": "pending",
                "reason": None,
                "metadata_id": None,
                "proposals": [],
                "completion": None,
            }
            return Rows([{"id": new_id}])
        if q.startswith("UPDATE workflows.discovery_frontiers SET budget_reason"):
            self.frontier["budget_reason"] = self.frontier["budget_reason"] or args[0]
            return Rows()
        if q.startswith("UPDATE workflows.discovery_frontiers SET status"):
            self.frontier.update(status=args[0], reason=args[1])
            return Rows()
        if q.startswith("UPDATE workflows.discovery_paths SET status = 'running'"):
            metadata_id, path_id, scan_id = args
            assert self.paths[path_id]["scan_id"] == scan_id
            assert self.paths[path_id]["status"] == "pending"
            self.paths[path_id].update(status="running", metadata_id=metadata_id)
            return Rows()
        if q.startswith("UPDATE workflows.discovery_paths SET status = %s, reason = %s, proposals"):
            status, reason, proposals, completion, path_id, scan_id, metadata_id = args
            assert self.paths[path_id]["scan_id"] == scan_id
            assert self.paths[path_id]["metadata_id"] == metadata_id
            self.paths[path_id].update(status=status, reason=reason, proposals=proposals.obj, completion=completion.obj)
            return Rows()
        if q.startswith("UPDATE workflows.discovery_paths SET status"):
            if "SET status = %s" in q:
                status, reason, path_id, _ = args
                self.paths[path_id].update(status=status, reason=reason)
            else:
                status = "budget_stopped" if "'budget_stopped'" in q else "blocked"
                if "AND status = 'pending'" in q:
                    reason, scan_id = args
                    for path in self.paths.values():
                        if path["scan_id"] == scan_id and path["status"] == "pending":
                            path.update(status=status, reason=reason)
                else:
                    reason, path_id, _ = args
                    self.paths[path_id].update(status=status, reason=reason)
            return Rows()
        raise AssertionError(f"Unsupported SQL in test double: {q}")


class Store(DiscoveryStore):
    def __init__(self):
        self.native_cap_calls = []

    def claim_step_metadata(self, conn, **kwargs):
        metadata_id = len(conn.metadata) + 100
        conn.metadata[metadata_id] = {**kwargs, "status": "running"}
        conn.scan["jobs_started"] += 1
        return metadata_id

    def claim_logical_job_slot(self, conn, **kwargs):
        self.native_cap_calls.append(kwargs)
        if not any(m["status"] == "running" for m in conn.metadata.values()):
            conn.scan["status"] = "stopped"
        return False


WORKFLOW = SimpleNamespace(id=31, steps=[SimpleNamespace(id=7, depth=0, is_last_step=False, multi_output=True)])


def snapshot(store, conn):
    return store.discovery_snapshot(conn, deepcopy(conn.scan), WORKFLOW)


def claim(store, conn, path_id):
    return store.claim_discovery_metadata(
        conn,
        scan_id=1,
        workflow_id=31,
        step_id=7,
        prev_id=path_id,
        prev_table=DISCOVERY_PATH_TABLE,
        repeat_run=1,
        prompt_template="review",
        prompt_filled="review",
        checked_out_commit=None,
        run_started_at=conn.now,
    )


def proposed(scope="src", question="Check alternate parsing path"):
    return {"scope": scope, "question": question, "rationale": "Independent reachable input boundary"}


def finish(store, conn, path_id, proposals=(), *, status="completed"):
    metadata_id = conn.paths[path_id]["metadata_id"]
    conn.metadata[metadata_id]["status"] = "completed"
    value = {"status": status, "reason": "Source review recorded", "next_paths": list(proposals)}
    store.complete_discovery_path(conn, 1, path_id, metadata_id, value)
    return value


def test_opt_out_does_not_query_or_seed():
    store, conn = Store(), MemoryConnection()
    conn.scan["configuration"] = {}
    assert snapshot(store, conn) is None
    assert conn.queries == []


def test_seed_claim_and_deadline_survive_scheduler_reconstruction():
    store, conn = Store(), MemoryConnection()
    first = snapshot(store, conn)
    assert len(first["paths"]) == 1
    assert first["paths"][0]["parent_path_id"] is None
    conn.now += timedelta(seconds=10)
    assert snapshot(Store(), conn)["deadline_at"] == first["deadline_at"]
    conn.queries.clear()
    metadata_id = claim(store, conn, 1)
    assert metadata_id is not None
    assert "pg_advisory_xact_lock" in conn.queries[0][0]
    assert "public.scans" in conn.queries[1][0]
    assert claim(store, conn, 1) is None
    assert conn.scan["jobs_started"] == 1
    assert store.discovery_remaining_seconds(conn, 1) == 50


def test_empty_findings_can_admit_new_paths_and_exact_cycles_do_not_reopen():
    store, conn = Store(), MemoryConnection()
    seed = snapshot(store, conn)["paths"][0]
    claim(store, conn, 1)
    finish(store, conn, 1, [proposed(), proposed("src/./", "CHECK alternate parsing path")])
    assert conn.findings == []
    assert snapshot(store, conn)["status"] == "running"
    assert [p["status"] for p in conn.paths[1]["proposals"]] == ["admitted", "duplicate"]
    assert len(conn.paths) == 2
    claim(store, conn, 2)
    finish(store, conn, 2, [proposed(seed["scope"], seed["question"])])
    assert conn.paths[2]["proposals"][0]["path_id"] == 1
    assert snapshot(store, conn)["status"] == "exhausted"
    assert len(conn.paths) == 2
    assert "not exhaustive security coverage" in snapshot(store, conn)["reason"]


def test_exact_completion_replay_is_idempotent_but_conflicting_replay_is_rejected():
    store, conn = Store(), MemoryConnection()
    snapshot(store, conn)
    mid = claim(store, conn, 1)
    value = finish(store, conn, 1, [proposed()])
    before = deepcopy(conn.paths)
    store.complete_discovery_path(conn, 1, 1, mid, value)
    assert conn.paths == before
    with pytest.raises(ValueError, match="no longer owned"):
        store.complete_discovery_path(conn, 1, 1, mid, {**value, "reason": "Changed payload"})
    with pytest.raises(ValueError, match="does not match"):
        store.complete_discovery_path(conn, 1, 1, mid + 100, value)


def test_path_admission_cap_retains_overflow_proposal_without_erasing_admitted_work():
    store, conn = Store(), MemoryConnection(max_paths=2)
    snapshot(store, conn)
    claim(store, conn, 1)
    finish(store, conn, 1, [proposed(), proposed("other")])
    assert len(conn.paths) == 2
    assert conn.paths[1]["proposals"][1]["status"] == "budget_stopped"
    assert conn.paths[1]["proposals"][1]["path_id"] is None
    assert snapshot(store, conn)["status"] == "running"
    claim(store, conn, 2)
    finish(store, conn, 2)
    assert snapshot(store, conn)["status"] == "budget_stopped"
    assert conn.frontier["budget_reason"] == "max_paths_reached"


def test_expired_running_path_is_not_reported_exhausted_and_late_output_is_retained():
    store, conn = Store(), MemoryConnection()
    snapshot(store, conn)
    claim(store, conn, 1)
    conn.now += timedelta(seconds=61)
    assert snapshot(store, conn)["status"] == "running"
    assert conn.paths[1]["status"] == "running"
    finish(store, conn, 1, [proposed()])
    assert conn.paths[1]["status"] == "completed"
    assert conn.paths[1]["completion"]["status"] == "completed"
    assert len(conn.paths) == 1
    assert conn.paths[1]["proposals"][0]["status"] == "budget_stopped"
    assert snapshot(store, conn)["status"] == "budget_stopped"


def test_wall_time_expiry_closes_pending_paths_without_starting_native_work():
    store, conn = Store(), MemoryConnection()
    snapshot(store, conn)
    conn.now += timedelta(seconds=60)
    assert claim(store, conn, 1) is None
    assert snapshot(store, conn)["status"] == "budget_stopped"
    assert conn.paths[1]["status"] == "budget_stopped"
    assert conn.metadata == {}


@pytest.mark.parametrize("native_status", ["failed", "stopped", "interrupted", "completed", None])
def test_orphaned_or_failed_attempt_is_blocked_without_silent_replay(native_status):
    store, conn = Store(), MemoryConnection()
    snapshot(store, conn)
    mid = claim(store, conn, 1)
    if native_status is None:
        conn.metadata.clear()
    else:
        conn.metadata[mid]["status"] = native_status
    state = snapshot(Store(), conn)
    assert state["status"] == "blocked"
    assert state["paths"][0]["status"] == "blocked"
    assert claim(store, conn, 1) is None
    assert conn.scan["jobs_started"] == 1


def test_failure_of_final_transaction_rolls_back_findings_metadata_and_child_admission():
    store, conn = Store(), MemoryConnection()
    snapshot(store, conn)
    mid = claim(store, conn, 1)
    with pytest.raises(RuntimeError, match="simulated crash"):
        with conn.transaction():
            store.lock_discovery(conn, 1)
            finish(store, conn, 1, [proposed()])
            conn.findings.append({"metadata_id": mid, "title": "Supported test finding"})
            raise RuntimeError("simulated crash before commit")
    assert len(conn.paths) == 1
    assert conn.paths[1]["status"] == "running"
    assert conn.metadata[mid]["status"] == "running"
    assert conn.findings == []
    with conn.transaction():
        finish(store, conn, 1, [proposed()])
        conn.findings.append({"metadata_id": mid, "title": "Supported test finding"})
    assert len(conn.paths) == 2
    assert conn.metadata[mid]["status"] == "completed"
    assert len(conn.findings) == 1


def test_explicit_block_does_not_cancel_independent_sibling_but_budget_stop_does():
    store, conn = Store(), MemoryConnection()
    snapshot(store, conn)
    claim(store, conn, 1)
    finish(store, conn, 1, [proposed(), proposed("other"), proposed("last")])
    mid = claim(store, conn, 2)
    conn.metadata[mid]["status"] = "failed"
    store.stop_discovery_path(conn, 1, 2, mid, "Unsupported source", status="blocked")
    assert snapshot(store, conn)["status"] == "running"
    assert conn.paths[3]["status"] == "pending"
    mid = claim(store, conn, 3)
    conn.metadata[mid]["status"] = "stopped"
    store.stop_discovery_path(conn, 1, 3, mid, "Discovery deadline reached", status="budget_stopped")
    assert snapshot(store, conn)["status"] == "budget_stopped"
    assert conn.paths[4]["status"] == "budget_stopped"


def test_whole_workflow_job_cap_preserves_native_stopped_scan_transition():
    store, conn = Store(), MemoryConnection(job_limit=1)
    snapshot(store, conn)
    claim(store, conn, 1)
    finish(store, conn, 1, [proposed()])
    assert claim(store, conn, 2) is None
    assert len(store.native_cap_calls) == 1
    assert conn.scan["status"] == "stopped"
    assert conn.scan["jobs_started"] == 1
    assert snapshot(store, conn)["status"] == "budget_stopped"


def test_foreign_metadata_link_cannot_complete_a_claimed_path():
    store, conn = Store(), MemoryConnection()
    snapshot(store, conn)
    mid = claim(store, conn, 1)
    conn.metadata[mid].update(scan_id=999, status="completed")
    with pytest.raises(ValueError, match="completed native metadata"):
        finish(store, conn, 1, [proposed()])
    assert len(conn.paths) == 1


def test_persisted_budget_cannot_be_changed_on_scheduler_reconstruction():
    store, conn = Store(), MemoryConnection()
    snapshot(store, conn)
    conn.scan["configuration"]["adaptive_discovery"]["wall_time_seconds"] = 120
    with pytest.raises(ValueError, match="Persisted discovery configuration"):
        snapshot(store, conn)


@pytest.mark.parametrize("reconciled", [False, True])
def test_late_completion_after_scan_stop_retains_payload_without_reopening(reconciled):
    store, conn = Store(), MemoryConnection()
    snapshot(store, conn)
    mid = claim(store, conn, 1)
    conn.scan["status"] = "stopped"
    if reconciled:
        conn.metadata[mid]["status"] = "interrupted"
        assert snapshot(store, conn)["status"] == "blocked"
    value = finish(store, conn, 1, [proposed()])
    assert len(conn.paths) == 1
    assert conn.paths[1]["status"] == "blocked"
    assert conn.paths[1]["completion"] == value
    assert conn.paths[1]["proposals"][0]["status"] == "blocked"
    assert snapshot(store, conn)["status"] == "blocked"
    before = deepcopy(conn.paths)
    store.complete_discovery_path(conn, 1, 1, mid, value)
    assert conn.paths == before


def test_stopped_scan_closes_unstarted_paths_but_not_live_native_metadata():
    store, conn = Store(), MemoryConnection()
    snapshot(store, conn)
    claim(store, conn, 1)
    finish(store, conn, 1, [proposed(), proposed("other")])
    mid = claim(store, conn, 2)
    conn.scan["status"] = "stopped"
    state = snapshot(store, conn)
    assert state["status"] == "running"
    assert conn.paths[2]["status"] == "running"
    assert conn.paths[3]["status"] == "blocked"
    conn.metadata[mid]["status"] = "stopped"
    assert snapshot(store, conn)["status"] == "blocked"


def test_lifecycle_reconciliation_does_not_seed_absent_disabled_or_deleted_scans():
    store, conn = Store(), MemoryConnection()
    assert store.reconcile_existing_discovery(conn, 1) is None
    conn.scan["configuration"] = {"adaptive_discovery": {"enabled": False}}
    assert store.reconcile_existing_discovery(conn, 1) is None
    assert store.reconcile_existing_discovery(conn, 999) is None
    assert store.reconcile_interrupted_discovery(conn) == []
    assert conn.frontier is None
    assert conn.paths == {}


def test_restart_reconciliation_closes_interrupted_path_without_requiring_enabled_config():
    store, conn = Store(), MemoryConnection()
    snapshot(store, conn)
    mid = claim(store, conn, 1)
    conn.scan["status"] = "stopped"
    conn.scan["configuration"] = {}
    conn.metadata[mid].update(status="stopped", phase="interrupted")
    repaired = Store().reconcile_interrupted_discovery(conn)
    assert len(repaired) == 1
    assert repaired[0]["status"] == "blocked"
    assert repaired[0]["paths"][0]["status"] == "blocked"
    assert conn.paths[1]["completion"] is None
    assert store.reconcile_interrupted_discovery(conn) == []


def test_lifecycle_reconciliation_keeps_live_attempt_in_flight_until_native_stop():
    store, conn = Store(), MemoryConnection()
    snapshot(store, conn)
    claim(store, conn, 1)
    finish(store, conn, 1, [proposed(), proposed("other")])
    mid = claim(store, conn, 2)
    conn.scan["status"] = "stopped"
    active = store.reconcile_existing_discovery(conn, 1)
    assert active["status"] == "running"
    assert conn.paths[2]["status"] == "running"
    assert conn.paths[3]["status"] == "blocked"
    conn.metadata[mid]["status"] = "stopped"
    assert store.reconcile_existing_discovery(conn, 1)["status"] == "blocked"
    assert len(conn.paths) == 3


@pytest.mark.parametrize("scan_status", ["paused", "rate_limited", "pending"])
def test_resumable_scan_preserves_pending_paths_and_original_deadline(scan_status):
    store, conn = Store(), MemoryConnection()
    seeded = snapshot(store, conn)
    conn.scan["status"] = scan_status
    restored = store.reconcile_existing_discovery(conn, 1)
    assert restored["status"] == "running"
    assert restored["paths"][0]["status"] == "pending"
    assert restored["deadline_at"] == seeded["deadline_at"]
    conn.now += timedelta(seconds=61)
    expired = store.reconcile_existing_discovery(conn, 1)
    assert expired["status"] == "budget_stopped"
    assert expired["paths"][0]["status"] == "budget_stopped"

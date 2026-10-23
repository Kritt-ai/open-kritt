from concurrent.futures import ThreadPoolExecutor

import pytest

from open_kritt_engine import harnesses
from open_kritt_engine.models import Step, StepResultRow, Workflow
from open_kritt_engine.queue import build_pending_jobs

TABLE = "workflows.discovery_paths"


def workflow(*, batch=False):
    return Workflow(
        1,
        "review",
        (
            Step(1, "Review source", '{"finding":"string"}', "discover", 0, True, False, "workflows.step_results", 1),
            Step(
                2,
                "Verify findings",
                '{"finding":"string"}',
                "verify",
                1,
                False,
                True,
                "workflows.vulnerabilities",
                2,
                consumes_all=batch,
            ),
        ),
    )


def scan(enabled=True):
    return {
        "id": 10,
        "repo_full": "fixture/repo",
        "repo_scope": ".",
        "commit_sha": "frozen-test-revision",
        "configuration": {
            "adaptive_discovery": {
                "enabled": True,
                "step_id": 1,
                "max_paths": 8,
                "wall_time_seconds": 60,
            }
            if enabled
            else False
        },
    }


def frontier(status, *paths):
    return {
        "scan_id": 10,
        "step_id": 1,
        "status": status,
        "paths": [
            {"id": path_id, "status": state, "scope": ".", "question": f"Question {path_id}", "rationale": "Follow-up"}
            for path_id, state in paths
        ],
    }


def result(path_id, row_id):
    return StepResultRow(row_id, 1, path_id, TABLE, 1, {"finding": str(row_id)})


def jobs(snapshot, *, completed=(), rows=None, claimed=None, batch=False):
    return build_pending_jobs(
        scan=scan(),
        workflow=workflow(batch=batch),
        completed=set(completed),
        step_results=rows or {},
        claimed=claimed,
        discovery_frontier=snapshot,
    )


def test_empty_findings_schedule_followup_without_counterfeit_finding():
    pending = jobs(frontier("running", (1, "completed"), (2, "pending")), completed={(1, 1, TABLE, 1)})
    assert len(pending) == 1
    assert pending[0].step.id == 1
    assert pending[0].state.prev_id == 2
    assert pending[0].state.output is None
    assert pending[0].state.context["discovery_path"]["question"] == "Question 2"


@pytest.mark.parametrize("batch", [False, True])
def test_downstream_waits_for_all_discovery_even_with_early_findings(batch):
    key = (1, 1, TABLE, 1)
    pending = jobs(
        frontier("running", (1, "completed"), (2, "running")),
        completed={key},
        claimed={key, (1, 2, TABLE, 1)},
        rows={key: [result(1, 101)]},
        batch=batch,
    )
    assert pending == []


def test_closed_frontier_batches_findings_from_every_completed_path():
    keys = {(1, 1, TABLE, 1), (1, 2, TABLE, 1)}
    rows = {key: [result(key[1], key[1] + 100)] for key in keys}
    pending = jobs(frontier("exhausted", (1, "completed"), (2, "completed")), completed=keys, rows=rows, batch=True)
    assert len(pending) == 1
    assert pending[0].step.id == 2
    assert pending[0].state.context["multi_output_depth_0"] == [{"finding": "101"}, {"finding": "102"}]


@pytest.mark.parametrize("status", ["blocked", "budget_stopped"])
def test_closed_unfinished_paths_do_not_rerun_or_lose_other_findings(status):
    key = (1, 1, TABLE, 1)
    pending = jobs(frontier(status, (1, "completed"), (2, status)), completed={key}, rows={key: [result(1, 101)]})
    assert [(job.step.id, job.state.prev_id) for job in pending] == [(2, 101)]


def test_blocked_semantic_path_can_still_yield_supported_findings():
    key = (1, 1, TABLE, 1)
    pending = jobs(frontier("blocked", (1, "blocked")), completed={key}, rows={key: [result(1, 101)]})
    assert [(job.step.id, job.state.prev_id) for job in pending] == [(2, 101)]


def test_inconsistent_closed_snapshot_does_not_replay_or_start_batch():
    with pytest.raises(ValueError, match="missing its native completion"):
        jobs(frontier("exhausted", (1, "completed")), batch=True)


def test_restart_uses_same_persisted_path_identity():
    snapshot = frontier("running", (1, "completed"), (2, "pending"))
    first = jobs(snapshot, completed={(1, 1, TABLE, 1)})
    assert jobs(snapshot, completed={(1, 1, TABLE, 1)}) == first
    assert first[0].state.prev_table == TABLE


def test_disabled_discovery_preserves_legacy_seed_and_schema():
    pending = build_pending_jobs(scan=scan(False), workflow=workflow(), completed=set(), step_results={})
    assert [(job.step.id, job.state.prev_id, job.state.prev_table) for job in pending] == [(1, 0, None)]


def test_enabled_discovery_cannot_fall_back_to_legacy_seed():
    with pytest.raises(ValueError, match="persisted frontier"):
        build_pending_jobs(scan=scan(), workflow=workflow(), completed=set(), step_results={})


def test_deadline_shrinks_across_resumes_and_resets_after_scope(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(harnesses.time, "monotonic", lambda: clock[0])
    with harnesses.harness_deadline(10):
        assert harnesses._deadline_timeout(600) == 10
        clock[0] += 6
        assert harnesses._deadline_timeout(600) == 4
        assert harnesses._deadline_timeout(2) == 2
        clock[0] += 4
        with pytest.raises(harnesses.HarnessError, match="budget expired"):
            harnesses._deadline_timeout(600)
    assert harnesses._deadline_timeout(600) == 600


def test_nested_deadline_cannot_extend_parent_and_threads_are_isolated(monkeypatch):
    monkeypatch.setattr(harnesses.time, "monotonic", lambda: 100.0)
    with harnesses.harness_deadline(10), ThreadPoolExecutor(max_workers=1) as pool:
        with harnesses.harness_deadline(20):
            assert harnesses._deadline_timeout(None) == 10
        assert pool.submit(harnesses._deadline_timeout, 600).result() == 600
    assert harnesses._deadline_timeout(None) is None


def test_model_dispatch_receives_remaining_budget(monkeypatch, tmp_path):
    monkeypatch.setattr(harnesses, "_unprivileged_process_command", lambda cmd, env: cmd)
    monkeypatch.setattr(harnesses.time, "monotonic", lambda: 100.0)
    calls = []

    def run(cmd, **kwargs):
        calls.append(kwargs["timeout"])
        return harnesses.subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(harnesses.subprocess, "run", run)
    with harnesses.harness_deadline(7):
        harnesses._run_process(["codex"], "test", tmp_path, 600, env={})
    assert calls == [7]

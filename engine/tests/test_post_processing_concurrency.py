from contextlib import contextmanager
from datetime import datetime, timezone
from types import SimpleNamespace

from open_kritt_engine import post_processing as post_processing_module
from open_kritt_engine.db import Database
from open_kritt_engine.post_processing import POST_WORKSPACE_ID_OFFSET, PostProcessor


class FakeConnection:
    def __init__(self):
        self.commits = 0

    def commit(self):
        self.commits += 1


def active_scan():
    return {
        "id": 146,
        "workflow_id": 3,
        "status": "post_processing",
        "configuration": {},
        "model": "test-model",
        "harness": "codex",
    }


def test_process_once_schedules_post_scripts_while_another_worker_runs_ranker():
    current = active_scan()

    class FakeDatabase:
        @contextmanager
        def connect(self):
            yield FakeConnection()

        def load_scan(self, _conn, _scan_id):
            return current

        def load_vulnerabilities(self, _conn, _scan_id):
            return [{"id": 127, "dedupe_is_canonical": True, "bounty_rank": None}]

    processor = PostProcessor(SimpleNamespace(), FakeDatabase())
    calls = []
    processor._run_next_ranker_batch = lambda _scan, _harness: calls.append("ranker") and False

    def run_post_script(_scan, _harness, *, allow_complete):
        calls.append(("post_script", allow_complete))
        return True

    processor._run_next_post_script_or_complete = run_post_script

    assert processor.process_once(current, object()) is True
    assert calls == ["ranker", ("post_script", False)]


def test_post_scripts_cannot_complete_scan_while_ranker_is_running():
    current = active_scan()

    class FakeDatabase:
        def __init__(self):
            self.status_updates = []

        @contextmanager
        def connect(self):
            yield FakeConnection()

        def load_scan(self, _conn, _scan_id):
            return current

        def count_running_post_process(self, _conn, _scan_id, kind):
            return 1 if kind == "ranker" else 0

        def set_scan_status_if_current(self, _conn, scan_id, current_status, next_status):
            self.status_updates.append((scan_id, current_status, next_status))

    database = FakeDatabase()
    processor = PostProcessor(SimpleNamespace(), database)

    assert processor._run_next_post_script_or_complete(current, object()) is False
    assert database.status_updates == []


def test_post_processing_uses_shared_workspace_setup_slot(monkeypatch):
    events = []

    class RecordingSlot:
        def __enter__(self):
            events.append("slot-enter")

        def __exit__(self, exc_type, exc_value, traceback):
            events.append("slot-exit")

    prepared = object()

    def prepare_dependency_workspace(**kwargs):
        events.append(("prepare", kwargs))
        return prepared

    monkeypatch.setattr(post_processing_module, "prepare_dependency_workspace", prepare_dependency_workspace)
    processor = PostProcessor(
        SimpleNamespace(data_dir="/tmp/data", github_token=None),
        object(),
        workspace_setup_slots=RecordingSlot(),
    )

    result = processor._prepare_workspace(42, active_scan(), agent_skills=[{"slug": "security-review"}])

    assert result is prepared
    assert events[0] == "slot-enter"
    assert events[2] == "slot-exit"
    assert events[1][0] == "prepare"
    assert events[1][1]["metadata_id"] == POST_WORKSPACE_ID_OFFSET + 42
    assert events[1][1]["agent_skills"] == [{"slug": "security-review"}]


class QueryResult:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row


class RankerClaimConnection:
    def __init__(self, *, active_ranker=None, eligible_targets=1):
        self.active_ranker = active_ranker
        self.eligible_targets = eligible_targets
        self.queries = []

    def execute(self, query, params):
        self.queries.append((query, params))
        if "FROM public.scans" in query and "FOR UPDATE" in query:
            return QueryResult({"id": 146, "status": "post_processing", "job_limit": None, "jobs_started": 0})
        if "FROM workflows.post_process_metadata" in query and "status = 'running'" in query:
            return QueryResult(self.active_ranker)
        if "SELECT count(*) AS count" in query and "FROM workflows.vulnerabilities" in query:
            return QueryResult({"count": self.eligible_targets})
        return QueryResult()


def claim_ranker(database, connection, *, batch_index=2):
    return database.claim_post_process_metadata(
        connection,
        scan_id=146,
        workflow_id=3,
        kind="ranker",
        batch_index=batch_index,
        target_vulnerability_ids=[127],
        prompt_template="anchored-ranker",
        prompt_filled="",
        model="test-model",
        harness="codex",
        thinking_effort="medium",
        model_provider="codex",
        run_started_at=datetime.now(timezone.utc),
    )


def test_ranker_claim_rechecks_for_any_active_batch_under_scan_lock():
    connection = RankerClaimConnection(active_ranker={"id": 268})

    assert claim_ranker(Database(""), connection) is None
    assert connection.queries[0][1] == ("post-process:146:ranker",)
    active_query = next(query for query, _params in connection.queries if "status = 'running'" in query)
    assert "batch_index = %s AND status = 'completed'" in active_query
    assert not any("INSERT INTO workflows.post_process_metadata" in query for query, _params in connection.queries)


def test_ranker_claim_rejects_targets_ranked_after_the_worker_loaded_them():
    connection = RankerClaimConnection(active_ranker=None, eligible_targets=0)

    assert claim_ranker(Database(""), connection) is None
    eligibility_query = next(
        query for query, _params in connection.queries if "FROM workflows.vulnerabilities" in query
    )
    assert "dedupe_is_canonical = true AND bounty_rank IS NULL" in eligibility_query
    assert not any("INSERT INTO workflows.post_process_metadata" in query for query, _params in connection.queries)

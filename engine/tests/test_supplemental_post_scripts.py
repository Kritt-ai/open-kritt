from contextlib import contextmanager
from types import SimpleNamespace

from open_kritt_engine.db import Database
from open_kritt_engine.post_processing import PostProcessor
from open_kritt_engine.schema import EXTRACTOR_HELPER_FIELD
from open_kritt_engine.worker import Worker


class Connection:
    def commit(self):
        return None


class ProcessingDatabase:
    def __init__(self):
        self.enrichments = []
        self.metadata = []
        self.completed_targets = []

    @contextmanager
    def connect(self):
        yield Connection()

    def upsert_vulnerability_enrichment(self, _conn, **kwargs):
        self.enrichments.append(kwargs)
        return 501

    def update_post_process_metadata(self, _conn, metadata_id, **kwargs):
        self.metadata.append({"metadata_id": metadata_id, **kwargs})

    def complete_supplemental_post_script_target(self, _conn, **kwargs):
        self.completed_targets.append(kwargs)
        return True


def supplemental_job():
    return {
        "scan": {
            "id": 7,
            "workflow_id": 3,
            "repo_full": "owner/repo",
            "repo_kind": "remote",
            "commit_sha": "abc123",
            "repo_scope": "all",
            "dependencies": ["owner/dependency"],
            "configuration": {"post_processing_thinking_effort": "high"},
            "extra": {"existing": "scan value", "network": "old value"},
            "model": "gpt-5",
            "model_provider": "codex",
            "harness": "codex",
            "thinking_effort": "medium",
        },
        "run": {
            "id": 41,
            "post_script_id": 12,
            "post_script_name": "Network context",
            "post_script_content": "{{repo_full}} {{summary}} {{extra.network}} {{extra.existing}}",
            "post_script_output_format": '{"note":"string"}',
            "model": "supplemental-model",
            "model_provider": "openrouter",
            "harness": "codex",
            "thinking_effort": "high",
            "extra": {"network": "mainnet"},
        },
        "target": {"id": 91, "vulnerability_id": 31},
        "vulnerability": {
            "id": 31,
            "json_answer": {
                "summary": "Unsafe call",
                "file_path": "src/app.py",
                "line": 8,
            },
        },
    }


def test_supplemental_execution_uses_full_scan_context_and_writes_an_additive_enrichment():
    database = ProcessingDatabase()
    processor = PostProcessor(SimpleNamespace(data_dir="/tmp", github_token=None), database)
    captured = {}
    payload = {
        EXTRACTOR_HELPER_FIELD: True,
        "stub": False,
        "stub_explanation": "",
        "results": [{"note": "checked"}],
    }

    def run_harness(**kwargs):
        captured.update(kwargs)
        return payload, {"tokens": 3}, "session-1", "abc123"

    processor._run_harness_with_retries = run_harness

    assert processor.process_supplemental_post_script_target(supplemental_job(), object(), metadata_id=77) is True

    context = captured["prompt_context"]
    assert context["repo_full"] == "owner/repo"
    assert context["dependencies"] == ["owner/dependency"]
    assert context["summary"] == "Unsafe call"
    assert context["extra"] == {"existing": "scan value", "network": "mainnet"}
    assert captured["prompt_template"] == "{{repo_full}} {{summary}} {{extra.network}} {{extra.existing}}"
    assert captured["kind"] == "supplemental_post_script"
    assert captured["scan"]["configuration"] == {
        "post_processing_thinking_effort": "high",
        "post_processing_model": "supplemental-model",
        "post_processing_model_provider": "openrouter",
        "post_processing_harness": "codex",
    }
    assert database.enrichments == [
        {
            "scan_id": 7,
            "vulnerability_id": 31,
            "post_script_id": 12,
            "post_script_name": "Network context",
            "result": {"note": "checked"},
            "stub": False,
            "stub_explanation": None,
            "supplemental_run_id": 41,
        }
    ]
    assert database.completed_targets == [{"target_id": 91, "enrichment_id": 501}]
    assert database.metadata[-1]["status"] == "completed"


class SchedulingDatabase:
    def __init__(self, job):
        self.job = job
        self.claimed = 0
        self.created_metadata = []

    @contextmanager
    def connect(self):
        yield Connection()

    def claim_supplemental_post_script_target(self, _conn):
        self.claimed += 1
        job, self.job = self.job, None
        return job

    def create_supplemental_post_process_metadata(self, _conn, **kwargs):
        self.created_metadata.append(kwargs)
        return 77


def test_worker_dispatches_supplemental_work_without_resuming_the_scan():
    job = supplemental_job()
    database = SchedulingDatabase(job)
    worker = Worker.__new__(Worker)
    worker.db = database
    worker.config = SimpleNamespace(poll_seconds=1, data_dir="/tmp")
    worker._worker_can_pick_job = lambda _worker_id: True
    worker._memory_allows_new_runner = lambda: True
    worker._new_scan_container_allowed = lambda _scan_id: True
    selections = []
    worker._harness_for_model_selection = lambda selection: selections.append(selection) or object()
    worker._schedule_post_task_cleanup = lambda: None
    calls = []
    worker.post_processor = SimpleNamespace(
        process_supplemental_post_script_target=lambda claimed, _harness, metadata_id: (
            calls.append((claimed, metadata_id)) or True
        )
    )

    assert worker.run_supplemental_post_script_once(worker_id=1) is True
    assert calls == [(job, 77)]
    assert selections[0].model == "supplemental-model"
    assert selections[0].model_provider == "openrouter"
    assert selections[0].thinking_effort == "high"
    assert job["scan"].get("status") is None
    assert database.created_metadata[0]["run"]["post_script_content"] == job["run"]["post_script_content"]


class ClaimConnection:
    def __init__(self):
        self.queries = []

    def execute(self, query, params=None):
        self.queries.append((query, params))
        return SimpleNamespace(fetchone=lambda: None)


def test_supplemental_claim_waits_for_original_scan_work_to_finish():
    connection = ClaimConnection()

    assert Database("").claim_supplemental_post_script_target(connection) is None

    candidate_query = connection.queries[0][0]
    assert "coalesce(sm.kind, 'step') = 'step'" in candidate_query
    assert "pm.supplemental_run_id IS NULL" in candidate_query

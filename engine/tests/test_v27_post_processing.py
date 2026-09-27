import json
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from open_kritt_engine import post_processing as post_processing_module
from open_kritt_engine.harnesses import HarnessResult
from open_kritt_engine.impact_gate import LEGACY_REASON
from open_kritt_engine.post_processing import PostProcessor
from open_kritt_engine.readiness_policies import POLICY_VERSION
from open_kritt_engine.schema import EXTRACTOR_HELPER_FIELD
from open_kritt_engine.v27_pipeline import d4_eligibility_sql, d5_eligibility_sql

D3_ID, D4_ID, D5_ID = 11, 12, 13
ARTIFACT_DIR = "poc-artifacts/scan-7/finding-5/metadata-9"

D3_FORMAT = {"verdict": "string", "impact_definition_status": "string"}
D4_FORMAT = {
    "poc_status": "string",
    "bug_status": "string",
    "impact_status": "string",
    "poc_artifact_paths": "array",
    "poc_artifact_dir": "string",
    "impact_artifact_paths": {"type": "array", "items": "string"},
    "impact_chain": {
        "type": "array",
        "items": {"type": "object", "fields": {"id": "string", "status": "string", "evidence_paths": "array"}},
    },
}
D5_FORMAT = {"submission_ready": "boolean", "impact_match_status": "string"}


def scan_row(configuration=None):
    return {
        "id": 7,
        "workflow_id": 3,
        "status": "post_processing",
        "repo_full": "owner/repo",
        "repo_kind": "remote",
        "commit_sha": "HEAD",
        "repo_scope": "full repository",
        "dependencies": [],
        "dependencies_detail": [],
        "configuration": {
            "v27_pipeline": {"d3": D3_ID, "d4": D4_ID, "d5": D5_ID},
            "post_script_ids": [D3_ID, D4_ID, D5_ID],
            "investigation_kind": "public_bounty",
            "investigation_kind_source": "user",
            "readiness_policy_version": POLICY_VERSION,
            **(configuration or {}),
        },
        "model": "test-model",
        "model_provider": "codex",
        "harness": "codex",
        "thinking_effort": "medium",
    }


def marked(results):
    return {EXTRACTOR_HELPER_FIELD: True, "stub": False, "stub_explanation": "", "results": results}


class Cursor:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return list(self.rows)

    def fetchone(self):
        return self.rows[0] if self.rows else None


class FakeConn:
    def __init__(self, db):
        self.db = db

    def commit(self):
        pass

    def execute(self, query, args=()):
        self.db.queries.append((query, args))
        if "FROM public.post_scripts" in query:
            return Cursor(self.db.scripts)
        if "FROM workflows.vulnerabilities v" in query:
            script_id = args[1]
            return Cursor([self.db.finding] if script_id == self.db.stage_script_id else [])
        if "FROM workflows.vulnerability_enrichments" in query:
            return Cursor(self.db.prior_rows)
        raise AssertionError(f"unexpected query: {query}")


class FakePostDb:
    def __init__(self, *, scan, stage_script_id, prior_rows=()):
        self.scan = scan
        self.stage_script_id = stage_script_id
        self.prior_rows = list(prior_rows)
        self.finding = {"id": 5, "bounty_rank": 1, "json_answer": {"summary": "finding"}}
        self.scripts = [
            {"id": D3_ID, "name": "D3", "content": "verify", "output_format": json.dumps(D3_FORMAT)},
            {"id": D4_ID, "name": "D4", "content": "poc", "output_format": json.dumps(D4_FORMAT)},
            {"id": D5_ID, "name": "D5", "content": "report", "output_format": json.dumps(D5_FORMAT)},
        ]
        self.queries = []
        self.updates = []
        self.enrichments = []

    @contextmanager
    def connect(self):
        yield FakeConn(self)

    def load_scan(self, _conn, _scan_id):
        return self.scan

    def count_running_post_process(self, _conn, _scan_id, _kind):
        return 0

    def claim_post_process_metadata(self, _conn, **kwargs):
        self.claimed = kwargs
        return 9

    def update_post_process_metadata(self, _conn, metadata_id, **kwargs):
        self.updates.append({"metadata_id": metadata_id, **kwargs})

    def upsert_vulnerability_enrichment(self, _conn, **kwargs):
        self.enrichments.append(kwargs)
        return len(self.enrichments)


def run_stage(db, payload, *, capture=None):
    processor = PostProcessor(SimpleNamespace(retry_count=0, data_dir="/tmp", github_token=None), db)
    seen = {}

    def fake_runner(**kwargs):
        seen.update(kwargs)
        if capture is not None:
            processor._evidence_captures[kwargs["metadata_id"]] = capture
        return payload, {"total_tokens": 3}, None, "abc"

    processor._run_harness_with_retries = fake_runner
    assert processor._run_next_post_script_or_complete(db.scan, object()) is True
    return seen, db.enrichments[-1]["result"]


def d4_rows(evidence=None, extra=None):
    result = {"poc_status": "reproduced", "bug_status": "reproduced", "impact_status": "proven", **(extra or {})}
    if evidence is not None:
        result["_engine_evidence"] = evidence
    return [
        {
            "post_script_id": D3_ID,
            "result": {"verdict": "confirmed", "impact_definition_status": "defined"},
            "stub": False,
        },
        {"post_script_id": D4_ID, "result": result, "stub": False},
    ]


def test_stage_conditions_use_the_gate_sql():
    db = FakePostDb(scan=scan_row(), stage_script_id=D3_ID)
    run_stage(db, marked([{"verdict": "confirmed", "impact_definition_status": "defined"}]))
    candidate_queries = [query for query, _args in db.queries if "FROM workflows.vulnerabilities v" in query]
    assert len(candidate_queries) == 1
    assert d4_eligibility_sql() not in candidate_queries[0]

    db = FakePostDb(scan=scan_row(), stage_script_id=D5_ID, prior_rows=d4_rows())
    run_stage(db, marked([{"submission_ready": False, "impact_match_status": "none"}]))
    candidate_queries = [query for query, _args in db.queries if "FROM workflows.vulnerabilities v" in query]
    assert d4_eligibility_sql() in candidate_queries[1]
    assert d5_eligibility_sql() in candidate_queries[2]
    assert "poc_status" not in candidate_queries[2]


def test_d3_result_gains_the_engine_lifecycle_block():
    db = FakePostDb(scan=scan_row(), stage_script_id=D3_ID)
    seen, stored = run_stage(db, marked([{"verdict": "confirmed", "impact_definition_status": "defined"}]))
    assert seen["kind"] == "post_script"
    assert stored["verdict"] == "confirmed"
    assert stored["_engine_lifecycle"] == {
        "lifecycle_status": "code_confirmed",
        "policy_version": POLICY_VERSION,
        "legacy": False,
    }


def test_d4_result_keeps_model_fields_and_adds_engine_evidence():
    db = FakePostDb(scan=scan_row(), stage_script_id=D4_ID, prior_rows=d4_rows()[:1])
    model_row = {
        "poc_status": "reproduced",
        "bug_status": "reproduced",
        "impact_status": "proven",
        "poc_artifact_paths": ["poc.py"],
        "poc_artifact_dir": "",
        "impact_artifact_paths": ["balances.json"],
        "impact_chain": [{"id": "hop-1", "status": "proven", "evidence_paths": ["attack.log"]}],
    }
    capture = {
        "artifact_dir": ARTIFACT_DIR,
        "captured_paths": ["poc.py", "balances.json"],
        "unresolved_paths": ["attack.log"],
        "capture_complete": False,
        "reason": "attack.log: artifact is missing or not a regular file",
    }
    seen, stored = run_stage(db, marked([dict(model_row)]), capture=capture)
    assert seen["kind"] == "v27_poc"
    assert seen["poc_finding_id"] == 5
    for key, value in model_row.items():
        assert stored[key] == value, key
    assert stored["poc_status"] == "reproduced"
    assert stored["_engine_evidence"] == {
        "bug_status": "reproduced",
        "impact_status": "blocked",
        "blocker_kind": "none",
        "artifact_dir": ARTIFACT_DIR,
        "captured_paths": ["poc.py", "balances.json"],
        "unresolved_paths": ["attack.log"],
        "capture_complete": False,
        "lifecycle_status": "impact_blocked",
        "policy_version": POLICY_VERSION,
        "legacy": False,
    }
    assert "_engine_lifecycle" not in stored


def test_d4_without_a_capture_record_is_marked_incomplete():
    db = FakePostDb(scan=scan_row(), stage_script_id=D4_ID, prior_rows=d4_rows()[:1])
    _seen, stored = run_stage(
        db,
        marked(
            [
                {
                    "poc_status": "not_reproduced",
                    "bug_status": "not_reproduced",
                    "impact_status": "not_proven",
                    "poc_artifact_paths": [],
                    "poc_artifact_dir": "",
                    "impact_artifact_paths": [],
                    "impact_chain": [],
                }
            ]
        ),
    )
    assert stored["_engine_evidence"]["capture_complete"] is False
    assert stored["_engine_evidence"]["artifact_dir"] == ""
    assert stored["_engine_evidence"]["lifecycle_status"] == "bug_not_reproduced"


def test_d5_result_gains_readiness_claim_and_chip():
    evidence = {
        "bug_status": "reproduced",
        "impact_status": "proven",
        "blocker_kind": "none",
        "artifact_dir": ARTIFACT_DIR,
        "captured_paths": ["poc.py"],
        "unresolved_paths": [],
        "capture_complete": True,
        "lifecycle_status": "impact_proven",
        "policy_version": POLICY_VERSION,
        "legacy": False,
    }
    db = FakePostDb(scan=scan_row(), stage_script_id=D5_ID, prior_rows=d4_rows(evidence))
    seen, stored = run_stage(db, marked([{"submission_ready": True, "impact_match_status": "partial"}]))
    assert seen["kind"] == "post_script"
    assert "Prior v2.7 stage results" in seen["prompt_template"]
    assert stored["submission_ready"] is True
    assert stored["model_readiness_claim"] is True
    readiness = stored["_engine_readiness"]
    assert readiness["ready"] is False
    assert readiness["label"] == "submission_ready"
    assert readiness["policy_version"] == POLICY_VERSION
    assert readiness["legacy"] is False
    assert readiness["checks"]["d5_match"] == "fail"
    assert readiness["evaluated_at"].endswith("+00:00")
    assert stored["_chip_lifecycle"] == readiness["lifecycle_status"] == "impact_proven"


def test_legacy_scan_readiness_carries_the_legacy_reason():
    scan = scan_row()
    for key in ("investigation_kind", "investigation_kind_source", "readiness_policy_version"):
        del scan["configuration"][key]
    evidence = {
        "bug_status": "reproduced",
        "impact_status": "proven",
        "artifact_dir": ARTIFACT_DIR,
        "capture_complete": True,
    }
    db = FakePostDb(scan=scan, stage_script_id=D5_ID, prior_rows=d4_rows(evidence))
    _seen, stored = run_stage(db, marked([{"submission_ready": True, "impact_match_status": "exact"}]))
    assert stored["_engine_readiness"]["ready"] is False
    assert LEGACY_REASON in stored["_engine_readiness"]["blocking_reasons"]


def test_model_supplied_engine_keys_are_stripped_before_persisting():
    db = FakePostDb(scan=scan_row(), stage_script_id=D3_ID)
    payload = marked(
        [
            {
                "verdict": "confirmed",
                "impact_definition_status": "defined",
                "_engine_readiness": {"ready": True},
                "_engine_lifecycle": {"lifecycle_status": "report_ready"},
                "_chip_lifecycle": "report_ready",
            }
        ]
    )
    _seen, stored = run_stage(db, payload)
    assert "_engine_readiness" not in stored
    assert "_chip_lifecycle" not in stored
    assert stored["_engine_lifecycle"]["lifecycle_status"] == "code_confirmed"


def test_stub_results_do_not_receive_engine_blocks():
    db = FakePostDb(scan=scan_row(), stage_script_id=D3_ID)
    _seen, stored = run_stage(
        db, {EXTRACTOR_HELPER_FIELD: True, "stub": True, "stub_explanation": "no code path", "results": []}
    )
    assert stored == {}


def test_harness_runner_captures_evidence_from_the_workspace(monkeypatch, tmp_path):
    root = tmp_path / "post-job"
    root.mkdir()
    repo = tmp_path / "repo"
    repo.mkdir()
    (repo / "poc.py").write_text("print('poc')")
    (repo / "attack.log").write_text("drained")

    class Workspace:
        root_dir = str(root)
        env = {"HOME": "/tmp/home"}

    prepared = SimpleNamespace(
        workspace=Workspace(),
        repo_dir=str(repo),
        checked_out_commit="def",
        layout="single repository",
        manifest_json='{"dependencies":[]}',
    )
    monkeypatch.setattr(post_processing_module, "prepare_dependency_workspace", lambda **_kwargs: prepared)

    class Db:
        def __init__(self):
            self.updates = []

        @contextmanager
        def connect(self):
            yield SimpleNamespace(commit=lambda: None)

        def update_post_process_metadata(self, _conn, metadata_id, **kwargs):
            self.updates.append({"metadata_id": metadata_id, **kwargs})

    class Harness:
        def run(self, **_kwargs):
            return HarnessResult(
                payload=marked(
                    [
                        {
                            "bug_status": "reproduced",
                            "poc_artifact_paths": ["poc.py", "attack.log", "missing.log"],
                            "poc_artifact_dir": "",
                        }
                    ]
                ),
                usage={"total_tokens": 3},
            )

    processor = PostProcessor(SimpleNamespace(retry_count=0, data_dir=str(tmp_path / "data"), github_token=None), Db())
    payload, _usage, _session, _commit = processor._run_harness_with_retries(
        metadata_id=9,
        scan=scan_row(),
        harness=Harness(),
        prompt="Reproduce.",
        schema={},
        validator=lambda _payload: None,
        kind="v27_poc",
        poc_finding_id=5,
    )
    capture = processor._evidence_captures[9]
    assert capture["artifact_dir"] == ARTIFACT_DIR
    assert capture["captured_paths"] == ["poc.py", "attack.log"]
    assert capture["unresolved_paths"] == ["missing.log"]
    assert capture["capture_complete"] is False
    assert payload["results"][0]["poc_artifact_dir"] == ARTIFACT_DIR
    assert payload["results"][0]["bug_status"] == "reproduced"
    assert (tmp_path / "data" / ARTIFACT_DIR / "attack.log").read_text() == "drained"
    assert not root.exists()


@pytest.mark.parametrize("stage_script_id", [D3_ID, D4_ID, D5_ID])
def test_every_stage_marks_metadata_completed(stage_script_id):
    payloads = {
        D3_ID: marked([{"verdict": "false_positive", "impact_definition_status": "unavailable"}]),
        D4_ID: marked(
            [
                {
                    "poc_status": "blocked",
                    "bug_status": "blocked",
                    "impact_status": "blocked",
                    "poc_artifact_paths": [],
                    "poc_artifact_dir": "",
                    "impact_artifact_paths": [],
                    "impact_chain": [],
                }
            ]
        ),
        D5_ID: marked([{"submission_ready": False, "impact_match_status": "none"}]),
    }
    prior = {D3_ID: [], D4_ID: d4_rows()[:1], D5_ID: d4_rows({"bug_status": "reproduced"})}
    db = FakePostDb(scan=scan_row(), stage_script_id=stage_script_id, prior_rows=prior[stage_script_id])
    run_stage(db, payloads[stage_script_id])
    assert db.updates[-1]["status"] == "completed"
    assert db.enrichments[-1]["post_script_id"] == stage_script_id

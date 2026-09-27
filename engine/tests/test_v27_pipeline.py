from open_kritt_engine import impact_gate
from open_kritt_engine.v27_pipeline import (
    D3_PASS_VERDICTS,
    d4_eligibility_sql,
    d5_eligibility_sql,
    eligible_for_stage,
    pipeline_ids,
    preceding_results,
)


def scan():
    return {"configuration": {"v27_pipeline": {"d3": "11", "d4": "12", "d5": "13"}}}


def evidence(**overrides):
    block = {
        "bug_status": "reproduced",
        "impact_status": "proven",
        "artifact_dir": "poc-artifacts/scan-1/finding-2/metadata-3",
        "capture_complete": True,
    }
    block.update(overrides)
    return block


def test_v27_gates_poc_and_report_on_prior_results():
    current = scan()
    assert pipeline_ids(current) == {"d3": 11, "d4": 12, "d5": 13}
    assert eligible_for_stage(current, 11, {})
    assert not eligible_for_stage(current, 12, {})
    assert not eligible_for_stage(current, 12, {11: {"verdict": "false_positive"}})
    assert eligible_for_stage(current, 12, {11: {"verdict": "plausible_needs_poc"}})
    assert not eligible_for_stage(current, 13, {12: {"poc_status": "reproduced", "poc_artifact_dir": "x"}})
    prior = {11: {"verdict": "confirmed"}, 12: {"poc_status": "reproduced", "_engine_evidence": evidence()}}
    assert eligible_for_stage(current, 13, prior)
    assert preceding_results(current, 13, prior) == {"d3": prior[11], "d4": prior[12]}


def test_d5_eligibility_follows_the_engine_evidence_block():
    current = scan()
    for impact in ("proven", "partial", "not_proven"):
        assert eligible_for_stage(current, 13, {12: {"_engine_evidence": evidence(impact_status=impact)}})
    for impact in ("blocked", "falsified", "unverified"):
        assert not eligible_for_stage(current, 13, {12: {"_engine_evidence": evidence(impact_status=impact)}})
    assert not eligible_for_stage(current, 13, {12: {"_engine_evidence": evidence(capture_complete=False)}})
    assert not eligible_for_stage(current, 13, {12: {"_engine_evidence": evidence(artifact_dir="")}})
    assert not eligible_for_stage(current, 13, {12: {"_engine_evidence": evidence(bug_status="blocked")}})


def test_unconfigured_scans_keep_existing_post_script_behavior():
    assert pipeline_ids({"configuration": {}}) == {}
    assert eligible_for_stage({"configuration": {}}, 7, {})


def test_eligibility_sql_is_built_from_the_gate_constants():
    assert D3_PASS_VERDICTS is impact_gate.D3_PASS_VERDICTS
    d4_sql = d4_eligibility_sql()
    assert "prior.result->>'verdict' IN ('confirmed', 'plausible_needs_poc')" in d4_sql

    d5_sql = d5_eligibility_sql()
    assert "prior.result->'_engine_evidence'->>'bug_status' = 'reproduced'" in d5_sql
    assert "prior.result->'_engine_evidence'->>'impact_status' IN ('proven', 'partial', 'not_proven')" in d5_sql
    assert "prior.result->'_engine_evidence'->>'capture_complete' = 'true'" in d5_sql
    assert "COALESCE(prior.result->'_engine_evidence'->>'artifact_dir', '') <> ''" in d5_sql
    assert "poc_status" not in d5_sql
    assert d5_eligibility_sql("e.result").count("e.result->'_engine_evidence'") == 4
    assert "%s" not in d5_sql

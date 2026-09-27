import copy

import pytest

from open_kritt_engine import impact_gate
from open_kritt_engine.impact_gate import (
    D3_PASS_VERDICTS,
    HOP_STATUSES,
    LEGACY_REASON,
    LIFECYCLE,
    chain_reasons,
    d5_eligible,
    dimension_reasons,
    evaluate_readiness,
    evidence_block,
    investigation_settings,
    lifecycle_block,
    lifecycle_status,
    normalize_missing_requirements,
    provenance_reasons,
    synthesize_legacy_blocks,
)
from open_kritt_engine.readiness_policies import LEGACY_POLICY_VERSION, POLICY_VERSION

ARTIFACT_DIR = "poc-artifacts/scan-1/finding-2/metadata-3"
EVALUATED_AT = "2026-09-24T10:00:00+00:00"
CHECKS = (
    "policy_version_supported",
    "investigation_kind_explicit",
    "d3_defined",
    "d4_bug_and_impact",
    "chain_complete",
    "provenance",
    "dimension_coverage",
    "d5_match",
    "scope_and_novelty",
)


def make_scan(kind="public_bounty", source="user", version=POLICY_VERSION):
    configuration = {}
    if kind is not None:
        configuration["investigation_kind"] = kind
    if source is not None:
        configuration["investigation_kind_source"] = source
    if version is not None:
        configuration["readiness_policy_version"] = version
    return {"id": 1, "configuration": configuration}


def dimension(tag, status="required", rationale=""):
    return {"tag": tag, "status": status, "rationale": rationale}


def hop(hop_id, status, evidence_paths=(), covers=(), assessment=""):
    return {
        "id": hop_id,
        "claim": f"claim for {hop_id}",
        "status": status,
        "evidence_paths": list(evidence_paths),
        "covers": list(covers),
        "assessment": assessment,
    }


def make_d3(source_type="bounty_rule"):
    return {
        "verdict": "confirmed",
        "reason": "withdraw() skips the share check",
        "scope_status": "in_scope_verified",
        "novelty_status": "novel_verified",
        "bug_claim": "withdraw() does not debit shares",
        "impact_claim": "attacker drains the vault",
        "impact_family": "funds_loss",
        "impact_objective": {
            "claim": "Direct theft of user funds from the vault",
            "source_type": source_type,
            "source_reference": "program rule: direct theft of funds",
            "affected_subject": "vault",
            "terminal_outcome": "Vault balance decreases and the attacker balance increases",
            "required_evidence": ["balance before and after", "recipient control"],
        },
        "evidence_dimensions": [
            dimension("balance_before"),
            dimension("balance_after"),
            dimension("asset_ownership"),
            dimension("net_change"),
            dimension("recipient_control"),
            dimension("terminal_outcome"),
        ],
        "impact_chain_plan": [
            hop("hop-1", "unverified", covers=["balance_before"]),
            hop(
                "hop-2",
                "unverified",
                covers=["balance_after", "asset_ownership", "net_change", "recipient_control", "terminal_outcome"],
            ),
        ],
        "unverified_assumptions": [],
        "falsification_plan": "call withdraw as a non-depositor and expect a revert",
        "first_unsupported_hop": "hop-1",
        "impact_definition_status": "defined",
    }


def make_d4():
    return {
        "poc_status": "reproduced",
        "poc_artifact_paths": ["poc.py", "attack.log"],
        "poc_artifact_dir": "",
        "remaining_limits": "",
        "_reserved_poc": "poc narrative",
        "bug_status": "reproduced",
        "impact_status": "proven",
        "blocker_kind": "none",
        "observed_behavior": "withdraw succeeded without shares",
        "claimed_impact": "attacker drains the vault",
        "observed_terminal_outcome": "vault balance 100 -> 0, attacker balance 0 -> 100",
        "impact_chain": [
            hop("hop-1", "proven", ["attack.log"], ["balance_before"]),
            hop(
                "hop-2",
                "proven",
                ["balances.json"],
                ["balance_after", "asset_ownership", "net_change", "recipient_control", "terminal_outcome"],
            ),
        ],
        "impact_artifact_paths": ["balances.json"],
        "missing_impact_links": [],
        "unverified_assumptions": [],
        "negative_control_status": "passed",
        "repeatability_status": "deterministic",
    }


def make_manifest():
    return {"poc.py", "attack.log", "balances.json"}


def make_evidence(d4=None, manifest=None, capture_complete=True, artifact_dir=ARTIFACT_DIR):
    return evidence_block(
        d4 if d4 is not None else make_d4(),
        manifest if manifest is not None else make_manifest(),
        capture_complete=capture_complete,
        artifact_dir=artifact_dir,
        policy_version=POLICY_VERSION,
        legacy=False,
    )


def make_d5():
    return {
        "submission_ready": True,
        "scope_status": "in_scope_verified",
        "severity": "critical",
        "novelty_status": "novel_verified",
        "impact_evidence": "balances.json shows the drain",
        "missing_requirements": [],
        "artifact_reference": ARTIFACT_DIR,
        "_reserved_report": "report",
        "scope_evidence": "vault is a listed asset",
        "novelty_evidence": "no prior report describes this path",
        "impact_match_status": "exact",
        "impact_evidence_status": "verified",
        "impact_mapping": [
            {
                "required_outcome": "vault balance decreases",
                "observed_outcome": "vault balance 100 -> 0",
                "status": "proven",
                "evidence_paths": ["balances.json"],
            }
        ],
        "report_readiness_reason": "terminal outcome observed and captured",
    }


def evaluate(scan=None, d3=None, d4=None, evidence=None, d5=None, evaluated_at=EVALUATED_AT):
    d4 = d4 if d4 is not None else make_d4()
    return evaluate_readiness(
        scan=scan if scan is not None else make_scan(),
        d3=d3 if d3 is not None else make_d3(),
        d4=d4,
        evidence=evidence if evidence is not None else make_evidence(d4),
        d5=d5 if d5 is not None else make_d5(),
        evaluated_at=evaluated_at,
    )


def failing(readiness):
    return [name for name, status in readiness["checks"].items() if status == "fail"]


def test_constants():
    assert D3_PASS_VERDICTS == frozenset({"confirmed", "plausible_needs_poc"})
    assert HOP_STATUSES == ("proven", "falsified", "partial", "unverified", "blocked", "not_applicable")
    assert len(LIFECYCLE) == 16 and len(set(LIFECYCLE)) == 16
    assert {"hypothesis", "report_ready", "legacy_bug_reproduced_impact_unverified"} <= set(LIFECYCLE)
    assert LEGACY_REASON == (
        "Investigation kind and readiness policy were not explicitly selected when this legacy scan was created."
    )


def test_investigation_settings_reads_explicit_keys_and_normalizes_legacy_scans():
    assert investigation_settings(make_scan("private_audit")) == {
        "investigation_kind": "private_audit",
        "investigation_kind_source": "user",
        "readiness_policy_version": POLICY_VERSION,
        "legacy": False,
    }
    assert investigation_settings({"configuration": {}}) == {
        "investigation_kind": "internal_research",
        "investigation_kind_source": "legacy_default",
        "readiness_policy_version": LEGACY_POLICY_VERSION,
        "legacy": True,
    }
    assert investigation_settings({"configuration": None})["legacy"] is True
    assert investigation_settings(make_scan(version=None))["legacy"] is True


def test_normalize_missing_requirements_handles_legacy_values():
    assert normalize_missing_requirements(None) == []
    assert normalize_missing_requirements("") == []
    assert normalize_missing_requirements("   ") == []
    assert normalize_missing_requirements("need scope proof") == ["need scope proof"]
    assert normalize_missing_requirements(["a", "b"]) == ["a", "b"]
    with pytest.raises(ValueError):
        normalize_missing_requirements({"a": 1})
    with pytest.raises(ValueError):
        normalize_missing_requirements(["a", 1])


# --- spec unit cases -------------------------------------------------------


def test_terminal_impact_proven_is_ready_and_d5_eligible():
    evidence = make_evidence()
    assert d5_eligible(evidence)
    readiness = evaluate(evidence=evidence)
    assert readiness["ready"] is True
    assert readiness["label"] == "submission_ready"
    assert readiness["lifecycle_status"] == "report_ready"
    assert readiness["blocking_reasons"] == []
    assert tuple(readiness["checks"]) == CHECKS
    assert set(readiness["checks"].values()) == {"pass"}
    assert readiness["policy"] == "public_bounty"
    assert readiness["policy_version"] == POLICY_VERSION
    assert readiness["evaluated_at"] == EVALUATED_AT
    assert readiness["legacy"] is False


def test_partial_impact_is_not_ready():
    d4 = {**make_d4(), "impact_status": "partial"}
    evidence = make_evidence(d4)
    assert evidence["impact_status"] == "partial"
    assert evidence["lifecycle_status"] == "impact_partial"
    assert d5_eligible(evidence)
    readiness = evaluate(d4=d4, evidence=evidence)
    assert readiness["ready"] is False
    assert "d4_bug_and_impact" in failing(readiness)
    assert readiness["lifecycle_status"] == "impact_partial"


def test_not_proven_impact_is_not_ready():
    d4 = {**make_d4(), "impact_status": "not_proven"}
    evidence = make_evidence(d4)
    assert evidence["lifecycle_status"] == "bug_proven_impact_unproven"
    assert d5_eligible(evidence)
    readiness = evaluate(d4=d4, evidence=evidence)
    assert readiness["ready"] is False
    assert "d4_bug_and_impact" in failing(readiness)


def test_proven_with_open_material_assumption_is_blocked():
    d4 = make_d4()
    d4["unverified_assumptions"] = [
        {
            "id": "a-1",
            "assumption": "vault uses default config",
            "kind": "configuration",
            "material": True,
            "status": "open",
        }
    ]
    readiness = evaluate(d4=d4)
    assert readiness["ready"] is False
    assert failing(readiness) == ["chain_complete"]
    assert any("a-1" in reason for reason in readiness["blocking_reasons"])


def test_evidence_not_matching_objective_is_not_ready():
    d5 = {**make_d5(), "impact_match_status": "partial"}
    readiness = evaluate(d5=d5)
    assert readiness["ready"] is False
    assert failing(readiness) == ["d5_match"]


def test_falsified_impact_is_not_ready_and_terminates_before_d5():
    d4 = {**make_d4(), "impact_status": "falsified"}
    evidence = make_evidence(d4)
    assert evidence["lifecycle_status"] == "impact_falsified"
    assert not d5_eligible(evidence)
    readiness = evaluate(d4=d4, evidence=evidence)
    assert readiness["ready"] is False


def test_failed_negative_control_is_not_ready():
    d4 = {**make_d4(), "negative_control_status": "failed"}
    readiness = evaluate(d4=d4)
    assert readiness["ready"] is False
    assert failing(readiness) == ["d4_bug_and_impact"]


def test_non_deterministic_reproduction_is_not_ready_without_probabilistic_policy():
    d4 = {**make_d4(), "repeatability_status": "non_deterministic"}
    readiness = evaluate(d4=d4)
    assert readiness["ready"] is False
    assert failing(readiness) == ["d4_bug_and_impact"]


def test_private_audit_without_novelty_may_be_report_ready():
    scan = make_scan("private_audit")
    d3 = make_d3(source_type="audit_spec")
    d5 = {**make_d5(), "novelty_status": "unknown", "novelty_evidence": ""}
    readiness = evaluate(scan=scan, d3=d3, d5=d5)
    assert readiness["ready"] is True
    assert readiness["label"] == "report_ready"


def test_public_bounty_with_unverified_novelty_is_not_submission_ready():
    d5 = {**make_d5(), "novelty_status": "unknown", "novelty_evidence": ""}
    readiness = evaluate(d5=d5)
    assert readiness["ready"] is False
    assert readiness["label"] == "submission_ready"
    assert failing(readiness) == ["scope_and_novelty"]


def test_legacy_result_is_unverified_and_not_ready():
    scan = {"id": 1, "configuration": {}}
    d4_legacy = {"poc_status": "reproduced", "poc_artifact_dir": ARTIFACT_DIR, "poc_artifact_paths": ["poc.py"]}
    blocks = synthesize_legacy_blocks(scan, "d4", d4_legacy)
    evidence = blocks["_engine_evidence"]
    assert set(blocks) == {"_engine_evidence"}
    assert evidence["bug_status"] == "reproduced"
    assert evidence["impact_status"] == "unverified"
    assert evidence["legacy"] is True
    assert evidence["artifact_dir"] == ARTIFACT_DIR
    assert evidence["lifecycle_status"] == "legacy_bug_reproduced_impact_unverified"
    assert evidence["policy_version"] == LEGACY_POLICY_VERSION
    assert not d5_eligible(evidence)

    d5_blocks = synthesize_legacy_blocks(scan, "d5", {"submission_ready": True, "missing_requirements": ""})
    readiness = d5_blocks["_engine_readiness"]
    assert readiness["ready"] is False
    assert readiness["legacy"] is True
    assert readiness["blocking_reasons"] == [LEGACY_REASON]
    assert tuple(readiness["checks"]) == CHECKS
    assert readiness["lifecycle_status"] == "legacy_bug_reproduced_impact_unverified"
    assert d5_blocks["model_readiness_claim"] is True
    assert d5_blocks["_chip_lifecycle"] == "legacy_bug_reproduced_impact_unverified"

    d3_blocks = synthesize_legacy_blocks(scan, "d3", {"verdict": "confirmed"})
    assert d3_blocks == {
        "_engine_lifecycle": {
            "lifecycle_status": "code_confirmed",
            "policy_version": LEGACY_POLICY_VERSION,
            "legacy": True,
        }
    }
    assert synthesize_legacy_blocks(scan, "d4", {"poc_status": "not_reproduced"})["_engine_evidence"][
        "lifecycle_status"
    ] == ("bug_not_reproduced")


def test_model_readiness_claim_is_overridden_by_the_gate():
    d4 = {**make_d4(), "impact_status": "partial"}
    d5 = {**make_d5(), "submission_ready": True}
    readiness = evaluate(d4=d4, evidence=make_evidence(d4), d5=d5)
    assert d5["submission_ready"] is True
    assert readiness["ready"] is False


# --- rule-level cases ------------------------------------------------------


def test_legacy_scan_blocks_with_the_exact_reason_string():
    readiness = evaluate(scan={"id": 1, "configuration": {}})
    assert readiness["ready"] is False
    assert LEGACY_REASON in readiness["blocking_reasons"]
    assert readiness["checks"]["investigation_kind_explicit"] == "fail"
    assert readiness["checks"]["policy_version_supported"] == "fail"
    assert readiness["policy_version"] == LEGACY_POLICY_VERSION


def test_unsupported_policy_version_blocks_and_never_falls_through():
    readiness = evaluate(scan=make_scan(version="v2.8-impact-gate-1"))
    assert readiness["ready"] is False
    assert readiness["checks"]["policy_version_supported"] == "fail"
    assert readiness["policy_version"] == "v2.8-impact-gate-1"
    assert any("v2.8-impact-gate-1" in reason for reason in readiness["blocking_reasons"])


def test_unknown_investigation_kind_blocks():
    readiness = evaluate(scan=make_scan(kind="bug_bash"))
    assert readiness["ready"] is False
    assert readiness["checks"]["investigation_kind_explicit"] == "fail"


def test_evaluation_is_pure_and_stable():
    first = evaluate()
    second = evaluate()
    assert first == second
    assert evaluate(evaluated_at="2030-01-01T00:00:00+00:00")["evaluated_at"] == "2030-01-01T00:00:00+00:00"
    assert not hasattr(impact_gate, "datetime")


def test_source_type_matrix_for_every_policy_row():
    matrix = {
        "public_bounty": {"bounty_rule"},
        "audit_competition": {"audit_spec", "engagement_scope"},
        "private_audit": {"audit_spec", "engagement_scope", "threat_model", "researcher_hypothesis"},
        "threat_model_validation": {"threat_model", "engagement_scope"},
        "internal_research": {"threat_model", "researcher_hypothesis", "engagement_scope"},
    }
    sources = ("bounty_rule", "audit_spec", "threat_model", "engagement_scope", "researcher_hypothesis")
    for kind, allowed in matrix.items():
        for source in sources:
            readiness = evaluate(scan=make_scan(kind), d3=make_d3(source_type=source))
            expected = "pass" if source in allowed else "fail"
            assert readiness["checks"]["d3_defined"] == expected, (kind, source)


def test_d3_definition_rules():
    ambiguous = {**make_d3(), "impact_definition_status": "ambiguous"}
    assert "d3_defined" in failing(evaluate(d3=ambiguous))
    no_outcome = make_d3()
    no_outcome["impact_objective"]["terminal_outcome"] = ""
    assert "d3_defined" in failing(evaluate(d3=no_outcome))
    no_evidence = make_d3()
    no_evidence["impact_objective"]["required_evidence"] = []
    assert "d3_defined" in failing(evaluate(d3=no_evidence))
    not_confirmed = {**make_d3(), "verdict": "false_positive"}
    assert "d3_defined" in failing(evaluate(d3=not_confirmed))
    assert "d3_defined" in failing(evaluate(d3={}))


def test_hop_superset_rules():
    plan = make_d3()["impact_chain_plan"]
    chain = make_d4()["impact_chain"]
    assert chain_reasons(plan, chain) == []

    renamed = copy.deepcopy(chain)
    renamed[1]["id"] = "hop-2b"
    assert any("hop-2" in reason for reason in chain_reasons(plan, renamed))

    dropped = chain[:1]
    assert any("hop-2" in reason for reason in chain_reasons(plan, dropped))

    added = [*chain, hop("hop-3", "proven", ["balances.json"], ["net_change"])]
    assert chain_reasons(plan, added) == []
    d4 = {**make_d4(), "impact_chain": added}
    assert evaluate(d4=d4)["ready"] is True

    duplicated = [*chain, copy.deepcopy(chain[0])]
    assert any("unique" in reason for reason in chain_reasons(plan, duplicated))


def test_hop_status_and_assessment_rules():
    plan = make_d3()["impact_chain_plan"]
    silent = [hop("hop-1", "proven", ["attack.log"]), hop("hop-2", "not_applicable")]
    assert any("assessment" in reason for reason in chain_reasons(plan, silent))
    explained = [
        hop("hop-1", "proven", ["attack.log"]),
        hop("hop-2", "not_applicable", assessment="collapsed into hop-1"),
    ]
    assert chain_reasons(plan, explained) == []
    unproven = [hop("hop-1", "proven", ["attack.log"]), hop("hop-2", "unverified")]
    assert any("hop-2" in reason for reason in chain_reasons(plan, unproven))
    no_paths = [hop("hop-1", "proven"), hop("hop-2", "proven", ["balances.json"])]
    assert any("evidence" in reason for reason in chain_reasons(plan, no_paths))
    bogus = [hop("hop-1", "proven", ["attack.log"]), hop("hop-2", "maybe")]
    assert any("maybe" in reason for reason in chain_reasons(plan, bogus))


def test_missing_impact_links_block_chain_completeness():
    d4 = {**make_d4(), "missing_impact_links": ["hop-2"]}
    assert failing(evaluate(d4=d4)) == ["chain_complete"]


def test_provenance_rules():
    captured = {"attack.log", "balances.json"}
    assert provenance_reasons(["attack.log", "./balances.json"], captured) == []
    assert provenance_reasons(["missing.log"], captured)
    assert provenance_reasons(["/etc/passwd"], captured)
    assert provenance_reasons(["../attack.log"], captured)
    assert provenance_reasons([""], captured)

    d4 = make_d4()
    d4["impact_chain"][1]["evidence_paths"] = ["missing.log"]
    readiness = evaluate(d4=d4)
    assert failing(readiness) == ["provenance"]
    assert any("missing.log" in reason for reason in readiness["blocking_reasons"])

    d5 = make_d5()
    d5["impact_mapping"][0]["evidence_paths"] = ["../escape.log"]
    assert failing(evaluate(d5=d5)) == ["provenance"]

    incomplete = make_evidence(capture_complete=False)
    assert incomplete["capture_complete"] is False
    assert incomplete["impact_status"] == "blocked"
    assert incomplete["lifecycle_status"] == "impact_blocked"
    assert not d5_eligible(incomplete)
    assert "provenance" in failing(evaluate(evidence=incomplete))


def test_evidence_block_normalizes_paths_and_statuses():
    evidence = make_evidence()
    assert evidence == {
        "bug_status": "reproduced",
        "impact_status": "proven",
        "blocker_kind": "none",
        "artifact_dir": ARTIFACT_DIR,
        "captured_paths": ["poc.py", "attack.log", "balances.json"],
        "unresolved_paths": [],
        "capture_complete": True,
        "lifecycle_status": "impact_proven",
        "policy_version": POLICY_VERSION,
        "legacy": False,
    }
    partial_manifest = make_evidence(manifest={"poc.py"})
    assert partial_manifest["unresolved_paths"] == ["attack.log", "balances.json"]
    d4 = {**make_d4(), "bug_status": "", "impact_status": "weird", "poc_status": "blocked"}
    fallback = make_evidence(d4)
    assert fallback["bug_status"] == "blocked"
    assert fallback["impact_status"] == "unverified"
    assert fallback["lifecycle_status"] == "bug_blocked"


def test_dimension_coverage_rules():
    d3 = make_d3()
    chain = make_d4()["impact_chain"]
    assert dimension_reasons(d3["evidence_dimensions"], "funds_loss", chain, POLICY_VERSION) == []

    uncovered = copy.deepcopy(chain)
    uncovered[1]["covers"].remove("recipient_control")
    assert any(
        "recipient_control" in r
        for r in dimension_reasons(d3["evidence_dimensions"], "funds_loss", uncovered, POLICY_VERSION)
    )

    weak_tag = [*d3["evidence_dimensions"], dimension("attacker_workload")]
    assert any("attacker_workload" in r for r in dimension_reasons(weak_tag, "funds_loss", chain, POLICY_VERSION))

    silent_na = copy.deepcopy(d3["evidence_dimensions"])
    silent_na[4] = dimension("recipient_control", "not_applicable", "")
    assert any("rationale" in r for r in dimension_reasons(silent_na, "funds_loss", uncovered, POLICY_VERSION))
    explained_na = copy.deepcopy(silent_na)
    explained_na[4] = dimension("recipient_control", "not_applicable", "attacker is the direct recipient")
    assert dimension_reasons(explained_na, "funds_loss", uncovered, POLICY_VERSION) == []

    unresolved = d3["evidence_dimensions"][:-1]
    assert any("terminal_outcome" in r for r in dimension_reasons(unresolved, "funds_loss", chain, POLICY_VERSION))

    unproven_cover = copy.deepcopy(chain)
    unproven_cover[0]["status"] = "partial"
    unproven_cover[0]["assessment"] = "only observed once"
    assert any(
        "balance_before" in r
        for r in dimension_reasons(d3["evidence_dimensions"], "funds_loss", unproven_cover, POLICY_VERSION)
    )

    assert dimension_reasons(d3["evidence_dimensions"], "money", chain, POLICY_VERSION)
    with pytest.raises(ValueError):
        dimension_reasons(d3["evidence_dimensions"], "funds_loss", chain, "nope")

    d3_weak = {**make_d3(), "evidence_dimensions": weak_tag}
    assert failing(evaluate(d3=d3_weak)) == ["dimension_coverage"]


def test_d5_match_rules():
    assert failing(evaluate(d5={**make_d5(), "impact_evidence_status": "insufficient"})) == ["d5_match"]
    assert failing(evaluate(d5={**make_d5(), "artifact_reference": "poc-artifacts/other"})) == ["d5_match"]
    assert failing(evaluate(d5={**make_d5(), "missing_requirements": "needs a mainnet fork"})) == ["d5_match"]
    assert failing(evaluate(d5={**make_d5(), "missing_requirements": {"bad": 1}})) == ["d5_match"]
    contradicted = make_d5()
    contradicted["impact_mapping"][0]["status"] = "contradicted"
    assert failing(evaluate(d5=contradicted)) == ["d5_match"]
    assert "d5_match" in failing(evaluate(d5={}))


def test_scope_rules_follow_the_policy():
    d5 = {**make_d5(), "scope_status": "unknown", "scope_evidence": ""}
    assert failing(evaluate(d5=d5)) == ["scope_and_novelty"]
    relaxed = evaluate(scan=make_scan("internal_research"), d3=make_d3("researcher_hypothesis"), d5=d5)
    assert relaxed["ready"] is True
    assert relaxed["label"] == "report_ready"


def test_lifecycle_status_covers_every_branch():
    assert lifecycle_status(None, None, None) == "hypothesis"
    assert lifecycle_status({"verdict": "false_positive"}, None, None) == "false_positive"
    assert lifecycle_status({"verdict": "unverifiable"}, None, None) == "not_advanced"
    assert lifecycle_status({"verdict": "confirmed"}, None, None) == "code_confirmed"
    assert lifecycle_status({"verdict": "plausible_needs_poc"}, None, None) == "code_confirmed"
    d3 = make_d3()

    def status(bug, impact, blocker="none", legacy=False):
        evidence = {"bug_status": bug, "impact_status": impact, "blocker_kind": blocker, "legacy": legacy}
        return lifecycle_status(d3, evidence, None)

    assert status("not_reproduced", "not_proven") == "bug_not_reproduced"
    assert status("falsified", "not_proven") == "bug_falsified"
    assert status("blocked", "not_proven") == "bug_blocked"
    assert status("reproduced", "not_proven") == "bug_proven_impact_unproven"
    assert status("reproduced", "partial") == "impact_partial"
    assert status("reproduced", "falsified") == "impact_falsified"
    assert status("reproduced", "blocked", "missing_configuration") == "impact_blocked_by_configuration"
    assert status("reproduced", "blocked", "deployment_fact") == "impact_blocked_by_deployment_fact"
    assert status("reproduced", "blocked", "missing_dependency") == "impact_blocked"
    assert status("reproduced", "proven") == "impact_proven"
    assert status("reproduced", "unverified", legacy=True) == "legacy_bug_reproduced_impact_unverified"
    assert status("reproduced", "unverified") == "bug_proven_impact_unproven"
    assert lifecycle_status(d3, make_evidence(), {"ready": True}) == "report_ready"
    assert lifecycle_status(d3, make_evidence(), {"ready": False}) == "impact_proven"
    assert set(LIFECYCLE) >= {
        status(bug, impact, blocker)
        for bug in ("reproduced", "not_reproduced", "blocked", "falsified")
        for impact in ("proven", "partial", "not_proven", "blocked", "falsified", "unverified")
        for blocker in ("none", "missing_configuration", "deployment_fact")
    }


def test_lifecycle_block_shape():
    assert lifecycle_block("code_confirmed", POLICY_VERSION, False) == {
        "lifecycle_status": "code_confirmed",
        "policy_version": POLICY_VERSION,
        "legacy": False,
    }

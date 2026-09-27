"""Deterministic evidence-to-impact gate for the v2.7 profile.

Every function here is pure: plain dicts in, plain dicts out, no clock and no I/O.
``evaluated_at`` is supplied by the caller. The model produces the evidence assessment;
this module enforces structure, provenance, consistency, and readiness rules and never
claims to prove the semantic truth of an artifact.
"""

from pathlib import PurePosixPath
from typing import Any

from .readiness_policies import (
    LEGACY_POLICY_VERSION,
    TERMINAL_OUTCOME_DIMENSION,
    UnsupportedPolicyVersion,
    family_dimensions,
    policy_for,
)

D3_PASS_VERDICTS = frozenset({"confirmed", "plausible_needs_poc"})
HOP_STATUSES = ("proven", "falsified", "partial", "unverified", "blocked", "not_applicable")
HOP_ASSESSMENT_REQUIRED = frozenset({"not_applicable", "falsified", "partial", "blocked"})
BUG_STATUSES = ("reproduced", "not_reproduced", "blocked", "falsified")
IMPACT_STATUSES = ("proven", "partial", "not_proven", "blocked", "falsified", "unverified")
BUG_REPRODUCED = "reproduced"
IMPACT_PROVEN = "proven"
IMPACT_UNVERIFIED = "unverified"
D5_ELIGIBLE_IMPACT_STATUSES = ("proven", "partial", "not_proven")
LIFECYCLE = (
    "hypothesis",
    "false_positive",
    "not_advanced",
    "code_confirmed",
    "bug_not_reproduced",
    "bug_falsified",
    "bug_blocked",
    "bug_proven_impact_unproven",
    "impact_partial",
    "impact_falsified",
    "impact_blocked_by_configuration",
    "impact_blocked_by_deployment_fact",
    "impact_blocked",
    "impact_proven",
    "report_ready",
    "legacy_bug_reproduced_impact_unverified",
)
READINESS_CHECKS = (
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
LEGACY_REASON = (
    "Investigation kind and readiness policy were not explicitly selected when this legacy scan was created."
)
DEFAULT_LABEL = "report_ready"
_LEGACY_POC_STATUS_TO_BUG = {"reproduced": "reproduced", "blocked": "blocked", "falsified": "falsified"}


def _text(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _rows(value: Any) -> list[dict[str, Any]]:
    return [row for row in value if isinstance(row, dict)] if isinstance(value, list) else []


def _strings(value: Any) -> list[str]:
    return [item for item in value if isinstance(item, str)] if isinstance(value, list) else []


def normalize_evidence_path(raw: Any) -> str | None:
    """Return the canonical artifact-relative form of ``raw`` or None when it is not acceptable."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    path = PurePosixPath(raw.strip().replace("\\", "/"))
    if path.is_absolute() or ".." in path.parts:
        return None
    parts = [part for part in path.parts if part not in ("", ".")]
    if not parts:
        return None
    return "/".join(parts)


def declared_evidence_paths(d4: dict[str, Any]) -> list[str]:
    """Deduplicated union of PoC paths, impact paths, and every hop's evidence paths (declaration order)."""
    ordered: list[str] = []
    seen: set[str] = set()

    def add(raw: Any):
        if not isinstance(raw, str) or not raw.strip():
            return
        key = normalize_evidence_path(raw) or raw.strip()
        if key not in seen:
            seen.add(key)
            ordered.append(raw.strip())

    for raw in _strings(d4.get("poc_artifact_paths")):
        add(raw)
    for raw in _strings(d4.get("impact_artifact_paths")):
        add(raw)
    for row in _rows(d4.get("impact_chain")):
        for raw in _strings(row.get("evidence_paths")):
            add(raw)
    return ordered


def investigation_settings(scan: dict[str, Any]) -> dict[str, Any]:
    configuration = _dict(_dict(scan).get("configuration"))
    kind = _text(configuration.get("investigation_kind"))
    source = _text(configuration.get("investigation_kind_source"))
    version = _text(configuration.get("readiness_policy_version"))
    if not kind or not version:
        return {
            "investigation_kind": "internal_research",
            "investigation_kind_source": "legacy_default",
            "readiness_policy_version": LEGACY_POLICY_VERSION,
            "legacy": True,
        }
    return {
        "investigation_kind": kind,
        "investigation_kind_source": source or "legacy_default",
        "readiness_policy_version": version,
        "legacy": source != "user",
    }


def normalize_missing_requirements(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return list(value)
    raise ValueError("missing_requirements must be a string or an array of strings")


def lifecycle_status(
    d3: dict[str, Any] | None, evidence: dict[str, Any] | None, readiness: dict[str, Any] | None
) -> str:
    if isinstance(readiness, dict) and readiness.get("ready") is True:
        return "report_ready"
    if isinstance(evidence, dict) and evidence:
        bug = evidence.get("bug_status")
        if bug != BUG_REPRODUCED:
            return {"not_reproduced": "bug_not_reproduced", "falsified": "bug_falsified"}.get(bug, "bug_blocked")
        impact = evidence.get("impact_status")
        if impact == IMPACT_PROVEN:
            return "impact_proven"
        if impact == "partial":
            return "impact_partial"
        if impact == "falsified":
            return "impact_falsified"
        if impact == "blocked":
            blocker = evidence.get("blocker_kind")
            if blocker == "missing_configuration":
                return "impact_blocked_by_configuration"
            if blocker == "deployment_fact":
                return "impact_blocked_by_deployment_fact"
            return "impact_blocked"
        if impact == IMPACT_UNVERIFIED and evidence.get("legacy") is True:
            return "legacy_bug_reproduced_impact_unverified"
        return "bug_proven_impact_unproven"
    if not isinstance(d3, dict):
        return "hypothesis"
    verdict = d3.get("verdict")
    if verdict in D3_PASS_VERDICTS:
        return "code_confirmed"
    if verdict == "false_positive":
        return "false_positive"
    return "not_advanced"


def lifecycle_block(status: str, policy_version: str, legacy: bool) -> dict[str, Any]:
    return {"lifecycle_status": status, "policy_version": policy_version, "legacy": bool(legacy)}


def evidence_block(
    d4: dict[str, Any],
    manifest_names: set[str] | None,
    *,
    capture_complete: bool,
    artifact_dir: str,
    policy_version: str,
    legacy: bool,
) -> dict[str, Any]:
    d4 = _dict(d4)
    bug_status = d4.get("bug_status")
    if bug_status not in BUG_STATUSES:
        bug_status = _LEGACY_POC_STATUS_TO_BUG.get(str(d4.get("poc_status") or ""), "not_reproduced")
    impact_status = d4.get("impact_status")
    if impact_status not in IMPACT_STATUSES:
        impact_status = IMPACT_UNVERIFIED
    artifact_dir = _text(artifact_dir)
    complete = bool(capture_complete) and bool(artifact_dir)
    if bug_status == BUG_REPRODUCED and not complete and impact_status in D5_ELIGIBLE_IMPACT_STATUSES:
        impact_status = "blocked"
    captured_names = {normalize_evidence_path(name) for name in (manifest_names or set())} - {None}
    captured: list[str] = []
    unresolved: list[str] = []
    for raw in declared_evidence_paths(d4):
        normalized = normalize_evidence_path(raw)
        if normalized is not None and normalized in captured_names:
            captured.append(normalized)
        else:
            unresolved.append(raw)
    block = {
        "bug_status": bug_status,
        "impact_status": impact_status,
        "blocker_kind": _text(d4.get("blocker_kind")) or "none",
        "artifact_dir": artifact_dir,
        "captured_paths": captured,
        "unresolved_paths": unresolved,
        "capture_complete": complete,
        "lifecycle_status": "",
        "policy_version": policy_version,
        "legacy": bool(legacy),
    }
    block["lifecycle_status"] = lifecycle_status(None, block, None)
    return block


def d5_eligible(evidence: dict[str, Any] | None) -> bool:
    evidence = _dict(evidence)
    return (
        evidence.get("bug_status") == BUG_REPRODUCED
        and bool(_text(evidence.get("artifact_dir")))
        and evidence.get("capture_complete") is True
        and evidence.get("impact_status") in D5_ELIGIBLE_IMPACT_STATUSES
    )


def _hop_ids(hops: list[dict[str, Any]]) -> list[str]:
    return [_text(row.get("id")) for row in hops]


def chain_reasons(plan_hops: list, chain_hops: list) -> list[str]:
    """Spec 6.6 rule 5 plus the per-hop status/assessment/evidence rules from 5.1."""
    reasons: list[str] = []
    plan = _rows(plan_hops)
    chain = _rows(chain_hops)
    plan_ids = _hop_ids(plan)
    chain_ids = _hop_ids(chain)
    if len(set(plan_ids)) != len(plan_ids):
        reasons.append("D3 impact chain plan hop ids are not unique.")
    if len(set(chain_ids)) != len(chain_ids):
        reasons.append("D4 impact chain hop ids are not unique.")
    for hop_id in plan_ids:
        if hop_id and hop_id not in chain_ids:
            reasons.append(
                f"D3 plan hop '{hop_id}' is missing from the D4 impact chain; hops may not be renamed or dropped."
            )
    for row in chain:
        hop_id = _text(row.get("id"))
        if not hop_id:
            reasons.append("D4 impact chain contains a hop without an id.")
            continue
        status = row.get("status")
        if status not in HOP_STATUSES:
            reasons.append(f"Hop '{hop_id}' has an unknown status '{status}'.")
            continue
        if status not in ("proven", "not_applicable"):
            reasons.append(f"Hop '{hop_id}' is '{status}', not proven.")
        if status in HOP_ASSESSMENT_REQUIRED and not _text(row.get("assessment")):
            reasons.append(f"Hop '{hop_id}' is '{status}' but carries no assessment.")
        if status == "proven" and not [p for p in _strings(row.get("evidence_paths")) if p.strip()]:
            reasons.append(f"Hop '{hop_id}' is proven without any evidence path.")
    return reasons


def provenance_reasons(paths: list[str], captured: set[str]) -> list[str]:
    """Spec 6.6 rule 6: every path must resolve to a captured artifact of the D4 artifact directory."""
    reasons: list[str] = []
    captured_names = {normalize_evidence_path(name) for name in captured} - {None}
    for raw in paths:
        normalized = normalize_evidence_path(raw)
        if normalized is None:
            reason = f"Evidence path {raw!r} is not a relative artifact path."
        elif normalized not in captured_names:
            reason = f"Evidence path '{normalized}' is not in the D4 artifact manifest."
        else:
            continue
        if reason not in reasons:
            reasons.append(reason)
    return reasons


def dimension_reasons(dimensions: list, family: str, chain_hops: list, version: str) -> list[str]:
    """Spec 6.6 rule 7. Raises UnsupportedPolicyVersion for an unknown policy version."""
    try:
        allowed = family_dimensions(version, family)
    except UnsupportedPolicyVersion:
        raise
    except ValueError as exc:
        return [str(exc)]
    reasons: list[str] = []
    covered: set[str] = set()
    for row in _rows(chain_hops):
        if row.get("status") == "proven":
            covered.update(tag for tag in _strings(row.get("covers")))
    resolved: dict[str, dict[str, Any]] = {}
    for row in _rows(dimensions):
        tag = _text(row.get("tag"))
        if tag not in allowed:
            reasons.append(f"Evidence dimension '{tag}' is not part of the '{family}' family table.")
            continue
        resolved[tag] = row
        status = row.get("status")
        if status == "required":
            if tag not in covered:
                reasons.append(f"Required evidence dimension '{tag}' is not covered by any proven hop.")
        elif status == "not_applicable":
            if tag == TERMINAL_OUTCOME_DIMENSION:
                reasons.append("The terminal_outcome dimension can never be not_applicable.")
            if not _text(row.get("rationale")):
                reasons.append(f"Evidence dimension '{tag}' is not_applicable without a rationale.")
        else:
            reasons.append(f"Evidence dimension '{tag}' has an unknown status '{status}'.")
    for tag in allowed:
        if tag not in resolved:
            reasons.append(f"Evidence dimension '{tag}' was not resolved by D3.")
    return reasons


def _material_open_assumptions(d3: dict[str, Any], d4: dict[str, Any]) -> list[str]:
    merged: dict[str, dict[str, Any]] = {}
    for index, row in enumerate([*_rows(d3.get("unverified_assumptions")), *_rows(d4.get("unverified_assumptions"))]):
        merged[_text(row.get("id")) or f"#{index}"] = row
    return [key for key, row in merged.items() if row.get("material") is True and row.get("status") == "open"]


def evaluate_readiness(
    *,
    scan: dict[str, Any],
    d3: dict[str, Any] | None,
    d4: dict[str, Any] | None,
    evidence: dict[str, Any] | None,
    d5: dict[str, Any] | None,
    evaluated_at: str,
) -> dict[str, Any]:
    settings = investigation_settings(scan)
    version = settings["readiness_policy_version"]
    kind = settings["investigation_kind"]
    d3 = _dict(d3)
    d4 = _dict(d4)
    d5 = _dict(d5)
    evidence = _dict(evidence)
    checks: dict[str, list[str]] = {name: [] for name in READINESS_CHECKS}

    policy = None
    try:
        policy = policy_for(version, kind)
    except UnsupportedPolicyVersion:
        checks["policy_version_supported"].append(
            f"Readiness policy version '{version}' is not supported by this engine; no policy fallback is applied."
        )
    except ValueError:
        checks["investigation_kind_explicit"].append(f"Investigation kind '{kind}' is not a known policy row.")

    if settings["legacy"] or settings["investigation_kind_source"] != "user":
        checks["investigation_kind_explicit"].append(LEGACY_REASON)

    # rule 3
    objective = _dict(d3.get("impact_objective"))
    if d3.get("verdict") not in D3_PASS_VERDICTS:
        checks["d3_defined"].append(f"D3 verdict '{d3.get('verdict')}' does not support a proof target.")
    if d3.get("impact_definition_status") != "defined":
        checks["d3_defined"].append(
            f"D3 impact definition status is '{d3.get('impact_definition_status')}', not 'defined'."
        )
    if not _text(objective.get("claim")):
        checks["d3_defined"].append("D3 impact objective has no claim.")
    if not _text(objective.get("terminal_outcome")):
        checks["d3_defined"].append("D3 impact objective has no terminal outcome.")
    if not [item for item in _strings(objective.get("required_evidence")) if item.strip()]:
        checks["d3_defined"].append("D3 impact objective lists no required evidence.")
    source_type = _text(objective.get("source_type"))
    if policy is not None and source_type not in policy.allowed_sources:
        checks["d3_defined"].append(
            f"Objective source '{source_type or 'missing'}' is not allowed for investigation kind '{kind}'"
            f" (allowed: {', '.join(sorted(policy.allowed_sources))})."
        )

    # rule 4
    bug_status = evidence.get("bug_status", d4.get("bug_status"))
    impact_status = evidence.get("impact_status", d4.get("impact_status"))
    if bug_status != BUG_REPRODUCED:
        checks["d4_bug_and_impact"].append(f"D4 bug status is '{bug_status}', not 'reproduced'.")
    if impact_status != IMPACT_PROVEN:
        checks["d4_bug_and_impact"].append(f"D4 impact status is '{impact_status}', not 'proven'.")
    if not _text(d4.get("observed_terminal_outcome")):
        checks["d4_bug_and_impact"].append("D4 recorded no observed terminal outcome.")
    if d4.get("negative_control_status") != "passed":
        checks["d4_bug_and_impact"].append(
            f"D4 negative control status is '{d4.get('negative_control_status')}', not 'passed'."
        )
    repeatability = d4.get("repeatability_status")
    allowed_repeatability = {"deterministic"}
    if policy is not None and policy.allows_probabilistic:
        allowed_repeatability.add("non_deterministic")
    if repeatability not in allowed_repeatability:
        checks["d4_bug_and_impact"].append(
            f"D4 repeatability status is '{repeatability}', not {' or '.join(sorted(allowed_repeatability))}."
        )

    # rule 5
    chain = _rows(d4.get("impact_chain"))
    checks["chain_complete"].extend(chain_reasons(_rows(d3.get("impact_chain_plan")), chain))
    if not chain:
        checks["chain_complete"].append("D4 recorded no impact chain.")
    missing_links = [link for link in _strings(d4.get("missing_impact_links")) if link.strip()]
    if missing_links:
        checks["chain_complete"].append("D4 reports missing impact links: " + ", ".join(missing_links) + ".")
    for assumption_id in _material_open_assumptions(d3, d4):
        checks["chain_complete"].append(f"Material assumption '{assumption_id}' is still open.")

    # rule 6
    if evidence.get("capture_complete") is not True:
        checks["provenance"].append("D4 artifact capture is incomplete.")
    evidence_paths: list[str] = []
    for row in chain:
        evidence_paths.extend(_strings(row.get("evidence_paths")))
    for row in _rows(d5.get("impact_mapping")):
        evidence_paths.extend(_strings(row.get("evidence_paths")))
    checks["provenance"].extend(provenance_reasons(evidence_paths, set(_strings(evidence.get("captured_paths")))))

    # rule 7
    if policy is None:
        checks["dimension_coverage"].append("Evidence dimensions cannot be verified without a supported policy.")
    else:
        checks["dimension_coverage"].extend(
            dimension_reasons(_rows(d3.get("evidence_dimensions")), _text(d3.get("impact_family")), chain, version)
        )

    # rule 8
    if d5.get("impact_match_status") != "exact":
        checks["d5_match"].append(f"D5 impact match status is '{d5.get('impact_match_status')}', not 'exact'.")
    if d5.get("impact_evidence_status") != "verified":
        checks["d5_match"].append(f"D5 impact evidence status is '{d5.get('impact_evidence_status')}', not 'verified'.")
    mapping = _rows(d5.get("impact_mapping"))
    if not mapping:
        checks["d5_match"].append("D5 recorded no required-versus-observed impact mapping.")
    for index, row in enumerate(mapping):
        if row.get("status") != "proven":
            checks["d5_match"].append(
                f"D5 impact mapping entry {index + 1} ('{_text(row.get('required_outcome'))}') is "
                f"'{row.get('status')}', not 'proven'."
            )
    artifact_dir = _text(evidence.get("artifact_dir"))
    if not artifact_dir or _text(d5.get("artifact_reference")) != artifact_dir:
        checks["d5_match"].append("D5 artifact reference does not equal the D4 artifact directory.")
    try:
        missing_requirements = normalize_missing_requirements(d5.get("missing_requirements"))
    except ValueError as exc:
        checks["d5_match"].append(f"D5 missing_requirements is malformed: {exc}.")
    else:
        if missing_requirements:
            checks["d5_match"].append("D5 lists missing requirements: " + "; ".join(missing_requirements) + ".")

    # rule 9
    if policy is not None:
        if policy.requires_scope and (
            d5.get("scope_status") != "in_scope_verified" or not _text(d5.get("scope_evidence"))
        ):
            checks["scope_and_novelty"].append("Scope is not verified with evidence for this investigation kind.")
        if policy.requires_novelty and (
            d5.get("novelty_status") != "novel_verified" or not _text(d5.get("novelty_evidence"))
        ):
            checks["scope_and_novelty"].append("Novelty is not verified with evidence for this investigation kind.")

    ready = all(not reasons for reasons in checks.values())
    blocking_reasons: list[str] = []
    for reasons in checks.values():
        for reason in reasons:
            if reason not in blocking_reasons:
                blocking_reasons.append(reason)
    readiness = {
        "ready": ready,
        "label": policy.label if policy is not None else DEFAULT_LABEL,
        "lifecycle_status": "",
        "blocking_reasons": blocking_reasons,
        "checks": {name: "fail" if reasons else "pass" for name, reasons in checks.items()},
        "policy": kind,
        "policy_version": version,
        "evaluated_at": evaluated_at,
        "legacy": False,
    }
    readiness["lifecycle_status"] = lifecycle_status(d3, evidence or None, readiness)
    return readiness


def synthesize_legacy_blocks(scan: dict[str, Any], stage: str, result: dict[str, Any]) -> dict[str, Any]:
    """Read-time engine blocks for historical enrichment rows (``legacy: True``); never persisted."""
    settings = investigation_settings(scan)
    version = settings["readiness_policy_version"]
    result = _dict(result)
    if stage == "d3":
        return {"_engine_lifecycle": lifecycle_block(lifecycle_status(result, None, None), version, True)}
    if stage == "d4":
        artifact_dir = _text(result.get("poc_artifact_dir"))
        return {
            "_engine_evidence": evidence_block(
                result,
                None,
                capture_complete=bool(artifact_dir),
                artifact_dir=artifact_dir,
                policy_version=version,
                legacy=True,
            )
        }
    if stage == "d5":
        label = DEFAULT_LABEL
        if not settings["legacy"]:
            try:
                label = policy_for(version, settings["investigation_kind"]).label
            except ValueError:
                label = DEFAULT_LABEL
        status = "legacy_bug_reproduced_impact_unverified"
        return {
            "_engine_readiness": {
                "ready": False,
                "label": label,
                "lifecycle_status": status,
                "blocking_reasons": [LEGACY_REASON],
                "checks": {name: "fail" for name in READINESS_CHECKS},
                "policy": settings["investigation_kind"],
                "policy_version": version,
                "evaluated_at": None,
                "legacy": True,
            },
            "model_readiness_claim": result.get("submission_ready") is True,
            "_chip_lifecycle": status,
        }
    raise ValueError(f"unknown v2.7 stage: {stage!r}")

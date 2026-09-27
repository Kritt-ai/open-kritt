"""Conditional post-processing gates for the versioned v2.7 scan profile."""

from typing import Any

from .impact_gate import (
    BUG_REPRODUCED,
    D3_PASS_VERDICTS,
    D5_ELIGIBLE_IMPACT_STATUSES,
    d5_eligible,
)

__all__ = [
    "D3_PASS_VERDICTS",
    "d4_eligibility_sql",
    "d5_eligibility_sql",
    "eligible_for_stage",
    "pipeline_ids",
    "preceding_results",
    "prior_results",
    "stage_for_script",
]


def pipeline_ids(scan: dict[str, Any]) -> dict[str, int]:
    configuration = scan.get("configuration")
    raw = configuration.get("v27_pipeline") if isinstance(configuration, dict) else None
    if not isinstance(raw, dict):
        return {}
    try:
        ids = {stage: int(raw[stage]) for stage in ("d3", "d4", "d5")}
    except (KeyError, TypeError, ValueError):
        return {}
    if any(value <= 0 for value in ids.values()) or len(set(ids.values())) != 3:
        return {}
    return ids


def stage_for_script(scan: dict[str, Any], script_id: int) -> str | None:
    return next((stage for stage, value in pipeline_ids(scan).items() if value == script_id), None)


def prior_results(rows: list[dict[str, Any]]) -> dict[int, dict[str, Any]]:
    return {
        int(row["post_script_id"]): row["result"]
        for row in rows
        if isinstance(row.get("result"), dict) and not row.get("stub")
    }


def eligible_for_stage(scan: dict[str, Any], script_id: int, results: dict[int, dict[str, Any]]) -> bool:
    stage = stage_for_script(scan, script_id)
    if stage in (None, "d3"):
        return True
    ids = pipeline_ids(scan)
    if stage == "d4":
        return results.get(ids["d3"], {}).get("verdict") in D3_PASS_VERDICTS
    if stage == "d5":
        d4 = results.get(ids["d4"], {})
        return d5_eligible(d4.get("_engine_evidence"))
    return False


def preceding_results(scan: dict[str, Any], script_id: int, results: dict[int, dict[str, Any]]) -> dict[str, Any]:
    stage = stage_for_script(scan, script_id)
    ids = pipeline_ids(scan)
    if stage == "d4":
        return {"d3": results.get(ids["d3"], {})}
    if stage == "d5":
        return {"d3": results.get(ids["d3"], {}), "d4": results.get(ids["d4"], {})}
    return {}


def _sql_list(values) -> str:
    return "(" + ", ".join(f"'{value}'" for value in values) + ")"


def d4_eligibility_sql(result_column: str = "prior.result") -> str:
    """SQL predicate over a D3 enrichment row's result column (constants only, no bind parameters)."""
    verdicts = _sql_list(sorted(D3_PASS_VERDICTS))
    return f"{result_column}->>'verdict' IN {verdicts}"


def d5_eligibility_sql(result_column: str = "prior.result") -> str:
    """SQL predicate over a D4 enrichment row's result column, mirroring ``impact_gate.d5_eligible``."""
    evidence = f"{result_column}->'_engine_evidence'"
    return (
        f"{evidence}->>'bug_status' = '{BUG_REPRODUCED}'"
        f" AND {evidence}->>'impact_status' IN {_sql_list(D5_ELIGIBLE_IMPACT_STATUSES)}"
        f" AND {evidence}->>'capture_complete' = 'true'"
        f" AND COALESCE({evidence}->>'artifact_dir', '') <> ''"
    )

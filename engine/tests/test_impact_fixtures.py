"""Cross-family fixtures (spec section 9): each JSON file carries its expected lifecycle and readiness."""

import json
from pathlib import Path

import pytest

from open_kritt_engine.impact_gate import LIFECYCLE, d5_eligible, evaluate_readiness, evidence_block, lifecycle_status
from open_kritt_engine.readiness_policies import IMPACT_FAMILIES, INVESTIGATION_KINDS

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "impact"
FIXTURE_PATHS = sorted(FIXTURE_DIR.glob("*.json"))
EVALUATED_AT = "2026-09-24T12:00:00+00:00"


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def test_ten_fixtures_cover_multiple_families_and_every_investigation_kind():
    fixtures = [load(path) for path in FIXTURE_PATHS]
    assert len(fixtures) == 10
    families = {fixture["d3"]["impact_family"] for fixture in fixtures}
    assert len(families) >= 6 and families <= set(IMPACT_FAMILIES)
    kinds = {fixture["scan"]["configuration"]["investigation_kind"] for fixture in fixtures}
    assert kinds == set(INVESTIGATION_KINDS)
    assert {fixture["expected"]["ready"] for fixture in fixtures} == {True, False}


@pytest.mark.parametrize("path", FIXTURE_PATHS, ids=[path.stem for path in FIXTURE_PATHS])
def test_fixture_lifecycle_and_readiness(path):
    fixture = load(path)
    manifest = fixture["manifest"]
    evidence = evidence_block(
        fixture["d4"],
        set(manifest["files"]),
        capture_complete=manifest["capture_complete"],
        artifact_dir=manifest["artifact_dir"],
        policy_version=fixture["scan"]["configuration"]["readiness_policy_version"],
        legacy=False,
    )
    assert evidence["unresolved_paths"] == [], evidence["unresolved_paths"]
    expected = fixture["expected"]
    if fixture["d5"] is None:
        assert not d5_eligible(evidence)
        assert lifecycle_status(fixture["d3"], evidence, None) == expected["lifecycle_status"]
        readiness = evaluate_readiness(
            scan=fixture["scan"],
            d3=fixture["d3"],
            d4=fixture["d4"],
            evidence=evidence,
            d5=None,
            evaluated_at=EVALUATED_AT,
        )
        assert readiness["ready"] is False and expected["ready"] is False
        return
    assert d5_eligible(evidence)
    readiness = evaluate_readiness(
        scan=fixture["scan"],
        d3=fixture["d3"],
        d4=fixture["d4"],
        evidence=evidence,
        d5=fixture["d5"],
        evaluated_at=EVALUATED_AT,
    )
    assert readiness["ready"] is expected["ready"], readiness["blocking_reasons"]
    assert readiness["lifecycle_status"] == expected["lifecycle_status"]
    assert readiness["lifecycle_status"] in LIFECYCLE
    assert lifecycle_status(fixture["d3"], evidence, readiness) == expected["lifecycle_status"]
    if not expected["ready"]:
        assert readiness["blocking_reasons"]

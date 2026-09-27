import pytest

from open_kritt_engine.readiness_policies import (
    IMPACT_FAMILIES,
    INVESTIGATION_KINDS,
    LEGACY_POLICY_VERSION,
    OBJECTIVE_SOURCES,
    POLICY_VERSION,
    InvestigationPolicy,
    UnsupportedPolicyVersion,
    family_dimensions,
    policy_for,
)

KIND_ROWS = {
    "public_bounty": ({"bounty_rule"}, True, True, False, "submission_ready"),
    "audit_competition": ({"audit_spec", "engagement_scope"}, True, True, False, "submission_ready"),
    "private_audit": (
        {"audit_spec", "engagement_scope", "threat_model", "researcher_hypothesis"},
        True,
        False,
        False,
        "report_ready",
    ),
    "threat_model_validation": ({"threat_model", "engagement_scope"}, False, False, False, "report_ready"),
    "internal_research": (
        {"threat_model", "researcher_hypothesis", "engagement_scope"},
        False,
        False,
        False,
        "report_ready",
    ),
}

FAMILY_ROWS = {
    "unauthorized_action": ("initial_actor", "permission_boundary", "protected_operation", "unauthorized_result"),
    "funds_loss": ("balance_before", "balance_after", "asset_ownership", "net_change", "recipient_control"),
    "availability_loss": ("attacker_workload", "measurable_degradation", "duration", "affected_component", "recovery"),
    "resource_exhaustion": (
        "pool_size",
        "attacker_cost_per_iteration",
        "iterations_required",
        "replenishment",
        "recovery",
    ),
    "consensus_failure": ("conflicting_state", "halt_or_divergence", "affected_participants", "recovery_requirements"),
    "integrity_violation": (
        "trusted_value_before",
        "trusted_value_after",
        "unauthorized_mutation",
        "downstream_consumer",
    ),
    "confidentiality_loss": ("protected_data", "unauthorized_actor", "disclosure_boundary"),
    "privilege_escalation": ("initial_role", "acquired_capability", "protected_operation"),
    "temporary_freezing": ("affected_value", "duration", "release_conditions", "recovery_path"),
    "permanent_freezing": ("affected_value", "irrecoverability_under_recovery_model"),
    "other": (),
}


def test_constants_match_the_spec():
    assert POLICY_VERSION == "v2.7-impact-gate-1"
    assert LEGACY_POLICY_VERSION == "legacy-unverified"
    assert INVESTIGATION_KINDS == tuple(KIND_ROWS)
    assert OBJECTIVE_SOURCES == (
        "bounty_rule",
        "audit_spec",
        "threat_model",
        "engagement_scope",
        "researcher_hypothesis",
    )
    assert IMPACT_FAMILIES == tuple(FAMILY_ROWS)


@pytest.mark.parametrize("kind", list(KIND_ROWS))
def test_every_investigation_kind_row(kind):
    sources, scope, novelty, probabilistic, label = KIND_ROWS[kind]
    policy = policy_for(POLICY_VERSION, kind)
    assert isinstance(policy, InvestigationPolicy)
    assert policy.kind == kind
    assert policy.allowed_sources == frozenset(sources)
    assert policy.requires_scope is scope
    assert policy.requires_novelty is novelty
    assert policy.allows_probabilistic is probabilistic
    assert policy.label == label


@pytest.mark.parametrize("family", list(FAMILY_ROWS))
def test_every_family_row_always_includes_terminal_outcome(family):
    dimensions = family_dimensions(POLICY_VERSION, family)
    assert dimensions == (*FAMILY_ROWS[family], "terminal_outcome")
    assert len(set(dimensions)) == len(dimensions)


def test_unknown_version_kind_and_family_are_rejected():
    with pytest.raises(UnsupportedPolicyVersion):
        policy_for("v2.8-impact-gate-1", "public_bounty")
    with pytest.raises(UnsupportedPolicyVersion):
        policy_for(LEGACY_POLICY_VERSION, "internal_research")
    with pytest.raises(UnsupportedPolicyVersion):
        family_dimensions("nope", "funds_loss")
    with pytest.raises(ValueError, match="investigation kind"):
        policy_for(POLICY_VERSION, "bug_bash")
    with pytest.raises(ValueError, match="impact family"):
        family_dimensions(POLICY_VERSION, "money")
    assert issubclass(UnsupportedPolicyVersion, ValueError)

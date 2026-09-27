"""Versioned readiness policy tables keyed by ``readiness_policy_version``.

Tables are frozen per policy version. Unknown versions never fall through to the
latest policy: callers receive :class:`UnsupportedPolicyVersion` and must block.
"""

from dataclasses import dataclass

POLICY_VERSION = "v2.7-impact-gate-1"
LEGACY_POLICY_VERSION = "legacy-unverified"

INVESTIGATION_KINDS = (
    "public_bounty",
    "audit_competition",
    "private_audit",
    "threat_model_validation",
    "internal_research",
)
OBJECTIVE_SOURCES = ("bounty_rule", "audit_spec", "threat_model", "engagement_scope", "researcher_hypothesis")
IMPACT_FAMILIES = (
    "unauthorized_action",
    "funds_loss",
    "availability_loss",
    "resource_exhaustion",
    "consensus_failure",
    "integrity_violation",
    "confidentiality_loss",
    "privilege_escalation",
    "temporary_freezing",
    "permanent_freezing",
    "other",
)
TERMINAL_OUTCOME_DIMENSION = "terminal_outcome"


@dataclass(frozen=True)
class InvestigationPolicy:
    kind: str
    allowed_sources: frozenset[str]
    requires_scope: bool
    requires_novelty: bool
    allows_probabilistic: bool
    label: str  # "submission_ready" | "report_ready"


class UnsupportedPolicyVersion(ValueError):
    pass


def _policy(kind, sources, *, scope, novelty, probabilistic, label) -> InvestigationPolicy:
    return InvestigationPolicy(
        kind=kind,
        allowed_sources=frozenset(sources),
        requires_scope=scope,
        requires_novelty=novelty,
        allows_probabilistic=probabilistic,
        label=label,
    )


_POLICIES: dict[str, dict[str, InvestigationPolicy]] = {
    POLICY_VERSION: {
        "public_bounty": _policy(
            "public_bounty", ("bounty_rule",), scope=True, novelty=True, probabilistic=False, label="submission_ready"
        ),
        "audit_competition": _policy(
            "audit_competition",
            ("audit_spec", "engagement_scope"),
            scope=True,
            novelty=True,
            probabilistic=False,
            label="submission_ready",
        ),
        "private_audit": _policy(
            "private_audit",
            ("audit_spec", "engagement_scope", "threat_model", "researcher_hypothesis"),
            scope=True,
            novelty=False,
            probabilistic=False,
            label="report_ready",
        ),
        "threat_model_validation": _policy(
            "threat_model_validation",
            ("threat_model", "engagement_scope"),
            scope=False,
            novelty=False,
            probabilistic=False,
            label="report_ready",
        ),
        "internal_research": _policy(
            "internal_research",
            ("threat_model", "researcher_hypothesis", "engagement_scope"),
            scope=False,
            novelty=False,
            probabilistic=False,
            label="report_ready",
        ),
    }
}

_FAMILY_DIMENSIONS: dict[str, dict[str, tuple[str, ...]]] = {
    POLICY_VERSION: {
        "unauthorized_action": ("initial_actor", "permission_boundary", "protected_operation", "unauthorized_result"),
        "funds_loss": ("balance_before", "balance_after", "asset_ownership", "net_change", "recipient_control"),
        "availability_loss": (
            "attacker_workload",
            "measurable_degradation",
            "duration",
            "affected_component",
            "recovery",
        ),
        "resource_exhaustion": (
            "pool_size",
            "attacker_cost_per_iteration",
            "iterations_required",
            "replenishment",
            "recovery",
        ),
        "consensus_failure": (
            "conflicting_state",
            "halt_or_divergence",
            "affected_participants",
            "recovery_requirements",
        ),
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
}


def _table(tables: dict[str, dict], version: str) -> dict:
    try:
        return tables[str(version)]
    except KeyError:
        raise UnsupportedPolicyVersion(f"unsupported readiness policy version: {version!r}") from None


def policy_for(version: str, kind: str) -> InvestigationPolicy:
    policies = _table(_POLICIES, version)
    try:
        return policies[str(kind)]
    except KeyError:
        raise ValueError(f"unknown investigation kind: {kind!r}") from None


def family_dimensions(version: str, family: str) -> tuple[str, ...]:
    families = _table(_FAMILY_DIMENSIONS, version)
    try:
        defaults = families[str(family)]
    except KeyError:
        raise ValueError(f"unknown impact family: {family!r}") from None
    if TERMINAL_OUTCOME_DIMENSION in defaults:
        return defaults
    return (*defaults, TERMINAL_OUTCOME_DIMENSION)

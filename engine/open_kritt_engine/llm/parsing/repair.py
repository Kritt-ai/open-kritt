"""Compatibility facade for deterministic JSON repair."""

from .recovery import RecoveryOrchestrator
from .types import JSONCandidate, RepairResult, StageArtifact


class DeterministicRepairer:
    """Run deterministic repair for callers that use the older repair API.

    New code should prefer ``RecoveryOrchestrator`` because it also returns
    recovery metrics. This class remains exported for backward compatibility.
    """

    def __init__(self, orchestrator: RecoveryOrchestrator | None = None):
        self.orchestrator = orchestrator or RecoveryOrchestrator()

    def repair(self, candidate: JSONCandidate) -> tuple[RepairResult, StageArtifact]:
        """Repair a JSON candidate and return the legacy repair artifact shape."""
        result, _metrics, artifact = self.orchestrator.recover(candidate)
        return result, StageArtifact(
            stage="repair",
            input=artifact.input,
            output=result,
            elapsed_ms=artifact.elapsed_ms,
            errors=artifact.errors,
            warnings=artifact.warnings,
        )

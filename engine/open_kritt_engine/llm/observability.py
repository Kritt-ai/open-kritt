"""Serializable artifacts for inspecting LLM runtime and parser behavior."""

import json
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Any

from .parsing import PipelineResult

if TYPE_CHECKING:
    from .runtime.types import RuntimeDiagnostics


@dataclass(frozen=True)
class LLMExecutionArtifact:
    """Complete debug snapshot for a single LLM execution."""

    prompt: str
    provider_request: dict[str, Any] | None
    raw_response: str
    normalized_response: str | None
    repaired_response: str | None
    validated_object: dict[str, Any] | None
    confidence_score: float
    timings: dict[str, float]
    retry_history: list[dict[str, Any]] = field(default_factory=list)
    provider_diagnostics: dict[str, Any] = field(default_factory=dict)
    runtime_diagnostics: "RuntimeDiagnostics | None" = None
    shadow_comparison: dict[str, Any] | None = None

    def to_json(self) -> str:
        """Serialize the artifact for storage or UI inspection."""
        return json.dumps(asdict(self), indent=2, sort_keys=True)


def artifact_from_pipeline(
    *,
    prompt: str,
    result: PipelineResult,
    provider_request: dict[str, Any] | None = None,
    runtime_diagnostics: "RuntimeDiagnostics | None" = None,
    shadow_comparison: dict[str, Any] | None = None,
) -> LLMExecutionArtifact:
    """Build an execution artifact from a completed pipeline result."""
    return LLMExecutionArtifact(
        prompt=prompt,
        provider_request=provider_request,
        raw_response=result.raw_response.raw_text or result.raw_response.stdout,
        normalized_response=result.normalized.text if result.normalized is not None else None,
        repaired_response=result.repaired_json,
        validated_object=result.validated_object,
        confidence_score=result.confidence.score,
        timings=_aggregate_timings(result.stage_artifacts),
        provider_diagnostics={"provider_id": result.raw_response.provider_id, "adapter_id": result.raw_response.adapter_id},
        runtime_diagnostics=runtime_diagnostics,
        shadow_comparison=shadow_comparison,
    )


def _aggregate_timings(stage_artifacts) -> dict[str, float]:
    timings: dict[str, float] = {}
    for artifact in stage_artifacts:
        timings[artifact.stage] = round(timings.get(artifact.stage, 0.0) + artifact.elapsed_ms, 3)
    return timings

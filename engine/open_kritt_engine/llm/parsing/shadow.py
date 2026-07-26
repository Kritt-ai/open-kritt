from dataclasses import dataclass
from typing import Any

from ..types import RawLLMResponse
from .pipeline import UniversalResponsePipeline
from .types import PipelineResult, StageArtifact


@dataclass(frozen=True)
class ShadowComparison:
    legacy_payload: dict[str, Any] | None
    pipeline_result: PipelineResult
    equivalent: bool
    differences: tuple[str, ...]
    artifact: StageArtifact


class ShadowPipelineComparator:
    def __init__(self, pipeline: UniversalResponsePipeline | None = None):
        self.pipeline = pipeline or UniversalResponsePipeline()

    def compare(
        self,
        *,
        legacy_payload: dict[str, Any] | None,
        raw_response: RawLLMResponse,
        schema: dict[str, Any] | None,
    ) -> ShadowComparison:
        result = self.pipeline.run(raw_response, schema)
        differences = _differences(legacy_payload, result.validated_object)
        return ShadowComparison(
            legacy_payload=legacy_payload,
            pipeline_result=result,
            equivalent=not differences,
            differences=tuple(differences),
            artifact=StageArtifact(
                stage="shadow",
                input={"legacy_payload": legacy_payload, "raw_response": raw_response},
                output={"pipeline_valid": result.valid, "differences": tuple(differences)},
                elapsed_ms=sum(artifact.elapsed_ms for artifact in result.stage_artifacts),
                warnings=tuple(differences),
            ),
        )


def _differences(legacy_payload: dict[str, Any] | None, pipeline_payload: dict[str, Any] | None) -> list[str]:
    if legacy_payload is None and pipeline_payload is None:
        return []
    if legacy_payload is None:
        return ["legacy_missing_pipeline_valid"]
    if pipeline_payload is None:
        return ["pipeline_missing_legacy_valid"]
    if legacy_payload != pipeline_payload:
        return ["payload_mismatch"]
    return []


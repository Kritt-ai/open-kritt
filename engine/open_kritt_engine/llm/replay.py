import json
from dataclasses import asdict, dataclass

from .parsing import UniversalResponsePipeline
from .types import RawLLMResponse


@dataclass(frozen=True)
class ReplayResult:
    pipeline_version: str
    valid: bool
    confidence: float
    selected_candidate_source: str | None
    recovery_count: int
    validation_errors: tuple[str, ...]


@dataclass(frozen=True)
class ReplayReport:
    output_id: str
    results: tuple[ReplayResult, ...]

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, sort_keys=True)


def replay_output(
    *,
    output_id: str,
    raw_output: str,
    schema: dict,
    pipelines: dict[str, UniversalResponsePipeline] | None = None,
) -> ReplayReport:
    selected = pipelines or {"current": UniversalResponsePipeline()}
    results = []
    for version, pipeline in selected.items():
        result = pipeline.run(
            RawLLMResponse(
                provider_id="replay",
                adapter_id="replay",
                model="replay",
                status="completed",
                raw_text=raw_output,
            ),
            schema,
        )
        results.append(
            ReplayResult(
                pipeline_version=version,
                valid=result.valid,
                confidence=result.confidence.score,
                selected_candidate_source=result.selected_candidate.source if result.selected_candidate else None,
                recovery_count=result.recovery_metrics.total_repair_count,
                validation_errors=tuple(f"{issue.path}: {issue.message}" for issue in result.validation_issues),
            )
        )
    return ReplayReport(output_id=output_id, results=tuple(results))


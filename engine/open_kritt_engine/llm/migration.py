import json
import logging
import os
from dataclasses import asdict, dataclass, field
from enum import Enum
from typing import Any

from .parsing import ShadowPipelineComparator
from .types import RawLLMResponse

LOGGER = logging.getLogger("open_kritt_engine")


class ProviderExecutionMode(str, Enum):
    LEGACY = "LEGACY"
    SHADOW = "SHADOW"
    HYBRID = "HYBRID"
    FULL = "FULL"


@dataclass(frozen=True)
class RuntimeMigrationFlags:
    use_new_runtime: bool = False
    use_new_parser: bool = False
    use_shadow_pipeline: bool = False
    use_runtime_only: bool = False
    use_full_provider_pipeline: bool = False
    execution_mode: ProviderExecutionMode = ProviderExecutionMode.LEGACY


@dataclass(frozen=True)
class RuntimeComparisonMetrics:
    provider_id: str
    adapter_id: str
    equivalent: bool
    legacy_valid: bool
    pipeline_valid: bool
    confidence: float
    recovery_source: str | None
    recovery_count: int
    old_latency_ms: float | None = None
    new_latency_ms: float | None = None
    differences: tuple[str, ...] = ()
    validation_errors: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    metadata: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True)


def runtime_migration_flags(provider_id: str, env: dict[str, str] | None = None) -> RuntimeMigrationFlags:
    source = os.environ if env is None else env
    mode = _execution_mode(source, provider_id)
    return RuntimeMigrationFlags(
        use_new_runtime=_flag(source, provider_id, "USE_NEW_RUNTIME"),
        use_new_parser=_flag(source, provider_id, "USE_NEW_PARSER"),
        use_shadow_pipeline=_flag(source, provider_id, "USE_SHADOW_PIPELINE"),
        use_runtime_only=_flag(source, provider_id, "USE_RUNTIME_ONLY"),
        use_full_provider_pipeline=_flag(source, provider_id, "USE_FULL_PROVIDER_PIPELINE"),
        execution_mode=mode,
    )


def compare_legacy_to_new_parser(
    *,
    provider_id: str,
    adapter_id: str,
    legacy_payload: dict[str, Any] | None,
    raw_response: RawLLMResponse,
    schema: dict[str, Any] | None,
    old_latency_ms: float | None = None,
    metadata: dict[str, Any] | None = None,
) -> RuntimeComparisonMetrics:
    comparison = ShadowPipelineComparator().compare(
        legacy_payload=legacy_payload,
        raw_response=raw_response,
        schema=schema,
    )
    result = comparison.pipeline_result
    metrics = RuntimeComparisonMetrics(
        provider_id=provider_id,
        adapter_id=adapter_id,
        equivalent=comparison.equivalent,
        legacy_valid=legacy_payload is not None,
        pipeline_valid=result.valid,
        confidence=result.confidence.score,
        recovery_source=result.selected_candidate.source if result.selected_candidate is not None else None,
        recovery_count=result.recovery_metrics.total_repair_count,
        old_latency_ms=old_latency_ms,
        new_latency_ms=sum(artifact.elapsed_ms for artifact in result.stage_artifacts),
        differences=comparison.differences,
        validation_errors=tuple(f"{issue.path}: {issue.message}" for issue in result.validation_issues),
        warnings=tuple(warning for artifact in result.stage_artifacts for warning in artifact.warnings),
        metadata=metadata or {},
    )
    if metrics.equivalent:
        LOGGER.info("llm shadow parser parity: %s", metrics.to_json())
    else:
        LOGGER.warning("llm shadow parser difference: %s", metrics.to_json())
    return metrics


def shadow_metrics_file(metrics: RuntimeComparisonMetrics) -> dict[str, str]:
    return {"llm-shadow-comparison.json": metrics.to_json()}


@dataclass(frozen=True)
class ProviderParitySummary:
    provider_id: str
    sample_count: int
    success_rate: float
    schema_equality_rate: float
    field_equality_rate: float
    average_repair_count: float
    average_confidence_delta: float
    average_latency_delta_ms: float
    failure_causes: dict[str, int] = field(default_factory=dict)

    def to_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True)


@dataclass(frozen=True)
class ProviderCertificationThresholds:
    min_schema_validity_rate: float = 0.99
    max_repair_rate: float = 0.01
    min_schema_equality_rate: float = 0.99
    min_field_equality_rate: float = 0.99
    max_average_confidence_delta: float = 0.05
    max_average_latency_delta_ms: float = 1500.0


@dataclass(frozen=True)
class ProviderCertificationResult:
    provider_id: str
    production_ready: bool
    summary: ProviderParitySummary
    thresholds: ProviderCertificationThresholds
    failures: tuple[str, ...] = ()

    def to_json(self) -> str:
        return json.dumps(asdict(self), sort_keys=True)


def summarize_provider_parity(provider_id: str, metrics: list[RuntimeComparisonMetrics]) -> ProviderParitySummary:
    sample_count = len(metrics)
    if sample_count == 0:
        return ProviderParitySummary(
            provider_id=provider_id,
            sample_count=0,
            success_rate=0.0,
            schema_equality_rate=0.0,
            field_equality_rate=0.0,
            average_repair_count=0.0,
            average_confidence_delta=1.0,
            average_latency_delta_ms=0.0,
            failure_causes={"no_samples": 1},
        )
    success_count = sum(1 for item in metrics if item.pipeline_valid)
    equal_count = sum(1 for item in metrics if item.equivalent)
    failure_causes: dict[str, int] = {}
    for item in metrics:
        for difference in item.differences or ():
            failure_causes[difference] = failure_causes.get(difference, 0) + 1
        for error in item.validation_errors or ():
            failure_causes[error] = failure_causes.get(error, 0) + 1
    latency_deltas = [
        abs((item.new_latency_ms or 0.0) - (item.old_latency_ms or 0.0))
        for item in metrics
        if item.new_latency_ms is not None and item.old_latency_ms is not None
    ]
    return ProviderParitySummary(
        provider_id=provider_id,
        sample_count=sample_count,
        success_rate=round(success_count / sample_count, 6),
        schema_equality_rate=round(equal_count / sample_count, 6),
        field_equality_rate=round(equal_count / sample_count, 6),
        average_repair_count=round(sum(item.recovery_count for item in metrics) / sample_count, 6),
        average_confidence_delta=0.0,
        average_latency_delta_ms=round(sum(latency_deltas) / len(latency_deltas), 3) if latency_deltas else 0.0,
        failure_causes=failure_causes,
    )


def certify_provider(
    provider_id: str,
    metrics: list[RuntimeComparisonMetrics],
    thresholds: ProviderCertificationThresholds | None = None,
) -> ProviderCertificationResult:
    thresholds = thresholds or ProviderCertificationThresholds()
    summary = summarize_provider_parity(provider_id, metrics)
    repair_rate = summary.average_repair_count
    failures = []
    if summary.success_rate < thresholds.min_schema_validity_rate:
        failures.append("schema_validity_below_threshold")
    if repair_rate > thresholds.max_repair_rate:
        failures.append("repair_rate_above_threshold")
    if summary.schema_equality_rate < thresholds.min_schema_equality_rate:
        failures.append("schema_equality_below_threshold")
    if summary.field_equality_rate < thresholds.min_field_equality_rate:
        failures.append("field_equality_below_threshold")
    if summary.average_confidence_delta > thresholds.max_average_confidence_delta:
        failures.append("confidence_delta_above_threshold")
    if summary.average_latency_delta_ms > thresholds.max_average_latency_delta_ms:
        failures.append("latency_delta_above_threshold")
    return ProviderCertificationResult(
        provider_id=provider_id,
        production_ready=not failures,
        summary=summary,
        thresholds=thresholds,
        failures=tuple(failures),
    )


def _flag(env: dict[str, str] | os._Environ, provider_id: str, name: str) -> bool:
    provider_key = f"OPEN_KRITT_LLM_{_env_provider(provider_id)}_{name}"
    generic_key = f"OPEN_KRITT_LLM_{name}"
    raw = env.get(provider_key)
    if raw is None:
        raw = env.get(generic_key)
    return _truthy(raw)


def _execution_mode(env: dict[str, str] | os._Environ, provider_id: str) -> ProviderExecutionMode:
    provider_key = f"OPEN_KRITT_LLM_{_env_provider(provider_id)}_EXECUTION_MODE"
    generic_key = "OPEN_KRITT_LLM_EXECUTION_MODE"
    raw = env.get(provider_key) or env.get(generic_key) or _default_execution_mode(provider_id).value
    normalized = str(raw).strip().upper()
    try:
        return ProviderExecutionMode(normalized)
    except ValueError:
        LOGGER.warning("invalid llm execution mode %r for provider %s; using LEGACY", raw, provider_id)
        return ProviderExecutionMode.LEGACY


def _truthy(raw: str | None) -> bool:
    return str(raw or "").strip().lower() in {"1", "true", "yes", "on"}


def _env_provider(provider_id: str) -> str:
    return "".join(char if char.isalnum() else "_" for char in provider_id.upper())


def _default_execution_mode(provider_id: str) -> ProviderExecutionMode:
    return ProviderExecutionMode.LEGACY

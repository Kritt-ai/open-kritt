"""Universal provider-independent response parsing pipeline."""

import json
import logging
import os
from typing import Any

from ..types import RawLLMResponse
from .confidence import ConfidenceScorer
from .extractor import JSONExtractor
from .normalizer import ResponseNormalizer
from .plugins import ParserPluginRegistry
from .recovery import RecoveryOrchestrator
from .types import ConfidenceResult, PipelineResult, RecoveryMetrics, StageArtifact, ValidationResult
from .validator import SchemaValidator

LOGGER = logging.getLogger("open_kritt_engine.llm.parsing")


def _debug_enabled() -> bool:
    value = f"{os.getenv('OPEN_KRITT_DEBUG', '')},{os.getenv('DEBUG', '')}".lower()
    return any(marker in value for marker in ("1", "true", "yes", "open_kritt", "open-kritt", "llm", "parser"))


def _json_default(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, dict):
        return {str(key): _json_default(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_default(item) for item in value]
    if hasattr(value, "__dict__"):
        return _json_default(vars(value))
    return str(value)


def _log_pipeline(stage: str, payload: dict[str, Any]) -> None:
    if _debug_enabled():
        LOGGER.info("llm parser %s=%s", stage, json.dumps(_json_default(payload), ensure_ascii=False, sort_keys=True))


class UniversalResponsePipeline:
    """Convert a raw model response into a schema-validated structured object.

    The pipeline is deliberately stage-based so each artifact can be inspected:
    normalization, candidate extraction, deterministic recovery, validation, and
    confidence scoring. Provider adapters must not bypass this path.
    """

    def __init__(
        self,
        *,
        normalizer: ResponseNormalizer | None = None,
        extractor: JSONExtractor | None = None,
        recovery: RecoveryOrchestrator | None = None,
        validator: SchemaValidator | None = None,
        scorer: ConfidenceScorer | None = None,
        parser_plugins: ParserPluginRegistry | None = None,
    ):
        self.normalizer = normalizer or ResponseNormalizer()
        self.extractor = extractor or JSONExtractor()
        self.recovery = recovery or RecoveryOrchestrator()
        self.validator = validator or SchemaValidator()
        self.scorer = scorer or ConfidenceScorer()
        self.parser_plugins = parser_plugins or ParserPluginRegistry()

    def run(self, response: RawLLMResponse, schema: dict[str, Any] | None) -> PipelineResult:
        """Run all parsing stages and return the best valid candidate, if any."""
        stage_artifacts: list[StageArtifact] = []
        normalized, artifact = self.normalizer.normalize(response)
        stage_artifacts.append(artifact)
        _log_pipeline(
            "normalized",
            {
                "provider": response.provider_id,
                "adapter": response.adapter_id,
                "model": response.model,
                "text_bytes": len((normalized.text or "").encode("utf-8")),
                "warnings": normalized.warnings,
            },
        )

        candidates, artifact = self.extractor.extract(normalized)
        plugin_candidates = []
        for plugin in self.parser_plugins.all():
            plugin_candidates.extend(plugin.parse(normalized))
        if plugin_candidates:
            candidates = (*candidates, *plugin_candidates)
        stage_artifacts.append(artifact)
        _log_pipeline(
            "candidates",
            {
                "candidate_count": len(candidates),
                "plugin_candidate_count": len(plugin_candidates),
                "sources": [candidate.source for candidate in candidates],
                "warnings": getattr(artifact, "warnings", ()),
            },
        )

        best_confidence: ConfidenceResult | None = None
        best_validation: ValidationResult | None = None
        best_repaired_json: str | None = None
        best_metrics: RecoveryMetrics | None = None
        selected_candidate = None
        valid_results = []

        for candidate in candidates:
            repair, metrics, recovery_artifact = self.recovery.recover(candidate)
            stage_artifacts.append(recovery_artifact)

            validation, validation_artifact = self.validator.validate(repair, schema)
            stage_artifacts.append(validation_artifact)
            _log_pipeline(
                "validation",
                {
                    "candidate_source": candidate.source,
                    "candidate_confidence": candidate.confidence,
                    "valid": validation.valid,
                    "issues": validation.issues,
                    "recovery": metrics,
                },
            )

            confidence, confidence_artifact = self.scorer.score(
                candidate=candidate,
                repair=repair,
                validation=validation,
                provider_warnings=response.warnings,
            )
            stage_artifacts.append(confidence_artifact)
            metrics = _with_final_confidence(metrics, confidence.score)

            if best_confidence is None or confidence.score > best_confidence.score:
                best_confidence = confidence
                best_validation = validation
                best_repaired_json = repair.text
                best_metrics = metrics
                selected_candidate = candidate
            if validation.valid:
                valid_results.append((confidence.score, candidate, repair, validation, confidence, metrics))

        if valid_results:
            _score, candidate, repair, validation, confidence, metrics = max(valid_results, key=lambda item: item[0])
            _log_pipeline(
                "result",
                {
                    "valid": True,
                    "selected_source": candidate.source,
                    "candidate_count": len(candidates),
                    "confidence": confidence.score,
                    "validation_issues": validation.issues,
                },
            )
            return PipelineResult(
                raw_response=response,
                normalized=normalized,
                candidates=candidates,
                selected_candidate=candidate,
                repaired_json=repair.text,
                validated_object=validation.value,
                confidence=confidence,
                stage_artifacts=tuple(stage_artifacts),
                validation_issues=validation.issues,
                recovery_metrics=metrics,
            )

        if best_confidence is None:
            empty_validation = ValidationResult(valid=False)
            best_confidence, confidence_artifact = self.scorer.score(
                candidate=None,
                repair=None,
                validation=empty_validation,
                provider_warnings=response.warnings,
            )
            stage_artifacts.append(confidence_artifact)
            best_validation = empty_validation
            best_metrics = RecoveryMetrics(final_confidence=best_confidence.score)

        _log_pipeline(
            "result",
            {
                "valid": False,
                "selected_source": selected_candidate.source if selected_candidate is not None else None,
                "candidate_count": len(candidates),
                "confidence": best_confidence.score,
                "validation_issues": best_validation.issues if best_validation is not None else (),
            },
        )
        return PipelineResult(
            raw_response=response,
            normalized=normalized,
            candidates=candidates,
            selected_candidate=selected_candidate,
            repaired_json=best_repaired_json,
            validated_object=None,
            confidence=best_confidence,
            stage_artifacts=tuple(stage_artifacts),
            validation_issues=best_validation.issues if best_validation is not None else (),
            recovery_metrics=best_metrics or RecoveryMetrics(final_confidence=best_confidence.score),
        )


def _with_final_confidence(metrics: RecoveryMetrics, score: float) -> RecoveryMetrics:
    return RecoveryMetrics(
        strategy_order=metrics.strategy_order,
        strategies_attempted=metrics.strategies_attempted,
        strategies_skipped=metrics.strategies_skipped,
        successful_strategy=metrics.successful_strategy,
        total_repair_count=metrics.total_repair_count,
        deterministic=metrics.deterministic,
        llm_repair_used=metrics.llm_repair_used,
        recovery_time_ms=metrics.recovery_time_ms,
        final_confidence=score,
    )

from time import monotonic

from .types import ConfidenceResult, JSONCandidate, RepairResult, StageArtifact, ValidationResult


class ConfidenceScorer:
    def score(
        self,
        *,
        candidate: JSONCandidate | None,
        repair: RepairResult | None,
        validation: ValidationResult,
        provider_warnings: tuple[str, ...] = (),
    ) -> tuple[ConfidenceResult, StageArtifact]:
        started = monotonic()
        signals = {
            "schema_valid": validation.valid,
            "candidate_source": candidate.source if candidate is not None else None,
            "candidate_confidence": candidate.confidence if candidate is not None else 0.0,
            "repair_count": 0,
            "truncation_detected": False,
            "candidate_complete": candidate.end is not None if candidate is not None else False,
            "parser_warning_count": len(candidate.warnings) if candidate is not None else 0,
            "provider_warning_count": len(provider_warnings),
        }
        score = candidate.confidence if candidate is not None else 0.0
        if validation.valid:
            score = max(score, 0.70)
        else:
            score = min(score, 0.35)

        if repair is not None:
            repair_count = sum(1 for action in repair.actions if action.applied)
            signals["repair_count"] = repair_count
            score -= min(0.30, repair_count * 0.04)
            truncation = any("truncated" in warning for warning in repair.warnings)
            signals["truncation_detected"] = truncation
            if truncation:
                score -= 0.20
            score -= min(0.10, len(repair.warnings) * 0.02)

        if provider_warnings:
            score -= min(0.20, len(provider_warnings) * 0.03)

        result = ConfidenceResult(score=max(0.0, min(1.0, round(score, 3))), signals=signals)
        return result, StageArtifact(
            stage="confidence",
            input={
                "candidate": candidate,
                "repair": repair,
                "validation": validation,
                "provider_warnings": provider_warnings,
            },
            output=result,
            elapsed_ms=_elapsed_ms(started),
            warnings=result.warnings,
        )


def _elapsed_ms(started: float) -> float:
    return round((monotonic() - started) * 1000, 3)

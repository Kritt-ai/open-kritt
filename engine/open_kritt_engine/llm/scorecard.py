import json
from dataclasses import asdict, dataclass
from statistics import mean
from typing import Any


@dataclass(frozen=True)
class ProviderScorecard:
    provider_id: str
    total_runs: int
    schema_success_rate: float
    repair_frequency: float
    average_latency_ms: float
    average_confidence: float
    hallucination_rate: float
    average_token_usage: float
    average_retry_count: float
    failure_reasons: dict[str, int]

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, sort_keys=True)


def build_provider_scorecard(provider_id: str, runs: list[dict[str, Any]]) -> ProviderScorecard:
    total = len(runs)
    if total == 0:
        return ProviderScorecard(provider_id, 0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, {})
    failures: dict[str, int] = {}
    for run in runs:
        reason = run.get("failure_reason")
        if reason:
            failures[str(reason)] = failures.get(str(reason), 0) + 1
    return ProviderScorecard(
        provider_id=provider_id,
        total_runs=total,
        schema_success_rate=_rate(runs, "schema_valid"),
        repair_frequency=_rate(runs, "repaired"),
        average_latency_ms=_avg(runs, "latency_ms"),
        average_confidence=_avg(runs, "confidence"),
        hallucination_rate=_rate(runs, "hallucination_detected"),
        average_token_usage=_avg(runs, "token_usage"),
        average_retry_count=_avg(runs, "retry_count"),
        failure_reasons=failures,
    )


def _rate(runs: list[dict[str, Any]], key: str) -> float:
    return round(sum(1 for run in runs if run.get(key)) / max(1, len(runs)), 4)


def _avg(runs: list[dict[str, Any]], key: str) -> float:
    values = [float(run.get(key) or 0) for run in runs]
    return round(mean(values), 4) if values else 0.0


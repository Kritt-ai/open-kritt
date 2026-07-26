from time import monotonic

from .strategies import RepairStrategy, default_repair_strategies
from .types import JSONCandidate, RecoveryMetrics, RepairAction, RepairResult, StageArtifact


class RecoveryOrchestrator:
    def __init__(self, strategies: tuple[RepairStrategy, ...] | None = None):
        self.strategies = strategies or default_repair_strategies()

    def recover(self, candidate: JSONCandidate) -> tuple[RepairResult, RecoveryMetrics, StageArtifact]:
        started = monotonic()
        text = candidate.text
        actions: list[RepairAction] = []
        warnings: list[str] = list(candidate.warnings)
        attempted: list[str] = []
        skipped: list[str] = []
        successful_strategy = None

        for strategy in self.strategies:
            if not strategy.applies(text):
                skipped.append(strategy.name)
                actions.append(RepairAction(strategy.name, applied=False, skipped=True))
                continue
            attempted.append(strategy.name)
            next_text, action, strategy_warnings = strategy.apply(text)
            actions.append(action)
            warnings.extend(strategy_warnings)
            if action.applied:
                text = next_text
                successful_strategy = strategy.name

        repair_count = sum(1 for action in actions if action.applied)
        elapsed = _elapsed_ms(started)
        result = RepairResult(text=text.strip(), actions=tuple(actions), warnings=tuple(warnings))
        metrics = RecoveryMetrics(
            strategy_order=tuple(strategy.name for strategy in self.strategies),
            strategies_attempted=tuple(attempted),
            strategies_skipped=tuple(skipped),
            successful_strategy=successful_strategy,
            total_repair_count=repair_count,
            deterministic=True,
            llm_repair_used=False,
            recovery_time_ms=elapsed,
        )
        return result, metrics, StageArtifact(
            stage="recovery",
            input=candidate,
            output={"repair": result, "metrics": metrics},
            elapsed_ms=elapsed,
            warnings=tuple(warnings),
        )


def _elapsed_ms(started: float) -> float:
    return round((monotonic() - started) * 1000, 3)


import random
from dataclasses import dataclass
from typing import Literal

RetryReason = Literal[
    "timeout",
    "rate_limit",
    "invalid_json",
    "network_failure",
    "provider_overload",
    "context_overflow",
    "authentication",
    "unknown",
]


@dataclass(frozen=True)
class RetryDecision:
    retry: bool
    delay_seconds: float
    reason: RetryReason
    strategy: str
    message: str = ""


@dataclass(frozen=True)
class RetryPolicy:
    max_attempts: int = 3
    base_delay_seconds: float = 1.0
    max_delay_seconds: float = 30.0
    jitter_seconds: float = 0.25

    def decide(self, *, reason: RetryReason, attempt: int) -> RetryDecision:
        if reason == "authentication":
            return RetryDecision(False, 0.0, reason, "do_not_retry", "authentication errors are terminal")
        if attempt >= self.max_attempts:
            return RetryDecision(False, 0.0, reason, "attempt_limit", "retry limit reached")
        if reason == "context_overflow":
            return RetryDecision(True, 0.0, reason, "shorten_prompt")
        if reason == "invalid_json":
            return RetryDecision(True, 0.0, reason, "repair_then_strict_prompt")
        if reason in {"timeout", "rate_limit", "network_failure", "provider_overload", "unknown"}:
            return RetryDecision(True, self._backoff(attempt), reason, "exponential_backoff")
        return RetryDecision(False, 0.0, reason, "do_not_retry")

    def _backoff(self, attempt: int) -> float:
        delay = min(self.max_delay_seconds, self.base_delay_seconds * (2 ** max(0, attempt - 1)))
        return round(delay + random.uniform(0, self.jitter_seconds), 3)


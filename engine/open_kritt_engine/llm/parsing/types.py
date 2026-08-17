from dataclasses import dataclass, field
from typing import Any, Literal

from ..types import RawLLMResponse

StageName = Literal["normalizer", "extractor", "repair", "recovery", "validator", "confidence", "shadow"]
CandidateSource = Literal["direct", "fenced", "balanced", "embedded", "partial"]


@dataclass(frozen=True)
class StageArtifact:
    stage: StageName
    input: Any
    output: Any
    elapsed_ms: float
    errors: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class NormalizedResponse:
    original: RawLLMResponse
    text: str
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class JSONCandidate:
    text: str
    source: CandidateSource
    confidence: float
    start: int | None = None
    end: int | None = None
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class RepairAction:
    name: str
    applied: bool
    reason: str = ""
    skipped: bool = False


@dataclass(frozen=True)
class RepairResult:
    text: str
    actions: tuple[RepairAction, ...] = ()
    warnings: tuple[str, ...] = ()
    errors: tuple[str, ...] = ()
    deterministic: bool = True


@dataclass(frozen=True)
class RecoveryMetrics:
    strategy_order: tuple[str, ...] = ()
    strategies_attempted: tuple[str, ...] = ()
    strategies_skipped: tuple[str, ...] = ()
    successful_strategy: str | None = None
    total_repair_count: int = 0
    deterministic: bool = True
    llm_repair_used: bool = False
    recovery_time_ms: float = 0.0
    final_confidence: float = 0.0


@dataclass(frozen=True)
class ValidationIssue:
    path: str
    message: str
    code: str = "schema_error"


@dataclass(frozen=True)
class ValidationResult:
    valid: bool
    value: dict[str, Any] | None = None
    issues: tuple[ValidationIssue, ...] = ()
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class ConfidenceResult:
    score: float
    signals: dict[str, Any] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()


@dataclass(frozen=True)
class PipelineResult:
    raw_response: RawLLMResponse
    normalized: NormalizedResponse | None
    candidates: tuple[JSONCandidate, ...]
    selected_candidate: JSONCandidate | None
    repaired_json: str | None
    validated_object: dict[str, Any] | None
    confidence: ConfidenceResult
    stage_artifacts: tuple[StageArtifact, ...]
    validation_issues: tuple[ValidationIssue, ...] = ()
    recovery_metrics: RecoveryMetrics = field(default_factory=RecoveryMetrics)

    @property
    def valid(self) -> bool:
        return self.validated_object is not None

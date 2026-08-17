from dataclasses import dataclass, field
from typing import Any, Protocol

from ..types import RawLLMResponse
from .types import RepairResult, ValidationIssue


@dataclass(frozen=True)
class RepairRequest:
    original_prompt: str
    raw_response: RawLLMResponse
    normalized_text: str
    parser_errors: tuple[ValidationIssue, ...]
    schema: dict[str, Any]
    repair_constraints: tuple[str, ...] = (
        "never invent missing information",
        "preserve the original semantics",
        "only repair formatting and structure",
        "return failure if recovery is impossible",
    )
    metadata: dict[str, str] = field(default_factory=dict)

    def prompt(self) -> str:
        constraints = "\n".join(f"- {item}" for item in self.repair_constraints)
        errors = "\n".join(f"- {issue.path}: {issue.message}" for issue in self.parser_errors) or "- none"
        return (
            "Repair the model output into valid JSON for the provided schema.\n\n"
            "Constraints:\n"
            f"{constraints}\n\n"
            "Parser errors:\n"
            f"{errors}\n\n"
            "Original prompt:\n"
            f"{self.original_prompt}\n\n"
            "Raw provider output:\n"
            f"{self.raw_response.raw_text or self.raw_response.stdout}\n\n"
            "Normalized candidate:\n"
            f"{self.normalized_text}\n\n"
            "JSON schema:\n"
            f"{self.schema}"
        )


@dataclass(frozen=True)
class RepairResponse:
    success: bool
    repair: RepairResult | None = None
    message: str = ""
    usage: dict[str, Any] | None = None
    raw_response: RawLLMResponse | None = None


class RepairProvider(Protocol):
    id: str

    def repair(self, request: RepairRequest) -> RepairResponse:
        ...


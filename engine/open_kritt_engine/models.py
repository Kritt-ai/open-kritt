from dataclasses import dataclass
from typing import Any

STEP_RESULTS_TABLE = "workflows.step_results"
VULNERABILITIES_TABLE = "workflows.vulnerabilities"


@dataclass(frozen=True)
class Step:
    id: int
    content: str
    output_format: str
    name: str | None
    depth: int
    multi_output: bool
    is_last_step: bool
    output_table: str
    order: int
    # A non-root depth may run once over the full previous-depth result array.
    consumes_all: bool = False


@dataclass(frozen=True)
class Workflow:
    id: int
    name: str
    steps: tuple[Step, ...]

    @property
    def depths(self):
        return tuple(sorted({s.depth for s in self.steps}))

    def steps_at_depth(self, depth):
        return tuple(s for s in self.steps if s.depth == depth)


@dataclass(frozen=True)
class State:
    prev_id: int
    prev_table: str | None
    repeat_run: int
    context: dict[str, Any]
    # The immediate preceding step result. Batches aggregate this exact payload,
    # rather than every value accumulated in the rendered prompt context.
    output: dict[str, Any] | None = None


@dataclass(frozen=True)
class Job:
    step: Step
    state: State

    @property
    def depth(self):
        return self.step.depth


@dataclass(frozen=True)
class StepResultRow:
    id: int
    step_id: int
    prev_id: int
    prev_table: str | None
    repeat_run: int
    json_answer: dict[str, Any]

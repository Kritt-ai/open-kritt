from dataclasses import dataclass
from typing import Any

STEP_RESULTS_TABLE = "workflows.step_results"
VULNERABILITIES_TABLE = "workflows.vulnerabilities"


@dataclass(frozen=True)
class ModelSelection:
    model: str
    model_provider: str
    harness: str
    thinking_effort: str


def _selection_value(configuration: dict[str, Any], snake_key: str, camel_key: str, fallback: str) -> str:
    value = configuration.get(snake_key)
    if value is None:
        value = configuration.get(camel_key)
    normalized = str(value or "").strip()
    return normalized or fallback


def model_selection_for_depth(scan: dict[str, Any], depth: int | None = None) -> ModelSelection:
    default = ModelSelection(
        model=str(scan.get("model") or "").strip(),
        model_provider=_selection_value(scan, "model_provider", "modelProvider", "openrouter"),
        harness=str(scan.get("harness") or "").strip(),
        thinking_effort=_selection_value(scan, "thinking_effort", "thinkingEffort", "medium"),
    )
    overrides = scan.get("model_overrides")
    if overrides is None:
        overrides = scan.get("modelOverrides")
    override = overrides.get(str(depth)) if depth is not None and isinstance(overrides, dict) else None
    if not isinstance(override, dict):
        return default
    return ModelSelection(
        model=_selection_value(override, "model", "model", default.model),
        model_provider=_selection_value(
            override,
            "model_provider",
            "modelProvider",
            default.model_provider,
        ),
        harness=_selection_value(override, "harness", "harness", default.harness),
        thinking_effort=_selection_value(
            override,
            "thinking_effort",
            "thinkingEffort",
            default.thinking_effort,
        ),
    )


def post_processing_thinking_effort(scan: dict[str, Any]) -> str:
    return post_processing_model_selection(scan).thinking_effort


def post_processing_model_selection(scan: dict[str, Any]) -> ModelSelection:
    configuration = scan.get("configuration")
    if not isinstance(configuration, dict):
        configuration = {}
    default = model_selection_for_depth(scan)
    return ModelSelection(
        model=_selection_value(
            configuration,
            "post_processing_model",
            "postProcessingModel",
            default.model,
        ),
        model_provider=_selection_value(
            configuration,
            "post_processing_model_provider",
            "postProcessingModelProvider",
            default.model_provider,
        ),
        harness=_selection_value(
            configuration,
            "post_processing_harness",
            "postProcessingHarness",
            default.harness,
        ),
        thinking_effort=_selection_value(
            configuration,
            "post_processing_thinking_effort",
            "postProcessingThinkingEffort",
            default.thinking_effort,
        ),
    )


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

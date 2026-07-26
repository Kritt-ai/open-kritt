import re
from typing import Any

from .models import Job, State, StepResultRow, Workflow
from .prompting import scan_context


def repeat_runs(scan: dict[str, Any]) -> int:
    configuration = scan.get("configuration") or {}
    raw = configuration.get("repeat_runs", 1) if isinstance(configuration, dict) else 1
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return 1
    return max(1, value)


def metadata_key(step_id: int, state: State):
    return (step_id, state.prev_id, state.prev_table, state.repeat_run)


MULTI_OUTPUT_DEPTH_RE = re.compile(r"^multi_output_depth_\d+$")


def _depth_consumes_all(steps, depth: int) -> bool:
    """A valid workflow applies one consume-all setting to every depth sibling."""

    return depth > 0 and bool(steps) and all(step.consumes_all for step in steps)


def _output_payload(row: StepResultRow) -> dict[str, Any]:
    return row.json_answer if isinstance(row.json_answer, dict) else {}


def _next_states(step, state: State, step_results) -> list[State]:
    if step.is_last_step:
        return []
    next_states = []
    for row in step_results.get(metadata_key(step.id, state), []):
        output = _output_payload(row)
        next_states.append(
            State(
                prev_id=row.id,
                prev_table="workflows.step_results",
                repeat_run=1,
                context={**state.context, **output},
                output=output,
            )
        )
    return next_states


def _batch_state(scan: dict[str, Any], states: list[State], previous_depth: int) -> State:
    """Collapse one repeat run into the context documented as multi_output_depth_N."""

    context = scan_context(scan)
    # Preserve any older batch arrays. Individual output keys from the immediate
    # previous depth intentionally disappear when this depth consumes all.
    for key, value in states[0].context.items():
        if MULTI_OUTPUT_DEPTH_RE.fullmatch(key):
            context[key] = value
    context[f"multi_output_depth_{previous_depth}"] = [state.output or {} for state in states]
    return State(prev_id=0, prev_table=None, repeat_run=1, context=context)


def _state_for_repeat(state: State, repeat_run: int) -> State:
    return State(
        prev_id=state.prev_id,
        prev_table=state.prev_table,
        repeat_run=repeat_run,
        context=state.context,
        output=state.output,
    )


def build_pending_jobs(
    *,
    scan: dict[str, Any],
    workflow: Workflow,
    completed: set[tuple[int, int, str | None, int]],
    step_results: dict[tuple[int, int, str | None, int], list[StepResultRow]],
    claimed: set[tuple[int, int, str | None, int]] | None = None,
) -> list[Job]:
    pending: list[Job] = []
    if claimed is None:
        claimed = completed
    runs = repeat_runs(scan)
    states = [State(prev_id=0, prev_table=None, repeat_run=1, context=scan_context(scan))]
    previous_depth_complete = True

    for depth in workflow.depths:
        steps = workflow.steps_at_depth(depth)
        next_states: list[State] = []
        depth_complete = previous_depth_complete

        if _depth_consumes_all(steps, depth):
            # Do not start a batch until every branch in the previous depth has
            # completed. Otherwise a concurrent worker could run it over a
            # partial result set.
            input_states = [_batch_state(scan, states, depth - 1)] if previous_depth_complete and states else []
        else:
            input_states = states

        for state in input_states:
            for step in steps:
                task_complete = True
                task_next_states: list[State] = []
                for repeat_run in range(1, runs + 1):
                    repeated_state = _state_for_repeat(state, repeat_run)
                    key = metadata_key(step.id, repeated_state)
                    if key not in completed:
                        task_complete = False
                        depth_complete = False
                        if key not in claimed:
                            pending.append(Job(step=step, state=repeated_state))
                        # The next repeat needs the output from this one, and the
                        # next depth needs the complete accumulated task output.
                        break
                    task_next_states.extend(_next_states(step, repeated_state, step_results))
                if task_complete:
                    next_states.extend(task_next_states)

        states = next_states
        previous_depth_complete = depth_complete

    return sorted(
        pending,
        key=lambda job: (-job.depth, job.state.repeat_run, job.step.order, job.state.prev_id),
    )

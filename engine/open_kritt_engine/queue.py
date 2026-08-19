import hashlib
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


def configured_step_ids(scan: dict[str, Any], key: str) -> set[int]:
    configuration = scan.get("configuration")
    if not isinstance(configuration, dict):
        return set()
    raw = configuration.get(key, [])
    if isinstance(raw, str | int):
        raw = [raw]
    if not isinstance(raw, list):
        return set()
    step_ids = set()
    for value in raw:
        try:
            step_id = int(value)
        except (TypeError, ValueError):
            continue
        if step_id > 0:
            step_ids.add(step_id)
    return step_ids


def configured_pending_lineage_order(scan: dict[str, Any], step_id: int) -> dict[int, int]:
    configuration = scan.get("configuration")
    if not isinstance(configuration, dict):
        return {}
    by_step = configuration.get("pending_lineage_order_by_step")
    if not isinstance(by_step, dict):
        return {}
    raw = by_step.get(str(step_id), by_step.get(step_id, []))
    if not isinstance(raw, list):
        return {}
    positions: dict[int, int] = {}
    for value in raw:
        try:
            prev_id = int(value)
        except (TypeError, ValueError):
            continue
        if prev_id > 0 and prev_id not in positions:
            positions[prev_id] = len(positions)
    return positions


def _pending_order_value(
    scan: dict[str, Any],
    job: Job,
    *,
    explicit: dict[int, int] | None = None,
    shuffle_step_ids: set[int] | None = None,
) -> tuple[int, int, int]:
    if explicit is None:
        explicit = configured_pending_lineage_order(scan, job.step.id)
    position = explicit.get(job.state.prev_id)
    if position is not None:
        return (0, position, job.state.prev_id)

    if shuffle_step_ids is None:
        shuffle_step_ids = configured_step_ids(scan, "shuffle_pending_step_ids")
    if job.step.id not in shuffle_step_ids:
        return (1 if explicit else 0, job.state.prev_id, job.state.prev_id)
    configuration = scan.get("configuration") or {}
    seed = str(configuration.get("pending_shuffle_seed") or scan.get("id") or "open-kritt")
    material = (
        f"{seed}|{job.step.id}|{job.state.prev_id}|{job.state.prev_table or ''}|{job.state.repeat_run}"
    ).encode()
    shuffled = int.from_bytes(hashlib.blake2b(material, digest_size=8).digest(), "big")
    return (1 if explicit else 0, shuffled, job.state.prev_id)


def _depth_consumes_all(steps, depth: int) -> bool:
    """A valid workflow applies one consume-all setting to every depth sibling."""

    return depth > 0 and bool(steps) and all(step.consumes_all for step in steps)


def validate_workflow_bindings(workflow: Workflow) -> None:
    """Reject persisted binding topologies that cannot represent a bijection."""

    for depth in workflow.depths:
        steps = workflow.steps_at_depth(depth)
        bound_steps = tuple(step for step in steps if step.bound_source_step_id is not None)
        if not bound_steps:
            continue
        if depth == 0:
            raise ValueError("workflow depth 0 cannot bind to a previous depth")
        if len(bound_steps) != len(steps):
            raise ValueError(f"workflow depth {depth} has an incomplete bound routing map")
        if any(step.consumes_all for step in steps):
            raise ValueError(f"workflow depth {depth} cannot combine bound routing with batch consumption")

        previous_steps = workflow.steps_at_depth(depth - 1)
        if len(previous_steps) < 2 or len(steps) < 2:
            raise ValueError(f"workflow depth {depth} bound routing requires at least two steps in both depths")
        previous_ids = {step.id for step in previous_steps}
        bound_source_ids = {step.bound_source_step_id for step in steps}
        if len(previous_steps) != len(steps) or bound_source_ids != previous_ids:
            raise ValueError(f"workflow depth {depth} must bind every previous-depth step to exactly one destination")


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
                source_step_id=step.id,
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
    return State(prev_id=0, prev_table=None, repeat_run=1, context=context, source_step_id=None)


def _state_for_repeat(state: State, repeat_run: int) -> State:
    return State(
        prev_id=state.prev_id,
        prev_table=state.prev_table,
        repeat_run=repeat_run,
        context=state.context,
        output=state.output,
        source_step_id=state.source_step_id,
    )


def build_pending_jobs(
    *,
    scan: dict[str, Any],
    workflow: Workflow,
    completed: set[tuple[int, int, str | None, int]],
    step_results: dict[tuple[int, int, str | None, int], list[StepResultRow]],
    claimed: set[tuple[int, int, str | None, int]] | None = None,
) -> list[Job]:
    validate_workflow_bindings(workflow)
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

        for step in steps:
            routed_states = (
                [state for state in input_states if state.source_step_id == step.bound_source_step_id]
                if step.bound_source_step_id is not None
                else input_states
            )
            for state in routed_states:
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

    step_ids = {job.step.id for job in pending}
    explicit_orders = {step_id: configured_pending_lineage_order(scan, step_id) for step_id in step_ids}
    shuffle_step_ids = configured_step_ids(scan, "shuffle_pending_step_ids")
    return sorted(
        pending,
        key=lambda job: (
            -job.depth,
            job.state.repeat_run,
            job.step.order,
            *_pending_order_value(
                scan,
                job,
                explicit=explicit_orders[job.step.id],
                shuffle_step_ids=shuffle_step_ids,
            ),
        ),
    )

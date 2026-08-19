import json
from contextlib import contextmanager
from datetime import datetime, timezone
from decimal import Decimal
from typing import Any

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from .artifact_cleanup import POST_WORKSPACE_ID_OFFSET
from .models import Step, StepResultRow, Workflow

RATE_LIMIT_RETRY_BASE_SECONDS = 60.0
RATE_LIMIT_RETRY_MAX_SECONDS = 10 * 60.0
QUOTA_RETRY_MAX_SECONDS = 30 * 60.0
QUEUED_SCAN_ADMISSION_LOCK = (0x6B726974, 0x71756575)


def rate_limit_retry_delay(
    retry_count: int,
    provider_retry_after_seconds: float = 0.0,
    *,
    maximum_seconds: float = RATE_LIMIT_RETRY_MAX_SECONDS,
) -> float:
    """Return the persistent retry delay for a rate-limited scan."""

    maximum_seconds = max(RATE_LIMIT_RETRY_BASE_SECONDS, float(maximum_seconds))
    exponent = max(0, retry_count - 1)
    exponential_delay = (
        maximum_seconds if exponent >= 8 else min(RATE_LIMIT_RETRY_BASE_SECONDS * (2**exponent), maximum_seconds)
    )
    provider_delay = max(0.0, float(provider_retry_after_seconds))
    return min(max(exponential_delay, provider_delay), maximum_seconds)


def _json(value):
    return Jsonb(value) if value is not None else None


def _to_int(value):
    if isinstance(value, Decimal):
        return int(value)
    return int(value)


def configured_agent_skill_ids(scan: dict[str, Any]) -> list[int]:
    ids: list[int] = []

    def add(value):
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return
        if parsed > 0 and parsed not in ids:
            ids.append(parsed)

    configured = scan.get("agent_skill_ids")
    if configured is None:
        configured = scan.get("agentSkillIds")
    if isinstance(configured, list):
        for item in configured:
            add(item.get("id") if isinstance(item, dict) else item)

    config = scan.get("configuration") if isinstance(scan.get("configuration"), dict) else {}
    configured = config.get("agent_skill_ids") or config.get("agent_skills") or []
    if isinstance(configured, str):
        try:
            configured = json.loads(configured)
        except json.JSONDecodeError:
            configured = [part.strip() for part in configured.split(",")]
    if isinstance(configured, list):
        for item in configured:
            add(item.get("id") if isinstance(item, dict) else item)
    return ids


def _completed_scan_reasoning_sql() -> str:
    return """CASE
        WHEN reasoning->>'code' = 'rate_limited'
        THEN NULLIF(
            reasoning - 'code' - 'limit_kind' - 'error' - 'retry_after' - 'retry_count',
            '{}'::jsonb
        )
        ELSE reasoning
    END"""


class Database:
    def __init__(self, database_url: str):
        self.database_url = database_url

    @contextmanager
    def connect(self):
        with psycopg.connect(self.database_url, row_factory=dict_row) as conn:
            yield conn

    def claim_scans(self, conn, *, max_concurrent_scans: int = 1) -> list[dict[str, Any]]:
        """Admit at most one waiting scan and return the active scan pool.

        Pending scans may fill configured concurrent slots. Queued scans only
        start once the active pool is empty.
        """

        limit = max(1, int(max_concurrent_scans))
        conn.execute(
            "SELECT pg_advisory_xact_lock(%s, %s)",
            QUEUED_SCAN_ADMISSION_LOCK,
        )
        active_row = conn.execute(
            """
            SELECT count(*) AS count
            FROM public.scans
            WHERE status IN ('prewarming_cache', 'running', 'post_processing')
            """
        ).fetchone()
        active_count = int((active_row or {}).get("count") or 0)

        admitted = None
        if active_count < limit:
            admitted = conn.execute(
                """
            WITH next_scan AS (
                SELECT id FROM public.scans
                WHERE status = 'pending'
                   OR (
                      status = 'rate_limited'
                      AND reasoning->>'retry_after' IS NOT NULL
                      AND (
                          (reasoning->>'retry_after')::timestamptz <= now()
                          OR (
                              reasoning->>'limit_kind' IN ('account_quota_limited', 'subagent_limited')
                              AND updated_at + make_interval(secs => %s::double precision) <= now()
                          )
                      )
                  )
                ORDER BY inserted_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE public.scans s
            SET status = 'running',
                reasoning = CASE
                    WHEN s.status = 'rate_limited'
                    THEN reasoning - 'error' - 'retry_after'
                    ELSE reasoning
                END,
                last_resumed_at = CASE
                    WHEN s.status = 'rate_limited' THEN now()
                    ELSE last_resumed_at
                END,
                updated_at = now()
            FROM next_scan
            WHERE s.id = next_scan.id
            RETURNING s.*
            """,
                (QUOTA_RETRY_MAX_SECONDS,),
            ).fetchone()

        if active_count == 0 and not admitted:
            admitted = conn.execute(
                """
            WITH next_scan AS (
                SELECT s.id
                FROM public.scans s
                WHERE s.status = 'queued'
                ORDER BY s.inserted_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE public.scans s
            SET status = 'running',
                reasoning = NULL,
                updated_at = now()
            FROM next_scan
            WHERE s.id = next_scan.id
            RETURNING s.*
            """
            ).fetchone()

        if active_count < limit and not admitted:
            conn.execute(
                """
            WITH next_scan AS (
                SELECT s.id
                FROM public.scans s
                WHERE s.status = 'completed'
                  AND EXISTS (
                      SELECT 1 FROM workflows.vulnerabilities v WHERE v.scan_id = s.id
                  )
                  AND (
                      EXISTS (
                          SELECT 1
                          FROM workflows.vulnerabilities v
                          WHERE v.scan_id = s.id
                            AND (v.dedupe_is_canonical IS NULL OR (v.dedupe_is_canonical = true AND v.bounty_rank IS NULL))
                      )
                      OR EXISTS (
                          SELECT 1
                          FROM workflows.vulnerabilities v
                          WHERE v.scan_id = s.id
                            AND s.post_script_id IS NOT NULL
                            AND EXISTS (SELECT 1 FROM public.post_scripts ps WHERE ps.id = s.post_script_id)
                            AND v.dedupe_is_canonical = true
                            AND NOT EXISTS (
                                SELECT 1
                                FROM workflows.vulnerability_enrichments e
                                WHERE e.vulnerability_id = v.id
                                  AND e.post_script_id = s.post_script_id
                            )
                      )
                  )
                ORDER BY s.inserted_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE public.scans s
            SET status = 'post_processing',
                updated_at = now()
            FROM next_scan
            WHERE s.id = next_scan.id
            RETURNING s.*
            """
            ).fetchone()

        return conn.execute(
            """
            SELECT *
            FROM public.scans
            WHERE status IN ('prewarming_cache', 'running', 'post_processing')
            ORDER BY inserted_at ASC, id ASC
            """
        ).fetchall()

    def claim_scan(self, conn, *, max_concurrent_scans: int = 1) -> dict[str, Any] | None:
        """Compatibility wrapper for callers that do not allocate the active pool."""

        scans = self.claim_scans(conn, max_concurrent_scans=max_concurrent_scans)
        return scans[0] if scans else None

    def claim_generation(self, conn) -> dict[str, Any] | None:
        """Atomically claim one pending draft-generation job."""

        return conn.execute(
            """
            WITH next_generation AS (
                SELECT id
                FROM public.generations
                WHERE status = 'pending'
                ORDER BY inserted_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            UPDATE public.generations AS generation
            SET status = 'running',
                result = NULL,
                error = NULL,
                validation_errors = NULL,
                raw_token_usage = NULL,
                codex_session_id = NULL,
                run_started_at = now(),
                completed_at = NULL,
                updated_at = now()
            FROM next_generation
            WHERE generation.id = next_generation.id
            RETURNING generation.*
            """
        ).fetchone()

    def fail_stale_generations(self, conn, *, stale_after_seconds: int) -> int:
        """Fail generation jobs whose worker lease has expired."""

        rows = conn.execute(
            """
            UPDATE public.generations
            SET status = 'failed',
                result = NULL,
                error = 'Generation was interrupted before the draft completed. Please try again.',
                validation_errors = NULL,
                raw_token_usage = NULL,
                codex_session_id = NULL,
                completed_at = now(),
                updated_at = now()
            WHERE status = 'running'
              AND COALESCE(updated_at, run_started_at, inserted_at)
                    < now() - make_interval(secs => %s)
            RETURNING id
            """,
            (max(1, int(stale_after_seconds)),),
        ).fetchall()
        return len(rows)

    def heartbeat_generation(self, conn, generation_id: int) -> bool:
        """Extend the lease for a generation that is still running."""

        row = conn.execute(
            """
            UPDATE public.generations
            SET updated_at = now()
            WHERE id = %s
              AND status = 'running'
            RETURNING id
            """,
            (generation_id,),
        ).fetchone()
        return row is not None

    def complete_generation(
        self,
        conn,
        generation_id: int,
        *,
        result: dict[str, Any],
        raw_token_usage: dict[str, Any] | None,
        codex_session_id: str | None,
    ) -> bool:
        row = conn.execute(
            """
            UPDATE public.generations
            SET status = 'completed',
                result = %s,
                error = NULL,
                validation_errors = NULL,
                raw_token_usage = %s,
                codex_session_id = %s,
                completed_at = now(),
                updated_at = now()
            WHERE id = %s
              AND status = 'running'
            RETURNING id
            """,
            (_json(result), _json(raw_token_usage), codex_session_id, generation_id),
        ).fetchone()
        return row is not None

    def fail_generation(
        self,
        conn,
        generation_id: int,
        *,
        error: str,
        validation_errors: list[dict[str, str]] | None = None,
        raw_token_usage: dict[str, Any] | None = None,
        codex_session_id: str | None = None,
    ) -> bool:
        row = conn.execute(
            """
            UPDATE public.generations
            SET status = 'failed',
                result = NULL,
                error = %s,
                validation_errors = %s,
                raw_token_usage = %s,
                codex_session_id = %s,
                completed_at = now(),
                updated_at = now()
            WHERE id = %s
              AND status = 'running'
            RETURNING id
            """,
            (error, _json(validation_errors), _json(raw_token_usage), codex_session_id, generation_id),
        ).fetchone()
        return row is not None

    def load_scan(self, conn, scan_id: int) -> dict[str, Any] | None:
        return conn.execute("SELECT * FROM public.scans WHERE id = %s", (scan_id,)).fetchone()

    def claim_logical_job_slot(
        self,
        conn,
        *,
        scan: dict[str, Any],
        scan_id: int,
        already_started: bool,
    ) -> bool:
        """Atomically consume one new logical-job slot for a scan."""

        if already_started:
            return True
        limit = scan.get("job_limit")
        started = int(scan.get("jobs_started") or 0)
        if limit is not None and started >= int(limit):
            running = conn.execute(
                """
                SELECT count(*) AS count
                FROM workflows.step_metadata
                WHERE scan_id = %s
                  AND status = 'running'
                """,
                (scan_id,),
            ).fetchone()
            if int((running or {}).get("count") or 0) == 0:
                conn.execute(
                    """
                    UPDATE public.scans
                    SET status = 'stopped',
                        reasoning = %s,
                        updated_at = now()
                    WHERE id = %s
                      AND status IN ('prewarming_cache', 'running', 'post_processing')
                    """,
                    (_json({"code": "job_limit_reached", "limit": int(limit), "used": started}), scan_id),
                )
            return False
        conn.execute(
            """
            UPDATE public.scans
            SET jobs_started = jobs_started + 1,
                updated_at = now()
            WHERE id = %s
            """,
            (scan_id,),
        )
        return True

    def upsert_model_catalog(
        self,
        conn,
        *,
        provider: str,
        models: list[dict[str, Any]],
        default_model: str,
    ) -> None:
        conn.execute(
            """
            INSERT INTO public.model_catalogs (provider, models, default_model, fetched_at, last_error, updated_at)
            VALUES (%s, %s, %s, now(), NULL, now())
            ON CONFLICT (provider)
            DO UPDATE SET
                models = EXCLUDED.models,
                default_model = EXCLUDED.default_model,
                fetched_at = EXCLUDED.fetched_at,
                last_error = NULL,
                updated_at = now()
            """,
            (provider, _json(models), default_model),
        )

    def record_model_catalog_error(self, conn, *, provider: str, error: str) -> None:
        # Retain any successful catalog so a transient provider outage does not
        # erase selectable models already known to work for this account.
        conn.execute(
            """
            INSERT INTO public.model_catalogs (provider, models, default_model, fetched_at, last_error, updated_at)
            VALUES (%s, '[]'::jsonb, NULL, NULL, %s, now())
            ON CONFLICT (provider)
            DO UPDATE SET
                last_error = EXCLUDED.last_error,
                updated_at = now()
            """,
            (provider, error),
        )

    def set_scan_status(self, conn, scan_id: int, status: str, error: str | None = None):
        reasoning_sql = ""
        if error:
            reasoning_sql = ", reasoning = %s::jsonb"
        elif status == "completed":
            reasoning_sql = ", reasoning = " + _completed_scan_reasoning_sql()
        params: list[Any] = [status]
        if error:
            params.append(_json({"error": error}))
        params.append(scan_id)
        conn.execute(
            f"""
            UPDATE public.scans
            SET status = %s,
                updated_at = now()
                {reasoning_sql}
            WHERE id = %s
            """,
            params,
        )

    def set_scan_storage_warning(
        self,
        conn,
        scan_id: int,
        *,
        free_bytes: int | None,
        required_bytes: int,
        check_error: str | None = None,
    ) -> bool:
        code = "storage_check_unavailable" if check_error else "low_storage"
        if check_error:
            message = (
                "New scan containers are paused because free storage could not be checked. "
                "This scan will resume automatically after the storage check succeeds."
            )
        else:
            free_gib = max(0, int(free_bytes or 0)) / 1024**3
            required_gib = max(0, int(required_bytes)) / 1024**3
            message = (
                f"New scan containers are paused because only {free_gib:.1f} GiB is free; "
                f"at least {required_gib:g} GiB is required. Running containers are not interrupted, "
                "and this scan will resume automatically when space is available."
            )
        warning = {
            "code": code,
            "message": message,
            "free_bytes": free_bytes,
            "required_bytes": required_bytes,
            "detected_at": now_utc().isoformat(),
        }
        if check_error:
            warning["check_error"] = str(check_error)[:500]

        row = conn.execute(
            """
            UPDATE public.scans
            SET reasoning = jsonb_set(
                    CASE
                        WHEN jsonb_typeof(reasoning) = 'object' THEN reasoning
                        ELSE '{}'::jsonb
                    END,
                    '{storage_warning}',
                    %s::jsonb,
                    true
                ),
                updated_at = now()
            WHERE id = %s
              AND status IN ('prewarming_cache', 'running', 'post_processing')
              AND reasoning->'storage_warning'->>'code' IS DISTINCT FROM %s
            RETURNING id
            """,
            (_json(warning), scan_id, code),
        ).fetchone()
        return row is not None

    def clear_scan_storage_warning(self, conn, scan_id: int) -> bool:
        row = conn.execute(
            """
            UPDATE public.scans
            SET reasoning = nullif(reasoning - 'storage_warning', '{}'::jsonb),
                updated_at = now()
            WHERE id = %s
              AND jsonb_typeof(reasoning) = 'object'
              AND reasoning ? 'storage_warning'
            RETURNING id
            """,
            (scan_id,),
        ).fetchone()
        return row is not None

    def defer_scan_after_rate_limit(
        self,
        conn,
        scan_id: int,
        *,
        retry_after_seconds: float,
        error: str,
        limit_kind: str = "rate_limited",
        autoscale_workers: bool = False,
        current_worker_cap: int | None = None,
    ) -> bool:
        current = conn.execute(
            """
            SELECT reasoning
            FROM public.scans
            WHERE id = %s
              AND status IN ('running', 'prewarming_cache', 'post_processing', 'failed')
            FOR UPDATE
            """,
            (scan_id,),
        ).fetchone()
        if current is None:
            return False

        reasoning = current.get("reasoning") if isinstance(current, dict) else None
        previous_retries = reasoning.get("retry_count", 0) if isinstance(reasoning, dict) else 0
        if not isinstance(previous_retries, int) or isinstance(previous_retries, bool) or previous_retries < 0:
            previous_retries = 0
        retry_count = previous_retries + 1
        retry_delay_seconds = rate_limit_retry_delay(
            retry_count,
            retry_after_seconds,
            maximum_seconds=(
                QUOTA_RETRY_MAX_SECONDS
                if limit_kind in {"account_quota_limited", "subagent_limited"}
                else RATE_LIMIT_RETRY_MAX_SECONDS
            ),
        )

        next_reasoning = dict(reasoning) if isinstance(reasoning, dict) else {}
        next_reasoning.update(
            {
                "code": "rate_limited",
                "limit_kind": limit_kind,
                "error": error,
                "retry_count": retry_count,
            }
        )
        if autoscale_workers and limit_kind in {"provider_throttled", "subagent_limited"}:
            stored_cap = next_reasoning.get("provider_capacity_worker_cap")
            if not isinstance(stored_cap, int) or isinstance(stored_cap, bool) or stored_cap < 1:
                stored_cap = current_worker_cap
            if isinstance(stored_cap, int) and not isinstance(stored_cap, bool) and stored_cap > 0:
                next_cap = max(1, stored_cap - 1)
                events = next_reasoning.get("provider_capacity_autoscale_events", 0)
                if not isinstance(events, int) or isinstance(events, bool) or events < 0:
                    events = 0
                initial_cap = next_reasoning.get("provider_capacity_initial_worker_cap")
                if not isinstance(initial_cap, int) or isinstance(initial_cap, bool) or initial_cap < 1:
                    initial_cap = stored_cap
                next_reasoning.update(
                    {
                        "provider_capacity_autoscale_enabled": True,
                        "provider_capacity_initial_worker_cap": initial_cap,
                        "provider_capacity_previous_worker_cap": stored_cap,
                        "provider_capacity_worker_cap": next_cap,
                        "provider_capacity_autoscale_events": events + (1 if next_cap < stored_cap else 0),
                        "provider_capacity_autoscaled_at": now_utc().isoformat(),
                    }
                )

        row = conn.execute(
            """
            UPDATE public.scans
            SET status = 'rate_limited',
                reasoning = %s::jsonb || jsonb_build_object(
                    'retry_after', now() + make_interval(secs => %s::double precision)
                ),
                updated_at = now()
            WHERE id = %s
              AND status IN ('running', 'prewarming_cache', 'post_processing', 'failed')
            RETURNING id
            """,
            (_json(next_reasoning), retry_delay_seconds, scan_id),
        ).fetchone()
        return row is not None

    def set_scan_status_if_current(
        self,
        conn,
        scan_id: int,
        current_status: str,
        status: str,
        *,
        error: str | None = None,
    ) -> bool:
        reasoning_sql = ", reasoning = %s" if error else ""
        if not error and status == "completed":
            reasoning_sql = ", reasoning = " + _completed_scan_reasoning_sql()
        params: list[Any] = [status]
        if error:
            params.append(_json({"error": error}))
        params.extend((scan_id, current_status))
        row = conn.execute(
            f"""
            UPDATE public.scans
            SET status = %s,
                updated_at = now()
                {reasoning_sql}
            WHERE id = %s
              AND status = %s
            RETURNING id
            """,
            params,
        ).fetchone()
        return row is not None

    def set_scan_status_if_active(
        self,
        conn,
        scan_id: int,
        status: str,
        *,
        error: str | None = None,
    ) -> bool:
        reasoning_sql = ", reasoning = %s" if error else ""
        params: list[Any] = [status]
        if error:
            params.append(_json({"error": error}))
        params.append(scan_id)
        row = conn.execute(
            f"""
            UPDATE public.scans
            SET status = %s,
                updated_at = now()
                {reasoning_sql}
            WHERE id = %s
              AND status IN ('prewarming_cache', 'running', 'post_processing')
            RETURNING id
            """,
            params,
        ).fetchone()
        return row is not None

    def load_workflow(self, conn, workflow_id: int) -> Workflow:
        workflow = conn.execute(
            "SELECT * FROM public.llm_workflows WHERE id = %s",
            (workflow_id,),
        ).fetchone()
        if not workflow:
            raise ValueError(f"workflow {workflow_id} not found")

        step_ids = [_to_int(sid) for sid in workflow["step_ids"]]
        if not step_ids:
            raise ValueError(f"workflow {workflow_id} has no steps")

        rows = conn.execute(
            "SELECT * FROM public.steps WHERE id = ANY(%s::bigint[])",
            (step_ids,),
        ).fetchall()
        by_id = {_to_int(row["id"]): row for row in rows}
        steps = []
        for order, step_id in enumerate(step_ids):
            row = by_id.get(step_id)
            if not row:
                raise ValueError(f"workflow {workflow_id} references missing step {step_id}")
            steps.append(
                Step(
                    id=step_id,
                    content=row["content"],
                    output_format=row["output_format"],
                    name=row["name"],
                    depth=row["depth"],
                    multi_output=row["multi_output"],
                    is_last_step=row["is_last_step"],
                    output_table=row["output_table"],
                    order=order,
                    consumes_all=bool(row.get("consume_all_previous", False)),
                    bound_source_step_id=(
                        _to_int(row["bound_source_step_id"]) if row.get("bound_source_step_id") is not None else None
                    ),
                )
            )
        return Workflow(id=_to_int(workflow["id"]), name=workflow["name"], steps=tuple(steps))

    def load_completed_metadata(self, conn, scan_id: int) -> set[tuple[int, int, str | None, int]]:
        return self.load_metadata_keys(conn, scan_id, ("completed",))

    def load_claimed_metadata(self, conn, scan_id: int) -> set[tuple[int, int, str | None, int]]:
        return self.load_metadata_keys(conn, scan_id, ("completed", "running"))

    def load_attempted_metadata(self, conn, scan_id: int) -> set[tuple[int, int, str | None, int]]:
        rows = conn.execute(
            """
            SELECT step_id, coalesce(prev_id, 0) AS prev_id, prev_table, coalesce(repeat_run, 1) AS repeat_run
            FROM workflows.step_metadata
            WHERE scan_id = %s
              AND coalesce(kind, 'step') = 'step'
            """,
            (scan_id,),
        ).fetchall()
        return {
            (_to_int(row["step_id"]), _to_int(row["prev_id"]), row["prev_table"], int(row["repeat_run"]))
            for row in rows
        }

    def load_metadata_keys(
        self, conn, scan_id: int, statuses: tuple[str, ...]
    ) -> set[tuple[int, int, str | None, int]]:
        rows = conn.execute(
            """
            SELECT step_id, coalesce(prev_id, 0) AS prev_id, prev_table, coalesce(repeat_run, 1) AS repeat_run
            FROM workflows.step_metadata
            WHERE scan_id = %s
              AND status = ANY(%s)
              AND coalesce(kind, 'step') = 'step'
            """,
            (scan_id, list(statuses)),
        ).fetchall()
        return {
            (_to_int(row["step_id"]), _to_int(row["prev_id"]), row["prev_table"], int(row["repeat_run"]))
            for row in rows
        }

    def load_step_results(self, conn, scan_id: int) -> dict[tuple[int, int, str | None, int], list[StepResultRow]]:
        rows = conn.execute(
            """
            SELECT id, step_id, coalesce(prev_id, 0) AS prev_id, prev_table,
                   coalesce(repeat_run, 1) AS repeat_run, json_answer
            FROM workflows.step_results
            WHERE scan_id = %s
            ORDER BY id ASC
            """,
            (scan_id,),
        ).fetchall()
        out: dict[tuple[int, int, str | None, int], list[StepResultRow]] = {}
        for row in rows:
            key = (_to_int(row["step_id"]), _to_int(row["prev_id"]), row["prev_table"], int(row["repeat_run"]))
            out.setdefault(key, []).append(
                StepResultRow(
                    id=_to_int(row["id"]),
                    step_id=_to_int(row["step_id"]),
                    prev_id=_to_int(row["prev_id"]),
                    prev_table=row["prev_table"],
                    repeat_run=int(row["repeat_run"]),
                    json_answer=row["json_answer"] or {},
                )
            )
        return out

    def load_prior_repeat_results(
        self,
        conn,
        *,
        scan_id: int,
        step_id: int,
        prev_id: int,
        prev_table: str | None,
        repeat_run: int,
    ) -> list[dict[str, Any]]:
        if repeat_run <= 1:
            return []
        rows = conn.execute(
            """
            SELECT result_kind, result_id, repeat_run, json_answer
            FROM (
                SELECT 'step_result'::text AS result_kind, r.id AS result_id,
                       coalesce(r.repeat_run, 1) AS repeat_run, r.json_answer
                FROM workflows.step_results r
                WHERE r.scan_id = %(scan_id)s
                  AND r.step_id = %(step_id)s
                  AND coalesce(r.prev_id, 0) = %(prev_id)s
                  AND r.prev_table IS NOT DISTINCT FROM %(prev_table)s
                  AND coalesce(r.repeat_run, 1) < %(repeat_run)s

                UNION ALL

                SELECT 'finding'::text AS result_kind, v.id AS result_id,
                       coalesce(v.repeat_run, 1) AS repeat_run, v.json_answer
                FROM workflows.vulnerabilities v
                JOIN workflows.step_metadata m ON m.id = v.scan_metadata_id
                WHERE v.scan_id = %(scan_id)s
                  AND m.step_id = %(step_id)s
                  AND coalesce(v.prev_id, 0) = %(prev_id)s
                  AND v.prev_table IS NOT DISTINCT FROM %(prev_table)s
                  AND coalesce(v.repeat_run, 1) < %(repeat_run)s
            ) prior
            ORDER BY repeat_run ASC, result_kind ASC, result_id ASC
            """,
            {
                "scan_id": scan_id,
                "step_id": step_id,
                "prev_id": prev_id,
                "prev_table": prev_table,
                "repeat_run": repeat_run,
            },
        ).fetchall()
        return [
            {
                "repeat_run": int(row["repeat_run"]),
                "result": row["json_answer"] or {},
            }
            for row in rows
        ]

    def load_post_script(self, conn, post_script_id: int) -> dict[str, Any] | None:
        return conn.execute("SELECT * FROM public.post_scripts WHERE id = %s", (post_script_id,)).fetchone()

    def load_agent_skills(self, conn, scan: dict[str, Any]) -> list[dict[str, Any]]:
        skill_ids = configured_agent_skill_ids(scan)
        if not skill_ids:
            return []
        rows = conn.execute(
            """
            SELECT id, slug, name, description, content, source_url, license_spdx, attribution
            FROM public.agent_skills
            WHERE id = ANY(%s::bigint[])
            """,
            (skill_ids,),
        ).fetchall()
        by_id = {_to_int(row["id"]): row for row in rows}
        return [by_id[skill_id] for skill_id in skill_ids if skill_id in by_id]

    def load_vulnerabilities(self, conn, scan_id: int) -> list[dict[str, Any]]:
        return conn.execute(
            """
            SELECT *
            FROM workflows.vulnerabilities
            WHERE scan_id = %s
            ORDER BY rank NULLS LAST, id ASC
            """,
            (scan_id,),
        ).fetchall()

    def claim_supplemental_post_script_target(self, conn) -> dict[str, Any] | None:
        """Claim one ready supplemental finding without changing the scan status."""

        candidate = conn.execute(
            """
            SELECT t.id, t.scan_id
            FROM workflows.supplemental_post_script_targets t
            INNER JOIN workflows.supplemental_post_script_runs r ON r.id = t.run_id
            INNER JOIN public.scans s ON s.id = t.scan_id
            WHERE t.status = 'pending'
              AND t.available_at <= now()
              AND r.status IN ('queued', 'running')
              AND s.status IN ('paused', 'completed', 'stopped', 'failed')
              AND NOT EXISTS (
                  SELECT 1
                  FROM workflows.step_metadata sm
                  WHERE sm.scan_id = t.scan_id
                    AND sm.status = 'running'
                    AND coalesce(sm.kind, 'step') = 'step'
              )
              AND NOT EXISTS (
                  SELECT 1
                  FROM workflows.post_process_metadata pm
                  WHERE pm.scan_id = t.scan_id
                    AND pm.status = 'running'
                    AND pm.supplemental_run_id IS NULL
              )
            ORDER BY r.inserted_at ASC, r.id ASC, t.id ASC
            FOR UPDATE OF t SKIP LOCKED
            LIMIT 1
            """
        ).fetchone()
        if not candidate:
            return None

        # Share-lock the scan so a resume/delete cannot race the target claim.
        scan = conn.execute(
            """
            SELECT *
            FROM public.scans
            WHERE id = %s
              AND status IN ('paused', 'completed', 'stopped', 'failed')
            FOR SHARE
            """,
            (_to_int(candidate["scan_id"]),),
        ).fetchone()
        if not scan:
            return None

        target = conn.execute(
            """
            UPDATE workflows.supplemental_post_script_targets
            SET status = 'running',
                attempts = attempts + 1,
                error = NULL,
                started_at = coalesce(started_at, now()),
                updated_at = now()
            WHERE id = %s AND status = 'pending'
            RETURNING *
            """,
            (_to_int(candidate["id"]),),
        ).fetchone()
        if not target:
            return None
        run = conn.execute(
            "SELECT * FROM workflows.supplemental_post_script_runs WHERE id = %s",
            (_to_int(target["run_id"]),),
        ).fetchone()
        vulnerability = conn.execute(
            """
            SELECT * FROM workflows.vulnerabilities
            WHERE id = %s AND scan_id = %s
            """,
            (_to_int(target["vulnerability_id"]), _to_int(target["scan_id"])),
        ).fetchone()
        if not run or not vulnerability:
            conn.execute(
                """
                UPDATE workflows.supplemental_post_script_targets
                SET status = 'failed', error = %s, completed_at = now(), updated_at = now()
                WHERE id = %s
                """,
                ("The selected scan or finding no longer exists.", _to_int(target["id"])),
            )
            self.refresh_supplemental_post_script_run(conn, _to_int(target["run_id"]))
            return None
        conn.execute(
            """
            UPDATE workflows.supplemental_post_script_runs
            SET status = 'running', started_at = coalesce(started_at, now()), updated_at = now()
            WHERE id = %s AND status = 'queued'
            """,
            (_to_int(run["id"]),),
        )
        run["status"] = "running"
        return {"target": target, "run": run, "scan": scan, "vulnerability": vulnerability}

    def create_supplemental_post_process_metadata(
        self,
        conn,
        *,
        target: dict[str, Any],
        run: dict[str, Any],
        scan: dict[str, Any],
        prompt_template: str,
        model: str,
        harness: str,
        thinking_effort: str | None,
        model_provider: str | None,
        run_started_at: datetime,
    ) -> int:
        row = conn.execute(
            """
            INSERT INTO workflows.post_process_metadata (
                scan_id, workflow_id, post_script_id, post_script_name, vulnerability_id,
                supplemental_run_id, kind, target_vulnerability_ids, status, phase,
                prompt_template, prompt_filled, run_started_at, run_time_ms,
                model, harness, thinking_effort, model_provider
            )
            VALUES (
                %(scan_id)s, %(workflow_id)s, %(post_script_id)s, %(post_script_name)s, %(vulnerability_id)s,
                %(supplemental_run_id)s, 'supplemental_post_script', %(target_ids)s, 'running',
                'building_workspace', %(prompt_template)s, '', %(run_started_at)s, 0,
                %(model)s, %(harness)s, %(thinking_effort)s, %(model_provider)s
            )
            RETURNING id
            """,
            {
                "scan_id": _to_int(scan["id"]),
                "workflow_id": _to_int(scan["workflow_id"]),
                "post_script_id": _to_int(run["post_script_id"]),
                "post_script_name": run["post_script_name"],
                "vulnerability_id": _to_int(target["vulnerability_id"]),
                "supplemental_run_id": _to_int(run["id"]),
                "target_ids": [_to_int(target["vulnerability_id"])],
                "prompt_template": prompt_template,
                "run_started_at": run_started_at,
                "model": model,
                "harness": harness,
                "thinking_effort": thinking_effort,
                "model_provider": model_provider,
            },
        ).fetchone()
        metadata_id = _to_int(row["id"])
        conn.execute(
            """
            UPDATE workflows.supplemental_post_script_targets
            SET post_process_metadata_id = %s, updated_at = now()
            WHERE id = %s AND status = 'running'
            """,
            (metadata_id, _to_int(target["id"])),
        )
        self.mirror_post_process_metadata(conn, metadata_id)
        return metadata_id

    def refresh_supplemental_post_script_run(self, conn, run_id: int) -> dict[str, Any] | None:
        return conn.execute(
            """
            WITH counts AS (
                SELECT
                    count(*) FILTER (WHERE status = 'completed')::integer AS completed_count,
                    count(*) FILTER (WHERE status = 'failed')::integer AS failed_count,
                    count(*) FILTER (WHERE status IN ('pending', 'running'))::integer AS open_count
                FROM workflows.supplemental_post_script_targets
                WHERE run_id = %(run_id)s
            )
            UPDATE workflows.supplemental_post_script_runs r
            SET completed_count = counts.completed_count,
                failed_count = counts.failed_count,
                status = CASE
                    WHEN counts.open_count > 0 THEN 'running'
                    WHEN counts.failed_count > 0 THEN 'completed_with_errors'
                    ELSE 'completed'
                END,
                completed_at = CASE WHEN counts.open_count = 0 THEN coalesce(r.completed_at, now()) ELSE NULL END,
                updated_at = now()
            FROM counts
            WHERE r.id = %(run_id)s
            RETURNING r.*
            """,
            {"run_id": run_id},
        ).fetchone()

    def complete_supplemental_post_script_target(self, conn, *, target_id: int, enrichment_id: int) -> bool:
        row = conn.execute(
            """
            UPDATE workflows.supplemental_post_script_targets
            SET status = 'completed', enrichment_id = %s, error = NULL,
                completed_at = now(), updated_at = now()
            WHERE id = %s AND status = 'running'
            RETURNING run_id
            """,
            (enrichment_id, target_id),
        ).fetchone()
        if not row:
            return False
        self.refresh_supplemental_post_script_run(conn, _to_int(row["run_id"]))
        return True

    def fail_supplemental_post_script_target(self, conn, *, target_id: int, error: str) -> bool:
        row = conn.execute(
            """
            UPDATE workflows.supplemental_post_script_targets
            SET status = 'failed', error = %s, completed_at = now(), updated_at = now()
            WHERE id = %s AND status = 'running'
            RETURNING run_id
            """,
            (error, target_id),
        ).fetchone()
        if not row:
            return False
        self.refresh_supplemental_post_script_run(conn, _to_int(row["run_id"]))
        return True

    def defer_supplemental_post_script_target(
        self, conn, *, target_id: int, error: str, retry_after_seconds: float
    ) -> bool:
        row = conn.execute(
            """
            UPDATE workflows.supplemental_post_script_targets
            SET status = 'pending', error = %s,
                available_at = now() + make_interval(secs => %s::double precision),
                post_process_metadata_id = NULL, updated_at = now()
            WHERE id = %s AND status = 'running'
            RETURNING run_id
            """,
            (error, max(0.0, float(retry_after_seconds)), target_id),
        ).fetchone()
        if not row:
            return False
        self.refresh_supplemental_post_script_run(conn, _to_int(row["run_id"]))
        return True

    def count_running_post_process(self, conn, scan_id: int, kind: str | None = None) -> int:
        params: list[Any] = [scan_id]
        kind_sql = ""
        if kind:
            kind_sql = " AND kind = %s"
            params.append(kind)
        row = conn.execute(
            f"""
            SELECT count(*) AS count
            FROM workflows.post_process_metadata
            WHERE scan_id = %s
              AND status = 'running'
              {kind_sql}
            """,
            params,
        ).fetchone()
        return int(row["count"])

    def next_post_process_batch_index(self, conn, scan_id: int, kind: str) -> int:
        row = conn.execute(
            """
            SELECT coalesce(max(batch_index), 0) + 1 AS batch_index
            FROM workflows.post_process_metadata
            WHERE scan_id = %s AND kind = %s
            """,
            (scan_id, kind),
        ).fetchone()
        return int(row["batch_index"])

    def claim_post_process_metadata(
        self,
        conn,
        *,
        scan_id: int,
        workflow_id: int,
        kind: str,
        batch_index: int | None,
        target_vulnerability_ids: list[int],
        prompt_template: str,
        prompt_filled: str,
        model: str,
        harness: str,
        thinking_effort: str | None,
        model_provider: str | None,
        run_started_at: datetime,
        codex_source_home: str | None = None,
        codex_account_id: str | None = None,
        codex_account_email: str | None = None,
        post_script_id: int | None = None,
        post_script_name: str | None = None,
        vulnerability_id: int | None = None,
    ) -> int | None:
        # Batch indexes are chosen before this transaction. Lock batch pipelines by
        # logical kind so two workers cannot turn the same snapshot into different
        # batch indexes; post-script jobs remain independently claimable.
        if kind == "post_script":
            lock_key = f"post-process:{scan_id}:{kind}:{post_script_id or 0}:{vulnerability_id or 0}"
        else:
            lock_key = f"post-process:{scan_id}:{kind}"
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (lock_key,))
        scan = conn.execute(
            """
            SELECT id, status, job_limit, jobs_started
            FROM public.scans
            WHERE id = %s
              AND status IN ('prewarming_cache', 'running', 'post_processing')
            FOR UPDATE
            """,
            (scan_id,),
        ).fetchone()
        if not scan:
            return None
        if kind == "post_script":
            existing = conn.execute(
                """
                SELECT id
                FROM workflows.post_process_metadata
                WHERE scan_id = %s
                  AND kind = %s
                  AND vulnerability_id = %s
                  AND post_script_id = %s
                  AND status IN ('running', 'completed')
                LIMIT 1
                """,
                (scan_id, kind, vulnerability_id, post_script_id),
            ).fetchone()
        else:
            # The scan row lock serializes this recheck with every other claim.
            existing = conn.execute(
                """
                SELECT id
                FROM workflows.post_process_metadata
                WHERE scan_id = %s
                  AND kind = %s
                  AND (
                      status = 'running'
                      OR (batch_index = %s AND status = 'completed')
                  )
                LIMIT 1
                """,
                (scan_id, kind, batch_index),
            ).fetchone()
        if existing:
            return None
        expected_target_ids = sorted(set(target_vulnerability_ids))
        if kind in {"dedupe", "ranker"}:
            if not expected_target_ids:
                return None
            target_state = (
                "dedupe_is_canonical IS NULL"
                if kind == "dedupe"
                else "dedupe_is_canonical = true AND bounty_rank IS NULL"
            )
            eligible = conn.execute(
                f"""
                SELECT count(*) AS count
                FROM workflows.vulnerabilities
                WHERE scan_id = %s
                  AND id = ANY(%s::bigint[])
                  AND {target_state}
                """,
                (scan_id, expected_target_ids),
            ).fetchone()
            if int(eligible["count"]) != len(expected_target_ids):
                return None
        previous = conn.execute(
            """
            SELECT id
            FROM workflows.post_process_metadata
            WHERE scan_id = %s
              AND kind = %s
              AND (
                  (%s = 'post_script' AND vulnerability_id = %s AND post_script_id = %s)
                  OR (%s <> 'post_script' AND batch_index = %s)
              )
            LIMIT 1
            """,
            (scan_id, kind, kind, vulnerability_id, post_script_id, kind, batch_index),
        ).fetchone()
        if not self.claim_logical_job_slot(
            conn,
            scan=scan,
            scan_id=scan_id,
            already_started=previous is not None,
        ):
            return None
        row = conn.execute(
            """
            INSERT INTO workflows.post_process_metadata (
                scan_id, workflow_id, post_script_id, post_script_name, vulnerability_id,
                kind, batch_index, target_vulnerability_ids, status, phase, prompt_template,
                prompt_filled, run_started_at, run_time_ms, codex_source_home, codex_account_id,
                codex_account_email, model, harness, thinking_effort, model_provider
            )
            VALUES (
                %(scan_id)s, %(workflow_id)s, %(post_script_id)s, %(post_script_name)s, %(vulnerability_id)s,
                %(kind)s, %(batch_index)s, %(target_vulnerability_ids)s, 'running', 'building_workspace', %(prompt_template)s,
                %(prompt_filled)s, %(run_started_at)s, 0, %(codex_source_home)s, %(codex_account_id)s,
                %(codex_account_email)s, %(model)s, %(harness)s, %(thinking_effort)s, %(model_provider)s
            )
            RETURNING id
            """,
            {
                "scan_id": scan_id,
                "workflow_id": workflow_id,
                "post_script_id": post_script_id,
                "post_script_name": post_script_name,
                "vulnerability_id": vulnerability_id,
                "kind": kind,
                "batch_index": batch_index,
                "target_vulnerability_ids": target_vulnerability_ids,
                "prompt_template": prompt_template,
                "prompt_filled": prompt_filled,
                "run_started_at": run_started_at,
                "codex_source_home": codex_source_home,
                "codex_account_id": codex_account_id,
                "codex_account_email": codex_account_email,
                "model": model,
                "harness": harness,
                "thinking_effort": thinking_effort,
                "model_provider": model_provider,
            },
        ).fetchone()
        metadata_id = _to_int(row["id"])
        self.mirror_post_process_metadata(conn, metadata_id)
        return metadata_id

    def mirror_post_process_metadata(self, conn, metadata_id: int):
        conn.execute(
            """
            INSERT INTO workflows.step_metadata (
                scan_id, workflow_id, step_id, prev_id, prev_table, repeat_run,
                status, phase, error, kind, post_process_metadata_id, post_script_id,
                post_script_name, vulnerability_id, supplemental_run_id,
                target_vulnerability_ids, batch_index,
                prompt_template, prompt_filled, output_json, checked_out_commit,
                run_started_at, run_time_ms, raw_token_usage, token_count_cached_input,
                token_count_input, token_count_output, token_count_reasoning_output,
                token_count_total, codex_session_id, codex_source_home, codex_account_id,
                codex_account_email, model, harness, thinking_effort, model_provider, subagent_count,
                inserted_at, updated_at
            )
            SELECT
                p.scan_id,
                p.workflow_id,
                0,
                p.vulnerability_id,
                CASE WHEN p.vulnerability_id IS NULL THEN NULL ELSE 'workflows.vulnerabilities' END,
                1,
                p.status,
                p.phase,
                p.error,
                p.kind,
                p.id,
                p.post_script_id,
                p.post_script_name,
                p.vulnerability_id,
                p.supplemental_run_id,
                p.target_vulnerability_ids,
                p.batch_index,
                p.prompt_template,
                p.prompt_filled,
                p.output_json,
                p.checked_out_commit,
                p.run_started_at,
                p.run_time_ms,
                p.raw_token_usage,
                p.token_count_cached_input,
                p.token_count_input,
                p.token_count_output,
                p.token_count_reasoning_output,
                p.token_count_total,
                p.codex_session_id,
                p.codex_source_home,
                p.codex_account_id,
                p.codex_account_email,
                p.model,
                p.harness,
                p.thinking_effort,
                p.model_provider,
                p.subagent_count,
                p.inserted_at,
                p.updated_at
            FROM workflows.post_process_metadata p
            WHERE p.id = %(metadata_id)s
            ON CONFLICT (post_process_metadata_id)
                WHERE kind <> 'step' AND post_process_metadata_id IS NOT NULL
            DO UPDATE SET
                scan_id = EXCLUDED.scan_id,
                workflow_id = EXCLUDED.workflow_id,
                prev_id = EXCLUDED.prev_id,
                prev_table = EXCLUDED.prev_table,
                repeat_run = EXCLUDED.repeat_run,
                status = EXCLUDED.status,
                phase = EXCLUDED.phase,
                error = EXCLUDED.error,
                kind = EXCLUDED.kind,
                post_script_id = EXCLUDED.post_script_id,
                post_script_name = EXCLUDED.post_script_name,
                vulnerability_id = EXCLUDED.vulnerability_id,
                supplemental_run_id = EXCLUDED.supplemental_run_id,
                target_vulnerability_ids = EXCLUDED.target_vulnerability_ids,
                batch_index = EXCLUDED.batch_index,
                prompt_template = EXCLUDED.prompt_template,
                prompt_filled = EXCLUDED.prompt_filled,
                output_json = EXCLUDED.output_json,
                checked_out_commit = EXCLUDED.checked_out_commit,
                run_started_at = EXCLUDED.run_started_at,
                run_time_ms = EXCLUDED.run_time_ms,
                raw_token_usage = EXCLUDED.raw_token_usage,
                token_count_cached_input = EXCLUDED.token_count_cached_input,
                token_count_input = EXCLUDED.token_count_input,
                token_count_output = EXCLUDED.token_count_output,
                token_count_reasoning_output = EXCLUDED.token_count_reasoning_output,
                token_count_total = EXCLUDED.token_count_total,
                codex_session_id = EXCLUDED.codex_session_id,
                codex_source_home = EXCLUDED.codex_source_home,
                codex_account_id = EXCLUDED.codex_account_id,
                codex_account_email = EXCLUDED.codex_account_email,
                model = EXCLUDED.model,
                harness = EXCLUDED.harness,
                thinking_effort = EXCLUDED.thinking_effort,
                model_provider = EXCLUDED.model_provider,
                subagent_count = EXCLUDED.subagent_count,
                updated_at = EXCLUDED.updated_at
            """,
            {"metadata_id": metadata_id},
        )

    def update_post_process_metadata(
        self,
        conn,
        metadata_id: int,
        *,
        status: str,
        error: str | None,
        run_time_ms: int,
        raw_token_usage: dict[str, Any] | None,
        output_json: dict[str, Any] | None = None,
        codex_session_id: str | None = None,
        checked_out_commit: str | None = None,
        prompt_filled: str | None = None,
        phase: str | None = None,
        codex_source_home: str | None = None,
        codex_account_id: str | None = None,
        codex_account_email: str | None = None,
    ):
        conn.execute(
            """
            UPDATE workflows.post_process_metadata
            SET status = %(status)s,
                phase = coalesce(%(phase)s, phase),
                error = %(error)s,
                output_json = %(output_json)s,
                prompt_filled = coalesce(%(prompt_filled)s, prompt_filled),
                checked_out_commit = coalesce(%(checked_out_commit)s, checked_out_commit),
                run_time_ms = %(run_time_ms)s,
                raw_token_usage = %(raw_token_usage)s,
                token_count_cached_input = %(cached_input)s,
                token_count_input = %(input_tokens)s,
                token_count_output = %(output_tokens)s,
                token_count_reasoning_output = %(reasoning_output)s,
                token_count_total = %(total_tokens)s,
                subagent_count = %(subagent_count)s,
                codex_session_id = %(codex_session_id)s,
                codex_source_home = coalesce(%(codex_source_home)s, codex_source_home),
                codex_account_id = coalesce(%(codex_account_id)s, codex_account_id),
                codex_account_email = coalesce(%(codex_account_email)s, codex_account_email),
                updated_at = now()
            WHERE id = %(metadata_id)s
            """,
            {
                "metadata_id": metadata_id,
                "status": status,
                "phase": phase,
                "error": error,
                "output_json": _json(output_json),
                "run_time_ms": run_time_ms,
                "raw_token_usage": _json(raw_token_usage),
                "cached_input": _json(_usage_part(raw_token_usage, "cached_input_tokens")),
                "input_tokens": _json(_usage_part(raw_token_usage, "input_tokens")),
                "output_tokens": _json(_usage_part(raw_token_usage, "output_tokens")),
                "reasoning_output": _json(_usage_part(raw_token_usage, "reasoning_output_tokens")),
                "total_tokens": _json(_usage_part(raw_token_usage, "total_tokens")),
                "subagent_count": _usage_subagent_count(raw_token_usage),
                "codex_session_id": codex_session_id,
                "codex_source_home": codex_source_home,
                "codex_account_id": codex_account_id,
                "codex_account_email": codex_account_email,
                "checked_out_commit": checked_out_commit,
                "prompt_filled": prompt_filled,
            },
        )
        self.mirror_post_process_metadata(conn, metadata_id)

    def apply_dedupe_mapping(
        self,
        conn,
        *,
        scan_id: int,
        dedupe_run_id: int,
        dedupe_model: str,
        mapping: dict[int, tuple[int, bool, str, str]],
    ) -> int:
        if not mapping:
            return 0
        items = list(mapping.items())
        values_sql = ", ".join(["(%s,%s,%s,%s,%s)"] * len(items))
        params: list[Any] = [dedupe_run_id, dedupe_model]
        for row_id, (canonical_id, is_canonical, cluster_id, reason) in items:
            params.extend([int(row_id), bool(is_canonical), int(canonical_id), cluster_id, reason])
        params.append(scan_id)
        conn.execute(
            f"""
            UPDATE workflows.vulnerabilities AS v
            SET dedupe_run_id = %s,
                dedupe_model = %s,
                dedupe_is_canonical = m.dedupe_is_canonical,
                dedupe_canonical_id = m.dedupe_canonical_id,
                dedupe_cluster_id = m.dedupe_cluster_id,
                dedupe_reason = m.dedupe_reason,
                updated_at = now()
            FROM (VALUES {values_sql}) AS m(id, dedupe_is_canonical, dedupe_canonical_id, dedupe_cluster_id, dedupe_reason)
            WHERE v.id = m.id
              AND v.scan_id = %s
            """,
            params,
        )
        return len(items)

    def apply_rank_updates(
        self,
        conn,
        *,
        scan_id: int,
        updates: list[dict[str, Any]],
    ) -> int:
        for item in updates:
            conn.execute(
                """
                UPDATE workflows.vulnerabilities
                SET bounty_rank_response = coalesce(%(bounty_rank_response)s, bounty_rank_response),
                    bounty_rank = %(bounty_rank)s,
                    bounty_rank_impact_level = coalesce(%(bounty_rank_impact_level)s, bounty_rank_impact_level),
                    bounty_rank_minimum_reward = coalesce(%(bounty_rank_minimum_reward)s, bounty_rank_minimum_reward),
                    bounty_rank_maximum_reward = coalesce(%(bounty_rank_maximum_reward)s, bounty_rank_maximum_reward),
                    bounty_rank_reasoning = coalesce(%(bounty_rank_reasoning)s, bounty_rank_reasoning),
                    rank_root_bug = coalesce(%(rank_root_bug)s, rank_root_bug),
                    bounty_rank_missing_from_prompt = coalesce(%(bounty_rank_missing_from_prompt)s, bounty_rank_missing_from_prompt),
                    bounty_rank_total_issues = coalesce(%(bounty_rank_total_issues)s, bounty_rank_total_issues),
                    bounty_rank_run_id = coalesce(%(bounty_rank_run_id)s, bounty_rank_run_id),
                    bounty_rank_model = coalesce(%(bounty_rank_model)s, bounty_rank_model),
                    bounty_rank_ts = coalesce(%(bounty_rank_ts)s, bounty_rank_ts),
                    rank = %(bounty_rank)s,
                    updated_at = now()
                WHERE scan_id = %(scan_id)s
                  AND id = %(id)s
                """,
                {
                    "scan_id": scan_id,
                    "id": int(item["id"]),
                    "bounty_rank_response": _json(item.get("bounty_rank_response")),
                    "bounty_rank": int(item["bounty_rank"]),
                    "bounty_rank_impact_level": item.get("bounty_rank_impact_level"),
                    "bounty_rank_minimum_reward": item.get("bounty_rank_minimum_reward"),
                    "bounty_rank_maximum_reward": item.get("bounty_rank_maximum_reward"),
                    "bounty_rank_reasoning": item.get("bounty_rank_reasoning"),
                    "rank_root_bug": item.get("rank_root_bug"),
                    "bounty_rank_missing_from_prompt": item.get("bounty_rank_missing_from_prompt"),
                    "bounty_rank_total_issues": item.get("bounty_rank_total_issues"),
                    "bounty_rank_run_id": item.get("bounty_rank_run_id"),
                    "bounty_rank_model": item.get("bounty_rank_model"),
                    "bounty_rank_ts": item.get("bounty_rank_ts"),
                },
            )
        return len(updates)

    def upsert_vulnerability_enrichment(
        self,
        conn,
        *,
        scan_id: int,
        vulnerability_id: int,
        post_script_id: int,
        post_script_name: str,
        result: dict[str, Any] | None,
        stub: bool,
        stub_explanation: str | None,
        supplemental_run_id: int | None = None,
    ) -> int:
        if supplemental_run_id is not None:
            row = conn.execute(
                """
                INSERT INTO workflows.vulnerability_enrichments (
                    scan_id, vulnerability_id, post_script_id, post_script_name,
                    result, stub, stub_explanation, supplemental_run_id
                )
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (supplemental_run_id, vulnerability_id)
                    WHERE supplemental_run_id IS NOT NULL
                DO UPDATE SET
                    scan_id = EXCLUDED.scan_id,
                    post_script_id = EXCLUDED.post_script_id,
                    post_script_name = EXCLUDED.post_script_name,
                    result = EXCLUDED.result,
                    stub = EXCLUDED.stub,
                    stub_explanation = EXCLUDED.stub_explanation,
                    updated_at = now()
                RETURNING id
                """,
                (
                    scan_id,
                    vulnerability_id,
                    post_script_id,
                    post_script_name,
                    _json(result),
                    stub,
                    stub_explanation,
                    supplemental_run_id,
                ),
            ).fetchone()
            return _to_int(row["id"])
        row = conn.execute(
            """
            INSERT INTO workflows.vulnerability_enrichments (
                scan_id, vulnerability_id, post_script_id, post_script_name,
                result, stub, stub_explanation
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (vulnerability_id, post_script_id)
                WHERE supplemental_run_id IS NULL
            DO UPDATE SET
                scan_id = EXCLUDED.scan_id,
                post_script_name = EXCLUDED.post_script_name,
                result = EXCLUDED.result,
                stub = EXCLUDED.stub,
                stub_explanation = EXCLUDED.stub_explanation,
                updated_at = now()
            RETURNING id
            """,
            (scan_id, vulnerability_id, post_script_id, post_script_name, _json(result), stub, stub_explanation),
        ).fetchone()
        return _to_int(row["id"])

    def insert_metadata(
        self,
        conn,
        *,
        scan_id: int,
        workflow_id: int,
        step_id: int,
        prev_id: int,
        prev_table: str | None,
        repeat_run: int,
        status: str,
        error: str | None,
        prompt_template: str,
        prompt_filled: str,
        checked_out_commit: str | None,
        run_started_at: datetime,
        run_time_ms: int,
        raw_token_usage: dict[str, Any] | None,
        codex_session_id: str | None = None,
        codex_source_home: str | None = None,
        codex_account_id: str | None = None,
        codex_account_email: str | None = None,
        model: str | None = None,
        harness: str | None = None,
        thinking_effort: str | None = None,
        model_provider: str | None = None,
        stub_explanation: str | None = None,
        phase: str | None = None,
    ) -> int:
        row = conn.execute(
            """
            INSERT INTO workflows.step_metadata (
                scan_id, workflow_id, step_id, prev_id, prev_table, repeat_run,
                status, phase, error, stub_explanation, prompt_template, prompt_filled, checked_out_commit,
                run_started_at, run_time_ms, raw_token_usage,
                token_count_cached_input, token_count_input, token_count_output,
                token_count_reasoning_output, token_count_total, codex_session_id,
                codex_source_home, codex_account_id, codex_account_email,
                model, harness, thinking_effort, model_provider, subagent_count
            )
            VALUES (
                %(scan_id)s, %(workflow_id)s, %(step_id)s, %(prev_id)s, %(prev_table)s, %(repeat_run)s,
                %(status)s, %(phase)s, %(error)s, %(stub_explanation)s, %(prompt_template)s, %(prompt_filled)s, %(checked_out_commit)s,
                %(run_started_at)s, %(run_time_ms)s, %(raw_token_usage)s,
                %(cached_input)s, %(input_tokens)s, %(output_tokens)s,
                %(reasoning_output)s, %(total_tokens)s, %(codex_session_id)s,
                %(codex_source_home)s, %(codex_account_id)s, %(codex_account_email)s,
                %(model)s, %(harness)s, %(thinking_effort)s, %(model_provider)s, %(subagent_count)s
            )
            RETURNING id
            """,
            {
                "scan_id": scan_id,
                "workflow_id": workflow_id,
                "step_id": step_id,
                "prev_id": prev_id,
                "prev_table": prev_table,
                "repeat_run": repeat_run,
                "status": status,
                "phase": phase,
                "error": error,
                "stub_explanation": stub_explanation,
                "prompt_template": prompt_template,
                "prompt_filled": prompt_filled,
                "checked_out_commit": checked_out_commit,
                "run_started_at": run_started_at,
                "run_time_ms": run_time_ms,
                "raw_token_usage": _json(raw_token_usage),
                "cached_input": _json(_usage_part(raw_token_usage, "cached_input_tokens")),
                "input_tokens": _json(_usage_part(raw_token_usage, "input_tokens")),
                "output_tokens": _json(_usage_part(raw_token_usage, "output_tokens")),
                "reasoning_output": _json(_usage_part(raw_token_usage, "reasoning_output_tokens")),
                "total_tokens": _json(_usage_part(raw_token_usage, "total_tokens")),
                "subagent_count": _usage_subagent_count(raw_token_usage),
                "codex_session_id": codex_session_id,
                "codex_source_home": codex_source_home,
                "codex_account_id": codex_account_id,
                "codex_account_email": codex_account_email,
                "model": model,
                "harness": harness,
                "thinking_effort": thinking_effort,
                "model_provider": model_provider,
            },
        ).fetchone()
        return _to_int(row["id"])

    def claim_step_metadata(
        self,
        conn,
        *,
        scan_id: int,
        workflow_id: int,
        step_id: int,
        prev_id: int,
        prev_table: str | None,
        repeat_run: int,
        prompt_template: str,
        prompt_filled: str,
        checked_out_commit: str | None,
        run_started_at: datetime,
        model: str | None = None,
        harness: str | None = None,
        thinking_effort: str | None = None,
        model_provider: str | None = None,
        codex_source_home: str | None = None,
        codex_account_id: str | None = None,
        codex_account_email: str | None = None,
    ) -> int | None:
        lock_key = f"{scan_id}:{step_id}:{prev_id}:{prev_table or ''}:{repeat_run}"
        conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (lock_key,))
        scan = conn.execute(
            """
            SELECT id, status, job_limit, jobs_started
            FROM public.scans
            WHERE id = %s
              AND status IN ('prewarming_cache', 'running', 'post_processing')
            FOR UPDATE
            """,
            (scan_id,),
        ).fetchone()
        if not scan:
            return None
        existing = conn.execute(
            """
            SELECT id
            FROM workflows.step_metadata
            WHERE scan_id = %s
              AND step_id = %s
              AND coalesce(prev_id, 0) = %s
              AND prev_table IS NOT DISTINCT FROM %s
              AND coalesce(repeat_run, 1) = %s
              AND status IN ('running', 'completed')
              AND coalesce(kind, 'step') = 'step'
            LIMIT 1
            """,
            (scan_id, step_id, prev_id, prev_table, repeat_run),
        ).fetchone()
        if existing:
            return None
        previous = conn.execute(
            """
            SELECT id
            FROM workflows.step_metadata
            WHERE scan_id = %s
              AND step_id = %s
              AND coalesce(prev_id, 0) = %s
              AND prev_table IS NOT DISTINCT FROM %s
              AND coalesce(repeat_run, 1) = %s
              AND coalesce(kind, 'step') = 'step'
            LIMIT 1
            """,
            (scan_id, step_id, prev_id, prev_table, repeat_run),
        ).fetchone()
        if not self.claim_logical_job_slot(
            conn,
            scan=scan,
            scan_id=scan_id,
            already_started=previous is not None,
        ):
            return None
        return self.insert_metadata(
            conn,
            scan_id=scan_id,
            workflow_id=workflow_id,
            step_id=step_id,
            prev_id=prev_id,
            prev_table=prev_table,
            repeat_run=repeat_run,
            status="running",
            error=None,
            prompt_template=prompt_template,
            prompt_filled=prompt_filled,
            checked_out_commit=checked_out_commit,
            run_started_at=run_started_at,
            run_time_ms=0,
            raw_token_usage=None,
            phase="building_workspace",
            model=model,
            harness=harness,
            thinking_effort=thinking_effort,
            model_provider=model_provider,
            codex_source_home=codex_source_home,
            codex_account_id=codex_account_id,
            codex_account_email=codex_account_email,
        )

    def update_metadata(
        self,
        conn,
        metadata_id: int,
        *,
        status: str,
        error: str | None,
        run_time_ms: int,
        raw_token_usage: dict[str, Any] | None,
        codex_session_id: str | None = None,
        checked_out_commit: str | None = None,
        stub: bool | None = None,
        stub_explanation: str | None = None,
        prompt_filled: str | None = None,
        phase: str | None = None,
        codex_source_home: str | None = None,
        codex_account_id: str | None = None,
        codex_account_email: str | None = None,
    ):
        conn.execute(
            """
            UPDATE workflows.step_metadata
            SET status = %(status)s,
                phase = coalesce(%(phase)s, phase),
                error = %(error)s,
                prompt_filled = coalesce(%(prompt_filled)s, prompt_filled),
                checked_out_commit = coalesce(%(checked_out_commit)s, checked_out_commit),
                stub = coalesce(%(stub)s, stub),
                stub_explanation = coalesce(%(stub_explanation)s, stub_explanation),
                run_time_ms = %(run_time_ms)s,
                raw_token_usage = %(raw_token_usage)s,
                token_count_cached_input = %(cached_input)s,
                token_count_input = %(input_tokens)s,
                token_count_output = %(output_tokens)s,
                token_count_reasoning_output = %(reasoning_output)s,
                token_count_total = %(total_tokens)s,
                subagent_count = %(subagent_count)s,
                codex_session_id = %(codex_session_id)s,
                codex_source_home = coalesce(%(codex_source_home)s, codex_source_home),
                codex_account_id = coalesce(%(codex_account_id)s, codex_account_id),
                codex_account_email = coalesce(%(codex_account_email)s, codex_account_email),
                updated_at = now()
            WHERE id = %(metadata_id)s
            """,
            {
                "metadata_id": metadata_id,
                "status": status,
                "phase": phase,
                "error": error,
                "run_time_ms": run_time_ms,
                "raw_token_usage": _json(raw_token_usage),
                "cached_input": _json(_usage_part(raw_token_usage, "cached_input_tokens")),
                "input_tokens": _json(_usage_part(raw_token_usage, "input_tokens")),
                "output_tokens": _json(_usage_part(raw_token_usage, "output_tokens")),
                "reasoning_output": _json(_usage_part(raw_token_usage, "reasoning_output_tokens")),
                "total_tokens": _json(_usage_part(raw_token_usage, "total_tokens")),
                "subagent_count": _usage_subagent_count(raw_token_usage),
                "codex_session_id": codex_session_id,
                "codex_source_home": codex_source_home,
                "codex_account_id": codex_account_id,
                "codex_account_email": codex_account_email,
                "checked_out_commit": checked_out_commit,
                "stub": stub,
                "stub_explanation": stub_explanation,
                "prompt_filled": prompt_filled,
            },
        )

    def insert_step_result(
        self,
        conn,
        *,
        scan_id: int,
        workflow_id: int,
        step_id: int,
        depth: int,
        prev_id: int,
        prev_table: str | None,
        repeat_run: int,
        json_answer: dict[str, Any],
    ) -> int:
        row = conn.execute(
            """
            INSERT INTO workflows.step_results (
                step_id, scan_id, workflow_id, partition_key,
                prev_id, prev_table, repeat_run, json_answer
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                step_id,
                scan_id,
                workflow_id,
                f"{scan_id}-{depth}",
                prev_id,
                prev_table,
                repeat_run,
                _json(json_answer),
            ),
        ).fetchone()
        return _to_int(row["id"])

    def next_vulnerability_rank(self, conn, scan_id: int) -> int:
        row = conn.execute(
            "SELECT coalesce(max(rank), 0) + 1 AS rank FROM workflows.vulnerabilities WHERE scan_id = %s",
            (scan_id,),
        ).fetchone()
        return int(row["rank"])

    def insert_vulnerability(
        self,
        conn,
        *,
        scan_id: int,
        workflow_id: int,
        scan_metadata_id: int,
        prev_id: int,
        prev_table: str | None,
        repeat_run: int,
        rank: int,
        json_answer: dict[str, Any],
    ) -> int:
        row = conn.execute(
            """
            INSERT INTO workflows.vulnerabilities (
                scan_id, workflow_id, scan_metadata_id, prev_id, prev_table,
                repeat_run, rank, json_answer
            )
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING id
            """,
            (
                scan_id,
                workflow_id,
                scan_metadata_id,
                prev_id,
                prev_table,
                repeat_run,
                rank,
                _json(json_answer),
            ),
        ).fetchone()
        return _to_int(row["id"])

    def mark_orphaned_running_metadata_interrupted(
        self,
        conn,
        *,
        engine_started_at: datetime,
        error: str,
    ) -> dict[str, int]:
        step_rows = conn.execute(
            """
            UPDATE workflows.step_metadata m
            SET status = 'stopped',
                phase = 'interrupted',
                error = %(error)s,
                updated_at = now()
            FROM public.scans s
            WHERE m.scan_id = s.id
              AND m.status = 'running'
              AND coalesce(m.kind, 'step') = 'step'
              AND m.updated_at < %(engine_started_at)s
            RETURNING m.id
            """,
            {"engine_started_at": engine_started_at, "error": error},
        ).fetchall()

        post_rows = conn.execute(
            """
            UPDATE workflows.post_process_metadata p
            SET status = 'stopped',
                phase = 'interrupted',
                error = %(error)s,
                updated_at = now()
            FROM public.scans s
            WHERE p.scan_id = s.id
              AND p.status = 'running'
              AND p.updated_at < %(engine_started_at)s
            RETURNING p.id
            """,
            {"engine_started_at": engine_started_at, "error": error},
        ).fetchall()

        post_ids = [_to_int(row["id"]) for row in post_rows]
        if post_ids:
            conn.execute(
                """
                UPDATE workflows.step_metadata
                SET status = 'stopped',
                    phase = 'interrupted',
                    error = %(error)s,
                    updated_at = now()
                WHERE post_process_metadata_id = ANY(%(post_ids)s::bigint[])
                """,
                {"post_ids": post_ids, "error": error},
            )

        supplemental_rows = conn.execute(
            """
            UPDATE workflows.supplemental_post_script_targets
            SET status = 'pending',
                error = %(error)s,
                post_process_metadata_id = NULL,
                available_at = now(),
                updated_at = now()
            WHERE status = 'running'
              AND updated_at < %(engine_started_at)s
            RETURNING run_id
            """,
            {"engine_started_at": engine_started_at, "error": error},
        ).fetchall()
        for run_id in {_to_int(row["run_id"]) for row in supplemental_rows}:
            self.refresh_supplemental_post_script_run(conn, run_id)

        return {"step": len(step_rows), "post": len(post_rows), "supplemental": len(supplemental_rows)}

    def load_artifact_cleanup_state(
        self,
        conn,
        *,
        retain_inactive_scan_caches_after: datetime,
        retain_finished_workspaces_after: datetime,
    ) -> tuple[set[int], set[int]]:
        # Keep cleanup mutually exclusive with scan admission. This prevents a
        # completed/failed scan from being resumed while its stale cache is
        # being removed; after this transaction commits, admission can safely
        # rebuild any cache that was intentionally expired.
        conn.execute("SELECT pg_advisory_xact_lock(%s, %s)", QUEUED_SCAN_ADMISSION_LOCK)
        workspace_rows = conn.execute(
            """
            SELECT id::bigint AS workspace_id
            FROM workflows.step_metadata
            WHERE (status = 'running' OR updated_at >= %s)
              AND coalesce(kind, 'step') = 'step'
            UNION ALL
            SELECT (%s::bigint + id)::bigint AS workspace_id
            FROM workflows.post_process_metadata
            WHERE status = 'running' OR updated_at >= %s
            """,
            (retain_finished_workspaces_after, POST_WORKSPACE_ID_OFFSET, retain_finished_workspaces_after),
        ).fetchall()
        scan_rows = conn.execute(
            """
            SELECT id
            FROM public.scans
            WHERE status IN ('queued', 'pending', 'prewarming_cache', 'running', 'post_processing', 'rate_limited')
               OR (
                    status IN ('paused', 'failed', 'stopped')
                    AND updated_at >= %s
               )
            """,
            (retain_inactive_scan_caches_after,),
        ).fetchall()
        return (
            {_to_int(row["workspace_id"]) for row in workspace_rows},
            {_to_int(row["id"]) for row in scan_rows},
        )

    def load_active_scan_cache_specs(self, conn) -> list[dict[str, Any]]:
        return conn.execute(
            """
            SELECT id, repo_kind, repo_full, commit_sha, dependencies, dependencies_detail
            FROM public.scans
            WHERE status IN ('queued', 'pending', 'prewarming_cache', 'running', 'rate_limited', 'post_processing')
            """
        ).fetchall()


def now_utc():
    return datetime.now(timezone.utc)


def _usage_part(raw_token_usage: dict[str, Any] | None, key: str):
    if not raw_token_usage:
        return None
    if key in raw_token_usage:
        return raw_token_usage[key]
    usage = raw_token_usage.get("usage") if isinstance(raw_token_usage.get("usage"), dict) else None
    if usage and key in usage:
        return usage[key]
    return None


def _usage_subagent_count(raw_token_usage: dict[str, Any] | None) -> int:
    if not raw_token_usage:
        return 0
    subagents = raw_token_usage.get("subagents")
    if not isinstance(subagents, dict):
        usage = raw_token_usage.get("usage") if isinstance(raw_token_usage.get("usage"), dict) else None
        subagents = (
            usage.get("subagents") if isinstance(usage, dict) and isinstance(usage.get("subagents"), dict) else None
        )
    if isinstance(subagents, dict):
        value = subagents.get("count")
        try:
            return max(0, int(value or 0))
        except (TypeError, ValueError):
            return 0
    return 0

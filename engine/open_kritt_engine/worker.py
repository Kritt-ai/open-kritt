import logging
import random
import shutil
import threading
import time
import unicodedata
from datetime import timedelta
from typing import Any

from .artifact_cleanup import (
    ArtifactCleanupResult,
    cleanup_checkout_caches,
    cleanup_legacy_checkout_cache,
    cleanup_legacy_repo_cache,
    cleanup_legacy_scan_workspaces,
    cleanup_orphaned_job_workspaces,
    cleanup_persisted_scan_caches,
    collect_quarantined_artifacts,
    delete_quarantined_artifacts,
)
from .claude_auth import ClaudeCredentialRateLimited
from .codex_updater import CodexCliGate, CodexUpdater
from .config import EngineConfig
from .db import QUOTA_RETRY_MAX_SECONDS, Database, now_utc
from .generation import GenerationRunner, GenerationValidationError
from .harnesses import (
    CAPACITY_RATE_LIMIT_FAILURES,
    RETRYABLE_RATE_LIMIT_FAILURES,
    HarnessError,
    cleanup_stale_scan_sandboxes,
    harness_failure_retry_count,
    harness_for,
    normalize_harness_name,
    scan_model_provider,
    validate_scan_runner_configuration,
)
from .memory_budget import (
    GIB,
    MIB,
    MemoryCapacity,
    calculate_memory_capacity,
    system_memory_available_bytes,
    system_memory_total_bytes,
)
from .model_catalog import ModelCatalogRefresher
from .model_output_artifacts import record_model_error_output
from .models import (
    ModelSelection,
    model_selection_for_depth,
    post_processing_model_selection,
    supplemental_post_script_model_selection,
)
from .post_processing import PostProcessor, PostProcessRateLimited
from .prompting import (
    harness_prompt,
    native_agent_skills_prompt,
    patched_since_prompt,
    render_prompt,
    repeat_append_prompt,
)
from .provider_credentials import provider_environment
from .queue import build_pending_jobs, configured_step_ids
from .runtime_config import runtime_bool, runtime_config_path, runtime_float, runtime_int, runtime_value
from .schema import OutputValidationError, output_schema, validate_payload
from .storage_cleanup import prune_docker_build_cache, prune_stopped_scan_containers, prune_unused_docker_images
from .workspace import (
    cleanup_job_workspace,
    cleanup_workspace,
    image_workspace_enabled,
    mark_provider_account_available,
    mark_provider_account_rate_limited,
    prepare_dependency_workspace,
    prewarm_scan_checkout_cache,
    provider_account_lease,
    provider_accounts_all_rate_limited,
    resolve_scan_checkout_revisions,
    restore_persistent_scan_checkout_cache,
    save_persistent_scan_checkout_cache,
    scan_checkout_cache_entry_names,
    scan_checkout_cache_entry_prefixes,
    scan_checkout_cache_key,
    workspace_context,
    workspace_prompt_context,
)
from .workspace_snapshots import cleanup_stale_workspace_snapshot_builders

LOGGER = logging.getLogger("open_kritt_engine")
NON_RUNNABLE_SCAN_STATUSES = {"queued", "pending", "rate_limited", "paused", "stopped", "failed", "completed"}
PREWARMING_SCAN_STATUS = "prewarming_cache"
ORPHANED_METADATA_ERROR = "interrupted by engine restart"
GENERATION_HEARTBEAT_INTERVAL_SECONDS = 15.0
GENERATION_STALE_AFTER_SECONDS = 60
GENERATION_RECOVERY_INTERVAL_SECONDS = 15.0
GENERATION_VALIDATION_ERROR_LIMIT = 25
GENERATION_VALIDATION_FIELD_LIMIT = 200
GENERATION_VALIDATION_MESSAGE_LIMIT = 1000
GENERATION_PERSISTENCE_ERROR = "Generated draft could not be saved. Please try again."
RATE_LIMIT_BACKOFF_BASE_SECONDS = 5.0
RATE_LIMIT_BACKOFF_MAX_SECONDS = 60.0
RATE_LIMIT_RETRY_AFTER_MAX_SECONDS = 300.0
RATE_LIMIT_RESUME_DELAY_SECONDS = 60.0
ARTIFACT_CLEANUP_INTERVAL_SECONDS = 5 * 60.0
ARTIFACT_CLEANUP_GRACE_SECONDS = 5 * 60.0


class StepExecutionError(RuntimeError):
    pass


class RateLimitExhausted(StepExecutionError):
    def __init__(
        self,
        message: str,
        *,
        retry_after_seconds: float,
        provider: str | None = None,
        account_home: str | None = None,
        limit_kind: str = "rate_limited",
    ):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds
        self.provider = provider
        self.account_home = account_home
        self.limit_kind = limit_kind


def _rate_limit_retry_delay(error: HarnessError, attempt: int) -> float:
    if error.code == "account_quota_limited":
        # Quota windows can be reset or replenished before the provider's
        # advertised deadline, so let the persistent scan backoff probe again.
        return RATE_LIMIT_RESUME_DELAY_SECONDS
    if error.retry_after_seconds is not None:
        maximum = QUOTA_RETRY_MAX_SECONDS if error.code == "subagent_limited" else RATE_LIMIT_RETRY_AFTER_MAX_SECONDS
        return min(max(0.0, error.retry_after_seconds), maximum)
    base = min(RATE_LIMIT_BACKOFF_BASE_SECONDS * (2 ** max(0, attempt - 1)), RATE_LIMIT_BACKOFF_MAX_SECONDS)
    return base * random.uniform(0.8, 1.2)


def _sanitize_generation_error_text(value: Any, limit: int) -> str:
    text = value if isinstance(value, str) else str(value or "")
    text = "".join(character for character in text if not unicodedata.category(character).startswith("C"))
    return text.strip()[:limit]


def sanitize_generation_validation_errors(errors: Any) -> list[dict[str, str]]:
    sanitized: list[dict[str, str]] = []
    if not isinstance(errors, list):
        return sanitized
    for item in errors[:GENERATION_VALIDATION_ERROR_LIMIT]:
        if not isinstance(item, dict):
            continue
        field = _sanitize_generation_error_text(item.get("field"), GENERATION_VALIDATION_FIELD_LIMIT)
        message = _sanitize_generation_error_text(item.get("message"), GENERATION_VALIDATION_MESSAGE_LIMIT)
        sanitized.append(
            {
                "field": field or "draft",
                "message": message or "Generated value is invalid.",
            }
        )
    return sanitized


def generation_harness_failure_message(error: HarnessError, generation_id: int) -> str:
    public_message = _sanitize_generation_error_text(error.public_message, GENERATION_VALIDATION_MESSAGE_LIMIT)
    code = _sanitize_generation_error_text(error.code, 100) or "model_process_error"
    message = public_message or "The model process exited without returning a structured result."
    return f"{message} Diagnostic: {code} (generation {generation_id})."


class Worker:
    def __init__(self, config: EngineConfig, db: Database | None = None):
        self.config = config
        self.db = db or Database(config.database_url)
        setup_concurrency = max(1, int(getattr(config, "workspace_setup_concurrency", 1)))
        self.workspace_setup_slots = threading.BoundedSemaphore(setup_concurrency)
        self.post_processor = PostProcessor(
            config,
            self.db,
            workspace_setup_slots=self.workspace_setup_slots,
        )
        self._prewarm_lock = threading.Lock()
        self._prewarmed_scan_cache_keys: set[tuple[int, str]] = set()
        self._prewarm_events: dict[tuple[int, str], threading.Event] = {}
        self._prewarm_errors: dict[tuple[int, str], BaseException] = {}
        self._scan_scheduler_lock = threading.Lock()
        self._scan_allocations: dict[int, int] = {}
        self._scan_last_dispatch: dict[int, int] = {}
        self._scan_no_work_until: dict[int, float] = {}
        self._scan_dispatch_sequence = 0
        self._supplemental_dispatch_next: dict[int, bool] = {}
        self.codex_cli_gate = CodexCliGate()
        self.generation_runner = GenerationRunner(config, codex_cli_gate=self.codex_cli_gate)
        self.model_catalog_refresher = ModelCatalogRefresher(
            self.db,
            timeout_seconds=float(getattr(config, "model_catalog_timeout_seconds", 10.0) or 10.0),
            codex_cli_gate=self.codex_cli_gate,
        )
        self._model_catalog_refresh_seconds = max(
            30.0, float(getattr(config, "model_catalog_refresh_seconds", 300.0) or 300.0)
        )
        self._next_model_catalog_refresh = 0.0
        self._model_catalog_refresh_lock = threading.Lock()
        self._codex_auto_update = bool(getattr(config, "codex_auto_update", True))
        self._codex_update_interval_seconds = max(
            60.0, float(getattr(config, "codex_update_interval_seconds", 86400.0) or 86400.0)
        )
        self._codex_update_retry_seconds = min(300.0, self._codex_update_interval_seconds)
        self._next_codex_update = 0.0
        self._codex_update_lock = threading.Lock()
        self.codex_updater = CodexUpdater(
            timeout_seconds=max(10.0, float(getattr(config, "codex_update_timeout_seconds", 120.0) or 120.0)),
            gate=self.codex_cli_gate,
        )
        self._generation_stale_after_seconds = GENERATION_STALE_AFTER_SECONDS
        self._artifact_cleanup_lock = threading.Lock()
        self._next_artifact_cleanup = 0.0
        self._artifact_cleanup_requested = False
        self._docker_storage_cleanup_lock = threading.Lock()
        self._next_docker_storage_cleanup = 0.0

    def run_forever(self):
        workers: dict[int, tuple[threading.Thread, threading.Event]] = {}
        generation_worker: tuple[threading.Thread, threading.Event] | None = None
        last_capacity: MemoryCapacity | None = None
        LOGGER.info("open-kritt engine started; live config: %s", runtime_config_path(self.config.data_dir))
        cleanup_stale_scan_sandboxes()
        cleanup_stale_workspace_snapshot_builders()
        if hasattr(self.db, "connect"):
            self.recover_orphaned_metadata(now_utc())
            try:
                self.cleanup_orphaned_artifacts(minimum_age_seconds=0)
            except Exception:
                LOGGER.exception("startup artifact cleanup failed")
            self._next_artifact_cleanup = time.monotonic() + ARTIFACT_CLEANUP_INTERVAL_SECONDS
        self._schedule_docker_storage_cleanup()
        self._update_codex_at_startup()

        while True:
            self._schedule_artifact_cleanup()
            self._schedule_codex_update()
            self._schedule_model_catalog_refresh()
            for worker_id, (thread, _stop_event) in list(workers.items()):
                if not thread.is_alive():
                    workers.pop(worker_id, None)
            if generation_worker is not None and not generation_worker[0].is_alive():
                generation_worker = None

            capacity = self.runtime_memory_capacity()
            desired = capacity.effective_workers
            if capacity != last_capacity:
                if capacity.total_bytes is None:
                    LOGGER.warning(
                        "engine worker capacity is %s; system memory is unavailable, so the configured ceiling "
                        "cannot be memory-budgeted",
                        desired,
                    )
                else:
                    LOGGER.info(
                        "engine worker capacity is %s of %s configured "
                        "(%.1f GiB total, %.1f GiB reserve, %s MiB reservation per runner, %s MiB hard cap)",
                        desired,
                        capacity.configured_workers,
                        capacity.total_bytes / GIB,
                        capacity.reserve_bytes / GIB,
                        capacity.runner_bytes // MIB,
                        self.runtime_scan_runner_memory_mb(),
                    )
                last_capacity = capacity

            for worker_id in sorted(workers, reverse=True):
                if worker_id > desired:
                    thread, stop_event = workers[worker_id]
                    stop_event.set()
                    if not thread.is_alive():
                        workers.pop(worker_id, None)

            for worker_id in range(1, desired + 1):
                if worker_id in workers:
                    continue
                stop_event = threading.Event()
                thread = threading.Thread(
                    target=self._run_loop,
                    args=(worker_id, stop_event),
                    name=f"executor-worker-{worker_id}",
                    daemon=True,
                )
                workers[worker_id] = (thread, stop_event)
                thread.start()
                # Ramp capacity one worker per supervisor pass. This prevents
                # workspace setup and model subprocess startup from peaking
                # simultaneously when capacity is raised or the engine restarts.
                break

            if desired <= 0:
                if generation_worker is not None:
                    generation_worker[1].set()
            elif generation_worker is None:
                stop_event = threading.Event()
                thread = threading.Thread(
                    target=self._generation_loop,
                    args=(stop_event,),
                    name="generation-worker",
                    daemon=True,
                )
                generation_worker = (thread, stop_event)
                thread.start()

            time.sleep(max(1.0, min(self.config.poll_seconds, 5.0)))

    def _update_codex_at_startup(self) -> None:
        if not self._codex_auto_update:
            LOGGER.info("Codex CLI auto-update is disabled")
            return
        self._run_codex_update()
        self._next_codex_update = time.monotonic() + self._codex_update_interval_seconds

    def _schedule_codex_update(self) -> None:
        if not self._codex_auto_update:
            return
        now = time.monotonic()
        if now < self._next_codex_update or not self._codex_update_lock.acquire(blocking=False):
            return
        self._next_codex_update = now + self._codex_update_interval_seconds
        threading.Thread(
            target=self._run_scheduled_codex_update,
            name="codex-updater",
            daemon=True,
        ).start()

    def _run_scheduled_codex_update(self) -> None:
        try:
            result = self._run_codex_update()
            if not result.attempted:
                self._next_codex_update = time.monotonic() + self._codex_update_retry_seconds
        finally:
            self._codex_update_lock.release()

    def _run_codex_update(self):
        result = self.codex_updater.update()
        if result.attempted:
            # Fetch against the post-update CLI instead of waiting for the normal cadence.
            self._next_model_catalog_refresh = 0.0
            self._schedule_model_catalog_refresh()
        return result

    def _schedule_model_catalog_refresh(self) -> None:
        # Let a due Codex update take precedence. Its completion resets this cadence and
        # requests a catalog refresh against the updated CLI.
        if self._codex_update_lock.locked():
            return
        now = time.monotonic()
        if now < self._next_model_catalog_refresh or not self._model_catalog_refresh_lock.acquire(blocking=False):
            return
        self._next_model_catalog_refresh = now + self._model_catalog_refresh_seconds
        threading.Thread(
            target=self._refresh_model_catalogs,
            name="model-catalog-refresher",
            daemon=True,
        ).start()

    def _refresh_model_catalogs(self) -> None:
        try:
            env = provider_environment()
            configured_codex_home = runtime_value(
                "ENGINE_CODEX_HOME",
                env.get("CODEX_HOME") or "/root/.codex",
                data_dir=getattr(self.config, "data_dir", None),
            )
            if configured_codex_home:
                env["ENGINE_CODEX_HOME"] = configured_codex_home
            self.model_catalog_refresher.refresh(env=env)
        except Exception:
            # Catalog refresh must never interrupt scan workers. The refresher
            # deliberately avoids logging upstream payloads or credentials.
            LOGGER.warning("model catalog refresh failed")
        finally:
            self._model_catalog_refresh_lock.release()

    def runtime_worker_count(self) -> int:
        return runtime_int(
            "ENGINE_WORKER_COUNT",
            2,
            data_dir=getattr(self.config, "data_dir", None),
            minimum=0,
            maximum=128,
        )

    def runtime_retry_count(self) -> int:
        return runtime_int(
            "ENGINE_RETRY_COUNT",
            2,
            data_dir=getattr(self.config, "data_dir", None),
            minimum=0,
            maximum=10,
        )

    def runtime_cyber_safety_retry_count(self) -> int:
        return runtime_int(
            "ENGINE_CYBER_SAFETY_RETRY_COUNT",
            0,
            data_dir=getattr(self.config, "data_dir", None),
            minimum=0,
            maximum=10,
        )

    def runtime_max_concurrent_scans(self) -> int:
        return runtime_int(
            "ENGINE_MAX_CONCURRENT_SCANS",
            1,
            data_dir=getattr(self.config, "data_dir", None),
            minimum=1,
            maximum=128,
        )

    def runtime_max_workers_per_scan(self) -> int:
        return runtime_int(
            "ENGINE_MAX_WORKERS_PER_SCAN",
            0,
            data_dir=getattr(self.config, "data_dir", None),
            minimum=0,
            maximum=128,
        )

    def runtime_memory_reserve_bytes(self) -> int:
        return int(
            runtime_float(
                "ENGINE_MEMORY_RESERVE_GB",
                2.0,
                data_dir=getattr(self.config, "data_dir", None),
                minimum=0.0,
                maximum=1024.0,
            )
            * GIB
        )

    def runtime_scan_runner_memory_mb(self) -> int:
        return runtime_int(
            "ENGINE_SCAN_RUNNER_MEMORY_MB",
            1536,
            data_dir=getattr(self.config, "data_dir", None),
            minimum=0,
            maximum=1024 * 1024,
        )

    def runtime_scan_runner_memory_reservation_mb(self) -> int:
        return runtime_int(
            "ENGINE_SCAN_RUNNER_MEMORY_RESERVATION_MB",
            self.runtime_scan_runner_memory_mb(),
            data_dir=getattr(self.config, "data_dir", None),
            minimum=0,
            maximum=1024 * 1024,
        )

    def runtime_memory_capacity(self) -> MemoryCapacity:
        total_reader = getattr(self, "_system_memory_total_bytes", system_memory_total_bytes)
        return calculate_memory_capacity(
            self.runtime_worker_count(),
            total_bytes=total_reader(),
            reserve_bytes=self.runtime_memory_reserve_bytes(),
            runner_bytes=self.runtime_scan_runner_memory_reservation_mb() * MIB,
        )

    def _memory_allows_new_runner(self) -> bool:
        available_reader = getattr(self, "_system_memory_available_bytes", system_memory_available_bytes)
        available_bytes = available_reader()
        if available_bytes is None:
            return True
        reserve_bytes = self.runtime_memory_reserve_bytes()
        runner_bytes = self.runtime_scan_runner_memory_reservation_mb() * MIB
        allowed = available_bytes >= reserve_bytes + runner_bytes
        was_paused = bool(getattr(self, "_memory_admission_paused", False))
        if not allowed and not was_paused:
            LOGGER.warning(
                "pausing new runner admission: %.1f GiB available, %.1f GiB reserve plus %s MiB required",
                available_bytes / GIB,
                reserve_bytes / GIB,
                runner_bytes // MIB,
            )
        elif allowed and was_paused:
            LOGGER.info("resuming runner admission with %.1f GiB available", available_bytes / GIB)
        self._memory_admission_paused = not allowed
        return allowed

    def runtime_autoscale_scan_workers_on_provider_capacity(self) -> bool:
        return runtime_bool(
            "ENGINE_AUTOSCALE_SCAN_WORKERS_ON_PROVIDER_CAPACITY",
            True,
            data_dir=getattr(self.config, "data_dir", None),
        )

    def runtime_harness_timeout_seconds(self) -> int:
        return runtime_int(
            "ENGINE_HARNESS_TIMEOUT_SECONDS",
            7200,
            data_dir=getattr(self.config, "data_dir", None),
            minimum=60,
            maximum=86400,
        )

    def runtime_codex_max_subagents(self) -> int:
        return runtime_int(
            "ENGINE_CODEX_MAX_SUBAGENTS_PER_SESSION",
            5,
            data_dir=getattr(self.config, "data_dir", None),
            minimum=1,
            maximum=5,
        )

    def runtime_min_free_storage_bytes(self) -> int:
        configured_default = max(0, int(getattr(self.config, "min_free_storage_bytes", 0) or 0))
        data_dir = getattr(self.config, "data_dir", None)
        if not data_dir:
            return configured_default
        default_gib = configured_default / 1024**3
        return int(
            runtime_float(
                "ENGINE_MIN_FREE_STORAGE_GB",
                default_gib,
                data_dir=data_dir,
                minimum=0.0,
                maximum=1024.0,
            )
            * 1024**3
        )

    def runtime_ignore_low_storage(self) -> bool:
        return runtime_bool(
            "ENGINE_IGNORE_LOW_STORAGE",
            bool(getattr(self.config, "ignore_low_storage", False)),
            data_dir=getattr(self.config, "data_dir", None),
        )

    def _harness_for_model_selection(self, selection: ModelSelection):
        return harness_for(
            normalize_harness_name(selection.harness),
            timeout_seconds=self.runtime_harness_timeout_seconds(),
            model_provider=selection.model_provider,
            codex_model_provider=getattr(self.config, "codex_model_provider", None),
            codex_cli_gate=self.codex_cli_gate,
            codex_max_subagents=self.runtime_codex_max_subagents(),
            runner_memory_mb=self.runtime_scan_runner_memory_mb(),
            runner_memory_reservation_mb=self.runtime_scan_runner_memory_reservation_mb(),
        )

    def recover_orphaned_metadata(self, engine_started_at):
        with self.db.connect() as conn:
            counts = self.db.mark_orphaned_running_metadata_interrupted(
                conn,
                engine_started_at=engine_started_at,
                error=ORPHANED_METADATA_ERROR,
            )
            conn.commit()
        repaired = sum(counts.values())
        if repaired:
            LOGGER.info("marked %s orphaned running metadata rows interrupted: %s", repaired, counts)
        return counts

    def cleanup_orphaned_artifacts(
        self,
        *,
        minimum_age_seconds: float,
        persisted_cache_minimum_age_seconds: float | None = None,
    ) -> ArtifactCleanupResult:
        load_state = getattr(self.db, "load_artifact_cleanup_state", None)
        if not callable(load_state):
            return ArtifactCleanupResult()
        persisted_cache_minimum_age_seconds = (
            minimum_age_seconds if persisted_cache_minimum_age_seconds is None else persisted_cache_minimum_age_seconds
        )
        retention_days = max(0.0, float(getattr(self.config, "scan_cache_retention_days", 0.0) or 0.0))
        retain_after = now_utc() - timedelta(days=retention_days)
        quarantine = collect_quarantined_artifacts(
            [
                self.config.data_dir,
                f"{self.config.data_dir}/jobs",
                f"{self.config.data_dir}/scan-workspaces",
                getattr(self.config, "checkout_cache_persist_dir", None),
                getattr(self.config, "checkout_cache_dir", None),
            ]
        )
        with self.db.connect() as conn:
            active_workspace_ids, retained_scan_ids = load_state(
                conn,
                retain_inactive_scan_caches_after=retain_after,
                retain_finished_workspaces_after=now_utc() - timedelta(seconds=max(0.0, minimum_age_seconds)),
            )
            load_active_scans = getattr(self.db, "load_active_scan_cache_specs", None)
            active_scans = load_active_scans(conn) if callable(load_active_scans) else []
            retained_checkout_names = {name for scan in active_scans for name in scan_checkout_cache_entry_names(scan)}
            retained_checkout_prefixes = {
                prefix for scan in active_scans for prefix in scan_checkout_cache_entry_prefixes(scan)
            }
            result = ArtifactCleanupResult(
                job_workspaces=cleanup_orphaned_job_workspaces(
                    self.config.data_dir,
                    active_workspace_ids=active_workspace_ids,
                    minimum_age_seconds=minimum_age_seconds,
                    quarantine=quarantine,
                ),
                persisted_scan_caches=cleanup_persisted_scan_caches(
                    getattr(self.config, "checkout_cache_persist_dir", None),
                    retained_scan_ids=retained_scan_ids,
                    minimum_age_seconds=persisted_cache_minimum_age_seconds,
                    quarantine=quarantine,
                ),
                checkout_caches=cleanup_checkout_caches(
                    getattr(self.config, "checkout_cache_dir", None),
                    retained_entry_names=retained_checkout_names,
                    retained_entry_prefixes=retained_checkout_prefixes,
                    minimum_age_seconds=minimum_age_seconds,
                    quarantine=quarantine,
                ),
                legacy_scan_workspaces=cleanup_legacy_scan_workspaces(
                    self.config.data_dir,
                    minimum_age_seconds=minimum_age_seconds,
                    quarantine=quarantine,
                ),
                legacy_checkout_caches=cleanup_legacy_checkout_cache(
                    self.config.data_dir,
                    getattr(self.config, "checkout_cache_dir", None),
                    quarantine=quarantine,
                ),
                legacy_repo_caches=cleanup_legacy_repo_cache(
                    self.config.data_dir,
                    getattr(self.config, "repo_dir", None),
                    quarantine=quarantine,
                ),
            )
            conn.commit()
        delete_quarantined_artifacts(quarantine)
        active_scan_ids = {int(scan["id"]) for scan in active_scans}
        prewarm_lock = getattr(self, "_prewarm_lock", None)
        if prewarm_lock is not None:
            with prewarm_lock:
                self._prewarmed_scan_cache_keys = {
                    key for key in self._prewarmed_scan_cache_keys if key[0] in active_scan_ids
                }
        if result.total:
            LOGGER.info(
                "removed stale engine artifacts: jobs=%s persisted_scan_caches=%s checkout_caches=%s "
                "legacy_scan_workspaces=%s legacy_checkout_caches=%s legacy_repo_caches=%s",
                result.job_workspaces,
                result.persisted_scan_caches,
                result.checkout_caches,
                result.legacy_scan_workspaces,
                result.legacy_checkout_caches,
                result.legacy_repo_caches,
            )
        return result

    def _schedule_artifact_cleanup(self, *, completion_triggered: bool = False) -> None:
        if not callable(getattr(self.db, "connect", None)) or not callable(
            getattr(self.db, "load_artifact_cleanup_state", None)
        ):
            return
        now = time.monotonic()
        if not completion_triggered and now < getattr(self, "_next_artifact_cleanup", 0.0):
            return
        cleanup_lock = getattr(self, "_artifact_cleanup_lock", None)
        if cleanup_lock is None:
            cleanup_lock = threading.Lock()
            self._artifact_cleanup_lock = cleanup_lock
        if not cleanup_lock.acquire(blocking=False):
            if completion_triggered:
                self._artifact_cleanup_requested = True
            return
        self._next_artifact_cleanup = now + ARTIFACT_CLEANUP_INTERVAL_SECONDS
        threading.Thread(
            target=self._run_scheduled_artifact_cleanup,
            args=(completion_triggered,),
            name="artifact-cleaner",
            daemon=True,
        ).start()

    def _run_scheduled_artifact_cleanup(self, completion_triggered: bool = False) -> None:
        try:
            self.cleanup_orphaned_artifacts(
                minimum_age_seconds=ARTIFACT_CLEANUP_GRACE_SECONDS,
                persisted_cache_minimum_age_seconds=0 if completion_triggered else ARTIFACT_CLEANUP_GRACE_SECONDS,
            )
        except Exception:
            LOGGER.exception("scheduled artifact cleanup failed")
        finally:
            self._artifact_cleanup_lock.release()
            if getattr(self, "_artifact_cleanup_requested", False):
                self._artifact_cleanup_requested = False
                self._schedule_artifact_cleanup(completion_triggered=True)

    def _schedule_docker_storage_cleanup(self) -> bool:
        if not (
            bool(getattr(self.config, "auto_prune_docker_build_cache", False))
            or bool(getattr(self.config, "auto_prune_unused_docker_images", False))
        ):
            return False
        now = time.monotonic()
        if now < getattr(self, "_next_docker_storage_cleanup", 0.0):
            return False
        cleanup_lock = getattr(self, "_docker_storage_cleanup_lock", None)
        if cleanup_lock is None:
            cleanup_lock = threading.Lock()
            self._docker_storage_cleanup_lock = cleanup_lock
        if not cleanup_lock.acquire(blocking=False):
            return False
        interval = max(
            30.0,
            float(getattr(self.config, "docker_build_cache_prune_interval_seconds", 300.0) or 300.0),
        )
        self._next_docker_storage_cleanup = now + interval
        threading.Thread(
            target=self._run_docker_storage_cleanup,
            name="docker-storage-cleaner",
            daemon=True,
        ).start()
        return True

    def _run_docker_storage_cleanup(self) -> None:
        try:
            if bool(getattr(self.config, "auto_prune_docker_build_cache", False)):
                try:
                    summary = prune_docker_build_cache(
                        keep_storage_bytes=int(getattr(self.config, "docker_build_cache_keep_bytes", 0) or 0)
                    )
                    if summary:
                        LOGGER.info("pruned unused Docker builder cache: %s", summary)
                except Exception as exc:
                    LOGGER.warning("Docker builder cache cleanup failed: %s", str(exc)[-1000:])
            if bool(getattr(self.config, "auto_prune_unused_docker_images", False)):
                try:
                    container_summary = prune_stopped_scan_containers()
                    if container_summary:
                        LOGGER.info("pruned stopped scan containers: %s", container_summary)
                except Exception as exc:
                    LOGGER.warning("Stopped scan container cleanup failed: %s", str(exc)[-1000:])
                try:
                    image_summary = prune_unused_docker_images()
                    if image_summary:
                        LOGGER.info("pruned unused Docker images: %s", image_summary)
                except Exception as exc:
                    LOGGER.warning("Unused Docker image cleanup failed: %s", str(exc)[-1000:])
        finally:
            self._docker_storage_cleanup_lock.release()

    def _schedule_post_task_cleanup(self) -> None:
        try:
            self._schedule_artifact_cleanup(completion_triggered=True)
            self._schedule_docker_storage_cleanup()
        except Exception:
            LOGGER.exception("could not schedule post-task storage cleanup")

    def _worker_can_pick_job(self, worker_id: int) -> bool:
        return worker_id <= self.runtime_worker_count()

    def _run_loop(self, worker_id: int, stop_event: threading.Event):
        LOGGER.info("worker %s started", worker_id)
        while not stop_event.is_set():
            try:
                did_work = self.run_scan_once(worker_id=worker_id)
            except Exception:
                LOGGER.exception("worker %s loop failed", worker_id)
                did_work = False
            if not did_work:
                stop_event.wait(self.config.poll_seconds)
        LOGGER.info("worker %s stopped", worker_id)

    def _generation_loop(self, stop_event: threading.Event) -> None:
        LOGGER.info("generation worker started")
        next_recovery = 0.0
        while not stop_event.is_set():
            if self.runtime_worker_count() <= 0:
                stop_event.wait(self.config.poll_seconds)
                continue
            now = time.monotonic()
            if now >= next_recovery:
                try:
                    self._recover_stale_generations()
                except Exception:
                    LOGGER.exception("stale generation recovery failed")
                next_recovery = now + GENERATION_RECOVERY_INTERVAL_SECONDS
            try:
                did_work = self.run_generation_once()
            except Exception:
                LOGGER.exception("generation worker loop failed")
                did_work = False
            if not did_work:
                stop_event.wait(self.config.poll_seconds)
        LOGGER.info("generation worker stopped")

    def _recover_stale_generations(self) -> int:
        fail_stale = getattr(self.db, "fail_stale_generations", None)
        if not callable(fail_stale):
            return 0
        with self.db.connect() as conn:
            recovered = fail_stale(conn, stale_after_seconds=self._generation_stale_after_seconds)
            conn.commit()
        if recovered:
            LOGGER.warning("marked %s interrupted generation job(s) as failed", recovered)
        return recovered

    def run_once(self, worker_id: int = 1) -> bool:
        if not self._worker_can_pick_job(worker_id):
            return False

        if self.run_generation_once():
            return True
        return self.run_scan_once(worker_id=worker_id)

    def run_generation_once(self) -> bool:
        if self.runtime_worker_count() <= 0:
            return False
        # Generation is intentionally a separate queue. A generation produces a
        # reviewable draft only; it never creates a workflow or post-script row.
        claim_generation = getattr(self.db, "claim_generation", None)
        if callable(claim_generation):
            with self.db.connect() as conn:
                generation = claim_generation(conn)
                conn.commit()
            if generation:
                self.process_generation(generation, worker_id="generation")
                return True
        return False

    def run_scan_once(self, worker_id: int = 1) -> bool:
        if not self._worker_can_pick_job(worker_id):
            return False
        if not hasattr(self, "_supplemental_dispatch_next"):
            self._supplemental_dispatch_next = {}
        supplemental_next = self._supplemental_dispatch_next.get(worker_id, True)
        if supplemental_next and self.run_supplemental_post_script_once(worker_id=worker_id):
            self._supplemental_dispatch_next[worker_id] = False
            return True
        scan = self._reserve_scan()
        if not scan:
            if not supplemental_next and self.run_supplemental_post_script_once(worker_id=worker_id):
                self._supplemental_dispatch_next[worker_id] = False
                return True
            return False
        self._supplemental_dispatch_next[worker_id] = True

        task_finished = False
        try:
            try:
                did_work = self.process_scan(scan, worker_id=worker_id)
                task_finished = did_work
            except (RateLimitExhausted, PostProcessRateLimited) as exc:
                task_finished = True
                provider = getattr(exc, "provider", None)
                account_home = getattr(exc, "account_home", None)
                limit_kind = getattr(exc, "limit_kind", "rate_limited")
                if limit_kind not in CAPACITY_RATE_LIMIT_FAILURES:
                    mark_provider_account_rate_limited(provider, account_home)
                    if account_home and not provider_accounts_all_rate_limited(
                        provider, data_dir=getattr(self.config, "data_dir", None)
                    ):
                        LOGGER.warning(
                            "%s account %s is rate limited; scan %s will continue on another account",
                            provider,
                            account_home,
                            scan["id"],
                        )
                        return True
                retry_after_seconds = max(exc.retry_after_seconds, RATE_LIMIT_RESUME_DELAY_SECONDS)
                autoscale_workers = (
                    limit_kind in CAPACITY_RATE_LIMIT_FAILURES
                    and self.runtime_autoscale_scan_workers_on_provider_capacity()
                )
                with self.db.connect() as conn:
                    deferred = self.db.defer_scan_after_rate_limit(
                        conn,
                        int(scan["id"]),
                        retry_after_seconds=retry_after_seconds,
                        error=str(exc),
                        limit_kind=limit_kind,
                        autoscale_workers=autoscale_workers,
                        current_worker_cap=self._scan_worker_cap_at_failure(scan),
                    )
                    conn.commit()
                if deferred:
                    if autoscale_workers:
                        LOGGER.warning(
                            "scan %s hit a provider or subagent capacity limit; applied its scan worker cap and "
                            "scheduled a retry",
                            scan["id"],
                        )
                    else:
                        LOGGER.warning("scan %s is rate limited and scheduled for automatic retry", scan["id"])
                return True
            except Exception as exc:
                task_finished = True
                LOGGER.exception("scan %s failed", scan["id"])
                with self.db.connect() as conn:
                    self.db.set_scan_status_if_active(conn, int(scan["id"]), "failed", error=str(exc))
                    conn.commit()
                return True
            self._record_scan_claim_result(int(scan["id"]), did_work=did_work)
            if did_work:
                LOGGER.info("worker %s made progress on scan %s (%s)", worker_id, scan["id"], scan["repo_full"])
            return did_work
        finally:
            self._release_scan(int(scan["id"]))
            if task_finished:
                self._schedule_post_task_cleanup()

    def run_supplemental_post_script_once(self, worker_id: int = 1) -> bool:
        if not self._worker_can_pick_job(worker_id):
            return False
        claim = getattr(self.db, "claim_supplemental_post_script_target", None)
        if not callable(claim):
            return False
        if not self._memory_allows_new_runner():
            return False
        with self.db.connect() as conn:
            job = claim(conn)
            conn.commit()
        if not job:
            return False

        target_id = int(job["target"]["id"])
        scan_id = int(job["scan"]["id"])
        if not self._new_scan_container_allowed(scan_id):
            with self.db.connect() as conn:
                self.db.defer_supplemental_post_script_target(
                    conn,
                    target_id=target_id,
                    error="Waiting for enough free storage to create the post-script workspace.",
                    retry_after_seconds=max(1.0, float(getattr(self.config, "poll_seconds", 5.0) or 5.0)),
                )
                conn.commit()
            return True

        run = job["run"]
        scan = job["scan"]
        selection = supplemental_post_script_model_selection(scan, run)
        prompt_template = run["post_script_content"]
        if str(run.get("post_script_name") or "").strip().casefold() == "patched since":
            prompt_template = patched_since_prompt(prompt_template)
        metadata_id = None
        try:
            with self.db.connect() as conn:
                metadata_id = self.db.create_supplemental_post_process_metadata(
                    conn,
                    target=job["target"],
                    run=run,
                    scan=scan,
                    prompt_template=prompt_template,
                    model=selection.model,
                    harness=selection.harness,
                    thinking_effort=selection.thinking_effort,
                    model_provider=selection.model_provider,
                    run_started_at=now_utc(),
                )
                conn.commit()
            harness = self._harness_for_model_selection(selection)
            return self.post_processor.process_supplemental_post_script_target(
                job,
                harness,
                metadata_id=metadata_id,
            )
        except PostProcessRateLimited as exc:
            provider = getattr(exc, "provider", None)
            account_home = getattr(exc, "account_home", None)
            limit_kind = getattr(exc, "limit_kind", "rate_limited")
            retry_after_seconds = max(exc.retry_after_seconds, RATE_LIMIT_RESUME_DELAY_SECONDS)
            if limit_kind not in CAPACITY_RATE_LIMIT_FAILURES:
                mark_provider_account_rate_limited(provider, account_home)
                if account_home and not provider_accounts_all_rate_limited(
                    provider, data_dir=getattr(self.config, "data_dir", None)
                ):
                    retry_after_seconds = 0
            with self.db.connect() as conn:
                self.db.defer_supplemental_post_script_target(
                    conn,
                    target_id=target_id,
                    error=str(exc),
                    retry_after_seconds=retry_after_seconds,
                )
                conn.commit()
            LOGGER.warning(
                "supplemental post-script target %s for scan %s was rate limited and will retry",
                target_id,
                scan_id,
            )
            return True
        except Exception as exc:
            LOGGER.exception("supplemental post-script target %s for scan %s failed", target_id, scan_id)
            with self.db.connect() as conn:
                if metadata_id is not None:
                    self.db.update_post_process_metadata(
                        conn,
                        metadata_id,
                        status="failed",
                        error=str(exc),
                        run_time_ms=0,
                        raw_token_usage=None,
                        phase="failed",
                    )
                self.db.fail_supplemental_post_script_target(conn, target_id=target_id, error=str(exc))
                conn.commit()
            return True
        finally:
            self._schedule_post_task_cleanup()

    def _new_scan_container_allowed(self, scan_id: int) -> bool:
        required_bytes = self.runtime_min_free_storage_bytes()
        if self.runtime_ignore_low_storage() or required_bytes <= 0:
            warning_clearer = getattr(self.db, "clear_scan_storage_warning", None)
            if callable(warning_clearer):
                with self.db.connect() as conn:
                    warning_clearer(conn, scan_id)
                    conn.commit()
            return True

        free_bytes: int | None = None
        check_error: str | None = None
        try:
            free_bytes = int(shutil.disk_usage(self.config.data_dir).free)
        except OSError as exc:
            check_error = str(exc)

        blocked = check_error is not None or free_bytes is None or free_bytes < required_bytes
        if blocked:
            self._schedule_docker_storage_cleanup()
        warning_changed = False
        warning_setter = getattr(self.db, "set_scan_storage_warning", None)
        warning_clearer = getattr(self.db, "clear_scan_storage_warning", None)
        with self.db.connect() as conn:
            if blocked and callable(warning_setter):
                warning_changed = warning_setter(
                    conn,
                    scan_id,
                    free_bytes=free_bytes,
                    required_bytes=required_bytes,
                    check_error=check_error,
                )
            elif not blocked and callable(warning_clearer):
                warning_clearer(conn, scan_id)
            conn.commit()

        if blocked and warning_changed:
            if check_error:
                LOGGER.warning("scan %s container launch paused: storage check failed: %s", scan_id, check_error)
            else:
                LOGGER.warning(
                    "scan %s container launch paused: %.1f GiB free, %.1f GiB required",
                    scan_id,
                    free_bytes / 1024**3,
                    required_bytes / 1024**3,
                )
        return not blocked

    def _scheduler_state(self) -> threading.Lock:
        if not hasattr(self, "_scan_scheduler_lock"):
            self._scan_scheduler_lock = threading.Lock()
            self._scan_allocations = {}
            self._scan_last_dispatch = {}
            self._scan_no_work_until = {}
            self._scan_dispatch_sequence = 0
        return self._scan_scheduler_lock

    def _record_scan_claim_result(self, scan_id: int, *, did_work: bool) -> None:
        with self._scheduler_state():
            if did_work:
                self._scan_no_work_until.pop(scan_id, None)
                return
            retry_seconds = max(0.01, float(getattr(self.config, "poll_seconds", 5.0) or 5.0))
            self._scan_no_work_until[scan_id] = time.monotonic() + retry_seconds

    def _reserve_scan(self) -> dict[str, Any] | None:
        with self._scheduler_state():
            if not self._memory_allows_new_runner():
                return None
            with self.db.connect() as conn:
                claim_scans = getattr(self.db, "claim_scans", None)
                if callable(claim_scans):
                    scans = claim_scans(conn, max_concurrent_scans=self.runtime_max_concurrent_scans())
                else:
                    scan = self.db.claim_scan(conn)
                    scans = [scan] if scan else []
                conn.commit()
            if not scans:
                return None

            active_ids = {int(scan["id"]) for scan in scans}
            self._scan_allocations = {
                scan_id: count
                for scan_id, count in self._scan_allocations.items()
                if scan_id in active_ids and count > 0
            }
            self._scan_last_dispatch = {
                scan_id: sequence for scan_id, sequence in self._scan_last_dispatch.items() if scan_id in active_ids
            }
            self._scan_no_work_until = {
                scan_id: retry_at for scan_id, retry_at in self._scan_no_work_until.items() if scan_id in active_ids
            }

            worker_limit = self.runtime_memory_capacity().effective_workers
            if worker_limit <= 0:
                return None
            if sum(self._scan_allocations.values()) >= worker_limit:
                return None
            configured_cap = self.runtime_max_workers_per_scan()
            default_scan_cap = min(worker_limit, configured_cap) if configured_cap > 0 else worker_limit

            def scan_cap(scan: dict[str, Any]) -> int:
                reasoning = scan.get("reasoning")
                adaptive_cap = reasoning.get("provider_capacity_worker_cap") if isinstance(reasoning, dict) else None
                if isinstance(adaptive_cap, int) and not isinstance(adaptive_cap, bool) and adaptive_cap > 0:
                    return min(default_scan_cap, adaptive_cap)
                return default_scan_cap

            now = time.monotonic()
            eligible = [
                scan
                for scan in scans
                if self._scan_allocations.get(int(scan["id"]), 0) < scan_cap(scan)
                and self._scan_no_work_until.get(int(scan["id"]), 0.0) <= now
            ]
            if not eligible:
                return None
            selected = min(
                eligible,
                key=lambda scan: (
                    self._scan_allocations.get(int(scan["id"]), 0),
                    self._scan_last_dispatch.get(int(scan["id"]), -1),
                    scan.get("inserted_at") or "",
                    int(scan["id"]),
                ),
            )
            scan_id = int(selected["id"])
            self._scan_allocations[scan_id] = self._scan_allocations.get(scan_id, 0) + 1
            self._scan_dispatch_sequence += 1
            self._scan_last_dispatch[scan_id] = self._scan_dispatch_sequence
            selected["_reserved_worker_cap"] = scan_cap(selected)
            return selected

    def _release_scan(self, scan_id: int) -> None:
        with self._scheduler_state():
            count = self._scan_allocations.get(scan_id, 0)
            if count <= 1:
                self._scan_allocations.pop(scan_id, None)
            else:
                self._scan_allocations[scan_id] = count - 1

    def _scan_worker_cap_at_failure(self, scan: dict[str, Any]) -> int | None:
        scan_id = int(scan["id"])
        with self._scheduler_state():
            allocated = self._scan_allocations.get(scan_id, 0)
        reserved_cap = scan.get("_reserved_worker_cap")
        candidates = [
            value
            for value in (allocated, reserved_cap)
            if isinstance(value, int) and not isinstance(value, bool) and value > 0
        ]
        return min(candidates) if candidates else None

    def process_generation(self, generation: dict[str, Any], worker_id: int | str = 1) -> None:
        generation_id = int(generation["id"])
        generation_started = time.monotonic()
        LOGGER.info("worker %s generating %s draft %s", worker_id, generation.get("kind"), generation_id)
        heartbeat = self._start_generation_heartbeat(generation_id)
        try:
            try:
                result = self.generation_runner.generate(generation)
            except Exception as exc:
                validation_errors = (
                    sanitize_generation_validation_errors(exc.errors)
                    if isinstance(exc, GenerationValidationError)
                    else None
                )
                if validation_errors is not None:
                    error = "Generated draft did not pass validation."
                elif isinstance(exc, HarnessError):
                    error = generation_harness_failure_message(exc, generation_id)
                else:
                    error = "Generation failed. Try again."
                failure_code = exc.code if isinstance(exc, HarnessError) else type(exc).__name__
                retryable = exc.retryable if isinstance(exc, HarnessError) else False
                exit_code = exc.exit_code if isinstance(exc, HarnessError) else None
                attempts = exc.attempts if isinstance(exc, HarnessError) else None
                model = _sanitize_generation_error_text(generation.get("model"), 200)
                LOGGER.warning(
                    "generation %s failed failure_code=%s exception_type=%s kind=%s provider=%s "
                    "harness=%s model=%s retryable=%s attempts=%s exit_code=%s duration_seconds=%.3f",
                    generation_id,
                    failure_code,
                    type(exc).__name__,
                    generation.get("kind"),
                    generation.get("model_provider"),
                    generation.get("harness"),
                    model,
                    retryable,
                    attempts,
                    exit_code,
                    time.monotonic() - generation_started,
                )
                self._fail_generation_best_effort(
                    generation_id,
                    error=error,
                    validation_errors=validation_errors,
                )
                return

            try:
                with self.db.connect() as conn:
                    completed = self.db.complete_generation(
                        conn,
                        generation_id,
                        result=result.artifact,
                        raw_token_usage=result.usage,
                        codex_session_id=result.codex_session_id,
                    )
                    conn.commit()
            except Exception:
                LOGGER.warning("generation %s completion could not be persisted", generation_id)
                self._fail_generation_best_effort(generation_id, error=GENERATION_PERSISTENCE_ERROR)
                return
            if not completed:
                LOGGER.warning("generation %s was no longer running when completion was recorded", generation_id)
        finally:
            self._stop_generation_heartbeat(heartbeat)
            self._schedule_post_task_cleanup()

    def _start_generation_heartbeat(self, generation_id: int) -> tuple[threading.Event, threading.Thread] | None:
        if not callable(getattr(self.db, "heartbeat_generation", None)):
            return None
        stop_event = threading.Event()
        thread = threading.Thread(
            target=self._generation_heartbeat_loop,
            args=(generation_id, stop_event),
            name=f"generation-heartbeat-{generation_id}",
            daemon=True,
        )
        thread.start()
        return stop_event, thread

    def _stop_generation_heartbeat(self, heartbeat: tuple[threading.Event, threading.Thread] | None) -> None:
        if heartbeat is None:
            return
        stop_event, thread = heartbeat
        stop_event.set()
        thread.join(timeout=1.0)

    def _generation_heartbeat_loop(self, generation_id: int, stop_event: threading.Event) -> None:
        while not stop_event.wait(GENERATION_HEARTBEAT_INTERVAL_SECONDS):
            try:
                with self.db.connect() as conn:
                    running = self.db.heartbeat_generation(conn, generation_id)
                    conn.commit()
            except Exception:
                LOGGER.warning("generation %s heartbeat failed", generation_id)
                continue
            if not running:
                return
            try:
                self._recover_stale_generations()
            except Exception:
                LOGGER.warning("stale generation recovery failed during heartbeat")

    def _fail_generation_best_effort(
        self,
        generation_id: int,
        *,
        error: str,
        validation_errors: list[dict[str, str]] | None = None,
    ) -> bool:
        try:
            with self.db.connect() as conn:
                failed = self.db.fail_generation(
                    conn,
                    generation_id,
                    error=error,
                    validation_errors=validation_errors,
                )
                conn.commit()
            return failed
        except Exception:
            LOGGER.warning("generation %s failure status could not be persisted", generation_id)
            return False

    def process_scan(self, scan: dict[str, Any], worker_id: int = 1) -> bool:
        scan_id = int(scan["id"])
        did_work = False
        with self.db.connect() as conn:
            workflow = self.db.load_workflow(conn, int(scan["workflow_id"]))

        while True:
            with self.db.connect() as conn:
                current = self.db.load_scan(conn, scan_id)
                if not current or current["status"] in NON_RUNNABLE_SCAN_STATUSES:
                    return did_work
                if not self._worker_can_pick_job(worker_id):
                    return did_work
                if current["status"] == PREWARMING_SCAN_STATUS:
                    conn.commit()
                    jobs = None
                    completed = claimed = set()
                elif current["status"] == "post_processing":
                    conn.commit()
                    jobs = None
                    completed = claimed = set()
                else:
                    completed = self.db.load_completed_metadata(conn, scan_id)
                    claimed = self.db.load_claimed_metadata(conn, scan_id)
                    skip_attempted_step_ids = configured_step_ids(current, "skip_attempted_step_ids")
                    if skip_attempted_step_ids:
                        attempted = self.db.load_attempted_metadata(conn, scan_id)
                        claimed |= {key for key in attempted if key[0] in skip_attempted_step_ids}
                    step_results = self.db.load_step_results(conn, scan_id)
                    jobs = build_pending_jobs(
                        scan=current,
                        workflow=workflow,
                        completed=completed,
                        claimed=claimed,
                        step_results=step_results,
                    )
                    conn.commit()

            needs_new_container = current["status"] == "post_processing" or bool(jobs)
            if needs_new_container and not self._new_scan_container_allowed(scan_id):
                return did_work

            if current["status"] == PREWARMING_SCAN_STATUS:
                if self._ensure_scan_cache_prewarmed(current, restore_status="running"):
                    did_work = True
                    continue

            if current["status"] != "post_processing" and jobs:
                if self._ensure_scan_cache_prewarmed(current, restore_status="running"):
                    did_work = True
                    continue

            if current["status"] == "post_processing":
                if self._ensure_scan_cache_prewarmed(current, restore_status="post_processing"):
                    did_work = True
                    continue
                if not self._worker_can_pick_job(worker_id):
                    return did_work
                harness = self._harness_for_model_selection(post_processing_model_selection(current))
                did_post_work = self.post_processor.process_once(current, harness)
                if did_post_work:
                    return True
                return did_work

            if not jobs:
                if claimed != completed:
                    return did_work
                with self.db.connect() as conn:
                    transitioned = self.db.set_scan_status_if_current(conn, scan_id, "running", "post_processing")
                    conn.commit()
                if not transitioned:
                    return did_work
                LOGGER.info("scan %s workflow completed; starting post-processing", scan_id)
                did_work = True
                continue

            did_claim = False
            for job in jobs:
                if not self._worker_can_pick_job(worker_id):
                    return did_work
                model_selection = model_selection_for_depth(current, getattr(job, "depth", 0))
                did_claim = self.execute_job(
                    scan=current,
                    workflow_id=workflow.id,
                    job=job,
                    harness=self._harness_for_model_selection(model_selection),
                    model_selection=model_selection,
                )
                if did_claim:
                    return True
            if not did_claim:
                return did_work

    def execute_job(self, *, scan, workflow_id, job, harness, model_selection: ModelSelection | None = None):
        step = job.step
        state = job.state
        metadata_id = None
        checked_out_commit = None
        prompt_filled = ""
        prepared = None
        try:
            schema = output_schema(step.output_format, step.multi_output)
            selection = model_selection or model_selection_for_depth(scan, step.depth)
            thinking_effort = selection.thinking_effort
            harness_name = normalize_harness_name(selection.harness)
            model_provider = scan_model_provider({"model_provider": selection.model_provider})
            with self.workspace_setup_slots:
                started = now_utc()
                with self.db.connect() as conn:
                    current_scan = self.db.load_scan(conn, int(scan["id"]))
                    if not current_scan or current_scan["status"] in NON_RUNNABLE_SCAN_STATUSES:
                        conn.commit()
                        return False
                    metadata_id = self.db.claim_step_metadata(
                        conn,
                        scan_id=int(scan["id"]),
                        workflow_id=workflow_id,
                        step_id=step.id,
                        prev_id=state.prev_id,
                        prev_table=state.prev_table,
                        repeat_run=state.repeat_run,
                        prompt_template=step.content,
                        prompt_filled="",
                        checked_out_commit=None,
                        run_started_at=started,
                        model=selection.model,
                        harness=harness_name,
                        thinking_effort=thinking_effort,
                        model_provider=model_provider,
                    )
                    agent_skills = (
                        self.db.load_agent_skills(conn, current_scan) if hasattr(self.db, "load_agent_skills") else []
                    )
                    load_prior_results = getattr(self.db, "load_prior_repeat_results", None)
                    prior_repeat_results = (
                        load_prior_results(
                            conn,
                            scan_id=int(scan["id"]),
                            step_id=step.id,
                            prev_id=state.prev_id,
                            prev_table=state.prev_table,
                            repeat_run=state.repeat_run,
                        )
                        if state.repeat_run > 1 and callable(load_prior_results)
                        else []
                    )
                    conn.commit()

                if metadata_id is None:
                    return False

                try:
                    prepared = prepare_dependency_workspace(
                        data_dir=self.config.data_dir,
                        checkout_cache_dir=getattr(self.config, "checkout_cache_dir", None),
                        metadata_id=metadata_id,
                        scan=scan,
                        github_token=self.config.github_token,
                        agent_skills=agent_skills,
                        harness_name=harness_name,
                        model_provider=model_provider,
                        use_snapshot_image=image_workspace_enabled(data_dir=getattr(self.config, "data_dir", None)),
                    )
                    checked_out_commit = prepared.checked_out_commit
                    context = {**state.context, **workspace_context(prepared)}
                    rendered_prompt = render_prompt(step.content, context)
                    prompt_parts = [
                        native_agent_skills_prompt(agent_skills, harness_name),
                        workspace_prompt_context(prepared.layout, prepared.manifest_json),
                        rendered_prompt,
                        repeat_append_prompt(state.repeat_run, prior_repeat_results),
                    ]
                    prompt_filled = harness_prompt(
                        "\n\n".join(part for part in prompt_parts if part),
                        multi_output=step.multi_output,
                        schema=schema,
                    )
                    with self.db.connect() as conn:
                        current_scan = self.db.load_scan(conn, int(scan["id"]))
                        if not current_scan or current_scan["status"] in NON_RUNNABLE_SCAN_STATUSES:
                            status = current_scan["status"] if current_scan else "missing"
                            self.db.update_metadata(
                                conn,
                                metadata_id,
                                status="stopped",
                                error=f"scan became {status} before harness started",
                                run_time_ms=int((now_utc() - started).total_seconds() * 1000),
                                raw_token_usage=None,
                                checked_out_commit=checked_out_commit,
                                prompt_filled=prompt_filled,
                                phase="interrupted",
                                codex_source_home=getattr(prepared.workspace, "codex_source_home", None),
                                codex_account_id=getattr(prepared.workspace, "provider_account_id", None),
                                codex_account_email=getattr(prepared.workspace, "provider_account_email", None),
                            )
                            conn.commit()
                            return True
                        self.db.update_metadata(
                            conn,
                            metadata_id,
                            status="running",
                            error=None,
                            run_time_ms=0,
                            raw_token_usage=None,
                            checked_out_commit=checked_out_commit,
                            prompt_filled=prompt_filled,
                            phase="running_harness",
                            codex_source_home=getattr(prepared.workspace, "codex_source_home", None),
                            codex_account_id=getattr(prepared.workspace, "provider_account_id", None),
                            codex_account_email=getattr(prepared.workspace, "provider_account_email", None),
                        )
                        conn.commit()
                except ClaudeCredentialRateLimited as exc:
                    with self.db.connect() as conn:
                        self.db.update_metadata(
                            conn,
                            metadata_id,
                            status="interrupted",
                            error=str(exc),
                            run_time_ms=int((now_utc() - started).total_seconds() * 1000),
                            raw_token_usage=None,
                            phase="interrupted",
                        )
                        conn.commit()
                    raise RateLimitExhausted(
                        str(exc),
                        retry_after_seconds=exc.retry_after_seconds,
                        provider="claude",
                        account_home=exc.account_home,
                        limit_kind=exc.limit_kind,
                    ) from exc
                except Exception as exc:
                    with self.db.connect() as conn:
                        self.db.update_metadata(
                            conn,
                            metadata_id,
                            status="failed",
                            error=f"workspace setup failed: {exc}",
                            run_time_ms=int((now_utc() - started).total_seconds() * 1000),
                            raw_token_usage=None,
                            phase="failed",
                        )
                        conn.commit()
                    raise StepExecutionError(f"workspace setup failed for step {step.id}: {exc}") from exc

            retry_count = self.runtime_retry_count()
            cyber_safety_retry_count = self.runtime_cyber_safety_retry_count()
            max_attempts = retry_count + cyber_safety_retry_count + 1
            last_error = None
            last_exception: Exception | None = None
            attempt_errors: list[str] = []
            failure_counts = {"regular": 0, "cyber_safety_blocked": 0}
            last_attempt = 1
            for attempt in range(1, max_attempts + 1):
                last_attempt = attempt
                started = now_utc()
                usage = None
                codex_session_id = None
                result = None
                try:
                    if not self._new_scan_container_allowed(int(scan["id"])):
                        with self.db.connect() as conn:
                            self.db.update_metadata(
                                conn,
                                metadata_id,
                                status="interrupted",
                                error=None,
                                run_time_ms=int((now_utc() - started).total_seconds() * 1000),
                                raw_token_usage=None,
                                phase="interrupted",
                            )
                            conn.commit()
                        return True
                    with provider_account_lease(
                        getattr(prepared.workspace, "provider_account_provider", None),
                        getattr(prepared.workspace, "provider_account_home", None),
                        data_dir=getattr(self.config, "data_dir", None),
                    ):
                        harness_arguments = {
                            "prompt": prompt_filled,
                            "schema": schema,
                            "repo_dir": prepared.repo_dir,
                            "model": selection.model,
                            "thinking_effort": thinking_effort,
                            "env": prepared.workspace.env,
                        }
                        runner_image = getattr(prepared, "runner_image", None)
                        if runner_image:
                            harness_arguments["runner_image"] = runner_image
                        result = harness.run(
                            **harness_arguments,
                        )
                    mark_provider_account_available(
                        getattr(prepared.workspace, "provider_account_provider", None),
                        getattr(prepared.workspace, "provider_account_home", None),
                    )
                    usage = result.usage
                    codex_session_id = result.codex_session_id
                    payload_stub = bool(result.payload.get("stub"))
                    stub_explanation = (result.payload.get("stub_explanation") or "").strip() or None
                    rows = validate_payload(result.payload, schema, step.multi_output)
                    run_time_ms = int((now_utc() - started).total_seconds() * 1000)
                    with self.db.connect() as conn:
                        self.db.update_metadata(
                            conn,
                            metadata_id,
                            status="running",
                            error=None,
                            run_time_ms=run_time_ms,
                            raw_token_usage=usage,
                            codex_session_id=codex_session_id,
                            stub=payload_stub,
                            stub_explanation=stub_explanation,
                            phase="writing_db",
                        )
                        conn.commit()
                    with self.db.connect() as conn:
                        self.db.update_metadata(
                            conn,
                            metadata_id,
                            status="completed",
                            error=None,
                            run_time_ms=run_time_ms,
                            raw_token_usage=usage,
                            codex_session_id=codex_session_id,
                            stub=payload_stub,
                            stub_explanation=stub_explanation,
                            phase="completed",
                        )
                        if step.is_last_step:
                            conn.execute(
                                "SELECT pg_advisory_xact_lock(hashtext(%s))", (f"vulnerability-rank:{int(scan['id'])}",)
                            )
                            rank = self.db.next_vulnerability_rank(conn, int(scan["id"]))
                            for offset, row in enumerate(rows):
                                self.db.insert_vulnerability(
                                    conn,
                                    scan_id=int(scan["id"]),
                                    workflow_id=workflow_id,
                                    scan_metadata_id=metadata_id,
                                    prev_id=state.prev_id,
                                    prev_table=state.prev_table,
                                    repeat_run=state.repeat_run,
                                    rank=rank + offset,
                                    json_answer=row,
                                )
                        else:
                            for row in rows:
                                self.db.insert_step_result(
                                    conn,
                                    scan_id=int(scan["id"]),
                                    workflow_id=workflow_id,
                                    step_id=step.id,
                                    depth=step.depth,
                                    prev_id=state.prev_id,
                                    prev_table=state.prev_table,
                                    repeat_run=state.repeat_run,
                                    json_answer=row,
                                )
                        conn.commit()
                    return True
                except (HarnessError, OutputValidationError, ValueError) as exc:
                    last_exception = exc
                    if isinstance(exc, HarnessError):
                        last_error = f"{exc.public_message} Diagnostic: {exc.code}."
                    else:
                        last_error = str(exc)
                    attempt_error = f"attempt {attempt}: {last_error}"
                    attempt_errors.append(attempt_error)
                    attempt_run_time_ms = int((now_utc() - started).total_seconds() * 1000)
                    with self.db.connect() as conn:
                        failed_metadata_id = self.db.insert_metadata(
                            conn,
                            scan_id=int(scan["id"]),
                            workflow_id=workflow_id,
                            step_id=step.id,
                            prev_id=state.prev_id,
                            prev_table=state.prev_table,
                            repeat_run=state.repeat_run,
                            status="failed",
                            error=attempt_error,
                            prompt_template=step.content,
                            prompt_filled=prompt_filled,
                            checked_out_commit=checked_out_commit,
                            run_started_at=started,
                            run_time_ms=attempt_run_time_ms,
                            raw_token_usage=usage,
                            codex_session_id=codex_session_id,
                            model=selection.model,
                            harness=harness_name,
                            thinking_effort=thinking_effort,
                            model_provider=model_provider,
                            codex_source_home=getattr(prepared.workspace, "codex_source_home", None)
                            if prepared
                            else None,
                            codex_account_id=getattr(prepared.workspace, "provider_account_id", None)
                            if prepared
                            else None,
                            codex_account_email=getattr(prepared.workspace, "provider_account_email", None)
                            if prepared
                            else None,
                            phase="failed",
                        )
                        conn.commit()
                    output = getattr(exc, "output", None) or getattr(result, "output", None)
                    if output is not None:
                        artifact_dir = record_model_error_output(
                            self.config.data_dir,
                            scan_id=int(scan["id"]),
                            workflow_id=workflow_id,
                            step_id=step.id,
                            metadata_id=failed_metadata_id,
                            attempt=attempt,
                            error=exc,
                            output=output,
                            kind="step",
                        )
                        if artifact_dir:
                            with self.db.connect() as conn:
                                self.db.update_metadata(
                                    conn,
                                    failed_metadata_id,
                                    status="failed",
                                    error=f"{attempt_error}; model output: {artifact_dir}",
                                    run_time_ms=attempt_run_time_ms,
                                    raw_token_usage=usage,
                                    codex_session_id=codex_session_id,
                                    phase="failed",
                                )
                                conn.commit()
                    LOGGER.warning("step %s failed attempt %s: %s", step.id, attempt, last_error)
                    if isinstance(exc, HarnessError) and exc.code in RETRYABLE_RATE_LIMIT_FAILURES:
                        if exc.code not in CAPACITY_RATE_LIMIT_FAILURES:
                            mark_provider_account_rate_limited(
                                getattr(prepared.workspace, "provider_account_provider", None),
                                getattr(prepared.workspace, "provider_account_home", None),
                            )
                        break
                    allowed_retries = (
                        harness_failure_retry_count(exc, retry_count, cyber_safety_retry_count)
                        if isinstance(exc, HarnessError)
                        else retry_count
                    )
                    failure_kind = (
                        "cyber_safety_blocked"
                        if isinstance(exc, HarnessError) and exc.code == "cyber_safety_blocked"
                        else "regular"
                    )
                    failure_counts[failure_kind] += 1
                    if failure_counts[failure_kind] > allowed_retries:
                        break

            run_time_ms = int((now_utc() - started).total_seconds() * 1000)
            exhausted_rate_limit = (
                isinstance(last_exception, HarnessError) and last_exception.code in RETRYABLE_RATE_LIMIT_FAILURES
            )
            failure_summary = (
                f"failed after {len(attempt_errors)} attempt{'s' if len(attempt_errors) != 1 else ''}: "
                + " | ".join(attempt_errors)
            )
            with self.db.connect() as conn:
                self.db.update_metadata(
                    conn,
                    metadata_id,
                    status="interrupted" if exhausted_rate_limit else "failed",
                    error=f"step {failure_summary}",
                    run_time_ms=run_time_ms,
                    raw_token_usage=None,
                    phase="interrupted" if exhausted_rate_limit else "failed",
                )
                conn.commit()
            if exhausted_rate_limit:
                raise RateLimitExhausted(
                    f"step {step.id} was rate limited: {' | '.join(attempt_errors)}",
                    retry_after_seconds=_rate_limit_retry_delay(last_exception, last_attempt),
                    provider=getattr(prepared.workspace, "provider_account_provider", None),
                    account_home=getattr(prepared.workspace, "provider_account_home", None),
                    limit_kind=last_exception.code,
                )
            raise StepExecutionError(f"step {step.id} {failure_summary}")
        finally:
            if metadata_id is not None:
                if prepared is not None:
                    cleanup_workspace(prepared.workspace)
                else:
                    cleanup_job_workspace(self.config.data_dir, metadata_id)

    def _ensure_scan_cache_prewarmed(self, scan: dict[str, Any], *, restore_status: str) -> bool:
        scan_id = int(scan["id"])
        resolved_scan = resolve_scan_checkout_revisions(
            scan,
            github_token=getattr(self.config, "github_token", None),
            data_dir=self.config.data_dir,
        )
        key = (scan_id, scan_checkout_cache_key(resolved_scan))
        should_prewarm = False
        with self._prewarm_lock:
            if key in self._prewarmed_scan_cache_keys:
                if scan.get("status") == PREWARMING_SCAN_STATUS:
                    with self.db.connect() as conn:
                        self.db.set_scan_status_if_current(conn, scan_id, PREWARMING_SCAN_STATUS, restore_status)
                        conn.commit()
                    return True
                return False
            event = self._prewarm_events.get(key)
            if event is None:
                event = threading.Event()
                self._prewarm_events[key] = event
                should_prewarm = True

        if should_prewarm:
            prewarm_succeeded = False
            try:
                LOGGER.info("prewarming checkout cache for scan %s", scan_id)
                with self.db.connect() as conn:
                    current = self.db.load_scan(conn, scan_id)
                    claimed_prewarm = bool(
                        current
                        and current["status"] not in NON_RUNNABLE_SCAN_STATUSES
                        and self.db.set_scan_status_if_current(
                            conn,
                            scan_id,
                            current["status"],
                            PREWARMING_SCAN_STATUS,
                        )
                    )
                    conn.commit()
                if not claimed_prewarm:
                    return False
                restored = restore_persistent_scan_checkout_cache(
                    checkout_cache_dir=getattr(self.config, "checkout_cache_dir", None),
                    checkout_cache_persist_dir=getattr(self.config, "checkout_cache_persist_dir", None),
                    scan=resolved_scan,
                    github_token=getattr(self.config, "github_token", None),
                    data_dir=self.config.data_dir,
                )
                if restored:
                    LOGGER.info("restored %s checkout cache entries for scan %s", len(restored), scan_id)
                prewarm_scan_checkout_cache(
                    checkout_cache_dir=getattr(self.config, "checkout_cache_dir", None),
                    scan=resolved_scan,
                    github_token=getattr(self.config, "github_token", None),
                    data_dir=self.config.data_dir,
                )
                saved = save_persistent_scan_checkout_cache(
                    checkout_cache_dir=getattr(self.config, "checkout_cache_dir", None),
                    checkout_cache_persist_dir=getattr(self.config, "checkout_cache_persist_dir", None),
                    scan=resolved_scan,
                    github_token=getattr(self.config, "github_token", None),
                    data_dir=self.config.data_dir,
                )
                if saved:
                    LOGGER.info("saved %s checkout cache entries for scan %s", len(saved), scan_id)
                prewarm_succeeded = True
                LOGGER.info("checkout cache prewarmed for scan %s", scan_id)
                with self._prewarm_lock:
                    self._prewarmed_scan_cache_keys.add(key)
                    self._prewarm_errors.pop(key, None)
            except Exception as exc:
                with self._prewarm_lock:
                    self._prewarm_errors[key] = exc
                raise
            finally:
                if prewarm_succeeded:
                    with self.db.connect() as conn:
                        self.db.set_scan_status_if_current(conn, scan_id, PREWARMING_SCAN_STATUS, restore_status)
                        conn.commit()
                event.set()
                with self._prewarm_lock:
                    self._prewarm_events.pop(key, None)
            return True

        event.wait()
        with self._prewarm_lock:
            error = self._prewarm_errors.get(key)
            if error is not None:
                raise error
        return True


def main():
    logging.basicConfig(level=logging.INFO)
    try:
        validate_scan_runner_configuration()
    except HarnessError as exc:
        LOGGER.error("engine startup configuration error: %s", exc)
        raise SystemExit(2) from exc
    Worker(EngineConfig.from_env()).run_forever()

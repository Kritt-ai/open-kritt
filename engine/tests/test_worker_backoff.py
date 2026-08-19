from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from open_kritt_engine import worker as worker_module
from open_kritt_engine.config import EngineConfig
from open_kritt_engine.db import (
    QUOTA_RETRY_MAX_SECONDS,
    RATE_LIMIT_RETRY_BASE_SECONDS,
    RATE_LIMIT_RETRY_MAX_SECONDS,
    Database,
    rate_limit_retry_delay,
)
from open_kritt_engine.worker import RATE_LIMIT_RESUME_DELAY_SECONDS, RateLimitExhausted, Worker


class _Connection:
    def commit(self):
        return None


def test_engine_config_reads_scan_storage_floor(monkeypatch, tmp_path):
    monkeypatch.setenv("ENGINE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ENGINE_RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.env"))
    monkeypatch.setenv("ENGINE_MIN_FREE_STORAGE_GB", "23.5")
    monkeypatch.setenv("ENGINE_IGNORE_LOW_STORAGE", "true")
    monkeypatch.setenv("ENGINE_SCAN_CACHE_RETENTION_DAYS", "3.5")
    monkeypatch.setenv("ENGINE_AUTO_PRUNE_DOCKER_BUILD_CACHE", "true")
    monkeypatch.setenv("ENGINE_AUTO_PRUNE_UNUSED_DOCKER_IMAGES", "true")
    monkeypatch.setenv("ENGINE_DOCKER_BUILD_CACHE_KEEP_GB", "4.5")
    monkeypatch.setenv("ENGINE_DOCKER_BUILD_CACHE_PRUNE_INTERVAL_SECONDS", "90")

    config = EngineConfig.from_env()

    assert config.min_free_storage_bytes == int(23.5 * 1024**3)
    assert config.ignore_low_storage is True
    assert config.scan_cache_retention_days == 3.5
    assert config.auto_prune_docker_build_cache is True
    assert config.auto_prune_unused_docker_images is True
    assert config.docker_build_cache_keep_bytes == int(4.5 * 1024**3)
    assert config.docker_build_cache_prune_interval_seconds == 90


class _ScanDatabase:
    def __init__(self, *, claimed):
        self.claimed = claimed
        self.scan = {
            "id": 58,
            "workflow_id": 2,
            "status": "running",
            "repo_full": "owner/repo",
            "harness": "codex",
        }

    @contextmanager
    def connect(self):
        yield _Connection()

    def claim_scan(self, _conn):
        return dict(self.scan)

    def load_workflow(self, _conn, _workflow_id):
        return SimpleNamespace(id=2)

    def load_scan(self, _conn, _scan_id):
        return dict(self.scan)

    def load_completed_metadata(self, _conn, _scan_id):
        return set()

    def load_claimed_metadata(self, _conn, _scan_id):
        return set(self.claimed)

    def load_step_results(self, _conn, _scan_id):
        return []


def _worker(db):
    worker = Worker.__new__(Worker)
    worker.db = db
    worker.config = SimpleNamespace(harness_timeout_seconds=1, codex_model_provider=None)
    worker.codex_cli_gate = None
    worker.runtime_worker_count = lambda: 2
    return worker


def test_worker_backs_off_when_running_scan_has_only_claimed_work(monkeypatch, caplog):
    db = _ScanDatabase(claimed={(1, 0, None, 1)})
    worker = _worker(db)
    monkeypatch.setattr(worker_module, "build_pending_jobs", lambda **_kwargs: [])
    monkeypatch.setattr(worker_module, "harness_for", lambda *_args, **_kwargs: object())
    cleanup_requests = []
    worker._schedule_post_task_cleanup = lambda: cleanup_requests.append(True)

    did_work = worker.run_scan_once(worker_id=2)

    assert did_work is False
    assert "processing scan" not in caplog.text
    assert "made progress on scan" not in caplog.text
    assert cleanup_requests == []


def test_worker_loop_waits_after_an_unclaimable_running_scan():
    worker = _worker(_ScanDatabase(claimed={(1, 0, None, 1)}))
    worker.config.poll_seconds = 0.25
    worker.run_scan_once = lambda **_kwargs: False

    class StopAfterWait:
        def __init__(self):
            self.waits = []

        def is_set(self):
            return bool(self.waits)

        def wait(self, seconds):
            self.waits.append(seconds)
            return True

    stop_event = StopAfterWait()
    worker._run_loop(worker_id=2, stop_event=stop_event)

    assert stop_event.waits == [0.25]


def test_worker_still_claims_pending_work_on_an_already_running_scan(monkeypatch):
    db = _ScanDatabase(claimed=set())
    worker = _worker(db)
    pending_job = object()
    calls = []
    monkeypatch.setattr(worker_module, "build_pending_jobs", lambda **_kwargs: [pending_job])
    monkeypatch.setattr(worker_module, "harness_for", lambda *_args, **_kwargs: object())
    worker._ensure_scan_cache_prewarmed = lambda *_args, **_kwargs: False
    cleanup_requests = []
    worker._schedule_post_task_cleanup = lambda: cleanup_requests.append(True)

    def execute_job(**kwargs):
        calls.append(kwargs["job"])
        return True

    worker.execute_job = execute_job

    assert worker.run_scan_once(worker_id=2) is True
    assert calls == [pending_job]
    assert cleanup_requests == [True]


class _RateLimitDatabase:
    def __init__(self):
        self.scan = {
            "id": 58,
            "workflow_id": 2,
            "status": "running",
            "repo_full": "owner/repo",
            "harness": "codex",
            "reasoning": None,
        }
        self.deferred = []
        self.statuses = []

    @contextmanager
    def connect(self):
        yield _Connection()

    def claim_scan(self, _conn):
        return dict(self.scan)

    def defer_scan_after_rate_limit(self, _conn, scan_id, **kwargs):
        self.deferred.append((scan_id, kwargs))
        self.scan["status"] = "rate_limited"
        return True

    def set_scan_status(self, _conn, scan_id, status, error=None):
        self.statuses.append((scan_id, status, error))
        self.scan["status"] = status


def test_exhausted_rate_limit_is_deferred_for_automatic_resume():
    db = _RateLimitDatabase()
    worker = _worker(db)
    worker.process_scan = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        RateLimitExhausted("provider rate limited", retry_after_seconds=12.0)
    )

    assert worker.run_scan_once(worker_id=2) is True

    assert db.statuses == []
    assert db.deferred == [
        (
            58,
            {
                "retry_after_seconds": RATE_LIMIT_RESUME_DELAY_SECONDS,
                "error": "provider rate limited",
                "limit_kind": "rate_limited",
                "autoscale_workers": False,
                "current_worker_cap": 1,
            },
        )
    ]


def test_rate_limited_account_does_not_defer_scan_while_another_account_is_healthy(monkeypatch):
    db = _RateLimitDatabase()
    worker = _worker(db)
    worker.process_scan = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        RateLimitExhausted(
            "provider rate limited",
            retry_after_seconds=12.0,
            provider="codex",
            account_home="/accounts/limited/.codex",
        )
    )
    marked = []
    monkeypatch.setattr(worker_module, "mark_provider_account_rate_limited", lambda *args: marked.append(args))
    monkeypatch.setattr(worker_module, "provider_accounts_all_rate_limited", lambda *_args, **_kwargs: False)

    assert worker.run_scan_once(worker_id=2) is True

    assert marked == [("codex", "/accounts/limited/.codex")]
    assert db.deferred == []
    assert db.scan["status"] == "running"


def test_provider_throttle_defers_without_marking_the_account_limited(monkeypatch):
    db = _RateLimitDatabase()
    worker = _worker(db)
    worker.process_scan = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        RateLimitExhausted(
            "provider server throttle",
            retry_after_seconds=12.0,
            provider="claude",
            account_home="/accounts/claude",
            limit_kind="provider_throttled",
        )
    )
    marked = []
    monkeypatch.setattr(worker_module, "mark_provider_account_rate_limited", lambda *args: marked.append(args))

    assert worker.run_scan_once(worker_id=2) is True

    assert marked == []
    assert db.deferred[0][1]["limit_kind"] == "provider_throttled"
    assert db.deferred[0][1]["autoscale_workers"] is True
    assert db.deferred[0][1]["current_worker_cap"] == 1
    assert db.scan["status"] == "rate_limited"


def test_subagent_limit_defers_and_autoscales_without_marking_the_account_limited(monkeypatch):
    db = _RateLimitDatabase()
    worker = _worker(db)
    worker.process_scan = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        RateLimitExhausted(
            "Codex premium subagent limit",
            retry_after_seconds=12.0,
            provider="codex",
            account_home="/accounts/healthy/.codex",
            limit_kind="subagent_limited",
        )
    )
    marked = []
    monkeypatch.setattr(worker_module, "mark_provider_account_rate_limited", lambda *args: marked.append(args))

    assert worker.run_scan_once(worker_id=2) is True

    assert marked == []
    assert db.deferred[0][1]["limit_kind"] == "subagent_limited"
    assert db.deferred[0][1]["autoscale_workers"] is True
    assert db.deferred[0][1]["current_worker_cap"] == 1
    assert db.scan["status"] == "rate_limited"


def test_rate_limit_recovery_keeps_deferring_without_a_resume_limit():
    db = _RateLimitDatabase()
    worker = _worker(db)
    worker.process_scan = lambda *_args, **_kwargs: (_ for _ in ()).throw(
        RateLimitExhausted("provider rate limited", retry_after_seconds=12.0)
    )

    assert worker.run_scan_once(worker_id=2) is True
    db.scan["status"] = "running"
    assert worker.run_scan_once(worker_id=2) is True

    assert len(db.deferred) == 2
    assert all(item[1]["retry_after_seconds"] == 60 for item in db.deferred)
    assert db.statuses == []


def test_rate_limit_backoff_is_exponential_and_jitter_is_testable(monkeypatch):
    monkeypatch.setattr(worker_module.random, "uniform", lambda _low, _high: 1.0)
    error = worker_module.HarnessError("rate limited", code="rate_limited")

    assert worker_module._rate_limit_retry_delay(error, 1) == 5.0
    assert worker_module._rate_limit_retry_delay(error, 2) == 10.0
    assert worker_module._rate_limit_retry_delay(error, 8) == 60.0

    hinted = worker_module.HarnessError("rate limited", code="rate_limited", retry_after_seconds=17.0)
    assert worker_module._rate_limit_retry_delay(hinted, 1) == 17.0

    quota = worker_module.HarnessError(
        "quota limited",
        code="account_quota_limited",
        retry_after_seconds=2 * 24 * 60 * 60,
    )
    assert worker_module._rate_limit_retry_delay(quota, 1) == RATE_LIMIT_RESUME_DELAY_SECONDS


class _QueryResult:
    def __init__(self, row=None):
        self.row = row

    def fetchone(self):
        return self.row

    def fetchall(self):
        return self.row or []


class _RecordingConnection:
    def __init__(self, rows=()):
        self.calls = []
        self.rows = iter(rows)

    def execute(self, query, params=None):
        self.calls.append((query, params))
        return _QueryResult(next(self.rows, None))


def test_artifact_cleanup_state_protects_running_workspaces_and_resumable_scans():
    retained_after = worker_module.now_utc()
    conn = _RecordingConnection(
        rows=(
            None,
            [{"workspace_id": 91}, {"workspace_id": 1_000_000_092}],
            [{"id": 144}, {"id": 145}],
        )
    )

    active_workspace_ids, retained_scan_ids = Database("").load_artifact_cleanup_state(
        conn,
        retain_inactive_scan_caches_after=retained_after,
        retain_finished_workspaces_after=retained_after,
    )

    assert active_workspace_ids == {91, 1_000_000_092}
    assert retained_scan_ids == {144, 145}
    assert "pg_advisory_xact_lock" in conn.calls[0][0]
    assert "post_process_metadata" in conn.calls[1][0]
    assert conn.calls[1][1] == (retained_after, 1_000_000_000, retained_after)
    assert "updated_at >= %s" in conn.calls[1][0]
    assert "updated_at >= %s" in conn.calls[2][0]
    assert conn.calls[2][1] == (retained_after,)


def test_recursive_artifact_deletion_runs_after_database_lock_is_released(monkeypatch, tmp_path):
    class CleanupDatabase:
        active = False

        @contextmanager
        def connect(self):
            self.active = True
            try:
                yield _Connection()
            finally:
                self.active = False

        def load_artifact_cleanup_state(self, _conn, **_kwargs):
            return set(), set()

        def load_active_scan_cache_specs(self, _conn):
            return []

    database = CleanupDatabase()
    worker = Worker.__new__(Worker)
    worker.db = database
    worker.config = SimpleNamespace(
        data_dir=str(tmp_path),
        scan_cache_retention_days=0,
        checkout_cache_dir=str(tmp_path / "checkout-cache"),
        checkout_cache_persist_dir=str(tmp_path / "persist"),
        repo_dir=str(tmp_path / "jobs"),
    )
    deletion_states = []
    monkeypatch.setattr(
        worker_module,
        "delete_quarantined_artifacts",
        lambda _artifacts: deletion_states.append(database.active),
    )

    worker.cleanup_orphaned_artifacts(minimum_age_seconds=0)

    assert deletion_states == [False]


class _StorageDatabase:
    def __init__(self):
        self.warnings = []
        self.cleared = []

    @contextmanager
    def connect(self):
        yield _Connection()

    def set_scan_storage_warning(self, _conn, scan_id, **warning):
        self.warnings.append((scan_id, warning))
        return True

    def clear_scan_storage_warning(self, _conn, scan_id):
        self.cleared.append(scan_id)
        return True


def test_worker_blocks_new_scan_containers_below_storage_floor(monkeypatch):
    database = _StorageDatabase()
    worker = Worker.__new__(Worker)
    worker.db = database
    worker.config = SimpleNamespace(data_dir="/data", min_free_storage_bytes=20 * 1024**3)
    worker.runtime_min_free_storage_bytes = lambda: 20 * 1024**3
    worker.runtime_ignore_low_storage = lambda: False
    monkeypatch.setattr(worker_module.shutil, "disk_usage", lambda _path: SimpleNamespace(free=19 * 1024**3))

    assert worker._new_scan_container_allowed(58) is False
    assert database.warnings == [
        (
            58,
            {
                "free_bytes": 19 * 1024**3,
                "required_bytes": 20 * 1024**3,
                "check_error": None,
            },
        )
    ]
    assert database.cleared == []


def test_worker_clears_storage_warning_before_launching_after_recovery(monkeypatch):
    database = _StorageDatabase()
    worker = Worker.__new__(Worker)
    worker.db = database
    worker.config = SimpleNamespace(data_dir="/data", min_free_storage_bytes=20 * 1024**3)
    worker.runtime_min_free_storage_bytes = lambda: 20 * 1024**3
    worker.runtime_ignore_low_storage = lambda: False
    monkeypatch.setattr(worker_module.shutil, "disk_usage", lambda _path: SimpleNamespace(free=21 * 1024**3))

    assert worker._new_scan_container_allowed(58) is True
    assert database.warnings == []
    assert database.cleared == [58]


def test_low_storage_requests_a_docker_cache_prune(monkeypatch):
    database = _StorageDatabase()
    worker = Worker.__new__(Worker)
    worker.db = database
    worker.config = SimpleNamespace(data_dir="/data", min_free_storage_bytes=20 * 1024**3)
    worker.runtime_min_free_storage_bytes = lambda: 20 * 1024**3
    worker.runtime_ignore_low_storage = lambda: False
    prune_requests = []
    worker._schedule_docker_storage_cleanup = lambda: prune_requests.append(True)
    monkeypatch.setattr(worker_module.shutil, "disk_usage", lambda _path: SimpleNamespace(free=19 * 1024**3))

    assert worker._new_scan_container_allowed(58) is False
    assert prune_requests == [True]


def test_worker_reads_live_scan_storage_floor(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    (tmp_path / "engine-runtime.env").write_text(
        "ENGINE_MIN_FREE_STORAGE_GB=17.5\nENGINE_IGNORE_LOW_STORAGE=true\n",
        encoding="utf-8",
    )
    worker = Worker.__new__(Worker)
    worker.config = SimpleNamespace(
        data_dir=str(tmp_path),
        min_free_storage_bytes=20 * 1024**3,
        ignore_low_storage=False,
    )

    assert worker.runtime_min_free_storage_bytes() == int(17.5 * 1024**3)
    assert worker.runtime_ignore_low_storage() is True


def test_worker_ignores_low_storage_and_clears_existing_warning(monkeypatch):
    database = _StorageDatabase()
    worker = Worker.__new__(Worker)
    worker.db = database
    worker.config = SimpleNamespace(
        data_dir="/data",
        min_free_storage_bytes=20 * 1024**3,
        ignore_low_storage=True,
    )
    worker.runtime_min_free_storage_bytes = lambda: 20 * 1024**3
    worker.runtime_ignore_low_storage = lambda: True
    monkeypatch.setattr(
        worker_module.shutil,
        "disk_usage",
        lambda _path: pytest.fail("disabled storage safeguard must not inspect disk usage"),
    )

    assert worker._new_scan_container_allowed(58) is True
    assert database.warnings == []
    assert database.cleared == [58]


def test_completion_cleanup_uses_zero_grace_for_finished_scan_caches():
    worker = Worker.__new__(Worker)
    worker._artifact_cleanup_lock = worker_module.threading.Lock()
    worker._artifact_cleanup_lock.acquire()
    worker._artifact_cleanup_requested = False
    calls = []
    worker.cleanup_orphaned_artifacts = lambda **kwargs: calls.append(kwargs)

    worker._run_scheduled_artifact_cleanup(completion_triggered=True)

    assert calls == [
        {
            "minimum_age_seconds": worker_module.ARTIFACT_CLEANUP_GRACE_SECONDS,
            "persisted_cache_minimum_age_seconds": 0,
        }
    ]


def test_concurrent_task_completions_schedule_only_one_docker_cleanup(monkeypatch):
    starts = []

    class DeferredThread:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

        def start(self):
            starts.append(self.kwargs)

    worker = Worker.__new__(Worker)
    worker.config = SimpleNamespace(
        auto_prune_docker_build_cache=True,
        auto_prune_unused_docker_images=True,
        docker_build_cache_prune_interval_seconds=300,
    )
    worker._docker_storage_cleanup_lock = worker_module.threading.Lock()
    worker._next_docker_storage_cleanup = 0
    monkeypatch.setattr(worker_module.threading, "Thread", DeferredThread)

    scheduled = [worker._schedule_docker_storage_cleanup() for _ in range(10)]

    assert scheduled == [True] + [False] * 9
    assert len(starts) == 1
    assert starts[0]["name"] == "docker-storage-cleaner"


def test_docker_cleanup_steps_continue_after_one_failure(monkeypatch):
    worker = Worker.__new__(Worker)
    worker.config = SimpleNamespace(
        auto_prune_docker_build_cache=True,
        auto_prune_unused_docker_images=True,
        docker_build_cache_keep_bytes=0,
    )
    worker._docker_storage_cleanup_lock = worker_module.threading.Lock()
    worker._docker_storage_cleanup_lock.acquire()
    calls = []

    def fail_builder(**_kwargs):
        calls.append("builder")
        raise RuntimeError("builder unavailable")

    monkeypatch.setattr(worker_module, "prune_docker_build_cache", fail_builder)
    monkeypatch.setattr(worker_module, "prune_stopped_scan_containers", lambda: calls.append("containers"))
    monkeypatch.setattr(worker_module, "prune_unused_docker_images", lambda: calls.append("images"))

    worker._run_docker_storage_cleanup()

    assert calls == ["builder", "containers", "images"]
    assert worker._docker_storage_cleanup_lock.acquire(blocking=False)


def test_storage_warning_is_persisted_inside_object_normalized_scan_reasoning():
    conn = _RecordingConnection(rows=({"id": 58},))

    assert Database("").set_scan_storage_warning(
        conn,
        58,
        free_bytes=12 * 1024**3,
        required_bytes=20 * 1024**3,
    )

    query, params = conn.calls[0]
    assert "'{storage_warning}'" in query
    assert "jsonb_typeof(reasoning) = 'object'" in query
    assert "ELSE '{}'::jsonb" in query
    assert "status IN ('prewarming_cache', 'running', 'post_processing')" in query
    assert params[0].obj["code"] == "low_storage"
    assert params[0].obj["free_bytes"] == 12 * 1024**3
    assert params[0].obj["required_bytes"] == 20 * 1024**3


def test_storage_warning_clear_preserves_other_scan_reasoning():
    conn = _RecordingConnection(rows=({"id": 58},))

    assert Database("").clear_scan_storage_warning(conn, 58)

    query, params = conn.calls[0]
    assert "reasoning - 'storage_warning'" in query
    assert "jsonb_typeof(reasoning) = 'object'" in query
    assert params == (58,)


class _PoolDatabase:
    def __init__(self, scans):
        self.scans = scans

    @contextmanager
    def connect(self):
        yield _Connection()

    def claim_scans(self, _conn, *, max_concurrent_scans):
        return self.scans[:max_concurrent_scans]


def _pool_worker(*, worker_count, max_per_scan, scans):
    worker = Worker.__new__(Worker)
    worker.db = _PoolDatabase(scans)
    worker.config = SimpleNamespace(data_dir="/tmp")
    worker.runtime_worker_count = lambda: worker_count
    worker.runtime_memory_capacity = lambda: worker_module.MemoryCapacity(
        configured_workers=worker_count,
        effective_workers=worker_count,
        total_bytes=None,
        reserve_bytes=0,
        runner_bytes=0,
    )
    worker._memory_allows_new_runner = lambda: True
    worker.runtime_max_concurrent_scans = lambda: len(scans)
    worker.runtime_max_workers_per_scan = lambda: max_per_scan
    return worker


def test_fair_scheduler_uses_the_memory_budget_as_its_global_worker_limit():
    scans = [{"id": 1, "inserted_at": "1"}]
    worker = _pool_worker(worker_count=15, max_per_scan=15, scans=scans)
    worker.runtime_memory_capacity = lambda: worker_module.MemoryCapacity(
        configured_workers=15,
        effective_workers=4,
        total_bytes=8 * 1024**3,
        reserve_bytes=2 * 1024**3,
        runner_bytes=1536 * 1024**2,
    )

    assert [worker._reserve_scan()["id"] for _ in range(4)] == [1, 1, 1, 1]
    assert worker._reserve_scan() is None


def test_fair_scheduler_pauses_admission_when_live_memory_is_low():
    scans = [{"id": 1, "inserted_at": "1"}]
    worker = _pool_worker(worker_count=8, max_per_scan=8, scans=scans)
    worker._memory_allows_new_runner = lambda: False

    assert worker._reserve_scan() is None


def test_live_memory_gate_preserves_the_reserve_before_admitting_a_runner():
    worker = Worker.__new__(Worker)
    worker.runtime_memory_reserve_bytes = lambda: int(1.25 * 1024**3)
    worker.runtime_scan_runner_memory_reservation_mb = lambda: 800
    worker._system_memory_available_bytes = lambda: 2 * 1024**3

    assert worker._memory_allows_new_runner() is False

    worker._system_memory_available_bytes = lambda: 3 * 1024**3
    assert worker._memory_allows_new_runner() is True


def test_worker_capacity_uses_soft_reservation_instead_of_hard_limit():
    worker = Worker.__new__(Worker)
    worker.config = SimpleNamespace(data_dir="/tmp")
    worker.runtime_worker_count = lambda: 10
    worker.runtime_memory_reserve_bytes = lambda: int(2.5 * 1024**3)
    worker.runtime_scan_runner_memory_mb = lambda: 2048
    worker.runtime_scan_runner_memory_reservation_mb = lambda: 768
    worker._system_memory_total_bytes = lambda: int(11.67 * 1024**3)

    capacity = worker.runtime_memory_capacity()

    assert capacity.effective_workers == 10
    assert capacity.runner_bytes == 768 * 1024**2


def test_fair_scheduler_divides_six_workers_evenly_between_two_scans():
    scans = [{"id": 1, "inserted_at": "1"}, {"id": 2, "inserted_at": "2"}]
    worker = _pool_worker(worker_count=6, max_per_scan=0, scans=scans)

    reserved = [worker._reserve_scan()["id"] for _ in range(6)]

    assert reserved.count(1) == 3
    assert reserved.count(2) == 3
    assert worker._reserve_scan() is None


def test_fair_scheduler_honors_a_hard_per_scan_worker_cap():
    scans = [{"id": 1, "inserted_at": "1"}, {"id": 2, "inserted_at": "2"}]
    worker = _pool_worker(worker_count=6, max_per_scan=2, scans=scans)

    reserved = [worker._reserve_scan()["id"] for _ in range(4)]

    assert reserved.count(1) == 2
    assert reserved.count(2) == 2
    assert worker._reserve_scan() is None


def test_fair_scheduler_lends_unused_workers_to_a_scan_that_can_claim_work(monkeypatch):
    scans = [{"id": 1, "inserted_at": "1"}, {"id": 2, "inserted_at": "2"}]
    worker = _pool_worker(worker_count=6, max_per_scan=0, scans=scans)
    worker.config.poll_seconds = 5
    monkeypatch.setattr(worker_module.time, "monotonic", lambda: 100.0)

    first = worker._reserve_scan()
    second = worker._reserve_scan()
    worker._record_scan_claim_result(second["id"], did_work=False)
    worker._release_scan(second["id"])
    borrowed = [worker._reserve_scan()["id"] for _ in range(5)]

    assert first["id"] == 1
    assert second["id"] == 2
    assert borrowed == [1, 1, 1, 1, 1]
    assert worker._reserve_scan() is None


def test_fair_scheduler_retries_a_scan_after_its_no_work_cooldown(monkeypatch):
    scans = [{"id": 1, "inserted_at": "1"}, {"id": 2, "inserted_at": "2"}]
    worker = _pool_worker(worker_count=2, max_per_scan=0, scans=scans)
    worker.config.poll_seconds = 5
    clock = [100.0]
    monkeypatch.setattr(worker_module.time, "monotonic", lambda: clock[0])

    first = worker._reserve_scan()
    second = worker._reserve_scan()
    worker._record_scan_claim_result(second["id"], did_work=False)
    worker._release_scan(second["id"])
    clock[0] += 5

    retried = worker._reserve_scan()

    assert first["id"] == 1
    assert second["id"] == 2
    assert retried["id"] == 2


def test_fair_scheduler_honors_a_scan_specific_provider_capacity_cap():
    scans = [
        {
            "id": 1,
            "inserted_at": "1",
            "reasoning": {"provider_capacity_worker_cap": 2},
        }
    ]
    worker = _pool_worker(worker_count=6, max_per_scan=0, scans=scans)

    reserved = [worker._reserve_scan()["id"] for _ in range(2)]

    assert reserved == [1, 1]
    assert worker._reserve_scan() is None


def test_provider_capacity_reduces_from_actual_in_flight_concurrency():
    scans = [{"id": 1, "inserted_at": "1"}]
    worker = _pool_worker(worker_count=25, max_per_scan=0, scans=scans)

    reservations = [worker._reserve_scan() for _ in range(20)]

    assert reservations[-1]["_reserved_worker_cap"] == 25
    assert worker._scan_worker_cap_at_failure(reservations[-1]) == 20


def test_fair_scheduler_rotates_when_there_are_more_scans_than_workers():
    scans = [
        {"id": 1, "inserted_at": "1"},
        {"id": 2, "inserted_at": "2"},
        {"id": 3, "inserted_at": "3"},
    ]
    worker = _pool_worker(worker_count=2, max_per_scan=0, scans=scans)

    first = worker._reserve_scan()
    second = worker._reserve_scan()
    worker._release_scan(first["id"])
    third = worker._reserve_scan()

    assert [first["id"], second["id"], third["id"]] == [1, 2, 3]


def test_claim_scan_skips_deferred_rate_limits_and_clears_due_timestamp_on_claim():
    conn = _RecordingConnection(rows=(None, {"count": 0}, None, None, None, []))

    assert Database("").claim_scan(conn, max_concurrent_scans=2) is None

    pending_query = conn.calls[2][0]
    assert "status = 'rate_limited'" in pending_query
    assert "reasoning->>'retry_after'" in pending_query
    assert "::timestamptz <= now()" in pending_query
    assert "updated_at + make_interval" in pending_query
    assert conn.calls[2][1] == (QUOTA_RETRY_MAX_SECONDS,)
    assert "reasoning - 'error' - 'retry_after'" in pending_query
    assert "last_resumed_at" in pending_query


def test_claim_scan_admits_the_oldest_queued_scan_when_the_pool_is_empty():
    queued_scan = {"id": 81, "status": "running"}
    conn = _RecordingConnection(rows=(None, {"count": 0}, None, queued_scan, [queued_scan]))

    assert Database("").claim_scan(conn, max_concurrent_scans=2) == queued_scan

    lock_query, lock_params = conn.calls[0]
    queued_query, queued_params = conn.calls[3]
    assert "pg_advisory_xact_lock" in lock_query
    assert len(lock_params) == 2
    assert "status = 'queued'" in queued_query
    assert "ORDER BY s.inserted_at ASC" in queued_query
    assert queued_params is None


def test_claim_scan_does_not_admit_waiting_work_when_the_pool_is_full():
    active_scan = {"id": 80, "status": "running"}
    conn = _RecordingConnection(rows=(None, {"count": 1}, [active_scan]))

    assert Database("").claim_scan(conn) == active_scan
    assert len(conn.calls) == 3
    assert all("status = 'pending'" not in query for query, _params in conn.calls)
    assert all("status = 'queued'" not in query for query, _params in conn.calls)


def test_claim_scan_keeps_queued_work_waiting_while_any_scan_is_active():
    active_scan = {"id": 80, "status": "running"}
    conn = _RecordingConnection(rows=(None, {"count": 1}, None, None, [active_scan]))

    assert Database("").claim_scan(conn, max_concurrent_scans=2) == active_scan

    assert any("status = 'pending'" in query for query, _params in conn.calls)
    assert all("status = 'queued'" not in query for query, _params in conn.calls)


def test_logical_job_limit_consumes_new_slots_but_not_retries():
    database = Database("")
    retry_conn = _RecordingConnection()
    assert database.claim_logical_job_slot(
        retry_conn,
        scan={"job_limit": 1, "jobs_started": 1},
        scan_id=58,
        already_started=True,
    )
    assert retry_conn.calls == []

    new_conn = _RecordingConnection()
    assert database.claim_logical_job_slot(
        new_conn,
        scan={"job_limit": 2, "jobs_started": 1},
        scan_id=58,
        already_started=False,
    )
    assert "jobs_started = jobs_started + 1" in new_conn.calls[0][0]


def test_logical_job_limit_stops_only_after_admitted_jobs_finish():
    database = Database("")
    active_conn = _RecordingConnection(rows=({"count": 1},))
    assert not database.claim_logical_job_slot(
        active_conn,
        scan={"job_limit": 2, "jobs_started": 2},
        scan_id=58,
        already_started=False,
    )
    assert len(active_conn.calls) == 1

    idle_conn = _RecordingConnection(rows=({"count": 0}, None))
    assert not database.claim_logical_job_slot(
        idle_conn,
        scan={"job_limit": 2, "jobs_started": 2},
        scan_id=58,
        already_started=False,
    )
    stop_query, stop_params = idle_conn.calls[1]
    assert "status = 'stopped'" in stop_query
    assert stop_params[1] == 58


def test_defer_scan_records_retry_deadline_without_schema_changes():
    conn = _RecordingConnection(rows=({"reasoning": None}, {"id": 58}))

    deferred = Database("").defer_scan_after_rate_limit(
        conn,
        58,
        retry_after_seconds=45.0,
        error="provider rate limited",
    )

    assert deferred is True
    query, params = conn.calls[1]
    assert "status = 'rate_limited'" in query
    assert "reasoning = %s::jsonb" in query
    assert "'retry_after', now() + make_interval" in query
    assert "'post_processing', 'failed'" in query
    assert "%s::double precision" in query
    assert params[0].obj == {
        "code": "rate_limited",
        "limit_kind": "rate_limited",
        "error": "provider rate limited",
        "retry_count": 1,
    }
    assert params[1:] == (RATE_LIMIT_RETRY_BASE_SECONDS, 58)


@pytest.mark.parametrize("limit_kind", ["provider_throttled", "subagent_limited"])
def test_defer_scan_reduces_capacity_limited_scan_cap_one_at_a_time(limit_kind):
    conn = _RecordingConnection(
        rows=(
            {
                "reasoning": {
                    "provider_capacity_autoscale_enabled": True,
                    "provider_capacity_initial_worker_cap": 20,
                    "provider_capacity_worker_cap": 19,
                    "provider_capacity_autoscale_events": 1,
                }
            },
            {"id": 58},
        )
    )

    assert Database("").defer_scan_after_rate_limit(
        conn,
        58,
        retry_after_seconds=45,
        error="server is temporarily limiting requests",
        limit_kind=limit_kind,
        autoscale_workers=True,
        current_worker_cap=20,
    )

    reasoning = conn.calls[1][1][0].obj
    assert reasoning["provider_capacity_initial_worker_cap"] == 20
    assert reasoning["provider_capacity_previous_worker_cap"] == 19
    assert reasoning["provider_capacity_worker_cap"] == 18
    assert reasoning["provider_capacity_autoscale_events"] == 2


def test_persistent_rate_limit_backoff_grows_and_caps_without_a_retry_limit():
    assert rate_limit_retry_delay(1) == 60
    assert rate_limit_retry_delay(2) == 2 * 60
    assert rate_limit_retry_delay(3) == 4 * 60
    assert rate_limit_retry_delay(4) == 8 * 60
    assert rate_limit_retry_delay(5) == 10 * 60
    assert rate_limit_retry_delay(100) == RATE_LIMIT_RETRY_MAX_SECONDS
    assert rate_limit_retry_delay(1, provider_retry_after_seconds=30 * 60) == 10 * 60
    assert (
        rate_limit_retry_delay(
            1,
            provider_retry_after_seconds=6 * 24 * 60 * 60,
            maximum_seconds=QUOTA_RETRY_MAX_SECONDS,
        )
        == QUOTA_RETRY_MAX_SECONDS
    )


def test_persistent_quota_backoff_retries_quickly_and_caps_at_thirty_minutes():
    delays = [
        rate_limit_retry_delay(
            retry_count,
            provider_retry_after_seconds=RATE_LIMIT_RESUME_DELAY_SECONDS,
            maximum_seconds=QUOTA_RETRY_MAX_SECONDS,
        )
        for retry_count in range(1, 8)
    ]

    assert delays == [60, 2 * 60, 4 * 60, 8 * 60, 16 * 60, 30 * 60, 30 * 60]


def test_completed_scan_clears_transient_rate_limit_reasoning_but_preserves_autoscale_history():
    conn = _RecordingConnection()

    Database("").set_scan_status(conn, 58, "completed")

    query, params = conn.calls[0]
    assert "reasoning->>'code' = 'rate_limited'" in query
    assert "reasoning - 'code' - 'limit_kind' - 'error' - 'retry_after' - 'retry_count'" in query
    assert params == ["completed", 58]

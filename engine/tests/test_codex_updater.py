import subprocess
from types import SimpleNamespace

from open_kritt_engine import worker as worker_module
from open_kritt_engine.codex_updater import CodexCliGate, CodexUpdater, CodexUpdateResult
from open_kritt_engine.config import EngineConfig
from open_kritt_engine.worker import Worker


def _completed(command, *, returncode=0, stdout=""):
    return subprocess.CompletedProcess(command, returncode, stdout=stdout, stderr="")


def test_codex_updater_installs_latest_and_reports_version_change():
    calls = []
    versions = iter(["0.142.2", "0.144.3"])

    def run_command(command, **kwargs):
        calls.append((command, kwargs))
        if command[0] == "codex":
            return _completed(command, stdout=f"codex-cli {next(versions)}\n")
        return _completed(command)

    result = CodexUpdater(run_command=run_command).update()

    assert result == CodexUpdateResult(True, True, True, "0.142.2", "0.144.3")
    assert [command for command, _kwargs in calls] == [
        ["codex", "--version"],
        ["npm", "install", "--global", "--no-audit", "--no-fund", "@openai/codex@latest"],
        ["codex", "--version"],
    ]
    assert calls[1][1]["timeout"] == 120.0


def test_codex_updater_keeps_existing_cli_when_npm_fails():
    calls = []

    def run_command(command, **kwargs):
        calls.append(command)
        if command[0] == "codex":
            return _completed(command, stdout="codex-cli 0.142.2\n")
        return _completed(command, returncode=1)

    result = CodexUpdater(run_command=run_command).update()

    assert result == CodexUpdateResult(True, False, False, "0.142.2", None)
    assert calls == [
        ["codex", "--version"],
        ["npm", "install", "--global", "--no-audit", "--no-fund", "@openai/codex@latest"],
    ]


def test_codex_updater_treats_timeout_as_non_fatal():
    def run_command(command, **kwargs):
        if command[0] == "codex":
            return _completed(command, stdout="codex-cli 0.142.2\n")
        raise subprocess.TimeoutExpired(command, kwargs["timeout"])

    result = CodexUpdater(timeout_seconds=9, run_command=run_command).update()

    assert result == CodexUpdateResult(True, False, False, "0.142.2", None)


def test_codex_updater_defers_while_a_codex_command_is_active():
    gate = CodexCliGate()
    calls = []
    updater = CodexUpdater(gate=gate, run_command=lambda *args, **kwargs: calls.append((args, kwargs)))

    with gate.use():
        result = updater.update()

    assert result == CodexUpdateResult(False, False, False, None, None)
    assert calls == []


def test_engine_config_defaults_to_pinned_codex_and_allows_opt_in_updates(monkeypatch, tmp_path):
    for name in (
        "ENGINE_CODEX_AUTO_UPDATE",
        "ENGINE_CODEX_UPDATE_INTERVAL_SECONDS",
        "ENGINE_CODEX_UPDATE_TIMEOUT_SECONDS",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ENGINE_DATA_DIR", str(tmp_path))

    defaults = EngineConfig.from_env()

    assert defaults.codex_auto_update is False
    assert defaults.codex_update_interval_seconds == 86400.0
    assert defaults.codex_update_timeout_seconds == 120.0

    monkeypatch.setenv("ENGINE_CODEX_AUTO_UPDATE", "true")
    monkeypatch.setenv("ENGINE_CODEX_UPDATE_INTERVAL_SECONDS", "90")
    monkeypatch.setenv("ENGINE_CODEX_UPDATE_TIMEOUT_SECONDS", "30")
    configured = EngineConfig.from_env()

    assert configured.codex_auto_update is True
    assert configured.codex_update_interval_seconds == 90.0
    assert configured.codex_update_timeout_seconds == 30.0


def _worker(tmp_path):
    return Worker(
        SimpleNamespace(
            database_url="",
            workspace_setup_concurrency=1,
            data_dir=str(tmp_path),
            model_catalog_refresh_seconds=300,
            model_catalog_timeout_seconds=10,
            codex_auto_update=True,
            codex_update_interval_seconds=86400,
            codex_update_timeout_seconds=120,
        )
    )


def test_worker_refreshes_catalog_after_startup_codex_update(monkeypatch, tmp_path):
    worker = _worker(tmp_path)
    refreshes = []
    worker._schedule_model_catalog_refresh = lambda: refreshes.append(True)
    worker.codex_updater = SimpleNamespace(update=lambda: CodexUpdateResult(True, True, True, "0.142.2", "0.144.3"))
    monkeypatch.setattr(worker_module.time, "monotonic", lambda: 100.0)

    worker._update_codex_at_startup()

    assert refreshes == [True]
    assert worker._next_codex_update == 86500.0


def test_worker_retries_deferred_daily_update_without_refreshing_catalog(monkeypatch, tmp_path):
    worker = _worker(tmp_path)
    refreshes = []
    worker._schedule_model_catalog_refresh = lambda: refreshes.append(True)
    worker.codex_updater = SimpleNamespace(update=lambda: CodexUpdateResult(False, False, False, None, None))
    monkeypatch.setattr(worker_module.time, "monotonic", lambda: 100.0)
    assert worker._codex_update_lock.acquire(blocking=False)

    worker._run_scheduled_codex_update()

    assert refreshes == []
    assert worker._next_codex_update == 400.0
    assert not worker._codex_update_lock.locked()

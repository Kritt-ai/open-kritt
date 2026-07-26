import subprocess
from pathlib import Path
from types import SimpleNamespace

from open_kritt_engine import repository
from open_kritt_engine.config import EngineConfig
from open_kritt_engine.post_processing import PostProcessor
from open_kritt_engine.runtime_config import parse_env_text, runtime_bool, runtime_int, sync_runtime_config_file
from open_kritt_engine.worker import Worker


def _git(*args: str, cwd: Path | None = None) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=cwd,
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()


def _remote_with_history(tmp_path: Path) -> tuple[Path, str]:
    source = tmp_path / "source"
    source.mkdir()
    _git("init", "--quiet", cwd=source)
    _git("config", "user.name", "Test User", cwd=source)
    _git("config", "user.email", "test@example.com", cwd=source)
    requested = ""
    for index in range(3):
        (source / "file.txt").write_text(f"revision {index}\n", encoding="utf-8")
        _git("add", "file.txt", cwd=source)
        _git("commit", "--quiet", "-m", f"revision {index}", cwd=source)
        if index == 0:
            requested = _git("rev-parse", "HEAD", cwd=source)

    remote = tmp_path / "remote.git"
    _git("clone", "--quiet", "--bare", str(source), str(remote))
    _git("config", "uploadpack.allowReachableSHA1InWant", "true", cwd=remote)
    return remote, requested


def test_exact_commit_checkout_uses_a_shallow_fetch(monkeypatch, tmp_path):
    remote, requested = _remote_with_history(tmp_path)
    monkeypatch.setattr(repository, "github_clone_url", lambda *_args, **_kwargs: remote.as_uri())

    repo_dir, checked_out = repository.checkout_repo("owner/repo", requested, str(tmp_path / "cache"))

    assert checked_out == requested
    assert (Path(repo_dir) / ".git" / "shallow").is_file()
    assert _git("rev-list", "--count", "HEAD", cwd=Path(repo_dir)) == "1"


def test_exact_commit_checkout_falls_back_to_full_fetch(monkeypatch, tmp_path):
    remote, requested = _remote_with_history(tmp_path)
    monkeypatch.setattr(repository, "github_clone_url", lambda *_args, **_kwargs: remote.as_uri())
    original_run = repository._run
    shallow_attempts = 0

    def fail_shallow_fetch(cmd, cwd=None, env=None):
        nonlocal shallow_attempts
        if cmd[:3] == ["git", "fetch", "--depth=1"]:
            shallow_attempts += 1
            raise repository.RepoError("server rejected a direct SHA fetch")
        return original_run(cmd, cwd=cwd, env=env)

    monkeypatch.setattr(repository, "_run", fail_shallow_fetch)

    repo_dir, checked_out = repository.checkout_repo("owner/repo", requested, str(tmp_path / "cache"))

    assert shallow_attempts == 1
    assert checked_out == requested
    assert not (Path(repo_dir) / ".git" / "shallow").exists()
    assert int(_git("rev-list", "--count", "--all", cwd=Path(repo_dir))) >= 3


def test_exact_commit_checkout_uses_askpass_without_putting_private_token_in_commands(monkeypatch, tmp_path):
    requested = "a" * 40
    commands = []
    monkeypatch.setattr(repository, "_has_commit", lambda *_args: False)

    def fake_run(cmd, cwd=None, env=None):
        commands.append((cmd, env))
        return requested if cmd[:3] == ["git", "rev-parse", "HEAD"] else ""

    monkeypatch.setattr(repository, "_run", fake_run)

    _, checked_out = repository.checkout_repo(
        "private/repo",
        requested,
        str(tmp_path / "cache"),
        github_token="dummy-private-token",
    )

    assert checked_out == requested
    remote_command, remote_env = next(item for item in commands if item[0][:3] == ["git", "remote", "add"])
    fetch_command, fetch_env = next(item for item in commands if item[0][:3] == ["git", "fetch", "--depth=1"])
    assert remote_command[-1] == "https://github.com/private/repo.git"
    assert fetch_command[-2:] == ["origin", requested]
    assert all("dummy-private-token" not in part for command, _env in commands for part in command)
    assert remote_env is None
    assert fetch_env["GIT_ASKPASS_REQUIRE"] == "force"
    assert fetch_env["GITHUB_TOKEN"] == "dummy-private-token"


def test_git_failure_redacts_credentials_from_command_and_output(monkeypatch):
    token = "dummy-private-token"

    monkeypatch.setattr(
        repository.subprocess,
        "run",
        lambda *_args, **_kwargs: subprocess.CompletedProcess(
            [],
            1,
            stdout="",
            stderr=f"failed to access https://x-access-token:{token}@github.com/private/repo.git",
        ),
    )

    try:
        repository._run(
            ["git", "clone", f"https://x-access-token:{token}@github.com/private/repo.git"],
            env={"GITHUB_TOKEN": token},
        )
    except repository.RepoError as exc:
        message = str(exc)
    else:
        raise AssertionError("expected RepoError")

    assert token not in message
    assert message.count("[REDACTED]") >= 2


def test_authenticated_git_disables_credential_helpers_and_uses_minimal_environment(monkeypatch):
    captured = {}
    monkeypatch.setenv("DATABASE_URL", "database-secret")
    monkeypatch.setenv("OPENROUTER_API_KEY", "provider-secret")
    monkeypatch.setenv("PATH", "/usr/bin")

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["env"] = kwargs["env"]
        return subprocess.CompletedProcess(cmd, 0, stdout="ok", stderr="")

    monkeypatch.setattr(repository.subprocess, "run", fake_run)
    with repository._github_auth_environment("github-secret") as env:
        repository._run(["git", "fetch", "origin"], env=env)

    assert captured["cmd"][0:3] == ["git", "-c", "credential.helper="]
    assert "-c" in captured["cmd"]
    assert any(part.startswith("core.askPass=") for part in captured["cmd"])
    assert captured["env"]["GITHUB_TOKEN"] == "github-secret"
    assert "DATABASE_URL" not in captured["env"]
    assert "OPENROUTER_API_KEY" not in captured["env"]


def test_engine_startup_syncs_explicit_env_without_disabling_live_edits(monkeypatch, tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    runtime_path = data_dir / "engine-runtime.env"
    runtime_path.write_text(
        "# preserve this operator note\n"
        "ENGINE_WORKER_COUNT=10\n"
        "ENGINE_CODEX_HOME=/old/codex\n"
        "ENGINE_WORKER_COUNT=9\n"
        "CUSTOM_RUNTIME_VALUE=keep-me\n",
        encoding="utf-8",
    )
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    monkeypatch.delenv("ENGINE_WORKERS", raising=False)
    monkeypatch.delenv("CODEX_HOME", raising=False)
    monkeypatch.setenv("ENGINE_DATA_DIR", str(data_dir))
    monkeypatch.setenv("ENGINE_WORKER_COUNT", "25")
    monkeypatch.setenv("ENGINE_CODEX_HOME", "/new/codex-a,/new/codex-b")

    config = EngineConfig.from_env()
    text = runtime_path.read_text(encoding="utf-8")
    values = parse_env_text(text)

    assert config.worker_count == 25
    assert values["ENGINE_WORKER_COUNT"] == "25"
    assert text.count("ENGINE_WORKER_COUNT=25") == 2
    assert values["ENGINE_CODEX_HOME"] == "/old/codex"
    assert values["CUSTOM_RUNTIME_VALUE"] == "keep-me"
    assert "# preserve this operator note" in text

    runtime_path.write_text(text.replace("ENGINE_WORKER_COUNT=25", "ENGINE_WORKER_COUNT=3"), encoding="utf-8")
    assert runtime_int("ENGINE_WORKER_COUNT", 25, data_dir=str(data_dir), minimum=0) == 3


def test_engine_uses_conservative_worker_default(monkeypatch, tmp_path):
    for name in ("ENGINE_WORKER_COUNT", "ENGINE_WORKERS", "ENGINE_RUNTIME_CONFIG_PATH"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("ENGINE_DATA_DIR", str(tmp_path))

    config = EngineConfig.from_env()

    assert config.worker_count == 2
    assert parse_env_text((tmp_path / "engine-runtime.env").read_text(encoding="utf-8"))["ENGINE_WORKER_COUNT"] == "2"
    assert runtime_bool("ENGINE_AUTOSCALE_SCAN_WORKERS_ON_PROVIDER_CAPACITY", True, data_dir=str(tmp_path))


def test_workspace_setup_capacity_is_not_clamped_to_the_startup_worker_count(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    monkeypatch.setenv("ENGINE_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("ENGINE_WORKER_COUNT", "1")
    monkeypatch.setenv("ENGINE_WORKSPACE_SETUP_CONCURRENCY", "4")

    config = EngineConfig.from_env()

    assert config.worker_count == 1
    assert config.workspace_setup_concurrency == 4


def test_startup_preserves_runtime_values_when_env_is_not_explicit(monkeypatch, tmp_path):
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    runtime_path = data_dir / "engine-runtime.env"
    runtime_path.write_text("ENGINE_WORKER_COUNT=7\nENGINE_CODEX_HOME=/operator/codex\n", encoding="utf-8")
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    for name in (
        "ENGINE_WORKER_COUNT",
        "ENGINE_WORKERS",
        "ENGINE_CODEX_HOME",
        "CODEX_HOME",
        "ENGINE_WORKSPACE_SETUP_CONCURRENCY",
    ):
        monkeypatch.delenv(name, raising=False)

    sync_runtime_config_file(str(data_dir))

    assert parse_env_text(runtime_path.read_text(encoding="utf-8")) == {
        "ENGINE_WORKER_COUNT": "7",
        "ENGINE_CODEX_HOME": "/operator/codex",
    }


def test_worker_and_post_processor_read_live_retry_and_timeout_settings(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    runtime_path = tmp_path / "engine-runtime.env"
    runtime_path.write_text(
        "ENGINE_WORKER_COUNT=3\nENGINE_RETRY_COUNT=5\nENGINE_HARNESS_TIMEOUT_SECONDS=1800\n",
        encoding="utf-8",
    )
    config = SimpleNamespace(
        data_dir=str(tmp_path),
        worker_count=2,
        retry_count=2,
        harness_timeout_seconds=7200,
    )
    worker = Worker.__new__(Worker)
    worker.config = config
    post_processor = PostProcessor.__new__(PostProcessor)
    post_processor.config = config

    assert worker.runtime_worker_count() == 3
    assert worker.runtime_retry_count() == 5
    assert worker.runtime_harness_timeout_seconds() == 1800
    assert post_processor._retry_count() == 5

    runtime_path.write_text(
        "ENGINE_WORKER_COUNT=1\nENGINE_RETRY_COUNT=0\nENGINE_HARNESS_TIMEOUT_SECONDS=600\n",
        encoding="utf-8",
    )
    assert worker.runtime_worker_count() == 1
    assert worker.runtime_retry_count() == 0
    assert worker.runtime_harness_timeout_seconds() == 600
    assert post_processor._retry_count() == 0

    runtime_path.write_text(
        "ENGINE_WORKER_COUNT=-1\nENGINE_RETRY_COUNT=99\nENGINE_HARNESS_TIMEOUT_SECONDS=30\n",
        encoding="utf-8",
    )
    assert worker.runtime_worker_count() == 2
    assert worker.runtime_retry_count() == 2
    assert worker.runtime_harness_timeout_seconds() == 7200
    assert post_processor._retry_count() == 2

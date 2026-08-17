import json
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from open_kritt_engine import harnesses
from open_kritt_engine import workspace as workspace_module
from open_kritt_engine.schema import EXTRACTOR_HELPER_FIELD
from open_kritt_engine.workspace import prepare_job_workspace, prewarm_scan_checkout_cache

REAL_SCAN_DOCKER_COMMAND = harnesses._scan_docker_command
REAL_RESOLVE_SCAN_CHECKOUT_REVISIONS = workspace_module.resolve_scan_checkout_revisions


def marked(payload):
    return {EXTRACTOR_HELPER_FIELD: True, **payload}


def scan(configuration=None):
    return {
        "id": 7,
        "workflow_id": 3,
        "repo_full": "owner/repo",
        "repo_kind": "remote",
        "commit_sha": "HEAD",
        "repo_scope": "full repository",
        "dependencies": [],
        "dependencies_detail": [],
        "configuration": configuration or {},
        "model": "test-model",
        "harness": "codex",
    }


def fake_cache_git_head(path):
    repo_txt = Path(path) / "repo.txt"
    if not repo_txt.exists():
        return None
    return f"commit-{repo_txt.read_text(encoding='utf-8').split('/')[-1]}"


@pytest.fixture(autouse=True)
def isolate_unit_tests_from_external_runners(monkeypatch):
    monkeypatch.setattr(harnesses, "_scan_docker_command", lambda cmd, _repo_dir, _env: cmd)
    monkeypatch.setattr(workspace_module, "resolve_scan_checkout_revisions", lambda value, **_kwargs: value)


def test_remote_head_is_resolved_once_per_scan_before_cache_keys_are_built(monkeypatch, tmp_path):
    resolutions = iter(["a" * 40, "b" * 40])
    calls = []

    def fake_resolve(repo_full, github_token=None):
        calls.append((repo_full, github_token))
        return next(resolutions)

    monkeypatch.setattr(workspace_module, "resolve_remote_head", fake_resolve)
    first_scan = {**scan(), "id": 71, "commit_sha": "HEAD"}
    first = REAL_RESOLVE_SCAN_CHECKOUT_REVISIONS(
        first_scan,
        github_token="private-token",
        data_dir=str(tmp_path / "data"),
    )
    first_again = REAL_RESOLVE_SCAN_CHECKOUT_REVISIONS(
        first_scan,
        github_token="private-token",
        data_dir=str(tmp_path / "data"),
    )
    second = REAL_RESOLVE_SCAN_CHECKOUT_REVISIONS(
        {**first_scan, "id": 72},
        github_token="private-token",
        data_dir=str(tmp_path / "data"),
    )

    assert first["commit_sha"] == "a" * 40
    assert first_again["commit_sha"] == "a" * 40
    assert second["commit_sha"] == "b" * 40
    assert calls == [("owner/repo", "private-token"), ("owner/repo", "private-token")]
    assert "@HEAD" not in str(workspace_module._scan_cache_bases(tmp_path / "cache", first)[0])
    assert (tmp_path / "data" / "scan-revisions").stat().st_mode & 0o777 == 0o700


def test_prewarm_uses_resolved_head_instead_of_accepting_literal_head_cache(monkeypatch, tmp_path):
    commit = "c" * 40
    requested = []

    monkeypatch.setattr(workspace_module, "resolve_scan_checkout_revisions", REAL_RESOLVE_SCAN_CHECKOUT_REVISIONS)
    monkeypatch.setattr(workspace_module, "resolve_remote_head", lambda *_args, **_kwargs: commit)
    monkeypatch.setattr(workspace_module, "_git_head_commit", fake_cache_git_head)

    def fake_checkout(repo_full, commit_sha, base_dir, github_token=None):
        requested.append(commit_sha)
        repo = Path(base_dir) / repo_full.replace("/", "__")
        (repo / ".git").mkdir(parents=True)
        return str(repo), commit_sha

    monkeypatch.setattr(workspace_module, "checkout_repo", fake_checkout)
    stale = tmp_path / "cache" / "owner__repo@HEAD" / "owner__repo"
    (stale / ".git").mkdir(parents=True)
    (stale / "stale.txt").write_text("old HEAD", encoding="utf-8")

    manifest = prewarm_scan_checkout_cache(
        checkout_cache_dir=str(tmp_path / "cache"),
        scan={**scan(), "id": 73, "commit_sha": "HEAD"},
        data_dir=str(tmp_path / "data"),
    )

    assert requested == [commit]
    assert manifest["primary"]["requested_commit"] == commit
    assert (tmp_path / "cache" / f"owner__repo@{commit}").is_dir()
    assert (stale / "stale.txt").read_text(encoding="utf-8") == "old HEAD"


def test_scan_runner_startup_rejects_missing_runner_image(monkeypatch, tmp_path):
    monkeypatch.setenv("ENGINE_DOCKER_DATA_DIR_HOST", str(tmp_path / "engine-data"))
    monkeypatch.setenv("ENGINE_SCAN_RUNNER_IMAGE", "runner-image")
    monkeypatch.setattr(harnesses.shutil, "which", lambda _name: "/usr/bin/docker")

    def fake_docker_control_run(command):
        if command[1:3] == ["image", "inspect"]:
            return subprocess.CompletedProcess(command, 1, "", "missing")
        return subprocess.CompletedProcess(command, 0, "ok\n", "")

    monkeypatch.setattr(harnesses, "_docker_control_run", fake_docker_control_run)

    with pytest.raises(harnesses.HarnessError, match="Scan runner image is not available") as exc_info:
        harnesses.validate_scan_runner_configuration()

    assert exc_info.value.code == "configuration_error"


def test_prewarm_rebuilds_previous_marker_version_instead_of_promoting_it(monkeypatch, tmp_path):
    stale_base = tmp_path / "cache" / "owner__repo@HEAD"
    stale_repo = stale_base / "owner__repo"
    (stale_repo / ".git").mkdir(parents=True)
    (stale_repo / "poisoned.txt").write_text("old-hardlink-content", encoding="utf-8")
    (stale_base / workspace_module.CACHE_READY_FILENAME).write_text(
        json.dumps(
            {
                "version": workspace_module.CACHE_MARKER_VERSION - 1,
                "kind": "remote",
                "repo_dir": "owner__repo",
                "commit": "old-commit",
            }
        ),
        encoding="utf-8",
    )

    def fake_checkout_repo(repo_full, commit_sha, base_dir, github_token=None):
        base_path = Path(base_dir)
        assert not base_path.exists()
        path = base_path / repo_full.replace("/", "__")
        path.mkdir(parents=True)
        (path / ".git").mkdir()
        (path / "fresh.txt").write_text("fresh", encoding="utf-8")
        return str(path), "fresh-commit"

    monkeypatch.setattr(workspace_module, "checkout_repo", fake_checkout_repo)
    monkeypatch.setattr(workspace_module, "_git_head_commit", fake_cache_git_head)

    result = prewarm_scan_checkout_cache(checkout_cache_dir=str(tmp_path / "cache"), scan=scan())

    assert result["primary"]["commit"] == "fresh-commit"
    assert not (stale_repo / "poisoned.txt").exists()


def test_scan_sandbox_creates_internet_enabled_per_job_network(monkeypatch):
    calls = []

    def fake_run(cmd, **_kwargs):
        calls.append(cmd)
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(harnesses.subprocess, "run", fake_run)
    cmd = [
        "docker",
        "run",
        "--name",
        "open-kritt-scan-test",
        "--network",
        "open-kritt-scan-test-network",
        "runner-image",
        "codex",
    ]

    harnesses._prepare_docker_sandbox(cmd)
    harnesses._cleanup_docker_run_container(cmd)

    assert calls[0] == [
        "docker",
        "network",
        "create",
        "--label",
        "open-kritt.scan-sandbox=1",
        "open-kritt-scan-test-network",
    ]
    assert ["docker", "network", "rm", "open-kritt-scan-test-network"] in calls


def test_root_scan_harness_is_launched_with_per_job_identity_and_no_groups(monkeypatch):
    captured = {}
    monkeypatch.setattr(harnesses.os, "geteuid", lambda: 0)
    monkeypatch.setattr(harnesses.shutil, "which", lambda name: "/usr/bin/setpriv" if name == "setpriv" else None)

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        captured["env"] = kwargs["env"]
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(harnesses.subprocess, "run", fake_run)

    harnesses._run_process(
        ["codex", "exec"],
        "prompt",
        "/tmp",
        1,
        env={"OPEN_KRITT_JOB_UID": "100123", "OPEN_KRITT_JOB_GID": "100123"},
    )

    assert captured["cmd"] == [
        "/usr/bin/setpriv",
        "--reuid=100123",
        "--regid=100123",
        "--clear-groups",
        "--no-new-privs",
        "--",
        "codex",
        "exec",
    ]


def test_tool_free_generation_without_job_identity_is_not_broken_by_scan_drop(monkeypatch):
    monkeypatch.setattr(harnesses.os, "geteuid", lambda: 0)

    result = harnesses._unprivileged_process_command(["codex", "exec"], {"CODEX_HOME": "/root/.codex"})

    assert result == ["codex", "exec"]


def test_engine_sensitive_mounts_are_behind_root_only_parent():
    repo_root = Path(__file__).resolve().parents[2]
    compose_path = repo_root / "docker-compose.yml"
    if not compose_path.is_file():
        pytest.skip("repo-level Compose file is outside the engine-only container mount")
    compose = compose_path.read_text(encoding="utf-8")
    dockerfile = (repo_root / "engine" / "Dockerfile").read_text(encoding="utf-8")

    for mount in ("credentials", "codex-accounts", "codex-home-source", "local-repos"):
        assert f":/run/open-kritt-secrets/{mount}" in compose
    assert "chmod 0700 /run/open-kritt-secrets" in dockerfile
    assert "/opt/cursor-agent/" in dockerfile
    assert "/root/.local/share/cursor-agent" not in dockerfile


def test_agent_cli_builds_use_exact_package_versions():
    repo_root = Path(__file__).resolve().parents[2]
    dockerfiles = {
        "engine": (repo_root / "engine" / "Dockerfile").read_text(encoding="utf-8"),
        "claude-runner": (repo_root / "engine" / "Dockerfile.claude-runner").read_text(encoding="utf-8"),
        "backend": (repo_root / "backend" / "Dockerfile").read_text(encoding="utf-8"),
    }

    assert "npm@12.0.1" in dockerfiles["engine"]
    for name in ("engine", "backend"):
        assert "@openai/codex@0.144.6" in dockerfiles[name]
        assert "@anthropic-ai/claude-code@2.1.215" in dockerfiles[name]
    assert "@anthropic-ai/claude-code@2.1.215" in dockerfiles["claude-runner"]

    for dockerfile in dockerfiles.values():
        assert "npm@latest" not in dockerfile
        assert "npm install --global --no-audit --no-fund @openai/codex \\" not in dockerfile
        assert " @anthropic-ai/claude-code \\" not in dockerfile
        assert "npm install -g @anthropic-ai/claude-code \\" not in dockerfile


@pytest.mark.parametrize("harness_name", ["codex", "claude-code"])
def test_openrouter_job_home_never_copies_native_provider_secrets(monkeypatch, tmp_path, harness_name):
    codex_home = tmp_path / "source-codex"
    claude_home = tmp_path / "source-claude"
    codex_home.mkdir()
    claude_home.mkdir()
    (codex_home / "auth.json").write_text('{"tokens":{"access_token":"codex-oauth"}}', encoding="utf-8")
    (codex_home / "config.toml").write_text('[mcp_servers.private]\nenv = { TOKEN = "mcp-secret" }\n', encoding="utf-8")
    (claude_home / ".credentials.json").write_text('{"claudeAiOauth":{"accessToken":"claude-oauth"}}', encoding="utf-8")
    (claude_home / "settings.json").write_text('{"hooks":{"PreToolUse":"leak"}}', encoding="utf-8")
    monkeypatch.setenv("ENGINE_CODEX_HOME", str(codex_home))
    monkeypatch.setenv("CLAUDE_HOME", str(claude_home))
    monkeypatch.setenv("OPENROUTER_API_KEY", "openrouter-only")

    workspace = prepare_job_workspace(
        str(tmp_path / "data"),
        200 if harness_name == "codex" else 201,
        harness_name=harness_name,
        model_provider="openrouter",
    )

    job_home = Path(workspace.env["HOME"])
    assert workspace.codex_source_home is None
    assert not (job_home / ".codex" / "auth.json").exists()
    if harness_name == "codex":
        config = (job_home / ".codex" / "config.toml").read_text(encoding="utf-8")
        assert "mcp-secret" not in config
    assert not (job_home / ".claude" / ".credentials.json").exists()
    assert not (job_home / ".claude" / "settings.json").exists()
    assert workspace.env["OPENROUTER_API_KEY"] == "openrouter-only"
    assert (Path(workspace.root_dir).stat().st_mode & 0o777) == 0o700


def test_stale_scan_cleanup_removes_labeled_runners_and_networks(monkeypatch):
    calls = []

    def fake_control(cmd):
        calls.append(cmd)
        if "ps" in cmd:
            return subprocess.CompletedProcess(cmd, 0, "runner-id\n", "")
        if "network" in cmd and "ls" in cmd:
            return subprocess.CompletedProcess(cmd, 0, "network-id\n", "")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(harnesses.shutil, "which", lambda _name: "/usr/bin/docker")
    monkeypatch.setattr(harnesses, "_docker_control_run", fake_control)

    harnesses.cleanup_stale_scan_sandboxes()

    assert ["/usr/bin/docker", "rm", "-f", "runner-id"] in calls
    assert ["/usr/bin/docker", "network", "rm", "network-id"] in calls

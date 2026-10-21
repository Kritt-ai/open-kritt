"""Unit tests for the Devin harness and devin provider wiring."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from open_kritt_engine import harnesses
from open_kritt_engine.generation import (
    HARNESS_THINKING_EFFORTS,
    MODEL_PROVIDER_HARNESSES,
    MODEL_PROVIDERS,
    GenerationValidationError,
    validate_generation_job,
)
from open_kritt_engine.harnesses import DevinHarness, HarnessError, normalize_harness_name
from open_kritt_engine.provider_credentials import job_environment
from open_kritt_engine.schema import EXTRACTOR_HELPER_FIELD, output_schema


def marked(payload):
    return {EXTRACTOR_HELPER_FIELD: True, **payload}


def test_devin_harness_aliases_and_generation_matrix():
    assert normalize_harness_name("devin") == "devin"
    assert normalize_harness_name("devin-cli") == "devin"
    # Devin cannot run tool-free, so generation rejects the provider up front
    # instead of accepting a selection the harness must refuse.
    assert "devin" not in MODEL_PROVIDERS
    assert "devin" not in MODEL_PROVIDER_HARNESSES
    assert "devin" not in HARNESS_THINKING_EFFORTS


def test_generation_rejects_devin_provider():
    job = {
        "kind": "workflow",
        "request": "draft a workflow",
        "model": "swe-2",
        "model_provider": "devin",
        "harness": "devin",
        "thinking_effort": "default",
    }
    with pytest.raises(GenerationValidationError) as exc_info:
        validate_generation_job(job)
    assert any(item["field"] == "model_provider" for item in exc_info.value.errors)


def test_devin_job_and_generation_environments_expose_no_api_keys(tmp_path):
    source = {
        "OPEN_KRITT_PROVIDER_CREDENTIALS_PATH": str(tmp_path / "missing.json"),
        "PATH": "/bin",
        "HOME": "/tmp/home",
        "DATABASE_URL": "database-secret",
        "GITHUB_TOKEN": "github-secret",
        "OPENROUTER_API_KEY": "openrouter-secret",
        "XAI_API_KEY": "xai-secret",
        "ANTHROPIC_API_KEY": "anthropic-secret",
        "DEVIN_BIN": "/opt/devin/bin/devin",
    }

    job_env = job_environment("devin", "devin", source)

    assert "OPENROUTER_API_KEY" not in job_env
    assert "XAI_API_KEY" not in job_env
    assert "ANTHROPIC_API_KEY" not in job_env
    assert "DATABASE_URL" not in job_env
    # Devin authenticates through a mounted credentials.toml; the only
    # provider-scoped variable is the optional binary override.
    assert job_env["DEVIN_BIN"] == "/opt/devin/bin/devin"


def test_devin_tool_free_generation_is_rejected(tmp_path):
    with pytest.raises(HarnessError) as exc_info:
        DevinHarness(timeout_seconds=5, model_provider="devin").run(
            prompt="prompt body",
            schema=output_schema('{"thing":"string"}', multi_output=False),
            repo_dir=str(tmp_path),
            model="swe-2",
            env={"HOME": str(tmp_path / "home"), "PATH": "/usr/local/bin"},
            allow_tools=False,
        )
    assert exc_info.value.code == "configuration_error"
    assert exc_info.value.harness == "devin"


def test_devin_tool_enabled_command_and_structured_output(monkeypatch, tmp_path):
    captured = {}
    payload = marked({"stub": True, "stub_explanation": "No matching records.", "results": []})
    provided_env = {
        "HOME": str(tmp_path / "home"),
        "PATH": "/usr/local/bin",
        "ACP_BACKEND": "ide-parent",
        "ACP_BACKEND_URL": "http://localhost:1",
    }

    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        captured["cmd"] = cmd
        captured["prompt"] = prompt
        captured["cwd"] = cwd
        captured["env"] = env
        prompt_path = Path(cmd[cmd.index("--prompt-file") + 1])
        captured["prompt_path"] = prompt_path
        captured["prompt_text"] = prompt_path.read_text(encoding="utf-8")
        captured["prompt_mode"] = prompt_path.stat().st_mode & 0o777
        # `devin -p` prints the assistant's final message on stdout: raw JSON
        # when the prompt requests JSON, not an envelope.
        return SimpleNamespace(stdout=json.dumps(payload), stderr="", returncode=0)

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)
    monkeypatch.setattr(harnesses, "_scan_docker_command", lambda cmd, repo_dir, env, **kwargs: cmd)
    monkeypatch.setattr(
        harnesses.shutil, "which", lambda name, path=None: "/usr/local/bin/devin" if name == "devin" else None
    )

    result = DevinHarness(timeout_seconds=5, model_provider="devin").run(
        prompt="prompt body",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir=str(tmp_path),
        model="swe-2-max",
        env=provided_env,
        allow_tools=True,
    )

    assert result.payload == payload
    assert result.usage["model_provider"] == "devin"
    assert result.usage["devin_model"] == "swe-2-max"
    cmd = captured["cmd"]
    assert cmd[0] == "/usr/local/bin/devin"
    assert "-p" in cmd
    assert "--prompt-file" in cmd
    assert cmd[cmd.index("--model") + 1] == "swe-2-max"
    assert cmd[cmd.index("--permission-mode") + 1] == "dangerous"
    assert cmd[cmd.index("--respect-workspace-trust") + 1] == "false"
    # The prompt is delivered via file, not process stdin.
    assert captured["prompt"] == ""
    assert captured["prompt_path"].parent == Path(provided_env["HOME"])
    assert captured["prompt_text"] == "prompt body"
    assert captured["prompt_mode"] == 0o600
    assert not captured["prompt_path"].exists()
    # ACP bridge wiring from a parent IDE must not reach the job process; it
    # would make the CLI ignore its mounted file credentials.
    assert "ACP_BACKEND" not in captured["env"]
    assert "ACP_BACKEND_URL" not in captured["env"]
    assert provided_env["ACP_BACKEND"] == "ide-parent"


def test_devin_snapshot_runner_remaps_prompt_into_runner_home(monkeypatch, tmp_path):
    data_dir = tmp_path / "engine-data"
    host_data_dir = tmp_path / "host-engine-data"
    repo_dir = data_dir / "jobs" / "metadata-9" / "workspace"
    home_dir = data_dir / "jobs" / "metadata-9" / "home"
    repo_dir.mkdir(parents=True)
    home_dir.mkdir(parents=True)
    captured = {}

    monkeypatch.setenv("ENGINE_DATA_DIR", str(data_dir))
    monkeypatch.setenv("ENGINE_DOCKER_DATA_DIR_HOST", str(host_data_dir))
    monkeypatch.setenv("ENGINE_SCAN_RUNNER_IMAGE", "runner-image")
    original_which = harnesses.shutil.which
    monkeypatch.setattr(
        harnesses.shutil,
        "which",
        lambda name, path=None: (
            "docker"
            if name == "docker"
            else "/usr/local/bin/devin"
            if name == "devin"
            else original_which(name, path=path)
        ),
    )

    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        captured["cmd"] = cmd
        prompt_files = list(home_dir.glob(".open-kritt-devin-prompt.*.txt"))
        captured["prompt_files"] = prompt_files
        captured["prompt_text"] = prompt_files[0].read_text(encoding="utf-8") if prompt_files else None
        return SimpleNamespace(
            stdout=json.dumps(marked({"stub": True, "stub_explanation": "ok", "results": []})),
            stderr="",
            returncode=0,
        )

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)

    DevinHarness(timeout_seconds=5, model_provider="devin").run(
        prompt="prompt",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir=str(repo_dir),
        model="swe-2",
        env={
            "HOME": str(home_dir),
            "PATH": "/usr/local/bin",
            "XDG_DATA_HOME": str(home_dir / ".local" / "share"),
        },
        allow_tools=True,
        runner_image="workspace-snapshot",
    )

    cmd = captured["cmd"]
    prompt_arg = cmd[cmd.index("--prompt-file") + 1]
    assert prompt_arg.startswith("/home/runner/.open-kritt-devin-prompt.")
    assert not prompt_arg.startswith("/workspace/")
    assert captured["prompt_text"] == "prompt"
    assert len(captured["prompt_files"]) == 1
    assert not captured["prompt_files"][0].exists()
    assert "workspace-snapshot" in cmd
    workspace_mount = f"src={host_data_dir / 'jobs' / 'metadata-9' / 'workspace'},dst=/workspace"
    assert not any(workspace_mount in part for part in cmd)
    assert any(part == "XDG_DATA_HOME=/home/runner/.local/share" for part in cmd)


def test_devin_invalid_output_raises_invalid_output(monkeypatch, tmp_path):
    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        return SimpleNamespace(stdout="no json here", stderr="", returncode=0)

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)
    monkeypatch.setattr(harnesses, "_scan_docker_command", lambda cmd, repo_dir, env, **kwargs: cmd)
    monkeypatch.setattr(
        harnesses.shutil, "which", lambda name, path=None: "/usr/local/bin/devin" if name == "devin" else None
    )

    with pytest.raises(HarnessError) as exc_info:
        DevinHarness(timeout_seconds=5).run(
            prompt="prompt",
            schema=output_schema('{"thing":"string"}', multi_output=False),
            repo_dir=str(tmp_path),
            model="swe-2",
            env={"HOME": str(tmp_path / "home"), "PATH": "/usr/local/bin"},
            allow_tools=True,
        )
    assert exc_info.value.code == "invalid_output"


def test_command_harness_detects_devin_binary():
    assert harnesses._command_harness(["/usr/local/bin/devin", "-p", "hi"]) == "devin"


def test_harness_for_returns_devin():
    harness = harnesses.harness_for("devin", timeout_seconds=1, model_provider="devin")
    assert isinstance(harness, DevinHarness)
    assert harness.name == "devin"

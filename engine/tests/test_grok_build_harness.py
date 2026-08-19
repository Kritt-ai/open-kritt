"""Unit tests for the Grok Build harness and xAI provider wiring."""

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
    generation_environment,
    validate_generation_job,
)
from open_kritt_engine.harnesses import GrokBuildHarness, HarnessError, normalize_harness_name
from open_kritt_engine.provider_credentials import PROVIDER_ENV_KEYS, job_environment
from open_kritt_engine.schema import EXTRACTOR_HELPER_FIELD, output_schema


def marked(payload):
    return {EXTRACTOR_HELPER_FIELD: True, **payload}


def test_grok_harness_aliases_and_matrix():
    assert normalize_harness_name("grok") == "grok-build"
    assert normalize_harness_name("grok-build") == "grok-build"
    assert "xai" in MODEL_PROVIDERS
    assert MODEL_PROVIDER_HARNESSES["xai"] == frozenset({"grok-build"})
    assert HARNESS_THINKING_EFFORTS["grok-build"] == frozenset({"low", "medium", "high", "xhigh"})
    assert PROVIDER_ENV_KEYS["xai"] == "XAI_API_KEY"


def test_generation_accepts_xhigh_but_rejects_unsupported_xai_harness_and_effort():
    job = {
        "kind": "workflow",
        "request": "draft a workflow",
        "model": "grok-4.5",
        "model_provider": "xai",
        "harness": "claude-code",
        "thinking_effort": "medium",
    }
    with pytest.raises(GenerationValidationError) as exc_info:
        validate_generation_job(job)
    assert any(item["field"] == "harness" for item in exc_info.value.errors)

    job["harness"] = "grok"
    job["thinking_effort"] = "xhigh"
    assert validate_generation_job(job)["thinking_effort"] == "xhigh"

    job["thinking_effort"] = "max"
    with pytest.raises(GenerationValidationError) as exc_info:
        validate_generation_job(job)
    assert any(item["field"] == "thinking_effort" for item in exc_info.value.errors)


def test_xai_job_and_generation_environments_are_scoped(tmp_path):
    source = {
        "OPEN_KRITT_PROVIDER_CREDENTIALS_PATH": str(tmp_path / "missing.json"),
        "PATH": "/bin",
        "HOME": "/tmp/home",
        "DATABASE_URL": "database-secret",
        "GITHUB_TOKEN": "github-secret",
        "OPENROUTER_API_KEY": "openrouter-secret",
        "XAI_API_KEY": "xai-secret",
        "ANTHROPIC_API_KEY": "anthropic-secret",
    }

    job_env = job_environment("xai", "grok-build", source)
    gen_env = generation_environment("xai", source)

    assert job_env["XAI_API_KEY"] == "xai-secret"
    assert "OPENROUTER_API_KEY" not in job_env
    assert "ANTHROPIC_API_KEY" not in job_env
    assert "DATABASE_URL" not in job_env
    assert gen_env["XAI_API_KEY"] == "xai-secret"
    assert "OPENROUTER_API_KEY" not in gen_env
    assert "GITHUB_TOKEN" not in gen_env


def test_grok_build_tool_free_command_and_structured_output(monkeypatch, tmp_path):
    captured = {}
    payload = marked({"stub": True, "stub_explanation": "No matching records.", "results": []})
    provided_env = {
        "HOME": str(tmp_path / "home"),
        "XAI_API_KEY": "xai-secret",
        "PATH": "/usr/local/bin",
        "GROK_FOLDER_TRUST": "0",
        "GROK_TELEMETRY_ENABLED": "true",
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
        return SimpleNamespace(
            stdout=json.dumps(
                {
                    "structuredOutput": payload,
                    "text": "ignore me",
                    "usage": {"input_tokens": 3, "output_tokens": 2},
                    "sessionId": "sess-1",
                    "stopReason": "end_turn",
                    "num_turns": 1,
                    "modelUsage": {"grok-4.5": {"inputTokens": 3}},
                }
            ),
            stderr="",
            returncode=0,
        )

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)
    monkeypatch.setattr(
        harnesses.shutil, "which", lambda name, path=None: "/usr/local/bin/grok" if name == "grok" else None
    )

    result = GrokBuildHarness(timeout_seconds=5, model_provider="xai").run(
        prompt="prompt body",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir=str(tmp_path),
        model="grok-4.6",
        thinking_effort="xhigh",
        env=provided_env,
        allow_tools=False,
    )

    assert result.payload == payload
    assert result.usage["usage"]["input_tokens"] == 3
    assert result.usage["sessionId"] == "sess-1"
    cmd = captured["cmd"]
    assert cmd[0] == "/usr/local/bin/grok"
    assert "--prompt-file" in cmd
    assert "--output-format" in cmd and cmd[cmd.index("--output-format") + 1] == "json"
    assert "--json-schema" in cmd
    schema_arg = cmd[cmd.index("--json-schema") + 1]
    assert schema_arg.startswith("{") and '"type"' in schema_arg
    assert cmd[cmd.index("--model") + 1] == "grok-4.6"
    assert cmd[cmd.index("--reasoning-effort") + 1] == "xhigh"
    assert "--permission-mode" in cmd and cmd[cmd.index("--permission-mode") + 1] == "dontAsk"
    assert "--tools" in cmd and cmd[cmd.index("--tools") + 1] == ""
    assert "--disable-web-search" in cmd
    assert "--no-subagents" in cmd
    assert "--no-plan" in cmd
    assert cmd[cmd.index("--deny") + 1] == "MCPTool"
    assert "--always-approve" not in cmd
    assert all(captured["env"].get(key) == value for key, value in harnesses.GROK_BUILD_RUNTIME_ENV.items())
    assert captured["env"]["GROK_FOLDER_TRUST"] == "1"
    assert captured["env"]["GROK_TELEMETRY_ENABLED"] == "false"
    # The harness copies a supplied environment before enforcing its settings.
    assert provided_env["GROK_FOLDER_TRUST"] == "0"
    assert provided_env["GROK_TELEMETRY_ENABLED"] == "true"
    # Prompt is delivered via file, not process stdin.
    assert captured["prompt"] == ""
    assert captured["prompt_path"].parent == Path(provided_env["HOME"])
    assert captured["prompt_text"] == "prompt body"
    assert captured["prompt_mode"] == 0o600
    assert not captured["prompt_path"].exists()


def test_grok_build_snapshot_runner_remaps_grok_home_and_runtime_prompt(monkeypatch, tmp_path):
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
    monkeypatch.setattr(harnesses, "_scan_docker_command", harnesses._scan_docker_command)
    original_which = harnesses.shutil.which
    monkeypatch.setattr(
        harnesses.shutil,
        "which",
        lambda name, path=None: (
            "docker"
            if name == "docker"
            else "/usr/local/bin/grok"
            if name == "grok"
            else original_which(name, path=path)
        ),
    )

    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        captured["cmd"] = cmd
        prompt_files = list(home_dir.glob(".open-kritt-grok-prompt.*.txt"))
        captured["prompt_files"] = prompt_files
        captured["prompt_text"] = prompt_files[0].read_text(encoding="utf-8") if prompt_files else None
        return SimpleNamespace(
            stdout=json.dumps({"structuredOutput": marked({"stub": True, "stub_explanation": "ok", "results": []})}),
            stderr="",
            returncode=0,
        )

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)

    GrokBuildHarness(timeout_seconds=5, model_provider="xai").run(
        prompt="prompt",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir=str(repo_dir),
        model="grok-4.5",
        env={
            "HOME": str(home_dir),
            "GROK_HOME": str(home_dir / ".grok"),
            "PATH": "/usr/local/bin",
        },
        allow_tools=True,
        runner_image="workspace-snapshot",
    )

    cmd = captured["cmd"]
    prompt_arg = cmd[cmd.index("--prompt-file") + 1]
    assert prompt_arg.startswith("/home/runner/.open-kritt-grok-prompt.")
    assert not prompt_arg.startswith("/workspace/")
    assert captured["prompt_text"] == "prompt"
    assert len(captured["prompt_files"]) == 1
    assert not captured["prompt_files"][0].exists()
    assert "workspace-snapshot" in cmd
    workspace_mount = f"src={host_data_dir / 'jobs' / 'metadata-9' / 'workspace'},dst=/workspace"
    assert not any(workspace_mount in part for part in cmd)
    grok_home_flags = [part for part in cmd if part == "GROK_HOME" or part.startswith("GROK_HOME=")]
    assert grok_home_flags == ["GROK_HOME=/home/runner/.grok"]
    for key, value in harnesses.GROK_BUILD_RUNTIME_ENV.items():
        assert f"{key}={value}" in cmd


def test_grok_build_tool_enabled_uses_bypass_permissions(monkeypatch, tmp_path):
    captured = {}
    payload = marked({"stub": True, "stub_explanation": "No matching records.", "results": []})

    def fake_scan_docker(cmd, repo_dir, env, **kwargs):
        captured["inner"] = cmd
        captured["env"] = env
        return ["docker", "run", *cmd]

    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        captured["cmd"] = cmd
        return SimpleNamespace(
            stdout=json.dumps({"structuredOutput": payload, "usage": {"input_tokens": 1}}),
            stderr="",
            returncode=0,
        )

    monkeypatch.setattr(harnesses, "_scan_docker_command", fake_scan_docker)
    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)
    monkeypatch.setattr(
        harnesses.shutil, "which", lambda name, path=None: "/usr/local/bin/grok" if name == "grok" else None
    )

    result = GrokBuildHarness(timeout_seconds=5).run(
        prompt="scan prompt",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir=str(tmp_path),
        model="grok-4.5",
        thinking_effort="medium",
        env={"HOME": str(tmp_path / "home"), "XAI_API_KEY": "xai-secret", "PATH": "/usr/local/bin"},
        allow_tools=True,
    )

    assert result.payload == payload
    assert captured["cmd"][:2] == ["docker", "run"]
    inner = captured["inner"]
    assert "--always-approve" in inner
    assert inner[inner.index("--permission-mode") + 1] == "bypassPermissions"
    assert "--tools" not in inner or inner[inner.index("--tools") + 1] != ""
    assert "--disable-web-search" in inner
    assert "--no-subagents" in inner
    assert "--no-plan" in inner
    assert inner[inner.index("--deny") + 1] == "MCPTool"
    assert all(captured["env"].get(key) == value for key, value in harnesses.GROK_BUILD_RUNTIME_ENV.items())


def test_grok_build_auth_error_is_classified(monkeypatch, tmp_path):
    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        raise HarnessError(
            "grok-build failed (auth_failed).",
            code="auth_failed",
            harness="grok-build",
            output=harnesses.HarnessOutput(
                stdout=json.dumps({"type": "error", "message": "Not signed in. Set XAI_API_KEY."}),
                stderr="Error: Not signed in",
                returncode=1,
            ),
        )

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)
    monkeypatch.setattr(
        harnesses.shutil, "which", lambda name, path=None: "/usr/local/bin/grok" if name == "grok" else None
    )

    with pytest.raises(HarnessError) as exc_info:
        GrokBuildHarness(timeout_seconds=5).run(
            prompt="prompt",
            schema=output_schema('{"thing":"string"}', multi_output=False),
            repo_dir=str(tmp_path),
            model="grok-4.5",
            env={"HOME": str(tmp_path / "home"), "PATH": "/usr/local/bin"},
            allow_tools=False,
        )
    assert exc_info.value.code == "auth_failed"


def test_classify_not_signed_in_as_auth_failed():
    assert harnesses._classify_harness_output('{"type":"error","message":"Not signed in."}') == "auth_failed"


def test_extract_json_prefers_structured_output_camel_case():
    payload = marked({"stub": True, "stub_explanation": "ok", "results": []})
    extracted = harnesses._extract_json({"structuredOutput": payload, "text": "{}"})
    assert extracted["stub"] is True
    assert extracted["results"] == []


def test_command_harness_detects_grok_binary():
    assert harnesses._command_harness(["/usr/local/bin/grok", "-p", "hi"]) == "grok-build"


def test_harness_for_returns_grok_build():
    harness = harnesses.harness_for("grok", timeout_seconds=1, model_provider="xai")
    assert isinstance(harness, GrokBuildHarness)
    assert harness.name == "grok-build"

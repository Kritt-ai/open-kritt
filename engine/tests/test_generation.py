import json
import os
import stat
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from open_kritt_engine import generation as generation_module
from open_kritt_engine import harnesses
from open_kritt_engine import worker as worker_module
from open_kritt_engine.db import Database
from open_kritt_engine.generation import (
    EXTRACTOR_HELPER_FIELD,
    GenerationRunner,
    GenerationRunResult,
    GenerationValidationError,
    build_generation_prompt,
    generation_environment,
    generation_response_schema,
    validate_generation_job,
    validate_generation_payload,
)
from open_kritt_engine.harnesses import ClaudeHarness, CodexHarness, HarnessResult, codex_exec_command
from open_kritt_engine.models import Step, StepResultRow, Workflow
from open_kritt_engine.queue import build_pending_jobs
from open_kritt_engine.worker import Worker, sanitize_generation_validation_errors


def marked(payload):
    return {EXTRACTOR_HELPER_FIELD: True, **payload}


def terminal_fields(*, line_type="number", trigger_flow_type="array"):
    return [
        {"key": "explanation", "type": "string"},
        {"key": "file_path", "type": "string"},
        {"key": "line", "type": line_type},
        {"key": "malicious_input_example", "type": "string"},
        {"key": "summary", "type": "string"},
        {"key": "trigger_flow", "type": trigger_flow_type},
        {"key": "vulnerability_type", "type": "string"},
        {"key": "malicious_actor", "type": "string"},
    ]


def raw_workflow(*, line_type="number", trigger_flow_type="array", content="Analyze {{repo_full}}."):
    return {
        "name": "generated-security-review",
        "description": "Find concrete vulnerabilities in externally reachable production flows.",
        "levels": [
            {
                "depth": 0,
                "multiOutput": True,
                "consumesAll": False,
                "outputFields": terminal_fields(line_type=line_type, trigger_flow_type=trigger_flow_type),
                "steps": [{"name": "Investigate attack surface", "content": content}],
            }
        ],
    }


def raw_late_batch_workflow(final_content):
    return {
        "name": "late-batch",
        "description": "Aggregates the immediate prior depth only.",
        "levels": [
            {
                "depth": 0,
                "multiOutput": True,
                "consumesAll": False,
                "outputFields": [{"key": "root_entrypoint", "type": "string"}],
                "steps": [{"name": "Map", "content": "Map {{repo_full}}."}],
            },
            {
                "depth": 1,
                "multiOutput": True,
                "consumesAll": False,
                "outputFields": [{"key": "reviewed_flow", "type": "string"}],
                "steps": [{"name": "Trace", "content": "Trace {{root_entrypoint}}."}],
            },
            {
                "depth": 2,
                "multiOutput": True,
                "consumesAll": True,
                "outputFields": terminal_fields(),
                "steps": [{"name": "Assess", "content": final_content}],
            },
        ],
    }


def raw_post_script(*, fields=None, content="Summarize {{summary}} at {{file_path}}:{{line}}."):
    return {
        "name": "finding-summary",
        "description": "Adds concise triage context to each finding.",
        "content": content,
        "outputFields": fields or [{"key": "_chip_severity", "type": "string"}],
    }


def generation_job(kind="workflow"):
    return {
        "id": 41,
        "kind": kind,
        "request": "Build a focused security review draft.",
        "model": "gpt-test",
        "model_provider": "codex",
        "harness": "codex",
        "thinking_effort": "medium",
    }


def test_workflow_generation_normalizes_output_fields_into_api_payload():
    payload = marked({"results": [raw_workflow()]})

    artifact = validate_generation_payload("workflow", payload)

    assert "outputFields" not in artifact["levels"][0]
    assert artifact["levels"][0]["outputFormat"]["line"] == "number"
    assert artifact["levels"][0]["outputFormat"]["trigger_flow"] == "array"
    assert artifact["levels"][0]["steps"][0]["name"] == "Investigate attack surface"


def test_generation_rejects_workflow_that_backend_would_reject():
    payload = marked({"results": [raw_workflow(line_type="string", content="Analyze {{not_available}}.")]})

    with pytest.raises(GenerationValidationError) as exc_info:
        validate_generation_payload("workflow", payload)

    errors = exc_info.value.errors
    assert any(item["field"] == "terminal.outputFormat" and "line" in item["message"] for item in errors)
    assert any("not_available" in item["message"] for item in errors)


def test_generation_clears_all_individual_ancestor_keys_at_a_late_batch_boundary():
    invalid = marked({"results": [raw_late_batch_workflow("Assess {{root_entrypoint}} and {{reviewed_flow}}.")]})

    with pytest.raises(GenerationValidationError) as exc_info:
        validate_generation_payload("workflow", invalid)

    assert any("root_entrypoint" in item["message"] for item in exc_info.value.errors)
    assert any("reviewed_flow" in item["message"] for item in exc_info.value.errors)

    valid = marked({"results": [raw_late_batch_workflow("Assess {{multi_output_depth_1}}.")]})
    artifact = validate_generation_payload("workflow", valid)
    assert artifact["levels"][2]["consumesAll"] is True


def test_post_script_generation_enforces_context_and_rendering_conventions():
    valid = marked(
        {
            "results": [
                raw_post_script(
                    fields=[
                        {"key": "_chip_severity", "type": "string"},
                        {"key": "_chip_confidence", "type": "string"},
                        {"key": "_reserved_report", "type": "string"},
                    ],
                    content=(
                        "Prioritize {{summary}} using {{explanation}}, {{malicious_input_example}}, and {{extra.team}}."
                    ),
                )
            ]
        }
    )

    artifact = validate_generation_payload("post_script", valid)

    assert artifact["outputFormat"]["_reserved_report"] == "string"
    assert artifact["outputFormat"]["_chip_confidence"] == "string"

    overflow = marked(
        {
            "results": [
                raw_post_script(
                    fields=[{"key": f"_chip_{label}", "type": "string"} for label in ("one", "two", "three", "four")]
                )
            ]
        }
    )
    assert "_chip_four" in validate_generation_payload("post_script", overflow)["outputFormat"]

    invalid = marked(
        {
            "results": [
                raw_post_script(
                    fields=[
                        {"key": "_reserved_poc", "type": "array"},
                    ],
                    content="Use {{unknown_key}}.",
                )
            ]
        }
    )
    with pytest.raises(GenerationValidationError) as exc_info:
        validate_generation_payload("post_script", invalid)
    assert any("Markdown" in item["message"] for item in exc_info.value.errors)
    assert any("unknown_key" in item["message"] for item in exc_info.value.errors)


@pytest.mark.parametrize(
    "content",
    [
        "Analyze {{entrypoints[0]}}.",
        "Analyze {{not-a-key}}.",
        "Analyze {{repo_full.",
        "Analyze {{extra.constructor}}.",
    ],
)
def test_generation_rejects_malformed_or_unsafe_template_references(content):
    with pytest.raises(GenerationValidationError):
        validate_generation_payload("workflow", marked({"results": [raw_workflow(content=content)]}))


@pytest.mark.parametrize("key", ["__proto__", "constructor", "prototype"])
def test_generation_rejects_unsafe_output_keys(key):
    workflow = raw_workflow()
    workflow["levels"][0]["outputFields"].append({"key": key, "type": "string"})

    with pytest.raises(GenerationValidationError) as exc_info:
        validate_generation_payload("workflow", marked({"results": [workflow]}))

    assert any("valid key name" in item["message"] for item in exc_info.value.errors)


def test_post_script_generation_rejects_unknown_context_reference():
    payload = marked({"results": [raw_post_script(content="Prioritize {{workflow_step_output}}.")]})

    with pytest.raises(GenerationValidationError) as exc_info:
        validate_generation_payload("post_script", payload)

    assert any("non-reserved" in item["message"] for item in exc_info.value.errors)


def test_generation_schema_uses_output_field_arrays_not_dynamic_maps():
    schema = generation_response_schema("workflow")
    item = schema["properties"]["results"]["items"]
    level = item["properties"]["levels"]["items"]
    output_field = level["properties"]["outputFields"]["items"]

    assert "outputFields" in level["properties"]
    assert "outputFormat" not in level["properties"]
    assert schema["properties"]["results"]["maxItems"] == 1
    assert schema["properties"][EXTRACTOR_HELPER_FIELD] == {"type": "boolean", "const": True}
    assert output_field["properties"]["type"]["type"] == "string"


def test_generation_prompts_explain_public_workflow_contracts_and_review_guidance():
    workflow_prompt = build_generation_prompt(
        "workflow", "Generate sibling impact reviews.", generation_response_schema("workflow")
    )
    post_script_prompt = build_generation_prompt(
        "post_script", "Generate finding triage.", generation_response_schema("post_script")
    )

    assert "Sibling steps at one depth share that depth's one output schema" in workflow_prompt
    assert "`multiOutput: true` means each concrete run may emit zero, one, or many records" in workflow_prompt
    assert "`{{extra.<key>}}` reference" in workflow_prompt
    assert "Siblings are static" in workflow_prompt
    assert "Turn a broad request into sequential stages" in workflow_prompt
    assert "identify the concrete units requested by the user" in workflow_prompt
    assert "Every step prompt must be detailed and self-contained" in workflow_prompt
    assert "objective, available inputs, requested analysis, expected output fields" in workflow_prompt
    assert "Comments and names can guide navigation, but are not sufficient evidence" in workflow_prompt
    assert "do not introduce an unrelated research methodology" in workflow_prompt
    assert "By default, every step at the next depth runs once for each record" in workflow_prompt
    assert "A no-result stub is a valid outcome" in workflow_prompt
    assert "Define the in-scope component, deployed or production path" in workflow_prompt
    assert "Trace untrusted or actor-controlled input" in workflow_prompt
    assert "A reported vulnerability needs a supported chain" in workflow_prompt
    assert "This is an example, not a mandatory template" in workflow_prompt
    assert "derives and validates those requirements from selected post-script prompts" in post_script_prompt


def test_generation_job_rejects_request_larger_than_backend_limit():
    job = generation_job()
    job["request"] = "x" * 20_001

    with pytest.raises(GenerationValidationError) as exc_info:
        validate_generation_job(job)

    assert any(item["field"] == "request" and "20,000" in item["message"] for item in exc_info.value.errors)


def test_generation_job_rejects_model_larger_than_backend_limit():
    job = generation_job()
    job["model"] = "m" * 201

    with pytest.raises(GenerationValidationError) as exc_info:
        validate_generation_job(job)

    assert any(item["field"] == "model" and "200" in item["message"] for item in exc_info.value.errors)


def test_generation_job_rejects_effort_the_selected_harness_cannot_pass():
    job = generation_job()
    job.update(
        {
            "model": "claude-fable-5",
            "model_provider": "claude",
            "harness": "claude-code",
            "thinking_effort": "ultra",
        }
    )

    with pytest.raises(GenerationValidationError) as exc_info:
        validate_generation_job(job)

    assert any(
        item["field"] == "thinking_effort" and "claude-code" in item["message"] for item in exc_info.value.errors
    )


def test_generation_environment_contains_only_selected_provider_credentials():
    source = {
        "PATH": "/bin",
        "HOME": "/root",
        "ENGINE_CODEX_HOME": "/codex-a,/codex-b",
        "OPENAI_API_KEY": "openai-secret",
        "ANTHROPIC_API_KEY": "anthropic-secret",
        "OPENROUTER_API_KEY": "openrouter-secret",
        "GITHUB_TOKEN": "github-secret",
        "DATABASE_URL": "database-secret",
    }

    codex_env = generation_environment("codex", source)
    openrouter_env = generation_environment("openrouter", source)

    assert codex_env["CODEX_API_KEY"] == "openai-secret"
    assert codex_env["CODEX_HOME"] == "/codex-a"
    assert "ANTHROPIC_API_KEY" not in codex_env
    assert "OPENROUTER_API_KEY" not in codex_env
    assert openrouter_env["OPENROUTER_API_KEY"] == "openrouter-secret"
    for env in (codex_env, openrouter_env):
        assert "GITHUB_TOKEN" not in env
        assert "DATABASE_URL" not in env


def test_generation_environment_prefers_live_codex_home():
    env = generation_environment(
        "codex",
        {"CODEX_HOME": "/startup-home", "ENGINE_CODEX_HOME": "/also-stale"},
        codex_home="/runtime-home",
    )

    assert env["CODEX_HOME"] == "/runtime-home"


def test_generation_runner_retries_validation_with_feedback_and_no_tools(monkeypatch, tmp_path):
    class FakeHarness:
        def __init__(self):
            self.calls = []
            self.payloads = [
                marked({"results": [raw_workflow(line_type="string")]}),
                marked({"results": [raw_workflow()]}),
            ]

        def run(self, **kwargs):
            self.calls.append(kwargs)
            return HarnessResult(payload=self.payloads.pop(0), usage={"total_tokens": 3}, codex_session_id="thread-1")

    fake_harness = FakeHarness()
    monkeypatch.setattr(generation_module, "harness_for", lambda *_args, **_kwargs: fake_harness)
    monkeypatch.setattr(generation_module, "codex_home_for_job", lambda *_args, **_kwargs: "/runtime-codex")
    monkeypatch.setenv("CODEX_API_KEY", "codex-secret")
    monkeypatch.setenv("GITHUB_TOKEN", "github-secret")
    config = SimpleNamespace(
        data_dir=str(tmp_path),
        harness_timeout_seconds=5,
        retry_count=1,
        codex_model_provider=None,
    )

    result = GenerationRunner(config).generate(generation_job())

    assert result.artifact["name"] == "generated-security-review"
    assert len(fake_harness.calls) == 2
    assert fake_harness.calls[0]["allow_tools"] is False
    assert fake_harness.calls[0]["env"]["CODEX_API_KEY"] == "codex-secret"
    assert fake_harness.calls[0]["env"]["CODEX_HOME"] == "/runtime-codex"
    assert "GITHUB_TOKEN" not in fake_harness.calls[0]["env"]
    assert "previous JSON draft failed validation" in fake_harness.calls[1]["prompt"]
    assert Path(fake_harness.calls[0]["repo_dir"]).is_dir()


def test_generation_runner_persists_codex_refresh_and_restores_private_mode(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    codex_home = tmp_path / "codex-home"
    codex_home.mkdir()
    auth_path = codex_home / "auth.json"
    auth_path.write_text('{"tokens":{"access_token":"original"}}', encoding="utf-8")
    auth_path.chmod(0o600)

    class RefreshingHarness:
        def run(self, **_kwargs):
            refreshed = codex_home / ".auth.json.refreshed"
            refreshed.write_text('{"tokens":{"access_token":"refreshed"}}', encoding="utf-8")
            refreshed.chmod(0o644)
            os.replace(refreshed, auth_path)
            return HarnessResult(payload=marked({"results": [raw_workflow()]}))

    monkeypatch.setattr(generation_module, "harness_for", lambda *_args, **_kwargs: RefreshingHarness())
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    monkeypatch.setenv("ENGINE_CODEX_HOME", str(codex_home))

    GenerationRunner(SimpleNamespace(data_dir=str(tmp_path))).generate(generation_job())

    assert auth_path.read_text(encoding="utf-8") == '{"tokens":{"access_token":"refreshed"}}'
    assert stat.S_IMODE(auth_path.stat().st_mode) == 0o600


def test_generation_runner_has_independent_timeout_and_retry_bounds(monkeypatch, tmp_path):
    class FailingHarness:
        def __init__(self):
            self.calls = 0

        def run(self, **_kwargs):
            self.calls += 1
            raise harnesses.HarnessError("provider failed")

    fake_harness = FailingHarness()
    harness_options = {}

    def fake_harness_for(*_args, **kwargs):
        harness_options.update(kwargs)
        return fake_harness

    monkeypatch.setattr(generation_module, "harness_for", fake_harness_for)
    config = SimpleNamespace(
        data_dir=str(tmp_path),
        harness_timeout_seconds=7200,
        retry_count=20,
        codex_model_provider=None,
    )

    with pytest.raises(harnesses.HarnessError):
        GenerationRunner(config).generate(generation_job())

    assert config.harness_timeout_seconds == 7200
    assert harness_options["timeout_seconds"] == 600
    assert fake_harness.calls == 2

    explicitly_overridden = GenerationRunner(
        SimpleNamespace(
            generation_harness_timeout_seconds=5000,
            generation_retry_count=20,
        )
    )
    assert explicitly_overridden._timeout_seconds() == 900
    assert explicitly_overridden._retry_count() == 1


def test_generation_runner_does_not_retry_permanent_harness_failures(monkeypatch, tmp_path):
    class FailingHarness:
        def __init__(self):
            self.calls = 0

        def run(self, **_kwargs):
            self.calls += 1
            raise harnesses.HarnessError(
                "codex failed (invalid_output_schema).",
                code="invalid_output_schema",
                exit_code=1,
                harness="codex",
            )

    fake_harness = FailingHarness()
    monkeypatch.setattr(generation_module, "harness_for", lambda *_args, **_kwargs: fake_harness)

    with pytest.raises(harnesses.HarnessError) as exc_info:
        GenerationRunner(SimpleNamespace(data_dir=str(tmp_path))).generate(generation_job())

    assert fake_harness.calls == 1
    assert exc_info.value.retryable is False
    assert exc_info.value.attempts == 1


def test_generation_runner_uses_the_cyber_safety_retry_limit(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    (tmp_path / "engine-runtime.env").write_text("ENGINE_CYBER_SAFETY_RETRY_COUNT=3\n", encoding="utf-8")

    class CyberBlockedHarness:
        def __init__(self):
            self.calls = 0

        def run(self, **_kwargs):
            self.calls += 1
            raise harnesses.HarnessError(
                "codex failed (cyber_safety_blocked).",
                code="cyber_safety_blocked",
                exit_code=1,
                harness="codex",
            )

    fake_harness = CyberBlockedHarness()
    monkeypatch.setattr(generation_module, "harness_for", lambda *_args, **_kwargs: fake_harness)

    with pytest.raises(harnesses.HarnessError) as exc_info:
        GenerationRunner(SimpleNamespace(data_dir=str(tmp_path), retry_count=0)).generate(generation_job())

    assert fake_harness.calls == 4
    assert exc_info.value.retryable is False
    assert exc_info.value.attempts == 4


def test_generation_runner_keeps_regular_and_cyber_retry_budgets_independent(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    (tmp_path / "engine-runtime.env").write_text("ENGINE_CYBER_SAFETY_RETRY_COUNT=3\n", encoding="utf-8")

    class MixedFailureHarness:
        def __init__(self):
            self.calls = 0

        def run(self, **_kwargs):
            self.calls += 1
            code = "model_process_error" if self.calls == 1 else "cyber_safety_blocked"
            raise harnesses.HarnessError(f"codex failed ({code}).", code=code, harness="codex")

    fake_harness = MixedFailureHarness()
    monkeypatch.setattr(generation_module, "harness_for", lambda *_args, **_kwargs: fake_harness)

    with pytest.raises(harnesses.HarnessError) as exc_info:
        GenerationRunner(SimpleNamespace(data_dir=str(tmp_path), retry_count=1)).generate(generation_job())

    assert fake_harness.calls == 5
    assert exc_info.value.code == "cyber_safety_blocked"
    assert exc_info.value.attempts == 5


def test_tool_free_codex_command_disables_search_and_execution_features():
    tool_free = codex_exec_command(
        repo_dir="/tmp/generation",
        model="gpt-test",
        schema_path="/tmp/schema.json",
        output_path="/tmp/output.json",
        model_provider="codex",
        thinking_effort="medium",
        allow_tools=False,
    )
    scan_mode = codex_exec_command(
        repo_dir="/tmp/repo",
        model="gpt-test",
        schema_path="/tmp/schema.json",
        output_path="/tmp/output.json",
        model_provider="codex",
        thinking_effort="medium",
        allow_tools=True,
        max_subagents=5,
    )

    assert "--search" not in tool_free
    assert "--dangerously-bypass-approvals-and-sandbox" not in tool_free
    assert tool_free[tool_free.index("--sandbox") + 1] == "read-only"
    for flag in ("--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check"):
        assert flag in tool_free
    for feature in harnesses.TOOL_FREE_CODEX_DISABLED_FEATURES:
        assert ["--disable", feature] == tool_free[tool_free.index(feature) - 1 : tool_free.index(feature) + 1]
    assert not any(value.startswith("model_provider=") for value in tool_free)
    assert "--search" in scan_mode
    assert "--dangerously-bypass-approvals-and-sandbox" in scan_mode
    assert "agents.max_concurrent_threads_per_session=5" in scan_mode
    assert not any(value.startswith("model_provider=") for value in scan_mode)

    provider_default = codex_exec_command(
        repo_dir="/tmp/repo",
        model="gpt-test",
        schema_path="/tmp/schema.json",
        output_path="/tmp/output.json",
        model_provider="codex",
        thinking_effort="default",
        allow_tools=True,
    )
    assert not any(value.startswith("model_reasoning_effort=") for value in provider_default)


def test_tool_free_codex_defines_only_standard_openrouter_provider(monkeypatch):
    captured = {}

    def fake_run_process(command, *_args, env=None, **_kwargs):
        captured["command"] = command
        captured["env"] = env
        output_path = Path(command[command.index("-o") + 1])
        output_path.write_text(json.dumps(marked({"results": []})), encoding="utf-8")
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)
    harness = CodexHarness(
        timeout_seconds=5,
        model_provider="openrouter",
        codex_model_provider="private-openrouter",
    )
    harness.run(
        prompt="Generate a draft.",
        schema={"type": "object"},
        repo_dir="/tmp",
        model="vendor/model",
        env={"OPENROUTER_API_KEY": "or-secret"},
        allow_tools=False,
    )

    configs = [captured["command"][index + 1] for index, value in enumerate(captured["command"]) if value == "-c"]
    assert 'model_provider="openrouter"' in configs
    assert 'model_providers.openrouter.name="OpenRouter"' in configs
    assert f'model_providers.openrouter.base_url="{harnesses.OPENROUTER_CODEX_BASE_URL}"' in configs
    assert 'model_providers.openrouter.env_key="OPENROUTER_API_KEY"' in configs
    assert 'model_providers.openrouter.wire_api="responses"' in configs
    assert not any("private-openrouter" in value for value in configs)
    assert "or-secret" not in " ".join(captured["command"])
    assert captured["env"]["OPENROUTER_API_KEY"] == "or-secret"


def test_scan_codex_provider_mapping_preserves_custom_openrouter_config():
    common = {
        "repo_dir": "/tmp/repo",
        "model": "glm-5.2",
        "schema_path": "/tmp/schema.json",
        "output_path": "/tmp/output.json",
        "thinking_effort": None,
        "allow_tools": True,
        "codex_model_provider": "private-openrouter",
    }
    codex = codex_exec_command(**common, model_provider="codex")
    openrouter = codex_exec_command(**common, model_provider="openrouter")
    legacy = codex_exec_command(**common, model_provider=None)

    assert not any(value.startswith("model_provider=") for value in codex)
    assert 'model_provider="private-openrouter"' in openrouter
    assert 'model_provider="private-openrouter"' in legacy
    assert not any(value.startswith("model_providers.") for value in openrouter)
    assert codex[codex.index("-m") + 1] == "glm-5.2"
    assert openrouter[openrouter.index("-m") + 1] == "z-ai/glm-5.2"


def test_tool_free_claude_command_has_no_default_tools(monkeypatch):
    commands = []

    def fake_run_process(command, *_args, **_kwargs):
        commands.append(command)
        return SimpleNamespace(stdout=json.dumps({"results": []}), stderr="")

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)
    harness = ClaudeHarness(timeout_seconds=5)
    harness.run(
        prompt="Generate a draft.",
        schema={"type": "object"},
        repo_dir="/tmp",
        model="claude-test",
        thinking_effort="default",
        allow_tools=False,
    )

    command = commands[0]
    assert "--dangerously-skip-permissions" not in command
    assert command[command.index("--tools") + 1] == ""
    assert "--strict-mcp-config" in command
    assert command[command.index("--setting-sources") + 1] == ""
    assert command[command.index("--append-system-prompt") + 1] == harnesses.CLAUDE_GENERATION_SYSTEM_PROMPT
    assert "--effort" not in command


def engine_step(step_id, depth, *, consumes_all=False, is_last=False, bound_source_step_id=None):
    return Step(
        id=step_id,
        content="Check {{repo_full}}",
        output_format='{"item":"string"}',
        name=f"step-{step_id}",
        depth=depth,
        multi_output=True,
        is_last_step=is_last,
        output_table="workflows.vulnerabilities" if is_last else "workflows.step_results",
        order=step_id,
        consumes_all=consumes_all,
        bound_source_step_id=bound_source_step_id,
    )


def queue_scan():
    return {
        "repo_full": "owner/repo",
        "commit_sha": "HEAD",
        "repo_scope": "full repository",
        "dependencies": [],
        "configuration": {},
    }


def test_database_loads_the_persisted_bound_source_step_id():
    class Cursor:
        def __init__(self, *, row=None, rows=None):
            self.row = row
            self.rows = rows

        def fetchone(self):
            return self.row

        def fetchall(self):
            return self.rows

    class Connection:
        def execute(self, query, _params):
            if "llm_workflows" in query:
                return Cursor(row={"id": 7, "name": "bound", "step_ids": [10, 20]})
            return Cursor(
                rows=[
                    {
                        "id": 10,
                        "content": "Source",
                        "output_format": '{"candidate":"string"}',
                        "name": "Source",
                        "depth": 0,
                        "multi_output": True,
                        "is_last_step": False,
                        "output_table": "workflows.step_results",
                        "consume_all_previous": False,
                        "bound_source_step_id": None,
                    },
                    {
                        "id": 20,
                        "content": "Destination",
                        "output_format": '{"finding":"string"}',
                        "name": "Destination",
                        "depth": 1,
                        "multi_output": True,
                        "is_last_step": True,
                        "output_table": "workflows.vulnerabilities",
                        "consume_all_previous": False,
                        "bound_source_step_id": 10,
                    },
                ]
            )

    workflow = Database("").load_workflow(Connection(), 7)

    assert workflow.steps[0].bound_source_step_id is None
    assert workflow.steps[1].bound_source_step_id == 10


def test_non_batch_depth_pipelines_a_ready_branch_while_its_sibling_is_running():
    workflow = Workflow(
        id=1,
        name="pipelined",
        steps=(engine_step(1, 0), engine_step(2, 0), engine_step(3, 1)),
    )
    completed_key = (1, 0, None, 1)
    results = {
        completed_key: [
            StepResultRow(id=11, step_id=1, prev_id=0, prev_table=None, repeat_run=1, json_answer={"item": "ready"})
        ]
    }

    pending = build_pending_jobs(
        scan=queue_scan(),
        workflow=workflow,
        completed={completed_key},
        step_results=results,
    )

    assert [job.step.id for job in pending] == [3, 2]
    assert pending[0].state.prev_id == 11
    assert pending[0].state.context["item"] == "ready"


def test_bound_depth_routes_each_source_result_only_to_its_selected_destination():
    workflow = Workflow(
        id=1,
        name="bound",
        steps=(
            engine_step(1, 0),
            engine_step(2, 0),
            engine_step(3, 1, is_last=True, bound_source_step_id=1),
            engine_step(4, 1, is_last=True, bound_source_step_id=2),
        ),
    )
    source_one = (1, 0, None, 1)
    source_two = (2, 0, None, 1)
    results = {
        source_one: [
            StepResultRow(id=11, step_id=1, prev_id=0, prev_table=None, repeat_run=1, json_answer={"item": "a"})
        ],
        source_two: [
            StepResultRow(id=22, step_id=2, prev_id=0, prev_table=None, repeat_run=1, json_answer={"item": "b"})
        ],
    }

    partially_ready = build_pending_jobs(
        scan=queue_scan(),
        workflow=workflow,
        completed={source_one},
        step_results=results,
    )
    assert [(job.step.id, job.state.prev_id) for job in partially_ready] == [(3, 11), (2, 0)]

    fully_ready = build_pending_jobs(
        scan=queue_scan(),
        workflow=workflow,
        completed={source_one, source_two},
        step_results=results,
    )
    assert {(job.step.id, job.state.prev_id) for job in fully_ready} == {(3, 11), (4, 22)}


def test_depth_after_a_bound_transition_returns_to_broadcast_routing():
    workflow = Workflow(
        id=1,
        name="bound-then-broadcast",
        steps=(
            engine_step(1, 0),
            engine_step(2, 0),
            engine_step(3, 1, bound_source_step_id=1),
            engine_step(4, 1, bound_source_step_id=2),
            engine_step(5, 2, is_last=True),
            engine_step(6, 2, is_last=True),
        ),
    )
    completed = {
        (1, 0, None, 1),
        (2, 0, None, 1),
        (3, 11, "workflows.step_results", 1),
        (4, 22, "workflows.step_results", 1),
    }
    results = {
        (1, 0, None, 1): [StepResultRow(11, 1, 0, None, 1, {"item": "a"})],
        (2, 0, None, 1): [StepResultRow(22, 2, 0, None, 1, {"item": "b"})],
        (3, 11, "workflows.step_results", 1): [StepResultRow(33, 3, 11, "workflows.step_results", 1, {"item": "c"})],
        (4, 22, "workflows.step_results", 1): [StepResultRow(44, 4, 22, "workflows.step_results", 1, {"item": "d"})],
    }

    pending = build_pending_jobs(scan=queue_scan(), workflow=workflow, completed=completed, step_results=results)

    assert {(job.step.id, job.state.prev_id) for job in pending} == {(5, 33), (5, 44), (6, 33), (6, 44)}


@pytest.mark.parametrize(
    "steps",
    [
        (engine_step(1, 0, bound_source_step_id=99),),
        (engine_step(1, 0), engine_step(2, 1, bound_source_step_id=1)),
        (engine_step(1, 0), engine_step(2, 1, bound_source_step_id=1), engine_step(3, 1)),
        (engine_step(1, 0), engine_step(2, 1, consumes_all=True, bound_source_step_id=1)),
        (engine_step(1, 0), engine_step(2, 0), engine_step(3, 1, bound_source_step_id=1)),
    ],
)
def test_engine_rejects_invalid_persisted_binding_topologies(steps):
    workflow = Workflow(id=1, name="invalid-binding", steps=steps)

    with pytest.raises(ValueError, match="bind|bound"):
        build_pending_jobs(scan=queue_scan(), workflow=workflow, completed=set(), step_results={})


def test_batch_depth_waits_for_all_previous_branches_and_receives_full_array():
    workflow = Workflow(
        id=1,
        name="batched",
        steps=(engine_step(1, 0), engine_step(2, 0), engine_step(3, 1, consumes_all=True)),
    )
    first_key = (1, 0, None, 1)
    second_key = (2, 0, None, 1)
    results = {
        first_key: [
            StepResultRow(id=11, step_id=1, prev_id=0, prev_table=None, repeat_run=1, json_answer={"item": "a"})
        ]
    }

    partial = build_pending_jobs(
        scan=queue_scan(),
        workflow=workflow,
        completed={first_key},
        step_results=results,
    )
    assert [job.step.id for job in partial] == [2]

    results[second_key] = [
        StepResultRow(id=12, step_id=2, prev_id=0, prev_table=None, repeat_run=1, json_answer={"item": "b"})
    ]
    pending = build_pending_jobs(
        scan=queue_scan(),
        workflow=workflow,
        completed={first_key, second_key},
        step_results=results,
    )
    assert [job.step.id for job in pending] == [3]
    assert pending[0].state.prev_id == 0
    assert pending[0].state.context["multi_output_depth_0"] == [{"item": "a"}, {"item": "b"}]


def test_batch_depth_waits_for_all_task_repeats_and_receives_accumulated_output():
    workflow = Workflow(
        id=1,
        name="batched-repeat",
        steps=(engine_step(1, 0), engine_step(2, 1, consumes_all=True)),
    )
    first_repeat_key = (1, 0, None, 1)
    scan = {**queue_scan(), "configuration": {"repeat_runs": 2}}
    results = {
        first_repeat_key: [
            StepResultRow(id=11, step_id=1, prev_id=0, prev_table=None, repeat_run=1, json_answer={"item": "a"})
        ]
    }

    first_pending = build_pending_jobs(
        scan=scan,
        workflow=workflow,
        completed={first_repeat_key},
        step_results=results,
    )

    assert [(job.step.id, job.state.repeat_run) for job in first_pending] == [(1, 2)]

    second_repeat_key = (1, 0, None, 2)
    results[second_repeat_key] = [
        StepResultRow(id=12, step_id=1, prev_id=0, prev_table=None, repeat_run=2, json_answer={"item": "b"})
    ]
    pending = build_pending_jobs(
        scan=scan,
        workflow=workflow,
        completed={first_repeat_key, second_repeat_key},
        step_results=results,
    )

    assert [(job.step.id, job.state.repeat_run) for job in pending] == [(2, 1)]
    assert pending[0].state.context["multi_output_depth_0"] == [{"item": "a"}, {"item": "b"}]


def test_output_after_a_batch_keeps_prior_batch_context_for_next_depth():
    workflow = Workflow(
        id=1,
        name="batched-next",
        steps=(
            engine_step(1, 0),
            engine_step(2, 1, consumes_all=True),
            engine_step(3, 2, is_last=True),
        ),
    )
    root_key = (1, 0, None, 1)
    batch_key = (2, 0, None, 1)
    results = {
        root_key: [
            StepResultRow(id=10, step_id=1, prev_id=0, prev_table=None, repeat_run=1, json_answer={"entry": "a"})
        ],
        batch_key: [
            StepResultRow(
                id=20,
                step_id=2,
                prev_id=0,
                prev_table=None,
                repeat_run=1,
                json_answer={"selected": "a"},
            )
        ],
    }

    pending = build_pending_jobs(
        scan=queue_scan(),
        workflow=workflow,
        completed={root_key, batch_key},
        step_results=results,
    )

    assert [job.step.id for job in pending] == [3]
    assert pending[0].state.context["multi_output_depth_0"] == [{"entry": "a"}]
    assert pending[0].state.context["selected"] == "a"


def test_resume_retries_only_the_failed_depth_and_preserves_completed_ancestors():
    workflow = Workflow(
        id=1,
        name="resumable",
        steps=(
            engine_step(1, 0),
            engine_step(2, 1),
            engine_step(3, 2, is_last=True),
        ),
    )
    root_key = (1, 0, None, 1)
    middle_key = (2, 10, "workflows.step_results", 1)
    results = {
        root_key: [
            StepResultRow(id=10, step_id=1, prev_id=0, prev_table=None, repeat_run=1, json_answer={"root": "a"})
        ],
        middle_key: [
            StepResultRow(
                id=20,
                step_id=2,
                prev_id=10,
                prev_table="workflows.step_results",
                repeat_run=1,
                json_answer={"middle": "b"},
            )
        ],
    }

    pending = build_pending_jobs(
        scan=queue_scan(),
        workflow=workflow,
        completed={root_key, middle_key},
        step_results=results,
    )

    assert [(job.step.id, job.depth, job.state.prev_id) for job in pending] == [(3, 2, 20)]
    assert pending[0].state.context["root"] == "a"
    assert pending[0].state.context["middle"] == "b"


def test_late_batch_discards_every_individual_ancestor_value():
    workflow = Workflow(
        id=1,
        name="late-batch",
        steps=(
            engine_step(1, 0),
            engine_step(2, 1),
            engine_step(3, 2, consumes_all=True),
        ),
    )
    root_key = (1, 0, None, 1)
    middle_key = (2, 10, "workflows.step_results", 1)
    results = {
        root_key: [
            StepResultRow(id=10, step_id=1, prev_id=0, prev_table=None, repeat_run=1, json_answer={"root": "a"})
        ],
        middle_key: [
            StepResultRow(
                id=20,
                step_id=2,
                prev_id=10,
                prev_table="workflows.step_results",
                repeat_run=1,
                json_answer={"middle": "b"},
            )
        ],
    }

    pending = build_pending_jobs(
        scan=queue_scan(),
        workflow=workflow,
        completed={root_key, middle_key},
        step_results=results,
    )

    assert [job.step.id for job in pending] == [3]
    context = pending[0].state.context
    assert context["multi_output_depth_1"] == [{"middle": "b"}]
    assert "root" not in context
    assert "middle" not in context


class FakeConn:
    def __init__(self):
        self.commits = 0

    def commit(self):
        self.commits += 1


def worker_config(tmp_path, **overrides):
    values = {
        "worker_count": 1,
        "workspace_setup_concurrency": 1,
        "data_dir": str(tmp_path),
        "database_url": "",
        "poll_seconds": 0.01,
        "retry_count": 0,
        "harness_timeout_seconds": 5,
        "codex_auto_update": False,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


def test_database_fails_only_expired_running_generations():
    class Result:
        def fetchall(self):
            return [{"id": 3}, {"id": 8}]

    class Conn:
        def __init__(self):
            self.query = ""
            self.params = ()

        def execute(self, query, params):
            self.query = query
            self.params = params
            return Result()

    conn = Conn()

    assert Database("").fail_stale_generations(conn, stale_after_seconds=900) == 2
    assert "WHERE status = 'running'" in conn.query
    assert "COALESCE(updated_at, run_started_at, inserted_at)" in conn.query
    assert "make_interval(secs => %s)" in conn.query
    assert conn.params == (900,)


def test_database_heartbeat_only_extends_a_running_generation():
    class Result:
        def __init__(self, row):
            self.row = row

        def fetchone(self):
            return self.row

    class Conn:
        def __init__(self, row):
            self.row = row
            self.query = ""
            self.params = ()

        def execute(self, query, params):
            self.query = query
            self.params = params
            return Result(self.row)

    running = Conn({"id": 41})
    no_longer_running = Conn(None)

    assert Database("").heartbeat_generation(running, 41) is True
    assert Database("").heartbeat_generation(no_longer_running, 41) is False
    assert "SET updated_at = now()" in running.query
    assert "AND status = 'running'" in running.query
    assert running.params == (41,)


def test_database_releases_orphaned_running_jobs_even_when_scan_is_active():
    class Result:
        def __init__(self, rows):
            self.rows = rows

        def fetchall(self):
            return self.rows

    class Conn:
        def __init__(self):
            self.queries = []

        def execute(self, query, params):
            self.queries.append((query, params))
            if "UPDATE workflows.step_metadata m" in query:
                return Result([{"id": 10}])
            if "UPDATE workflows.post_process_metadata p" in query:
                return Result([{"id": 20}])
            return Result([])

    conn = Conn()
    started_at = datetime.now(timezone.utc)

    counts = Database("").mark_orphaned_running_metadata_interrupted(
        conn,
        engine_started_at=started_at,
        error="interrupted",
    )

    assert counts == {"step": 1, "post": 1, "supplemental": 0}
    release_queries = "\n".join(query for query, _params in conn.queries[:2])
    assert "s.status NOT IN" not in release_queries
    assert "m.updated_at < %(engine_started_at)s" in release_queries
    assert "p.updated_at < %(engine_started_at)s" in release_queries
    assert "post_process_metadata_id = ANY" in conn.queries[2][0]
    assert "supplemental_post_script_targets" in conn.queries[3][0]


def test_metadata_claims_take_scan_update_lock_and_stop_if_scan_was_deleted():
    class Result:
        def __init__(self, row=None):
            self.row = row

        def fetchone(self):
            return self.row

    class Conn:
        def __init__(self):
            self.queries = []

        def execute(self, query, params):
            self.queries.append((query, params))
            return Result(None)

    database = Database("")
    step_conn = Conn()
    step = database.claim_step_metadata(
        step_conn,
        scan_id=41,
        workflow_id=3,
        step_id=9,
        prev_id=0,
        prev_table=None,
        repeat_run=1,
        prompt_template="prompt",
        prompt_filled="prompt",
        checked_out_commit=None,
        run_started_at=datetime.now(timezone.utc),
    )
    post_conn = Conn()
    post = database.claim_post_process_metadata(
        post_conn,
        scan_id=41,
        workflow_id=3,
        kind="dedupe",
        batch_index=1,
        target_vulnerability_ids=[1],
        prompt_template="prompt",
        prompt_filled="prompt",
        model="model",
        harness="codex",
        thinking_effort="medium",
        model_provider="codex",
        run_started_at=datetime.now(timezone.utc),
    )

    assert step is None
    assert post is None
    for conn in (step_conn, post_conn):
        assert "FOR UPDATE" in conn.queries[1][0]
        assert conn.queries[1][1] == (41,)
        assert not any("INSERT INTO workflows" in query for query, _params in conn.queries)


def test_worker_recovers_stale_generations_after_short_heartbeat_lease(tmp_path):
    class FakeDb:
        def __init__(self):
            self.conn = FakeConn()
            self.stale_after_seconds = None

        @contextmanager
        def connect(self):
            yield self.conn

        def fail_stale_generations(self, _conn, *, stale_after_seconds):
            self.stale_after_seconds = stale_after_seconds
            return 2

    fake_db = FakeDb()
    worker = Worker(
        worker_config(tmp_path, retry_count=20, harness_timeout_seconds=7200),
        db=fake_db,
    )

    assert worker._recover_stale_generations() == 2
    assert fake_db.stale_after_seconds == 60
    assert fake_db.conn.commits == 1


def test_worker_heartbeats_live_generation_and_recovers_crashed_peers(monkeypatch, tmp_path):
    heartbeat_committed = worker_module.threading.Event()

    class FakeDb:
        def __init__(self):
            self.heartbeats = []
            self.stale_windows = []
            self.completed = []

        @contextmanager
        def connect(self):
            yield FakeConn()

        def heartbeat_generation(self, _conn, generation_id):
            self.heartbeats.append(generation_id)
            return True

        def fail_stale_generations(self, _conn, *, stale_after_seconds):
            self.stale_windows.append(stale_after_seconds)
            heartbeat_committed.set()
            return 1

        def complete_generation(self, _conn, generation_id, **kwargs):
            self.completed.append((generation_id, kwargs))
            return True

    fake_db = FakeDb()
    worker = Worker(worker_config(tmp_path), db=fake_db)
    worker.generation_runner = SimpleNamespace(
        generate=lambda _job: (
            GenerationRunResult(
                artifact={"name": "draft"},
                usage=None,
                codex_session_id=None,
            )
            if heartbeat_committed.wait(timeout=1)
            else (_ for _ in ()).throw(AssertionError("generation was not heartbeated"))
        )
    )
    monkeypatch.setattr(worker_module, "GENERATION_HEARTBEAT_INTERVAL_SECONDS", 0.01)

    worker.process_generation(generation_job())

    assert fake_db.heartbeats == [41]
    assert fake_db.stale_windows == [60]
    assert fake_db.completed[0][0] == 41


def test_run_forever_starts_a_dedicated_generation_worker(monkeypatch, tmp_path):
    started_threads = []

    class StopRunForever(Exception):
        pass

    class FakeThread:
        def __init__(self, *, target, args=(), name, daemon):
            self.target = target
            self.args = args
            self.name = name
            self.daemon = daemon
            self.started = False

        def start(self):
            self.started = True
            started_threads.append(self)

        def is_alive(self):
            return self.started

    worker = Worker(worker_config(tmp_path), db=SimpleNamespace())
    worker.runtime_worker_count = lambda: 1
    worker._schedule_codex_update = lambda: None
    worker._schedule_model_catalog_refresh = lambda: None
    monkeypatch.setattr(worker_module, "cleanup_stale_scan_sandboxes", lambda: None)
    monkeypatch.setattr(worker_module, "cleanup_stale_workspace_snapshot_builders", lambda: None)
    monkeypatch.setattr(worker_module.threading, "Thread", FakeThread)
    monkeypatch.setattr(worker_module.time, "sleep", lambda _seconds: (_ for _ in ()).throw(StopRunForever()))

    with pytest.raises(StopRunForever):
        worker.run_forever()

    assert [thread.name for thread in started_threads] == ["executor-worker-1", "generation-worker"]
    assert started_threads[0].target == worker._run_loop
    assert started_threads[1].target == worker._generation_loop


def test_scan_worker_loop_never_claims_generation_jobs(tmp_path):
    stop_event = worker_module.threading.Event()

    class FakeDb:
        def __init__(self):
            self.scan_claims = 0
            self.generation_claims = 0

        @contextmanager
        def connect(self):
            yield FakeConn()

        def claim_scan(self, _conn):
            self.scan_claims += 1
            stop_event.set()
            return None

        def claim_generation(self, _conn):
            self.generation_claims += 1
            return None

    fake_db = FakeDb()
    worker = Worker(worker_config(tmp_path), db=fake_db)

    worker._run_loop(1, stop_event)

    assert fake_db.scan_claims == 1
    assert fake_db.generation_claims == 0


def test_worker_claims_and_completes_generation_without_claiming_a_scan(monkeypatch, tmp_path):
    class FakeDb:
        def __init__(self):
            self.generation = generation_job()
            self.completed = []

        @contextmanager
        def connect(self):
            yield FakeConn()

        def claim_generation(self, _conn):
            claimed, self.generation = self.generation, None
            return claimed

        def complete_generation(self, _conn, generation_id, **kwargs):
            self.completed.append((generation_id, kwargs))
            return True

        def claim_scan(self, _conn):
            raise AssertionError("generation should be claimed before scans")

    config = worker_config(tmp_path)
    fake_db = FakeDb()
    worker = Worker(config, db=fake_db)
    worker._worker_can_pick_job = lambda _worker_id: True
    worker.generation_runner = SimpleNamespace(
        generate=lambda _job: GenerationRunResult(
            artifact={"name": "draft"}, usage={"total_tokens": 2}, codex_session_id="thread-2"
        )
    )

    assert worker.run_once() is True
    assert fake_db.completed == [
        (41, {"result": {"name": "draft"}, "raw_token_usage": {"total_tokens": 2}, "codex_session_id": "thread-2"})
    ]


def test_worker_records_only_safe_validation_failure_details(tmp_path):
    class FakeDb:
        def __init__(self):
            self.failed = []

        @contextmanager
        def connect(self):
            yield FakeConn()

        def fail_generation(self, _conn, generation_id, **kwargs):
            self.failed.append((generation_id, kwargs))
            return True

    config = worker_config(tmp_path)
    fake_db = FakeDb()
    worker = Worker(config, db=fake_db)
    worker.generation_runner = SimpleNamespace(
        generate=lambda _job: (_ for _ in ()).throw(
            GenerationValidationError([{"field": "terminal.outputFormat", "message": "line must be number"}])
        )
    )

    worker.process_generation(generation_job())

    assert fake_db.failed == [
        (
            41,
            {
                "error": "Generated draft did not pass validation.",
                "validation_errors": [{"field": "terminal.outputFormat", "message": "line must be number"}],
            },
        )
    ]


def test_worker_records_actionable_harness_failure_without_provider_detail(caplog, tmp_path):
    class FakeDb:
        def __init__(self):
            self.failed = []

        @contextmanager
        def connect(self):
            yield FakeConn()

        def fail_generation(self, _conn, generation_id, **kwargs):
            self.failed.append((generation_id, kwargs))
            return True

    provider_detail = "provider response contained secret-value"
    harness_error = harnesses.HarnessError(
        provider_detail,
        code="invalid_output_schema",
        exit_code=1,
        harness="codex",
    )
    harness_error.attempts = 1
    fake_db = FakeDb()
    worker = Worker(worker_config(tmp_path), db=fake_db)
    worker.generation_runner = SimpleNamespace(generate=lambda _job: (_ for _ in ()).throw(harness_error))

    with caplog.at_level("WARNING", logger="open_kritt_engine"):
        worker.process_generation(generation_job())

    persisted_error = fake_db.failed[0][1]["error"]
    assert "engine compatibility error" in persisted_error
    assert "Diagnostic: invalid_output_schema (generation 41)" in persisted_error
    assert provider_detail not in persisted_error
    assert "failure_code=invalid_output_schema" in caplog.text
    assert "provider=codex" in caplog.text
    assert "model=gpt-test" in caplog.text
    assert "attempts=1" in caplog.text
    assert provider_detail not in caplog.text


def test_worker_marks_generation_failed_when_completed_result_cannot_be_serialized(tmp_path):
    class FakeDb:
        def __init__(self):
            self.failed = []

        @contextmanager
        def connect(self):
            yield FakeConn()

        def complete_generation(self, _conn, _generation_id, **kwargs):
            json.dumps(kwargs["result"])
            raise AssertionError("result should be non-serializable")

        def fail_generation(self, _conn, generation_id, **kwargs):
            self.failed.append((generation_id, kwargs))
            return True

    fake_db = FakeDb()
    worker = Worker(worker_config(tmp_path), db=fake_db)
    worker.generation_runner = SimpleNamespace(
        generate=lambda _job: GenerationRunResult(
            artifact={"bad": object()},
            usage=None,
            codex_session_id=None,
        )
    )

    worker.process_generation(generation_job())

    assert fake_db.failed == [
        (
            41,
            {
                "error": "Generated draft could not be saved. Please try again.",
                "validation_errors": None,
            },
        )
    ]


def test_generation_validation_errors_are_bounded_and_strip_controls():
    errors = [
        {
            "field": f"field-{index}\x00" + ("f" * 250),
            "message": f"message-{index}\n\t\x1b" + ("m" * 1200),
        }
        for index in range(30)
    ]

    sanitized = sanitize_generation_validation_errors(errors)

    assert len(sanitized) == 25
    assert all(len(item["field"]) <= 200 for item in sanitized)
    assert all(len(item["message"]) <= 1000 for item in sanitized)
    assert all("\x00" not in item["field"] for item in sanitized)
    assert all("\n" not in item["message"] and "\t" not in item["message"] for item in sanitized)
    assert all("\x1b" not in item["message"] for item in sanitized)

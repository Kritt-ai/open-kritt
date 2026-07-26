import json
import os
import shutil
from pathlib import Path

import pytest

from open_kritt_engine import harnesses
from open_kritt_engine.harnesses import ClaudeHarness, HarnessOutput, HarnessResult, OpenAICompatibleHarness
from open_kritt_engine.llm.migration import (
    ProviderCertificationThresholds,
    ProviderExecutionMode,
    RuntimeComparisonMetrics,
    certify_provider,
    compare_legacy_to_new_parser,
    runtime_migration_flags,
)
from open_kritt_engine.llm.types import RawLLMResponse
from open_kritt_engine.model_output_artifacts import record_model_output_artifact
from open_kritt_engine.schema import EXTRACTOR_HELPER_FIELD

WORKSPACE_TMP = Path(__file__).parent / ".tmp-phase8"


def schema():
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            EXTRACTOR_HELPER_FIELD: {"type": "boolean", "const": True},
            "results": {"type": "array", "items": {"type": "object"}},
        },
        "required": [EXTRACTOR_HELPER_FIELD, "results"],
        "additionalProperties": False,
    }


def payload():
    return {EXTRACTOR_HELPER_FIELD: True, "results": [{"name": "ok"}]}


def claude_stdout(value=None):
    return json.dumps({"result": "```json\n" + json.dumps(value or payload()) + "\n```", "usage": {"total_tokens": 5}})


class FakeClaudeRuntime:
    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.requests = []

    def execute(self, request):
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        text = self.response if self.response is not None else claude_stdout()
        return RawLLMResponse(
            provider_id="claude-code",
            adapter_id="cli:claude-code",
            model=request.llm.model,
            status="completed",
            raw_text=text,
            content_blocks=({"text": payload_text_from_claude(text)},),
            stdout=text,
            stderr="",
            exit_code=0,
            usage={"total_tokens": 5},
            timing={"total_ms": 2.0},
        )


def payload_text_from_claude(text):
    try:
        wrapper = json.loads(text)
    except json.JSONDecodeError:
        return text
    return wrapper.get("result") or text


class FakeCodexRuntime:
    def __init__(self, response=None, error=None, status="completed", stderr=""):
        self.response = response
        self.error = error
        self.status = status
        self.stderr = stderr
        self.requests = []

    def execute(self, request):
        self.requests.append(request)
        if self.error is not None:
            raise self.error
        text = self.response if self.response is not None else json.dumps({"message": "```json\n" + json.dumps(payload()) + "\n```"})
        return RawLLMResponse(
            provider_id="codex",
            adapter_id="cli:codex",
            model=request.llm.model,
            status=self.status,
            raw_text=text,
            content_blocks=({"text": payload_text_from_codex(text)},),
            stdout=text,
            stderr=self.stderr,
            exit_code=0 if self.status == "completed" else 1,
            usage={"total_tokens": 5},
            timing={"total_ms": 2.0},
        )


def payload_text_from_codex(text):
    try:
        wrapper = json.loads(text)
    except json.JSONDecodeError:
        return text
    return wrapper.get("message") or wrapper.get("content") or wrapper.get("text") or text


def provider_settings():
    return {
        "base_url": "https://provider.test/v1",
        "api_key": "secret",
        "label": "Provider",
    }


def test_runtime_migration_flags_are_disabled_by_default():
    flags = runtime_migration_flags("openai-compatible", env={})

    assert flags.use_new_runtime is False
    assert flags.use_new_parser is False
    assert flags.use_shadow_pipeline is False
    assert flags.use_runtime_only is False
    assert flags.use_full_provider_pipeline is False
    assert flags.execution_mode == ProviderExecutionMode.HYBRID


def test_runtime_migration_flags_support_provider_specific_overrides():
    flags = runtime_migration_flags(
        "openai-compatible",
        env={
            "OPEN_KRITT_LLM_USE_SHADOW_PIPELINE": "false",
            "OPEN_KRITT_LLM_OPENAI_COMPATIBLE_USE_SHADOW_PIPELINE": "true",
            "OPEN_KRITT_LLM_OPENAI_COMPATIBLE_USE_NEW_PARSER": "1",
        },
    )

    assert flags.use_shadow_pipeline is True
    assert flags.use_new_parser is True
    assert flags.use_new_runtime is False


def test_runtime_migration_flags_support_provider_execution_mode():
    flags = runtime_migration_flags(
        "openai-compatible",
        env={"OPEN_KRITT_LLM_OPENAI_COMPATIBLE_EXECUTION_MODE": "hybrid"},
    )

    assert flags.execution_mode == ProviderExecutionMode.HYBRID


def test_claude_code_defaults_to_hybrid_mode():
    flags = runtime_migration_flags("claude-code", env={})

    assert flags.execution_mode == ProviderExecutionMode.HYBRID


def test_codex_defaults_to_hybrid_mode():
    flags = runtime_migration_flags("codex", env={})

    assert flags.execution_mode == ProviderExecutionMode.HYBRID


def test_shadow_comparison_metrics_capture_parser_parity():
    raw = RawLLMResponse(
        provider_id="openai-compatible",
        adapter_id="legacy-openai-compatible:responses",
        model="test-model",
        status="completed",
        raw_text=json.dumps(payload()),
    )

    metrics = compare_legacy_to_new_parser(
        provider_id="openai-compatible",
        adapter_id="legacy-openai-compatible:responses",
        legacy_payload=payload(),
        raw_response=raw,
        schema=schema(),
        old_latency_ms=12.5,
    )

    assert metrics.equivalent is True
    assert metrics.legacy_valid is True
    assert metrics.pipeline_valid is True
    assert metrics.confidence > 0
    assert metrics.old_latency_ms == 12.5
    assert metrics.new_latency_ms is not None


def test_openai_compatible_harness_uses_new_pipeline_by_default(monkeypatch):
    monkeypatch.setattr(harnesses, "custom_provider_settings", lambda *_args, **_kwargs: provider_settings())
    monkeypatch.setattr(
        harnesses,
        "_openai_compatible_request",
        lambda *_args, **_kwargs: (
            {"output_text": "```json\n" + json.dumps(payload()) + "\n```", "usage": {"total_tokens": 5}},
            HarnessOutput(stdout="```json\n" + json.dumps(payload()) + "\n```", returncode=0),
        ),
    )

    result = OpenAICompatibleHarness(10, "custom").run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="test-model",
        env={"OPENAI_API_KEY": "secret"},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert result.usage["llm_execution_mode"] == "NEW_PIPELINE"
    assert result.output.files is not None
    assert "llm-pipeline-artifact.json" in result.output.files


def test_openai_compatible_legacy_mode_is_instant_rollback(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_OPENAI_COMPATIBLE_EXECUTION_MODE", "LEGACY")
    monkeypatch.setattr(harnesses, "custom_provider_settings", lambda *_args, **_kwargs: provider_settings())
    monkeypatch.setattr(
        harnesses,
        "_openai_compatible_request",
        lambda *_args, **_kwargs: (
            {"output_parsed": payload(), "usage": {"total_tokens": 5}},
            HarnessOutput(stdout=json.dumps(payload()), returncode=0),
        ),
    )

    result = OpenAICompatibleHarness(10, "custom").run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="test-model",
        env={"OPENAI_API_KEY": "secret"},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert result.output.files is None


def test_openai_compatible_harness_shadows_new_parser_without_changing_result(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_OPENAI_COMPATIBLE_USE_SHADOW_PIPELINE", "true")
    monkeypatch.setattr(harnesses, "custom_provider_settings", lambda *_args, **_kwargs: provider_settings())
    monkeypatch.setattr(
        harnesses,
        "_openai_compatible_request",
        lambda *_args, **_kwargs: (
            {"output_text": "```json\n" + json.dumps(payload()) + "\n```", "usage": {"total_tokens": 5}},
            HarnessOutput(stdout="```json\n" + json.dumps(payload()) + "\n```", returncode=0),
        ),
    )

    result = OpenAICompatibleHarness(10, "custom").run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="test-model",
        env={"OPENAI_API_KEY": "secret"},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert result.usage["endpoint"] == "responses"
    assert result.output.files is not None
    comparison = json.loads(result.output.files["llm-shadow-comparison.json"])
    assert comparison["provider_id"] == "openai-compatible"
    assert comparison["pipeline_valid"] is True
    assert comparison["legacy_valid"] is True
    assert comparison["equivalent"] is True
    assert comparison["metadata"]["mode"] == "new_runtime_new_parser_shadow"


def test_openai_compatible_shadow_mode_runs_new_runtime_and_returns_legacy(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_OPENAI_COMPATIBLE_EXECUTION_MODE", "SHADOW")
    monkeypatch.setattr(harnesses, "custom_provider_settings", lambda *_args, **_kwargs: provider_settings())

    calls = []

    def request(*_args, **_kwargs):
        calls.append(True)
        return (
            {"output_text": "```json\n" + json.dumps(payload()) + "\n```", "usage": {"total_tokens": 5}},
            HarnessOutput(stdout="```json\n" + json.dumps(payload()) + "\n```", returncode=0),
        )

    monkeypatch.setattr(harnesses, "_openai_compatible_request", request)

    result = OpenAICompatibleHarness(10, "custom").run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="test-model",
        env={"OPENAI_API_KEY": "secret"},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert len(calls) == 2
    assert result.output.files is not None
    assert "llm-pipeline-artifact.json" in result.output.files
    comparison = json.loads(result.output.files["llm-shadow-comparison.json"])
    assert comparison["equivalent"] is True
    assert comparison["metadata"]["mode"] == "new_runtime_new_parser_shadow"


def test_openai_compatible_full_mode_returns_new_pipeline_result(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_OPENAI_COMPATIBLE_EXECUTION_MODE", "FULL")
    monkeypatch.setattr(harnesses, "custom_provider_settings", lambda *_args, **_kwargs: provider_settings())
    monkeypatch.setattr(
        harnesses,
        "_openai_compatible_request",
        lambda *_args, **_kwargs: (
            {"output_text": "```json\n" + json.dumps(payload()) + "\n```", "usage": {"total_tokens": 5}},
            HarnessOutput(stdout="```json\n" + json.dumps(payload()) + "\n```", returncode=0),
        ),
    )

    result = OpenAICompatibleHarness(10, "custom").run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="test-model",
        env={"OPENAI_API_KEY": "secret"},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert result.usage["llm_execution_mode"] == "NEW_PIPELINE"
    artifact = json.loads(result.output.files["llm-pipeline-artifact.json"])
    assert artifact["provider_request"]["model"] == "test-model"
    assert artifact["validated_object"] == payload()


def test_openai_compatible_hybrid_mode_falls_back_to_legacy(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_OPENAI_COMPATIBLE_EXECUTION_MODE", "HYBRID")
    monkeypatch.setattr(harnesses, "custom_provider_settings", lambda *_args, **_kwargs: provider_settings())

    calls = []

    def request(*_args, **_kwargs):
        calls.append(True)
        if len(calls) <= 2:
            return (
                {"output_text": "not json"},
                HarnessOutput(stdout="not json", returncode=0),
            )
        return (
            {"output_parsed": payload(), "usage": {"total_tokens": 5}},
            HarnessOutput(stdout=json.dumps(payload()), returncode=0),
        )

    monkeypatch.setattr(harnesses, "_openai_compatible_request", request)

    result = OpenAICompatibleHarness(10, "custom").run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="test-model",
        env={"OPENAI_API_KEY": "secret"},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert result.usage["llm_execution_mode"] == "HYBRID_FALLBACK"
    assert result.output.files is not None
    assert "llm-hybrid-fallback-error.txt" in result.output.files


def test_openai_compatible_feature_adaptation_supports_json_mode_reasoning_tools_and_streaming():
    provider = {
        "structured_outputs": False,
        "json_mode": True,
        "streaming": True,
        "tool_calling": True,
        "reasoning": True,
        "tools": [{"type": "function", "function": {"name": "inspect"}}],
        "tool_choice": "auto",
        "temperature": "0",
        "max_output_tokens": "1234",
    }
    capabilities = harnesses._openai_compatible_capabilities(provider)
    payload = harnesses._apply_openai_compatible_features(
        harnesses._openai_compatible_chat_payload("model", "prompt", schema()),
        endpoint_name="chat.completions",
        capabilities=capabilities,
        thinking_effort="high",
    )

    assert payload["response_format"] == {"type": "json_object"}
    assert payload["stream"] is True
    assert payload["reasoning_effort"] == "high"
    assert payload["tools"] == provider["tools"]
    assert payload["tool_choice"] == "auto"
    assert payload["temperature"] == 0
    assert payload["max_output_tokens"] == 1234


def test_openai_compatible_stream_response_is_normalized_to_chat_shape():
    streamed = "\n\n".join(
        [
            'data: {"choices":[{"delta":{"content":"{\\"_kritt_extractor_helper\\":true,"}}]}',
            'data: {"choices":[{"delta":{"content":"\\"results\\":[]}"}}],"usage":{"total_tokens":7}}',
            "data: [DONE]",
        ]
    )

    response = harnesses._openai_compatible_stream_response(streamed)

    assert response["streamed"] is True
    assert response["usage"]["total_tokens"] == 7
    assert json.loads(response["choices"][0]["message"]["content"]) == {EXTRACTOR_HELPER_FIELD: True, "results": []}


def test_successful_parser_artifacts_can_be_recorded_for_debugging():
    root = WORKSPACE_TMP / "artifacts"
    shutil.rmtree(root, ignore_errors=True)

    artifact_dir = record_model_output_artifact(
        str(root),
        scan_id=1,
        metadata_id=2,
        attempt=1,
        output=HarnessOutput(
            stdout="raw",
            stderr="",
            returncode=0,
            files={"llm-pipeline-artifact.json": json.dumps({"confidence_score": 0.99})},
        ),
        kind="step",
        workflow_id=3,
        step_id=4,
    )

    assert artifact_dir is not None
    artifact_path = Path(artifact_dir)
    assert (artifact_path / "llm-pipeline-artifact.json").exists()
    metadata = json.loads((artifact_path / "metadata.json").read_text(encoding="utf-8"))
    assert metadata["error"] is None
    assert metadata["metadata_id"] == 2
    shutil.rmtree(root, ignore_errors=True)


def test_claude_harness_uses_new_runtime_by_default(monkeypatch):
    fake_runtime = FakeClaudeRuntime()
    monkeypatch.setattr(harnesses, "_claude_code_runtime", lambda: fake_runtime)

    result = ClaudeHarness(10).run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="claude-test",
        env={},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert result.usage["llm_execution_mode"] == "NEW_PIPELINE"
    assert result.output.files is not None
    assert "llm-pipeline-artifact.json" in result.output.files
    assert fake_runtime.requests[0].llm.allow_tools is False
    assert "<output_contract>" in fake_runtime.requests[0].llm.prompt


def test_claude_harness_passes_prepared_job_environment_to_runtime(monkeypatch):
    fake_runtime = FakeClaudeRuntime()
    monkeypatch.setattr(harnesses, "_claude_code_runtime", lambda: fake_runtime)
    job_env = {
        "HOME": "/job/home",
        "CLAUDE_HOME": "/job/home/.claude",
        "CLAUDE_CONFIG_DIR": "/job/home/.claude",
    }

    ClaudeHarness(10).run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="claude-test",
        env=job_env,
        allow_tools=False,
    )

    assert fake_runtime.requests[0].env == job_env


def test_claude_harness_legacy_mode_is_instant_rollback(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_CLAUDE_CODE_EXECUTION_MODE", "LEGACY")
    monkeypatch.setattr(
        ClaudeHarness,
        "_run_legacy",
        lambda self, **_kwargs: HarnessResult(payload=payload(), usage={"legacy": True}, output=HarnessOutput(stdout="legacy")),
    )

    result = ClaudeHarness(10).run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="claude-test",
        env={},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert result.usage["legacy"] is True
    assert result.output.stdout == "legacy"


def test_claude_harness_shadow_mode_returns_legacy_and_records_comparison(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_CLAUDE_CODE_EXECUTION_MODE", "SHADOW")
    fake_runtime = FakeClaudeRuntime()
    monkeypatch.setattr(harnesses, "_claude_code_runtime", lambda: fake_runtime)
    monkeypatch.setattr(
        ClaudeHarness,
        "_run_legacy",
        lambda self, **_kwargs: HarnessResult(payload=payload(), usage={"legacy": True}, output=HarnessOutput(stdout=json.dumps(payload()))),
    )

    result = ClaudeHarness(10).run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="claude-test",
        env={},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert result.usage["legacy"] is True
    comparison = json.loads(result.output.files["llm-shadow-comparison.json"])
    assert comparison["provider_id"] == "claude-code"
    assert comparison["pipeline_valid"] is True


def test_claude_harness_hybrid_falls_back_to_legacy_on_runtime_error(monkeypatch):
    class RuntimeFailure(RuntimeError):
        code = "cli_unavailable"

    monkeypatch.setattr(harnesses, "_claude_code_runtime", lambda: FakeClaudeRuntime(error=RuntimeFailure("missing claude")))
    monkeypatch.setattr(
        ClaudeHarness,
        "_run_legacy",
        lambda self, **_kwargs: HarnessResult(payload=payload(), usage={"legacy": True}, output=HarnessOutput(stdout="legacy")),
    )

    result = ClaudeHarness(10).run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="claude-test",
        env={},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert result.usage["llm_execution_mode"] == "HYBRID_FALLBACK"
    assert "llm-hybrid-fallback-error.txt" in result.output.files


def test_claude_harness_full_mode_reports_missing_cli_without_login_flow(monkeypatch):
    class RuntimeFailure(RuntimeError):
        code = "cli_unavailable"

    monkeypatch.setenv("OPEN_KRITT_LLM_CLAUDE_CODE_EXECUTION_MODE", "FULL")
    monkeypatch.setattr(harnesses, "_claude_code_runtime", lambda: FakeClaudeRuntime(error=RuntimeFailure("missing claude")))

    with pytest.raises(harnesses.HarnessError) as exc_info:
        ClaudeHarness(10).run(
            prompt="Return JSON",
            schema=schema(),
            repo_dir=".",
            model="claude-test",
            env={},
            allow_tools=False,
        )

    assert exc_info.value.code == "start_failed"
    assert "not installed or is not on PATH" in str(exc_info.value)


def test_claude_harness_full_mode_reports_existing_cli_auth_required(monkeypatch):
    class RuntimeFailure(RuntimeError):
        code = "cli_authentication_required"

    monkeypatch.setenv("OPEN_KRITT_LLM_CLAUDE_CODE_EXECUTION_MODE", "FULL")
    monkeypatch.setattr(harnesses, "_claude_code_runtime", lambda: FakeClaudeRuntime(error=RuntimeFailure("not logged in")))

    with pytest.raises(harnesses.HarnessError) as exc_info:
        ClaudeHarness(10).run(
            prompt="Return JSON",
            schema=schema(),
            repo_dir=".",
            model="claude-test",
            env={},
            allow_tools=False,
        )

    assert exc_info.value.code == "auth_failed"
    assert "not authenticated" in str(exc_info.value)


@pytest.mark.skipif(
    not (os.getenv("OPEN_KRITT_LIVE_CLAUDE_CODE") and shutil.which("claude")),
    reason="live Claude Code test requires OPEN_KRITT_LIVE_CLAUDE_CODE=1 and claude on PATH",
)
def test_live_claude_code_uses_installed_cli_without_credentials(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_CLAUDE_CODE_EXECUTION_MODE", "FULL")

    result = ClaudeHarness(60).run(
        prompt="Return exactly one valid JSON object with _kritt_extractor_helper true and an empty results array.",
        schema=schema(),
        repo_dir=".",
        model=os.getenv("OPEN_KRITT_LIVE_CLAUDE_MODEL", "sonnet"),
        env={},
        allow_tools=False,
    )

    assert result.payload[EXTRACTOR_HELPER_FIELD] is True
    assert isinstance(result.payload["results"], list)


def test_codex_harness_uses_new_runtime_by_default(monkeypatch):
    fake_runtime = FakeCodexRuntime()
    monkeypatch.setattr(harnesses, "_codex_runtime", lambda: fake_runtime)

    result = harnesses.CodexHarness(10).run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="codex-test",
        env={},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert result.usage["llm_execution_mode"] == "NEW_PIPELINE"
    assert result.output.files is not None
    assert "llm-pipeline-artifact.json" in result.output.files
    assert fake_runtime.requests[0].llm.allow_tools is False


def test_codex_harness_passes_prepared_job_environment_to_runtime(monkeypatch):
    fake_runtime = FakeCodexRuntime()
    monkeypatch.setattr(harnesses, "_codex_runtime", lambda: fake_runtime)
    job_env = {
        "HOME": "/job/home",
        "CODEX_HOME": "/job/home/.codex",
        "CODEX_API_KEY": "secret",
    }

    harnesses.CodexHarness(10).run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="codex-test",
        env=job_env,
        allow_tools=False,
    )

    assert fake_runtime.requests[0].env == job_env


def test_codex_harness_legacy_mode_is_instant_rollback(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_CODEX_EXECUTION_MODE", "LEGACY")
    monkeypatch.setattr(
        harnesses.CodexHarness,
        "_run",
        lambda self, *_args: HarnessResult(payload=payload(), usage={"legacy": True}, codex_session_id="thread", output=HarnessOutput(stdout="legacy")),
    )

    result = harnesses.CodexHarness(10).run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="codex-test",
        env={},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert result.usage["legacy"] is True
    assert result.codex_session_id == "thread"


def test_codex_harness_shadow_mode_returns_legacy_and_records_comparison(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_CODEX_EXECUTION_MODE", "SHADOW")
    fake_runtime = FakeCodexRuntime()
    monkeypatch.setattr(harnesses, "_codex_runtime", lambda: fake_runtime)
    monkeypatch.setattr(
        harnesses.CodexHarness,
        "_run",
        lambda self, *_args: HarnessResult(payload=payload(), usage={"legacy": True}, output=HarnessOutput(stdout=json.dumps(payload()))),
    )

    result = harnesses.CodexHarness(10).run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="codex-test",
        env={},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert result.usage["legacy"] is True
    comparison = json.loads(result.output.files["llm-shadow-comparison.json"])
    assert comparison["provider_id"] == "codex"
    assert comparison["pipeline_valid"] is True


def test_codex_harness_hybrid_falls_back_to_legacy_on_runtime_error(monkeypatch):
    class RuntimeFailure(RuntimeError):
        code = "cli_unavailable"

    monkeypatch.setattr(harnesses, "_codex_runtime", lambda: FakeCodexRuntime(error=RuntimeFailure("missing codex")))
    monkeypatch.setattr(
        harnesses.CodexHarness,
        "_run",
        lambda self, *_args: HarnessResult(payload=payload(), usage={"legacy": True}, output=HarnessOutput(stdout="legacy")),
    )

    result = harnesses.CodexHarness(10).run(
        prompt="Return JSON",
        schema=schema(),
        repo_dir=".",
        model="codex-test",
        env={},
        allow_tools=False,
    )

    assert result.payload == payload()
    assert result.usage["llm_execution_mode"] == "HYBRID_FALLBACK"
    assert "llm-hybrid-fallback-error.txt" in result.output.files


def test_codex_harness_full_mode_reports_missing_cli_without_login_flow(monkeypatch):
    class RuntimeFailure(RuntimeError):
        code = "cli_unavailable"

    monkeypatch.setenv("OPEN_KRITT_LLM_CODEX_EXECUTION_MODE", "FULL")
    monkeypatch.setattr(harnesses, "_codex_runtime", lambda: FakeCodexRuntime(error=RuntimeFailure("missing codex")))

    with pytest.raises(harnesses.HarnessError) as exc_info:
        harnesses.CodexHarness(10).run(
            prompt="Return JSON",
            schema=schema(),
            repo_dir=".",
            model="codex-test",
            env={},
            allow_tools=False,
        )

    assert exc_info.value.code == "start_failed"
    assert "not installed or is not on PATH" in str(exc_info.value)


def test_codex_harness_full_mode_reports_existing_cli_auth_required(monkeypatch):
    class RuntimeFailure(RuntimeError):
        code = "cli_authentication_required"

    monkeypatch.setenv("OPEN_KRITT_LLM_CODEX_EXECUTION_MODE", "FULL")
    monkeypatch.setattr(harnesses, "_codex_runtime", lambda: FakeCodexRuntime(error=RuntimeFailure("not logged in")))

    with pytest.raises(harnesses.HarnessError) as exc_info:
        harnesses.CodexHarness(10).run(
            prompt="Return JSON",
            schema=schema(),
            repo_dir=".",
            model="codex-test",
            env={},
            allow_tools=False,
        )

    assert exc_info.value.code == "auth_failed"
    assert "not authenticated" in str(exc_info.value)


def test_codex_harness_full_mode_reports_nonzero_cli_exit(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_CODEX_EXECUTION_MODE", "FULL")
    monkeypatch.setattr(harnesses, "_codex_runtime", lambda: FakeCodexRuntime(status="failed", stderr="model unavailable"))

    with pytest.raises(harnesses.HarnessError) as exc_info:
        harnesses.CodexHarness(10).run(
            prompt="Return JSON",
            schema=schema(),
            repo_dir=".",
            model="codex-test",
            env={},
            allow_tools=False,
        )

    assert exc_info.value.code == "model_unavailable"


def test_codex_harness_full_mode_reports_cli_startup_access_denied(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_CODEX_EXECUTION_MODE", "FULL")
    monkeypatch.setattr(
        harnesses,
        "_codex_runtime",
        lambda: FakeCodexRuntime(
            status="failed",
            stderr="Error: failed to initialize in-process app-server client: Access is denied. (os error 5)",
        ),
    )

    with pytest.raises(harnesses.HarnessError) as exc_info:
        harnesses.CodexHarness(10).run(
            prompt="Return JSON",
            schema=schema(),
            repo_dir=".",
            model="codex-test",
            env={},
            allow_tools=False,
        )

    assert exc_info.value.code == "start_failed"
    assert "could not initialize" in str(exc_info.value)


@pytest.mark.skipif(
    not (os.getenv("OPEN_KRITT_LIVE_CODEX") and shutil.which("codex")),
    reason="live Codex test requires OPEN_KRITT_LIVE_CODEX=1 and codex on PATH",
)
def test_live_codex_uses_installed_cli_without_credentials(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_CODEX_EXECUTION_MODE", "FULL")

    result = harnesses.CodexHarness(60).run(
        prompt="Return exactly one valid JSON object with _kritt_extractor_helper true and an empty results array.",
        schema=schema(),
        repo_dir=".",
        model=os.getenv("OPEN_KRITT_LIVE_CODEX_MODEL", "gpt-5"),
        env={},
        allow_tools=False,
    )

    assert result.payload[EXTRACTOR_HELPER_FIELD] is True
    assert isinstance(result.payload["results"], list)


def test_openai_compatible_harness_shadows_when_legacy_parser_finds_no_payload(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_OPENAI_COMPATIBLE_USE_SHADOW_PIPELINE", "true")
    monkeypatch.setattr(harnesses, "custom_provider_settings", lambda *_args, **_kwargs: provider_settings())
    monkeypatch.setattr(
        harnesses,
        "_openai_compatible_request",
        lambda *_args, **_kwargs: (
            {"unrecognized": "```json\n" + json.dumps(payload()) + "\n```"},
            HarnessOutput(stdout="```json\n" + json.dumps(payload()) + "\n```", returncode=0),
        ),
    )

    try:
        OpenAICompatibleHarness(10, "custom").run(
            prompt="Return JSON",
            schema=schema(),
            repo_dir=".",
            model="test-model",
            env={"OPENAI_API_KEY": "secret"},
            allow_tools=False,
        )
    except harnesses.HarnessError as exc:
        assert exc.output.files is not None
        comparison = json.loads(exc.output.files["llm-shadow-comparison.json"])
        assert comparison["legacy_valid"] is False
        assert comparison["pipeline_valid"] is True
        assert comparison["differences"] == ["legacy_missing_pipeline_valid"]
    else:
        raise AssertionError("legacy harness should still fail when legacy parser finds no payload")


def test_provider_certification_blocks_promotion_below_thresholds():
    metrics = [
        RuntimeComparisonMetrics(
            provider_id="openai-compatible",
            adapter_id="http-openai-compatible:responses",
            equivalent=True,
            legacy_valid=True,
            pipeline_valid=True,
            confidence=0.95,
            recovery_source="direct",
            recovery_count=0,
            old_latency_ms=10,
            new_latency_ms=11,
        ),
        RuntimeComparisonMetrics(
            provider_id="openai-compatible",
            adapter_id="http-openai-compatible:responses",
            equivalent=False,
            legacy_valid=True,
            pipeline_valid=False,
            confidence=0.2,
            recovery_source=None,
            recovery_count=1,
            old_latency_ms=10,
            new_latency_ms=20,
            differences=("pipeline_missing_legacy_valid",),
        ),
    ]

    result = certify_provider(
        "openai-compatible",
        metrics,
        ProviderCertificationThresholds(min_schema_validity_rate=0.99, max_repair_rate=0.01),
    )

    assert result.production_ready is False
    assert "schema_validity_below_threshold" in result.failures
    assert "repair_rate_above_threshold" in result.failures


@pytest.mark.skipif(
    not (
        os.getenv("OPEN_KRITT_LIVE_OPENAI_COMPATIBLE_BASE_URL")
        and os.getenv("OPEN_KRITT_LIVE_OPENAI_COMPATIBLE_API_KEY")
        and os.getenv("OPEN_KRITT_LIVE_OPENAI_COMPATIBLE_MODEL")
    ),
    reason="live OpenAI-compatible certification env vars are not configured",
)
def test_live_openai_compatible_provider_uses_production_runtime(monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_LLM_OPENAI_COMPATIBLE_EXECUTION_MODE", "FULL")
    monkeypatch.setattr(
        harnesses,
        "custom_provider_settings",
        lambda *_args, **_kwargs: {
            "base_url": os.environ["OPEN_KRITT_LIVE_OPENAI_COMPATIBLE_BASE_URL"],
            "api_key": os.environ["OPEN_KRITT_LIVE_OPENAI_COMPATIBLE_API_KEY"],
            "structured_outputs": True,
            "json_mode": True,
        },
    )

    result = OpenAICompatibleHarness(30, "live").run(
        prompt="Return exactly one valid JSON object with _kritt_extractor_helper true and an empty results array.",
        schema=schema(),
        repo_dir=".",
        model=os.environ["OPEN_KRITT_LIVE_OPENAI_COMPATIBLE_MODEL"],
        env={},
        allow_tools=False,
    )

    assert result.payload[EXTRACTOR_HELPER_FIELD] is True
    assert isinstance(result.payload["results"], list)

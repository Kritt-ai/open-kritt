import builtins
import sys
import time
from pathlib import Path

import pytest

from open_kritt_engine.harnesses import HarnessOutput, HarnessResult
from open_kritt_engine.llm import LLMRequest
from open_kritt_engine.llm.capabilities import ProviderCapabilities
from open_kritt_engine.llm.runtime import (
    CancellationToken,
    ClaudeCodeRuntime,
    CLIAuthenticationRequired,
    CLIUnavailable,
    CodexRuntime,
    HTTPRuntimeProvider,
    LegacyHarnessRuntime,
    OllamaRuntime,
    OpenAIRuntime,
    RateLimited,
    RuntimeRequest,
    StreamEvent,
    TimeoutError,
    TransportError,
)
from open_kritt_engine.llm.runtime.process import ProcessResult, SubprocessRunner

WORKSPACE_TMP = Path(__file__).parent / ".tmp-runtime"


class FakeProcessRunner:
    def __init__(self, *, executable="/usr/bin/tool", results=None):
        self.executable = executable
        self.results = list(results or [])
        self.calls = []
        self.stream_calls = []

    def which(self, names, path=None):
        self.calls.append(("which", names, path))
        return self.executable

    def run(self, command, *, input_text, cwd, timeout_seconds, env):
        self.calls.append(("run", command, input_text, cwd, timeout_seconds, env))
        if self.results:
            result = self.results.pop(0)
            if isinstance(result, Exception):
                raise result
            return result
        return ProcessResult(stdout="OK", stderr="", returncode=0, elapsed_ms=1.0)

    def run_stream(self, command, *, input_text, cwd, timeout_seconds, env, callback, cancellation_token):
        self.stream_calls.append((command, input_text, cwd, timeout_seconds, env))
        if cancellation_token is not None and cancellation_token.cancelled():
            callback(StreamEvent(kind="cancelled"))
            return ProcessResult(stdout="", stderr="", returncode=130, elapsed_ms=0.5)
        callback(StreamEvent(kind="stdout", text="chunk"))
        callback(StreamEvent(kind="completed"))
        return ProcessResult(stdout="chunk", stderr="warn", returncode=0, elapsed_ms=2.0)


class FakeHTTPClient:
    def __init__(self, response=(200, {"x-request-id": "req_1"}, '{"ok":true}'), error=None):
        self.response = response
        self.error = error
        self.calls = []

    def post_json(self, url, *, headers, payload, timeout_seconds):
        self.calls.append((url, headers, payload, timeout_seconds))
        if self.error is not None:
            raise self.error
        return self.response


class FakeHarness:
    def run(self, **_kwargs):
        return HarnessResult(
            payload={"ok": True},
            usage={"tokens": 1},
            output=HarnessOutput(stdout='{"ok":true}', stderr="", returncode=0),
        )


def llm_request(**overrides):
    values = {
        "prompt": "Return JSON.",
        "schema": {"type": "object"},
        "model": "test-model",
        "mode": "generation",
        "repo_dir": "/repo",
        "allow_tools": False,
        "allow_streaming": False,
        "timeout_seconds": 7,
    }
    values.update(overrides)
    return LLMRequest(**values)


def runtime_request(**overrides):
    stream_callback = overrides.pop("stream_callback", None)
    cancellation_token = overrides.pop("cancellation_token", None)
    env = overrides.pop("env", None)
    request = llm_request(**overrides)
    return RuntimeRequest(
        llm=request,
        provider_id="test-provider",
        adapter_id="test-adapter",
        capabilities=ProviderCapabilities(streaming=request.allow_streaming),
        stream_callback=stream_callback,
        cancellation_token=cancellation_token,
        env=env,
    )


def test_cli_runtime_detects_missing_executable():
    runtime = ClaudeCodeRuntime(runner=FakeProcessRunner(executable=None))

    detection = runtime.detect()

    assert detection.available is False
    assert detection.authenticated is None
    assert "Executable not found" in detection.diagnostics[0]


def test_cli_runtime_detects_version_and_authentication():
    runner = FakeProcessRunner(
        executable="/usr/bin/claude",
        results=[
            ProcessResult(stdout="claude 1.2.3", stderr="", returncode=0, elapsed_ms=1.0),
            ProcessResult(stdout="OK", stderr="", returncode=0, elapsed_ms=1.0),
            ProcessResult(stdout="--output-format stream-json --tools --effort --json-schema vision context 200", stderr="", returncode=0, elapsed_ms=1.0),
        ],
    )
    runtime = ClaudeCodeRuntime(runner=runner)

    detection = runtime.detect()

    assert detection.available is True
    assert detection.authenticated is True
    assert detection.version == "claude 1.2.3"
    assert detection.capabilities.cli_execution is True
    assert detection.capabilities.streaming is True
    assert detection.capabilities.structured_outputs is True
    assert detection.capabilities.tools is True


def test_cli_runtime_reports_authentication_failure():
    runner = FakeProcessRunner(
        executable="/usr/bin/claude",
        results=[
            ProcessResult(stdout="", stderr="not logged in with api_key=sk-secretvalue123456789", returncode=1, elapsed_ms=1.0),
        ],
    )
    runtime = ClaudeCodeRuntime(runner=runner)

    with pytest.raises(CLIAuthenticationRequired) as exc_info:
        runtime.execute(runtime_request())

    assert exc_info.value.code == "cli_authentication_required"
    assert "not logged in" in str(exc_info.value)
    assert "sk-secretvalue123456789" not in str(exc_info.value)
    assert "[REDACTED]" in str(exc_info.value)


def test_cli_runtime_does_not_treat_probe_transport_failure_as_auth_failure():
    runner = FakeProcessRunner(
        executable="/usr/bin/claude",
        results=[
            ProcessResult(stdout="", stderr="Unable to connect to API", returncode=1, elapsed_ms=1.0),
            ProcessResult(stdout='{"results":[]}', stderr="", returncode=0, elapsed_ms=2.0),
        ],
    )
    runtime = ClaudeCodeRuntime(runner=runner)

    response = runtime.execute(runtime_request())

    assert response.status == "completed"
    assert response.raw_text == '{"results":[]}'


def test_cli_runtime_preserves_windows_process_environment(monkeypatch):
    monkeypatch.setenv("SystemRoot", r"C:\Windows")
    monkeypatch.setenv("COMSPEC", r"C:\Windows\System32\cmd.exe")
    runtime = ClaudeCodeRuntime(runner=FakeProcessRunner())

    env = runtime.runtime_env()

    assert env["SystemRoot"] == r"C:\Windows"
    assert env["COMSPEC"] == r"C:\Windows\System32\cmd.exe"


def test_cli_runtime_uses_request_environment_for_auth_probe_and_execution():
    runner = FakeProcessRunner(
        executable="/usr/bin/codex",
        results=[
            ProcessResult(stdout="OK", stderr="", returncode=0, elapsed_ms=1.0),
            ProcessResult(stdout='{"results":[]}', stderr="", returncode=0, elapsed_ms=2.0),
        ],
    )
    runtime = CodexRuntime(runner=runner)
    env = {
        "PATH": "/job/bin",
        "HOME": "/job/home",
        "CODEX_HOME": "/job/home/.codex",
        "CODEX_API_KEY": "secret",
    }

    runtime.execute(runtime_request(model="gpt-test", env=env))

    assert runner.calls[0] == ("which", ("codex",), "/job/bin")
    auth_env = runner.calls[1][5]
    exec_env = runner.calls[2][5]
    assert auth_env["CODEX_HOME"] == "/job/home/.codex"
    assert auth_env["CODEX_API_KEY"] == "secret"
    assert exec_env["CODEX_HOME"] == "/job/home/.codex"
    assert exec_env["HOME"] == "/job/home"


def test_cli_runtime_reports_unavailable_executable():
    runtime = CodexRuntime(runner=FakeProcessRunner(executable=None))

    with pytest.raises(CLIUnavailable):
        runtime.execute(runtime_request())


def test_claude_runtime_builds_command_without_credentials():
    runner = FakeProcessRunner(
        executable="/usr/bin/claude",
        results=[
            ProcessResult(stdout="OK", stderr="", returncode=0, elapsed_ms=1.0),
            ProcessResult(stdout='{"results":[]}', stderr="warn", returncode=0, elapsed_ms=2.0),
        ],
    )
    runtime = ClaudeCodeRuntime(runner=runner)

    response = runtime.execute(runtime_request(model="claude-test", thinking_effort="medium", allow_streaming=True))

    command = runner.calls[-1][1]
    assert command[:4] == ["/usr/bin/claude", "-p", "--model", "claude-test"]
    assert "--effort" in command
    assert "--tools" not in command
    assert command[command.index("--output-format") + 1] == "json"
    assert "--verbose" not in command
    assert response.status == "completed"
    assert response.stdout == '{"results":[]}'
    assert response.stderr == "warn"
    assert response.capabilities_used["runtime"] == "cli"


def test_claude_runtime_uses_stream_json_only_with_callback():
    runner = FakeProcessRunner(
        executable="/usr/bin/claude",
        results=[ProcessResult(stdout="OK", stderr="", returncode=0, elapsed_ms=1.0)],
    )
    runtime = ClaudeCodeRuntime(runner=runner)

    response = runtime.execute(runtime_request(allow_streaming=True, stream_callback=lambda _event: None))

    command = runner.stream_calls[-1][0]
    assert command[command.index("--output-format") + 1] == "stream-json"
    assert "--verbose" in command
    assert response.status == "completed"


def test_claude_runtime_extracts_content_blocks_from_json_wrapper():
    runner = FakeProcessRunner(
        executable="/usr/bin/claude",
        results=[
            ProcessResult(stdout="OK", stderr="", returncode=0, elapsed_ms=1.0),
            ProcessResult(
                stdout='{"result":"```json\\n{\\"ok\\":true}\\n```","usage":{"total_tokens":5}}',
                stderr="",
                returncode=0,
                elapsed_ms=2.0,
            ),
        ],
    )
    runtime = ClaudeCodeRuntime(runner=runner)

    response = runtime.execute(runtime_request(model="claude-test"))

    assert response.raw_text.startswith('{"result"')
    assert response.content_blocks[0]["source"] == "claude_result"
    assert '{"ok":true}' in response.content_blocks[0]["text"]


def test_codex_runtime_builds_command_without_credentials():
    runner = FakeProcessRunner(
        executable="/usr/bin/codex",
        results=[
            ProcessResult(stdout="OK", stderr="", returncode=0, elapsed_ms=1.0),
            ProcessResult(stdout='{"results":[]}', stderr="", returncode=0, elapsed_ms=2.0),
        ],
    )
    runtime = CodexRuntime(runner=runner)

    response = runtime.execute(runtime_request(model="gpt-test"))

    command = runner.calls[-1][1]
    assert command[:5] == ["/usr/bin/codex", "exec", "--json", "-m", "gpt-test"]
    assert response.raw_text == '{"results":[]}'


def test_codex_runtime_auth_probe_sends_prompt_on_stdin():
    runner = FakeProcessRunner(
        executable="/usr/bin/codex",
        results=[
            ProcessResult(stdout="OK", stderr="", returncode=0, elapsed_ms=1.0),
            ProcessResult(stdout='{"results":[]}', stderr="", returncode=0, elapsed_ms=2.0),
        ],
    )
    runtime = CodexRuntime(runner=runner)

    runtime.execute(runtime_request(model="gpt-test"))

    auth_call = [call for call in runner.calls if call[0] == "run"][0]
    assert auth_call[0] == "run"
    assert auth_call[2] == "Return OK."


def test_codex_runtime_detects_help_capabilities():
    runner = FakeProcessRunner(
        executable="/usr/bin/codex",
        results=[
            ProcessResult(stdout="codex 1.2.3", stderr="", returncode=0, elapsed_ms=1.0),
            ProcessResult(stdout="OK", stderr="", returncode=0, elapsed_ms=1.0),
            ProcessResult(stdout="--json --sandbox --output-schema reasoning effort", stderr="", returncode=0, elapsed_ms=1.0),
        ],
    )
    runtime = CodexRuntime(runner=runner)

    detection = runtime.detect()

    assert detection.available is True
    assert detection.authenticated is True
    assert detection.capabilities.cli_execution is True
    assert detection.capabilities.streaming is True
    assert detection.capabilities.structured_outputs is True
    assert detection.capabilities.thinking is True


def test_codex_runtime_extracts_content_blocks_from_jsonl():
    runner = FakeProcessRunner(
        executable="/usr/bin/codex",
        results=[
            ProcessResult(stdout="OK", stderr="", returncode=0, elapsed_ms=1.0),
            ProcessResult(
                stdout='{"message":"```json\\n{\\"ok\\":true}\\n```"}\n{"payload":{"extra":true}}',
                stderr="",
                returncode=0,
                elapsed_ms=2.0,
            ),
        ],
    )
    runtime = CodexRuntime(runner=runner)

    response = runtime.execute(runtime_request(model="codex-test"))

    assert response.content_blocks[0]["source"] == "codex_message"
    assert '{"ok":true}' in response.content_blocks[0]["text"]
    assert response.content_blocks[1]["source"] == "codex_payload"


def test_cli_runtime_supports_streaming_callbacks():
    runner = FakeProcessRunner(
        executable="/usr/bin/claude",
        results=[ProcessResult(stdout="OK", stderr="", returncode=0, elapsed_ms=1.0)],
    )
    runtime = ClaudeCodeRuntime(runner=runner)
    events = []

    response = runtime.execute(
        runtime_request(
            allow_streaming=True,
            stream_callback=events.append,
        )
    )

    assert [event.kind for event in events] == ["stdout", "completed"]
    assert response.raw_text == "chunk"
    assert response.capabilities_used["streaming"] is True


def test_cli_runtime_supports_cancellation():
    runner = FakeProcessRunner(
        executable="/usr/bin/claude",
        results=[ProcessResult(stdout="OK", stderr="", returncode=0, elapsed_ms=1.0)],
    )
    runtime = ClaudeCodeRuntime(runner=runner)
    token = CancellationToken()
    token.cancel()
    events = []

    response = runtime.execute(
        runtime_request(
            allow_streaming=True,
            stream_callback=events.append,
            cancellation_token=token,
        )
    )

    assert response.status == "failed"
    assert response.warnings == ("cancelled",)
    assert [event.kind for event in events].count("cancelled") >= 1


def test_cli_runtime_normalizes_timeout_error():
    runner = FakeProcessRunner(
        executable="/usr/bin/claude",
        results=[ProcessResult(stdout="OK", stderr="", returncode=0, elapsed_ms=1.0), TimeoutError()],
    )
    runtime = ClaudeCodeRuntime(runner=runner)

    with pytest.raises(TimeoutError):
        runtime.execute(runtime_request())


def test_subprocess_streaming_cancellation_terminates_running_process():
    runner = SubprocessRunner()
    token = CancellationToken()
    events = []

    def callback(event):
        events.append(event)
        if event.kind == "stdout":
            token.cancel()

    result = runner.run_stream(
        [
            sys.executable,
            "-c",
            "import time; print('first', flush=True); time.sleep(5); print('second', flush=True)",
        ],
        input_text="",
        cwd=None,
        timeout_seconds=10,
        env=None,
        callback=callback,
        cancellation_token=token,
    )

    assert result.returncode != 0
    assert "first" in result.stdout
    assert "second" not in result.stdout
    assert "cancelled" in [event.kind for event in events]


def test_subprocess_streaming_timeout_terminates_running_process():
    runner = SubprocessRunner()

    with pytest.raises(TimeoutError):
        runner.run_stream(
            [sys.executable, "-c", "import time; time.sleep(5)"],
            input_text="",
            cwd=None,
            timeout_seconds=1,
            env=None,
            callback=lambda _event: None,
            cancellation_token=None,
        )


def test_subprocess_streaming_callback_error_terminates_running_process():
    runner = SubprocessRunner()
    WORKSPACE_TMP.mkdir(parents=True, exist_ok=True)
    marker = WORKSPACE_TMP / "leaked-process.txt"
    marker.unlink(missing_ok=True)

    def callback(event):
        if event.kind == "stdout":
            raise RuntimeError("callback failed")

    with pytest.raises(RuntimeError, match="callback failed"):
        runner.run_stream(
            [
                sys.executable,
                "-c",
                f"import pathlib, time; print('ready', flush=True); time.sleep(1.5); pathlib.Path({str(marker)!r}).write_text('leaked')",
            ],
            input_text="",
            cwd=None,
            timeout_seconds=10,
            env=None,
            callback=callback,
            cancellation_token=None,
        )

    time.sleep(2)
    assert not marker.exists()


def test_http_runtime_executes_to_raw_response():
    client = FakeHTTPClient()
    runtime = OpenAIRuntime(base_url="https://example.test/v1/responses", api_key="secret", client=client)

    response = runtime.execute(runtime_request(model="gpt-test"))

    assert response.status == "completed"
    assert response.request_id == "req_1"
    assert response.raw_provider_payload == {"ok": True}
    assert client.calls[0][1]["Authorization"] == "Bearer secret"


def test_http_runtime_detects_missing_configuration():
    runtime = HTTPRuntimeProvider(
        id="openai",
        adapter_id="http:openai",
        base_url=None,
        api_key=None,
        client=FakeHTTPClient(),
        default_capabilities=ProviderCapabilities(),
    )

    detection = runtime.detect()

    assert detection.available is False
    assert "base URL" in detection.diagnostics[0]


def test_http_runtime_normalizes_rate_limit():
    runtime = OpenAIRuntime(
        base_url="https://example.test",
        api_key="secret",
        client=FakeHTTPClient(response=(429, {}, "limited")),
    )

    with pytest.raises(RateLimited):
        runtime.execute(runtime_request())


def test_http_runtime_normalizes_transport_error():
    runtime = OpenAIRuntime(
        base_url="https://example.test",
        api_key="secret",
        client=FakeHTTPClient(error=OSError("network down")),
    )

    with pytest.raises(TransportError):
        runtime.execute(runtime_request())


def test_http_runtime_normalizes_builtin_timeout_error():
    runtime = OpenAIRuntime(
        base_url="https://example.test",
        api_key="secret",
        client=FakeHTTPClient(error=builtins.TimeoutError("socket timed out")),
    )

    with pytest.raises(TimeoutError):
        runtime.execute(runtime_request())


def test_ollama_runtime_does_not_require_api_key():
    runtime = OllamaRuntime(base_url="http://localhost:11434/api/generate", client=FakeHTTPClient())

    detection = runtime.detect()

    assert detection.available is True
    assert detection.authenticated is True
    assert detection.capabilities.local_execution is True


def test_legacy_harness_runtime_returns_raw_response_without_new_parser():
    runtime = LegacyHarnessRuntime(
        id="legacy",
        adapter_id="legacy:harness",
        harness_factory=lambda _timeout: FakeHarness(),
    )

    response = runtime.execute(runtime_request())

    assert response.status == "completed"
    assert response.raw_text == '{"ok":true}'
    assert response.raw_provider_payload == {"ok": True}
    assert response.capabilities_used["runtime"] == "legacy_harness"

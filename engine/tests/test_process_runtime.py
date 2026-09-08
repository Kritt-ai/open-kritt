import json
import subprocess
import sys
from types import SimpleNamespace

import pytest

from open_kritt_engine import harnesses, workspace_snapshots
from open_kritt_engine.worker import Worker

DOCUMENT_SCHEMA = {
    "type": "object",
    "properties": {"message": {"type": "string"}, "count": {"type": "integer"}},
    "required": ["message", "count"],
    "additionalProperties": False,
}
DOCUMENT = {"message": "example", "count": 0}


def test_parser_recovers_a_complete_document_after_unbalanced_text():
    text = "unfinished { example\n" + json.dumps(DOCUMENT)
    assert harnesses._parse_json_text(text, DOCUMENT_SCHEMA) == DOCUMENT


def test_parser_rejects_a_document_that_does_not_match_its_schema():
    with pytest.raises(harnesses.HarnessError):
        harnesses._parse_json_text('{"message":"example","count":"wrong"}', DOCUMENT_SCHEMA)


@pytest.mark.parametrize("key", ["structuredOutput", "structured_output"])
@pytest.mark.parametrize("nested", [False, True])
def test_structured_response_wrappers_remain_compatible(key, nested):
    wrapped = {key: DOCUMENT}
    if nested:
        wrapped = {"result": wrapped}
    assert harnesses._extract_json(wrapped, DOCUMENT_SCHEMA) == DOCUMENT


def test_current_jsonl_message_shape_and_non_object_records():
    event = {"type": "item.completed", "item": {"type": "agent_message", "text": json.dumps(DOCUMENT)}}
    output = 'null\n[]\n42\n"text"\n' + json.dumps(event)
    result = harnesses._jsonl_result(output, DOCUMENT_SCHEMA)
    assert result.payload == DOCUMENT


def test_command_output_is_not_classified_as_a_provider_error():
    event = {"type": "item.completed", "item": {"type": "command_execution", "output": "invalid API key"}}
    assert harnesses._codex_error_diagnostic_text(json.dumps(event), "") == ""
    error = json.dumps({"type": "turn.failed", "error": {"message": "request rejected"}})
    assert harnesses._codex_error_diagnostic_text(error, "") == error


def test_openrouter_stream_uses_valid_structured_output(monkeypatch, tmp_path):
    calls = []
    output = json.dumps({"type": "result", "structured_output": DOCUMENT, "usage": {"input_tokens": 1}})

    def run(command, prompt, cwd, timeout, env=None):
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, output, "")

    monkeypatch.setattr(harnesses, "_run_process", run)
    result = harnesses.ClaudeHarness(5, "openrouter").run(
        prompt="Return the example document.",
        schema=DOCUMENT_SCHEMA,
        repo_dir=str(tmp_path),
        model="example/model",
        env={"OPENROUTER_API_KEY": "synthetic-key"},
        allow_tools=False,
    )
    assert result.payload == DOCUMENT
    assert json.loads(calls[0][calls[0].index("--json-schema") + 1]) == DOCUMENT_SCHEMA
    assert calls[0][calls[0].index("--tools") + 1] == ""


def test_stream_error_takes_precedence_over_an_earlier_document():
    output = "\n".join(
        [
            json.dumps({"type": "result", "structured_output": DOCUMENT}),
            json.dumps({"type": "error", "error": {"message": "service unavailable"}}),
        ]
    )
    with pytest.raises(harnesses.HarnessError):
        harnesses._extract_json_from_claude_stream(output, provider="openrouter", schema=DOCUMENT_SCHEMA)


def test_process_output_is_spooled_and_recovered(tmp_path):
    result = harnesses._run_process(
        [sys.executable, "-c", "import sys; print('x' * 100000); print('notice', file=sys.stderr)"],
        "",
        str(tmp_path),
        5,
        env={},
    )
    assert result.stdout == "x" * 100000 + "\n"
    assert result.stderr == "notice\n"


def test_timeout_preserves_spooled_output(monkeypatch, tmp_path):
    def run(command, **kwargs):
        kwargs["stdout"].write("partial output")
        kwargs["stderr"].write("partial diagnostic")
        raise subprocess.TimeoutExpired(command, 1)

    monkeypatch.setattr(harnesses.subprocess, "run", run)
    with pytest.raises(harnesses.HarnessError) as raised:
        harnesses._run_process([sys.executable], "", str(tmp_path), 1, env={})
    assert raised.value.code == "timeout"
    assert raised.value.output.stdout == "partial output"
    assert raised.value.output.stderr == "partial diagnostic"


def test_memory_pressure_interruption_is_disabled_by_default(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_MEMORY_PRESSURE_EVICTION_ENABLED", raising=False)
    monkeypatch.setenv("ENGINE_RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.env"))
    worker = SimpleNamespace(config=SimpleNamespace(data_dir=str(tmp_path)))
    assert Worker.runtime_memory_pressure_eviction_enabled(worker) is False


def test_disabled_interruption_does_not_inspect_or_stop_jobs():
    worker = SimpleNamespace(runtime_memory_pressure_eviction_enabled=lambda: False)
    assert Worker._evict_runner_under_memory_pressure(worker) is None


def test_abnormal_container_exit_is_reported_as_capacity_pressure(monkeypatch, tmp_path):
    monkeypatch.setattr(harnesses, "_docker_run_details", lambda _cmd: ("example", "example-net"))
    monkeypatch.setattr(harnesses, "_prepare_docker_sandbox", lambda _cmd: None)
    monkeypatch.setattr(harnesses, "_cleanup_docker_run_container", lambda _cmd: None)
    monkeypatch.setattr(
        harnesses.subprocess, "run", lambda command, **_kwargs: subprocess.CompletedProcess(command, 137, "", "")
    )
    with pytest.raises(harnesses.HarnessError) as raised:
        harnesses._run_process(["docker", "run"], "", str(tmp_path), 5, env={})
    assert raised.value.code == "runner_resource_limited"


def test_network_creation_retries_pool_exhaustion_only(monkeypatch):
    calls = []

    def control(command):
        calls.append(command)
        if len(calls) == 1:
            return subprocess.CompletedProcess(command, 1, "", "all predefined address pools have been fully subnetted")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(harnesses, "_docker_run_details", lambda _cmd: ("example", "open-kritt-sandbox-example"))
    monkeypatch.setattr(harnesses, "SCAN_SANDBOX_NETWORK_PREFIX", "open-kritt-sandbox-")
    monkeypatch.setattr(harnesses, "_docker_control_run", control)
    harnesses._prepare_docker_sandbox(["docker"])
    assert len(calls) == 2
    assert "--subnet" in calls[1]
    assert calls[1][-1] == "open-kritt-sandbox-example"


@pytest.mark.parametrize("entrypoint,command", [(["unexpected"], ["/bin/true"]), (None, ["unexpected"])])
def test_snapshot_cache_rejects_executable_defaults(monkeypatch, entrypoint, command):
    inspected = {
        "Config": {
            "Labels": {workspace_snapshots.SNAPSHOT_KEY_LABEL: "example"},
            "Entrypoint": entrypoint,
            "Cmd": command,
        }
    }
    monkeypatch.setattr(workspace_snapshots, "_inspect_snapshot_image", lambda _image: inspected)
    assert workspace_snapshots._image_snapshot_key("example:local") is None

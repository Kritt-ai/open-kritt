import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from open_kritt_engine import harnesses
from open_kritt_engine.harnesses import CodexHarness, HarnessError, harness_failure_retry_count

SCHEMA = {
    "type": "object",
    "properties": {"ok": {"type": "boolean"}},
    "required": ["ok"],
}


def run_with_blocked_responses(monkeypatch, tmp_path, blocked_responses):
    calls = []

    def fake_run_process(command, prompt, cwd, timeout, env=None):
        calls.append((command, prompt))
        if len(calls) <= blocked_responses:
            stdout = "\n".join(
                [
                    json.dumps({"type": "thread.started", "thread_id": "synthetic-thread"}),
                    json.dumps({"type": "error", "message": "flagged for possible cybersecurity risk"}),
                ]
            )
            return SimpleNamespace(stdout=stdout, stderr="", returncode=1)
        Path(command[command.index("-o") + 1]).write_text(json.dumps({"ok": True}), encoding="utf-8")
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)
    monkeypatch.setattr(harnesses, "_scan_docker_command", lambda command, *args, **kwargs: command)
    monkeypatch.setattr(harnesses, "_extract_json_from_codex_session_files", lambda *args: None)
    harness = CodexHarness(timeout_seconds=5, model_provider="codex")

    def run():
        return harness.run(
            prompt="Return a synthetic JSON result.",
            schema=SCHEMA,
            repo_dir=str(tmp_path),
            model="synthetic-model",
            env={"HOME": str(tmp_path), "OPEN_KRITT_CODEX_CYBER_ACCESS_PROGRAM": "daybreak_blue"},
        )

    return run, calls


@pytest.mark.parametrize("blocked_responses", [1, 4])
def test_cyber_continuation_succeeds_in_same_thread(monkeypatch, tmp_path, blocked_responses):
    run, calls = run_with_blocked_responses(monkeypatch, tmp_path, blocked_responses)
    result = run()
    assert result.payload["ok"] is True
    assert len(calls) == blocked_responses + 1
    for command, prompt in calls[1:]:
        assert command[-2:] == ["synthetic-thread", "-"]
        assert prompt == "please continue"
    for command, _ in calls:
        assert command[command.index("--cyber-access-program") + 1] == "daybreak_blue"


def test_cyber_continuation_fails_only_after_five_blocks(monkeypatch, tmp_path):
    run, calls = run_with_blocked_responses(monkeypatch, tmp_path, 5)
    with pytest.raises(HarnessError) as raised:
        run()
    assert len(calls) == 5
    assert raised.value.code == "cyber_safety_blocked"
    assert raised.value.cyber_blocks_exhausted
    assert harness_failure_retry_count(raised.value, retry_count=2, cyber_safety_retry_count=10) == 0
    for command, prompt in calls[1:]:
        assert command[-2:] == ["synthetic-thread", "-"]
        assert prompt == "please continue"

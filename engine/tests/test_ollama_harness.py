import json
import os

import pytest

from open_kritt_engine.harnesses import HarnessError, OllamaHarness, harness_for


def test_ollama_harness_parses_text_tool_calls_and_returns_final_payload(tmp_path, monkeypatch):
    (tmp_path / "go.mod").write_text("module github.com/example/repo\n\ngo 1.24\n", encoding="utf-8")
    replies = iter(
        [
            {"message": {"content": '<tool_call>{"name":"read_file","arguments":{"path":"go.mod","line_count":1}}</tool_call>'}},
            {
                "message": {
                    "content": json.dumps(
                        {
                            "summary": "module inspected",
                            "module": "github.com/example/repo",
                        }
                    )
                },
                "prompt_eval_count": 10,
                "eval_count": 4,
            },
        ]
    )
    observed = []
    harness = OllamaHarness(timeout_seconds=5, model_provider="ollama")

    def fake_chat(_base_url, payload, _timeout_seconds=None):
        observed.append(payload)
        return next(replies)

    monkeypatch.setattr(harness, "_chat", fake_chat)
    result = harness.run(
        prompt="Inspect the module.",
        schema={
            "type": "object",
            "properties": {"summary": {"type": "string"}, "module": {"type": "string"}},
            "required": ["summary", "module"],
        },
        repo_dir=str(tmp_path),
        model="qwen2.5-coder:7b-instruct",
    )

    assert result.payload == {"summary": "module inspected", "module": "github.com/example/repo"}
    assert result.usage["local"] is True
    assert "github.com/example/repo" in observed[1]["messages"][-1]["content"]


STUB_SCHEMA = {
    "type": "object",
    "properties": {
        "stub": {"type": "boolean"},
        "stub_explanation": {"type": "string"},
        "results": {"type": "array"},
    },
    "required": ["stub", "stub_explanation", "results"],
}
STUB_REPLY = {"message": {"content": json.dumps({"stub": True, "stub_explanation": "none", "results": []})}}


def test_ollama_harness_requires_repository_actions_before_accepting_stub(tmp_path, monkeypatch):
    (tmp_path / "Vault.sol").write_text("contract Vault {}\n", encoding="utf-8")
    replies = iter(
        [
            STUB_REPLY,
            {"message": {"content": '{"name":"list_files","arguments":{"path":"."}}'}},
            STUB_REPLY,
            {"message": {"content": '{"name":"read_file","arguments":{"path":"Vault.sol"}}'}},
            STUB_REPLY,
        ]
    )
    observed = []
    harness = OllamaHarness(timeout_seconds=5)

    def fake_chat(_base_url, payload, _timeout_seconds=None):
        observed.append(payload["messages"][-1]["content"])
        return next(replies)

    monkeypatch.setattr(harness, "_chat", fake_chat)
    result = harness.run(prompt="Map entrypoints.", schema=STUB_SCHEMA, repo_dir=str(tmp_path), model="qwen")

    assert result.payload["stub"] is True
    assert len(observed) == 5
    assert "without inspecting the repository" in observed[1]
    assert "without inspecting the repository" in observed[3]
    assert "Tool result for read_file" in observed[4]


def test_ollama_harness_accepts_immediate_stub_when_tools_are_disabled(tmp_path, monkeypatch):
    harness = OllamaHarness(timeout_seconds=5)
    monkeypatch.setattr(harness, "_chat", lambda *_args, **_kwargs: STUB_REPLY)
    result = harness.run(
        prompt="Summarize.", schema=STUB_SCHEMA, repo_dir=str(tmp_path), model="qwen", allow_tools=False
    )
    assert result.payload["stub"] is True


def test_ollama_harness_rejects_paths_outside_repository(tmp_path):
    harness = OllamaHarness(timeout_seconds=5)
    with pytest.raises(HarnessError, match="outside the repository"):
        harness._tool(str(tmp_path), "read_file", {"path": "../secret"})


def test_ollama_harness_uses_explicit_environment_without_ambient_fallback(tmp_path, monkeypatch):
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://ambient.invalid")
    harness = OllamaHarness(timeout_seconds=5)
    observed = []

    def fake_chat(base_url, _payload, _timeout_seconds=None):
        observed.append(base_url)
        return {"message": {"content": '{"summary":"done"}'}}

    monkeypatch.setattr(harness, "_chat", fake_chat)
    result = harness.run(
        prompt="Return the result.",
        schema={"type": "object", "properties": {"summary": {"type": "string"}}},
        repo_dir=str(tmp_path),
        model="qwen2.5-coder:7b-instruct",
        env={},
        allow_tools=False,
    )

    assert result.payload == {"summary": "done"}
    assert observed == ["http://host.docker.internal:11435"]


def test_ollama_search_falls_back_when_ripgrep_is_unavailable(tmp_path, monkeypatch):
    (tmp_path / "contract.sol").write_text("contract Safe {}\ncontract Target {}\n", encoding="utf-8")
    harness = OllamaHarness(timeout_seconds=5)
    monkeypatch.setattr("open_kritt_engine.harnesses.shutil.which", lambda _name: None)

    result = harness._tool(str(tmp_path), "search_text", {"pattern": "Target", "path": "."})

    assert result == "contract.sol:2:contract Target {}"


def test_ollama_harness_repairs_schema_invalid_final_output(tmp_path, monkeypatch):
    replies = iter(
        [
            {"message": {"content": '{"results":[{"summary":"missing path"}]}' }},
            {"message": {"content": '{"results":[{"summary":"fixed","lane_file_path":"contract.sol"}]}' }},
        ]
    )
    observed = []
    harness = OllamaHarness(timeout_seconds=5)

    def fake_chat(_base_url, payload, _timeout_seconds=None):
        observed.append(payload)
        return next(replies)

    monkeypatch.setattr(harness, "_chat", fake_chat)
    result = harness.run(
        prompt="Return the result.",
        schema={
            "type": "object",
            "properties": {
                "results": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "summary": {"type": "string"},
                            "lane_file_path": {"type": "string"},
                        },
                        "required": ["summary", "lane_file_path"],
                    },
                }
            },
            "required": ["results"],
        },
        repo_dir=str(tmp_path),
        model="gemma4:e4b-it-qat",
        allow_tools=False,
    )

    assert result.payload["results"][0]["lane_file_path"] == "contract.sol"
    assert "lane_file_path" in observed[1]["messages"][-1]["content"]


def test_ollama_harness_repairs_missing_final_container_delimiter(tmp_path, monkeypatch):
    harness = OllamaHarness(timeout_seconds=5)
    monkeypatch.setattr(
        harness,
        "_chat",
        lambda *_args, **_kwargs: {
            "message": {
                "content": '{"results":[{"summary":"complete model answer"}]}'[:-1],
            }
        },
    )

    result = harness.run(
        prompt="Return the result.",
        schema={
            "type": "object",
            "properties": {
                "results": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {"summary": {"type": "string"}},
                        "required": ["summary"],
                    },
                }
            },
            "required": ["results"],
        },
        repo_dir=str(tmp_path),
        model="gemma4:e4b-it-qat",
        allow_tools=False,
    )

    assert result.payload == {"results": [{"summary": "complete model answer"}]}


def test_ollama_harness_does_not_repair_mismatched_json_delimiters():
    assert OllamaHarness._repair_truncated_json('{"results":]}') is None


def test_ollama_harness_repairs_missing_object_delimiter_before_final_array_close():
    repaired = OllamaHarness._repair_truncated_json('{"results":[{"summary":"complete"}]}'.replace("}]}", "]}"))

    assert json.loads(repaired) == {"results": [{"summary": "complete"}]}


def test_harness_factory_supports_ollama():
    harness = harness_for("ollama", timeout_seconds=5, model_provider="ollama")
    assert isinstance(harness, OllamaHarness)


@pytest.mark.skipif(os.getenv("OLLAMA_INTEGRATION") != "1", reason="requires the isolated local Ollama server")
def test_ollama_harness_live_repository_round_trip(tmp_path):
    (tmp_path / "go.mod").write_text("module github.com/example/live-bridge\n\ngo 1.24\n", encoding="utf-8")
    harness = OllamaHarness(timeout_seconds=180, model_provider="ollama")
    result = harness.run(
        prompt=(
            "Read go.mod with the provided tool. Then return only a JSON object with "
            'summary set to "module inspected" and module set to the module path you observed.'
        ),
        schema={
            "type": "object",
            "properties": {"summary": {"type": "string"}, "module": {"type": "string"}},
            "required": ["summary", "module"],
            "additionalProperties": False,
        },
        repo_dir=str(tmp_path),
        model=os.getenv("OLLAMA_INTEGRATION_MODEL", "qwen2.5-coder:7b-instruct"),
        env={"OLLAMA_BASE_URL": os.getenv("OLLAMA_BASE_URL", "http://host.docker.internal:11435")},
    )

    assert result.payload == {"summary": "module inspected", "module": "github.com/example/live-bridge"}
    assert result.usage["local"] is True


FINAL_SCHEMA = {
    "type": "object",
    "properties": {"summary": {"type": "string"}},
    "required": ["summary"],
}
FINAL_REPLY = {"message": {"content": json.dumps({"summary": "done"})}}


def _solidity_repo(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "Vault.sol").write_text(
        "contract Vault {\n    function deposit(uint256 a) external {}\n}\n", encoding="utf-8"
    )
    (tmp_path / "lib" / "dep").mkdir(parents=True)
    (tmp_path / "lib" / "dep" / "Dep.sol").write_text("contract Dep {}\n", encoding="utf-8")
    return tmp_path


def _scripted(harness, monkeypatch, replies):
    seen = []
    iterator = iter(replies)

    def fake_chat(_base_url, payload, _timeout_seconds=None):
        seen.append(
            {
                "messages": [dict(message) for message in payload["messages"]],
                "options": dict(payload["options"]),
            }
        )
        return next(iterator)

    monkeypatch.setattr(harness, "_chat", fake_chat)
    return seen


def test_ollama_prompt_lists_source_files_and_language_entrypoint_hint(tmp_path, monkeypatch):
    repo = _solidity_repo(tmp_path)
    harness = OllamaHarness(timeout_seconds=5)
    seen = _scripted(harness, monkeypatch, [FINAL_REPLY])
    harness.run(prompt="Map entrypoints.", schema=FINAL_SCHEMA, repo_dir=str(repo), model="qwen")

    system = seen[0]["messages"][0]["content"]
    assert "src/Vault.sol" in system
    assert "lib/dep/Dep.sol" not in system
    assert "Solidity" in system
    assert "external|public" in system


def test_ollama_nudges_model_to_read_files_after_repeated_empty_searches(tmp_path, monkeypatch):
    repo = _solidity_repo(tmp_path)
    harness = OllamaHarness(timeout_seconds=5)
    searches = [
        {"message": {"content": json.dumps({"name": "search_text", "arguments": {"pattern": f"external HTTP {i}"}})}}
        for i in range(3)
    ]
    seen = _scripted(harness, monkeypatch, [*searches, FINAL_REPLY])
    harness.run(prompt="Map entrypoints.", schema=FINAL_SCHEMA, repo_dir=str(repo), model="qwen")

    last = seen[3]["messages"][-1]["content"]
    assert "no matches" in last
    assert "read_file" in last
    assert "src/Vault.sol" in last


def test_ollama_does_not_repeat_an_identical_tool_action(tmp_path, monkeypatch):
    repo = _solidity_repo(tmp_path)
    harness = OllamaHarness(timeout_seconds=5)
    action = {"message": {"content": json.dumps({"name": "list_files", "arguments": {"path": "src"}})}}
    seen = _scripted(harness, monkeypatch, [action, action, FINAL_REPLY])
    harness.run(prompt="Map entrypoints.", schema=FINAL_SCHEMA, repo_dir=str(repo), model="qwen")

    assert "already ran" in seen[2]["messages"][-1]["content"]


def test_ollama_retry_of_same_prompt_raises_temperature(tmp_path, monkeypatch):
    repo = _solidity_repo(tmp_path)
    harness = OllamaHarness(timeout_seconds=5)
    seen = _scripted(harness, monkeypatch, [FINAL_REPLY, FINAL_REPLY])
    prompt = f"Map entrypoints for {tmp_path}."
    harness.run(prompt=prompt, schema=FINAL_SCHEMA, repo_dir=str(repo), model="qwen")
    OllamaHarness(timeout_seconds=5)  # a fresh instance must still see the prior attempt
    harness.run(prompt=prompt, schema=FINAL_SCHEMA, repo_dir=str(repo), model="qwen")

    assert seen[0]["options"]["temperature"] == 0
    assert seen[1]["options"]["temperature"] > 0


def test_ollama_elides_old_tool_output_but_keeps_the_task(tmp_path, monkeypatch):
    repo = _solidity_repo(tmp_path)
    (repo / "src" / "Big.sol").write_text("\n".join(f"// line {i} " + "x" * 80 for i in range(400)), encoding="utf-8")
    harness = OllamaHarness(timeout_seconds=5)
    harness.context_char_budget = 30_000
    reads = [
        {
            "message": {
                "content": json.dumps(
                    {"name": "read_file", "arguments": {"path": "src/Big.sol", "start_line": 1 + 100 * i, "line_count": 100}}
                )
            }
        }
        for i in range(4)
    ]
    seen = _scripted(harness, monkeypatch, [*reads, FINAL_REPLY])
    harness.run(prompt="UNIQUE-TASK-MARKER", schema=FINAL_SCHEMA, repo_dir=str(repo), model="qwen")

    final_messages = seen[-1]["messages"]
    assert sum(len(message["content"]) for message in final_messages) <= 30_000
    assert final_messages[1]["content"] == "UNIQUE-TASK-MARKER"
    assert any("elided" in message["content"] for message in final_messages)
    assert "line 399" in final_messages[-1]["content"]


ROWS_SCHEMA = {
    "type": "object",
    "properties": {
        "stub": {"type": "boolean"},
        "stub_explanation": {"type": "string"},
        "results": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"handler": {"type": "string"}, "line": {"type": "number"}},
                "required": ["handler", "line"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["stub", "stub_explanation", "results"],
    "additionalProperties": False,
}


def _record(*rows):
    return {"message": {"content": json.dumps({"name": "record_results", "arguments": {"results": list(rows)}})}}


def _read_vault():
    return {"message": {"content": json.dumps({"name": "read_file", "arguments": {"path": "src/Vault.sol"}})}}


def test_ollama_merges_recorded_rows_into_the_final_result(tmp_path, monkeypatch):
    repo = _solidity_repo(tmp_path)
    harness = OllamaHarness(timeout_seconds=5)
    _scripted(
        harness,
        monkeypatch,
        [
            _read_vault(),
            _record({"handler": "Vault.deposit", "line": 2}),
            {"message": {"content": json.dumps({"stub": False, "stub_explanation": "", "results": [{"handler": "Vault.withdraw", "line": 3}]})}},
        ],
    )
    result = harness.run(prompt="Map entrypoints.", schema=ROWS_SCHEMA, repo_dir=str(repo), model="qwen")

    assert result.payload["stub"] is False
    assert result.payload["results"] == [{"handler": "Vault.deposit", "line": 2}, {"handler": "Vault.withdraw", "line": 3}]


def test_ollama_rejects_recorded_rows_that_violate_the_item_schema(tmp_path, monkeypatch):
    repo = _solidity_repo(tmp_path)
    harness = OllamaHarness(timeout_seconds=5)
    seen = _scripted(
        harness,
        monkeypatch,
        [_record({"handler": "Vault.deposit"}), _read_vault(), _read_vault(), STUB_REPLY],
    )
    result = harness.run(prompt="Map entrypoints.", schema=ROWS_SCHEMA, repo_dir=str(repo), model="qwen")

    assert "rejected" in seen[1]["messages"][-1]["content"]
    assert result.payload["results"] == []


def test_ollama_returns_recorded_rows_when_the_turn_budget_runs_out(tmp_path, monkeypatch):
    repo = _solidity_repo(tmp_path)
    harness = OllamaHarness(timeout_seconds=5)
    harness.max_turns = 4
    replies = [
        _record({"handler": "Vault.deposit", "line": 2}),
        *[
            {"message": {"content": json.dumps({"name": "search_text", "arguments": {"pattern": f"p{i}"}})}}
            for i in range(3)
        ],
    ]
    seen = _scripted(harness, monkeypatch, replies)
    result = harness.run(prompt="Map entrypoints.", schema=ROWS_SCHEMA, repo_dir=str(repo), model="qwen")

    assert result.payload == {"stub": False, "stub_explanation": "", "results": [{"handler": "Vault.deposit", "line": 2}]}
    assert "turns left" in seen[-1]["messages"][-1]["content"]

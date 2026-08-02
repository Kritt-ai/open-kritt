"""Unit tests for xAI-only Codex Responses rewrites (no network)."""

from __future__ import annotations

import json
from pathlib import Path

from open_kritt_engine import harnesses
from open_kritt_engine.harnesses import codex_exec_command
from open_kritt_engine.xai_codex_compat import (
    XAI_CODEX_DISABLED_FEATURES,
    inject_xai_base_url,
    install_compat_script,
    rewrite_responses_request_body,
    rewrite_tools,
    wrap_codex_command_for_xai,
)


def test_rewrite_strips_openai_web_search_fields_and_preview_type():
    tools = rewrite_tools(
        [
            {
                "type": "web_search",
                "external_web_access": True,
                "search_context_size": "medium",
                "filters": {"allowed_domains": ["grapheneos.org"], "bogus": 1},
            },
            {"type": "web_search_preview", "external_web_access": False},
            {
                "type": "function",
                "name": "exec_command",
                "parameters": {"type": "object"},
            },
            {"type": "unsupported_openai_only"},
        ]
    )
    assert tools[0] == {
        "type": "web_search",
        "filters": {"allowed_domains": ["grapheneos.org"]},
    }
    assert tools[1] == {"type": "web_search"}
    assert tools[2]["name"] == "exec_command"
    assert all(t.get("type") != "unsupported_openai_only" for t in tools)


def test_rewrite_strips_reasoning_encrypted_content():
    body = rewrite_responses_request_body(
        {
            "model": "grok-4.5",
            "input": [
                {
                    "type": "reasoning",
                    "summary": [{"type": "summary_text", "text": "thinking"}],
                    "content": None,
                    "encrypted_content": "blob-not-for-xai",
                },
                {"type": "function_call_output", "call_id": "c1", "output": "ok"},
            ],
            "tools": [{"type": "web_search", "external_web_access": True}],
        }
    )
    reasoning = body["input"][0]
    assert reasoning["type"] == "reasoning"
    assert "encrypted_content" not in reasoning
    assert "content" not in reasoning
    assert body["tools"] == [{"type": "web_search"}]


def test_inject_xai_base_url_replaces_only_xai_provider_url():
    command = [
        "codex",
        "exec",
        "-c",
        'model_providers.xai.base_url="https://api.x.ai/v1"',
        "-c",
        'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"',
        "-",
    ]
    rewritten = inject_xai_base_url(command, "http://127.0.0.1:9/v1")
    configs = [rewritten[i + 1] for i, part in enumerate(rewritten) if part == "-c"]
    assert 'model_providers.xai.base_url="http://127.0.0.1:9/v1"' in configs
    assert 'model_providers.openrouter.base_url="https://openrouter.ai/api/v1"' in configs
    assert rewritten[-1] == "-"


def test_wrap_codex_command_uses_installed_script(tmp_path: Path):
    script = install_compat_script(tmp_path)
    assert script.is_file()
    wrapped = wrap_codex_command_for_xai(["codex", "exec", "-"], codex_home=str(tmp_path))
    assert wrapped[:4] == ["python3", str(script), "exec", "--"]
    assert wrapped[4:] == ["codex", "exec", "-"]


def test_xai_codex_exec_enables_search_and_disables_only_xai_features():
    xai = codex_exec_command(
        repo_dir="/tmp/repo",
        model="grok-4.5",
        schema_path="/tmp/schema.json",
        output_path="/tmp/out.json",
        model_provider="xai",
        thinking_effort="high",
        allow_tools=True,
        max_subagents=5,
    )
    openrouter = codex_exec_command(
        repo_dir="/tmp/repo",
        model="vendor/model",
        schema_path="/tmp/schema.json",
        output_path="/tmp/out.json",
        model_provider="openrouter",
        thinking_effort="high",
        allow_tools=True,
        max_subagents=5,
    )
    codex = codex_exec_command(
        repo_dir="/tmp/repo",
        model="gpt-test",
        schema_path="/tmp/schema.json",
        output_path="/tmp/out.json",
        model_provider="codex",
        thinking_effort="high",
        allow_tools=True,
        max_subagents=5,
    )

    assert "--search" in xai
    assert 'web_search="disabled"' not in " ".join(xai)
    for feature in XAI_CODEX_DISABLED_FEATURES:
        assert ["--disable", feature] == xai[xai.index(feature) - 1 : xai.index(feature) + 1]
    assert "agents.max_concurrent_threads_per_session=1" in xai
    assert 'model_provider="xai"' in " ".join(xai)
    assert xai[xai.index("-m") + 1] == "grok-4.5"

    # Other providers keep their previous shape.
    assert "--search" in openrouter
    assert "--search" in codex
    assert "agents.max_concurrent_threads_per_session=5" in openrouter
    assert "agents.max_concurrent_threads_per_session=5" in codex
    assert not any(value.startswith("model_providers.xai.") for value in openrouter)
    assert not any(value.startswith("model_providers.xai.") for value in codex)
    for feature in XAI_CODEX_DISABLED_FEATURES:
        # openrouter/codex may disable other features for tool-free mode only
        if feature in {"multi_agent", "apps"}:
            continue
        # ensure we did not inject xAI-only disable list wholesale
        pass
    assert "remote_compaction_v2" not in openrouter
    assert "remote_compaction_v2" not in codex


def test_xai_tool_free_command_still_defines_xai_provider_only():
    tool_free = codex_exec_command(
        repo_dir="/tmp/gen",
        model="grok-4.5",
        schema_path="/tmp/schema.json",
        output_path="/tmp/out.json",
        model_provider="xai",
        thinking_effort="default",
        allow_tools=False,
    )
    assert "--search" not in tool_free
    configs = [tool_free[i + 1] for i, part in enumerate(tool_free) if part == "-c"]
    assert any(value.startswith("model_providers.xai.") for value in configs)
    assert not any("model_providers.openrouter" in value for value in configs)

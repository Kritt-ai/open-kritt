"""Runtime settings written by the backend must decode the same way in Python."""

from open_kritt_engine.runtime_config import parse_env_text


def test_backend_encoded_apostrophe_round_trips():
    text = "ENGINE_CLAUDE_HOME='/local/O\\'Brien/.claude'\n"

    assert parse_env_text(text)["ENGINE_CLAUDE_HOME"] == "/local/O'Brien/.claude"


def test_last_duplicate_value_remains_authoritative():
    text = "ENGINE_CODEX_HOME=/root/.codex\nENGINE_CODEX_HOME=\n"

    assert parse_env_text(text)["ENGINE_CODEX_HOME"] == ""

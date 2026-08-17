import sys
import types

sys.modules.setdefault("fcntl", types.SimpleNamespace(flock=lambda *_args, **_kwargs: None, LOCK_EX=2, LOCK_UN=8))

from open_kritt_engine.llm.migration import ProviderExecutionMode, runtime_migration_flags
from open_kritt_engine.workspace import provider_home_for_job


def test_codex_provider_home_honors_selected_local_account(tmp_path):
    data_dir = tmp_path / "data"
    account_root = tmp_path / "codex-accounts"
    selected = account_root / "reviewer" / ".codex"
    other = account_root / "other" / ".codex"
    selected.mkdir(parents=True)
    other.mkdir(parents=True)
    (selected / "auth.json").write_text("{}", encoding="utf-8")
    (other / "auth.json").write_text("{}", encoding="utf-8")
    (data_dir / "engine-runtime.env").parent.mkdir(parents=True)
    (data_dir / "engine-runtime.env").write_text(
        f"ENGINE_CODEX_HOME={selected},{other}\n",
        encoding="utf-8",
    )

    assert (
        provider_home_for_job("codex", 1, data_dir=str(data_dir), preferred_account_id="other")
        == str(other)
    )


def test_claude_provider_home_honors_default_local_account(tmp_path):
    data_dir = tmp_path / "data"
    home = tmp_path / ".claude"
    home.mkdir()
    (data_dir / "engine-runtime.env").parent.mkdir(parents=True)
    (data_dir / "engine-runtime.env").write_text(f"ENGINE_CLAUDE_HOME={home}\n", encoding="utf-8")

    assert (
        provider_home_for_job("claude", 1, data_dir=str(data_dir), preferred_account_id="default")
        == str(home)
    )


def test_cli_runtime_migration_defaults_to_legacy_until_explicitly_enabled():
    assert runtime_migration_flags("codex", {}).execution_mode == ProviderExecutionMode.LEGACY
    assert runtime_migration_flags("claude-code", {}).execution_mode == ProviderExecutionMode.LEGACY

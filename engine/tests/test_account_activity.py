import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from open_kritt_engine import workspace
from open_kritt_engine.account_activity import (
    API_ACCOUNT_KEYS,
    AccountInactiveError,
    assert_account_assignment,
    read_account_activity,
)
from open_kritt_engine.provider_credentials import job_environment


@pytest.fixture
def activity(tmp_path, monkeypatch):
    monkeypatch.setenv("OPEN_KRITT_PROVIDER_CREDENTIALS_PATH", str(tmp_path / "providers.json"))
    for keys in API_ACCOUNT_KEYS.values():
        for key in keys:
            monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(workspace, "_provider_account_health", lambda provider: {})
    path = tmp_path / "account-activity.json"

    def save(provider, entries):
        temporary = tmp_path / "next.json"
        temporary.write_text(
            json.dumps(
                {
                    "version": 1,
                    "accounts": [
                        {"provider": provider, "path": home, "active": active} for home, active in entries.items()
                    ],
                }
            )
        )
        temporary.replace(path)

    return save


@pytest.mark.parametrize("provider", ["codex", "claude", "xai"])
def test_default_mixed_all_inactive_and_reactivated_pools(provider, activity, monkeypatch):
    homes = ["/sample/one", "/sample/two"]
    monkeypatch.setattr(workspace, "_configured_provider_homes", lambda *args, **kwargs: homes)
    assert workspace.provider_home_for_job(provider, 1) in homes
    activity(provider, {homes[0]: False})
    for _ in range(4):
        assert workspace.provider_home_for_job(provider, 1) == homes[1]
    workspace.mark_provider_account_rate_limited(provider, homes[1])
    assert workspace.provider_home_for_job(provider, 1) == homes[1]
    activity(provider, dict.fromkeys(homes, False))
    with pytest.raises(AccountInactiveError, match="No active accounts"):
        workspace.provider_home_for_job(provider, 1)
    activity(provider, {homes[0]: True, homes[1]: False})
    assert workspace.provider_home_for_job(provider, 1) == homes[0]


@pytest.mark.parametrize("provider,keys", API_ACCOUNT_KEYS.items())
def test_disabled_keys_do_not_reach_jobs_or_retries(provider, keys, activity, tmp_path):
    source = {"OPEN_KRITT_PROVIDER_CREDENTIALS_PATH": str(tmp_path / "providers.json")}
    source.update(dict.fromkeys(keys, "synthetic-key"))
    before = job_environment(provider, "codex", source)
    assert before[keys[0]] == "synthetic-key"
    activity(provider, {keys[0]: False})
    after = job_environment(provider, "codex", source)
    assert not set(keys) & after.keys()
    with pytest.raises(AccountInactiveError, match="inactive"):
        assert_account_assignment(provider, env=before)
    with pytest.raises(AccountInactiveError, match="inactive"):
        assert_account_assignment(provider, env=after)
    activity(provider, {keys[0]: True})
    assert job_environment(provider, "codex", source)[keys[0]] == "synthetic-key"


@pytest.mark.parametrize("provider", ["codex", "claude", "xai"])
def test_active_key_can_replace_an_inactive_login(provider, activity, monkeypatch):
    monkeypatch.setattr(workspace, "_configured_provider_homes", lambda *args, **kwargs: ["/sample/one"])
    monkeypatch.setenv(API_ACCOUNT_KEYS[provider][0], "synthetic-key")
    activity(provider, {"/sample/one": False})
    assert workspace.provider_home_for_job(provider, 1) == ""


def test_admitted_call_finishes_but_waiting_assignment_observes_toggle(activity, monkeypatch):
    provider, home = "codex", "/sample/waiting"
    monkeypatch.setattr(workspace, "_provider_account_worker_limit", lambda data_dir: 1)
    waiting = threading.Event()
    with workspace.provider_account_lease(provider, home):
        gate = workspace._PROVIDER_ACCOUNT_GATES[(provider, home)]
        original_wait = gate.condition.wait

        def wait(*args, **kwargs):
            waiting.set()
            return original_wait(*args, **kwargs)

        monkeypatch.setattr(gate.condition, "wait", wait)

        def allocate():
            with workspace.provider_account_lease(provider, home):
                return "unexpected assignment"

        pool = ThreadPoolExecutor(max_workers=1)
        pending = pool.submit(allocate)
        assert waiting.wait(5)
        activity(provider, {home: False})
        assert gate.active == 1
    with pytest.raises(AccountInactiveError, match="inactive"):
        pending.result(timeout=5)
    pool.shutdown()
    assert gate.active == 0


def test_corrupt_preferences_fail_closed(activity, tmp_path):
    (tmp_path / "account-activity.json").write_text("{invalid")
    with pytest.raises(AccountInactiveError, match="preferences could not be read"):
        read_account_activity()


@pytest.mark.parametrize(
    "provider,harness",
    [("codex", "codex"), ("claude", "claude-code"), ("xai", "grok-build"), ("deepseek", "codex")],
)
def test_key_only_workspace_never_copies_an_inactive_login(provider, harness, activity, monkeypatch, tmp_path):
    monkeypatch.setattr(workspace, "_configured_provider_homes", lambda *args, **kwargs: ["/sample/disabled"])
    monkeypatch.setenv(API_ACCOUNT_KEYS[provider][0], "synthetic-key")
    activity(provider, {"/sample/disabled": False})
    copied = []
    monkeypatch.setattr(workspace, "_copy_credential_files", lambda *args: copied.append(args))
    monkeypatch.setattr(workspace, "prepare_claude_job_credentials", lambda *args, **kwargs: copied.append(args))
    monkeypatch.setattr(workspace, "_secure_job_tree", lambda *args: None)
    prepared = workspace.prepare_job_workspace(str(tmp_path), 7, harness_name=harness, model_provider=provider)
    assert copied == []
    assert prepared.provider_account_home is None
    assert prepared.provider_account_provider == provider
    assert prepared.env[API_ACCOUNT_KEYS[provider][0]] == "synthetic-key"
    assert "OPEN_KRITT_PROVIDER_CREDENTIALS_PATH" not in prepared.env


def test_inactive_key_does_not_block_an_active_login(activity, tmp_path):
    home = tmp_path / "sample-login"
    home.mkdir()
    (home / "auth.json").write_text("{}")
    activity("codex", {"CODEX_API_KEY": False})
    assert_account_assignment("codex", str(home), {})

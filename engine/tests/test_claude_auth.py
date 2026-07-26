import json
import stat
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from open_kritt_engine.claude_auth import (
    ClaudeCredentialError,
    ClaudeCredentialRateLimited,
    claude_oauth_timeout_seconds,
    prepare_claude_job_credentials,
)


def _write_credential(home: Path, *, access_token: str, expires_at_ms: int) -> Path:
    home.mkdir(parents=True, exist_ok=True)
    path = home / ".credentials.json"
    path.write_text(
        json.dumps(
            {
                "claudeAiOauth": {
                    "accessToken": access_token,
                    "refreshToken": "refresh-token",
                    "expiresAt": expires_at_ms,
                }
            }
        ),
        encoding="utf-8",
    )
    path.chmod(0o600)
    return path


def test_missing_claude_credential_returns_without_leaving_lock(tmp_path):
    source = tmp_path / "source"

    assert not prepare_claude_job_credentials(
        source,
        tmp_path / "job",
        harness_timeout_seconds=3600,
        run_process=lambda *_args, **_kwargs: pytest.fail("CLI must not run"),
    )
    assert not (source / ".open-kritt-auth.lock").exists()


def test_fresh_claude_credential_is_snapshotted_without_network(tmp_path):
    now = 1_800_000_000.0
    source = tmp_path / "source"
    target = tmp_path / "job"
    source_path = _write_credential(source, access_token="fresh", expires_at_ms=int((now + 10_000) * 1000))

    def unexpected_run(*_args, **_kwargs):
        raise AssertionError("fresh credentials must not launch Claude")

    assert prepare_claude_job_credentials(
        source,
        target,
        harness_timeout_seconds=3600,
        now=lambda: now,
        run_process=unexpected_run,
    )

    snapshot = target / ".credentials.json"
    assert snapshot.read_bytes() == source_path.read_bytes()
    assert stat.S_IMODE(snapshot.stat().st_mode) == 0o600


def test_two_hour_claude_credential_does_not_refresh_for_one_hour_window(tmp_path):
    now = 1_800_000_000.0
    source = tmp_path / "source"
    target = tmp_path / "job"
    _write_credential(source, access_token="fresh", expires_at_ms=int((now + 2 * 60 * 60) * 1000))

    def unexpected_run(*_args, **_kwargs):
        raise AssertionError("credentials outside the one-hour refresh window must not launch Claude")

    assert prepare_claude_job_credentials(
        source,
        target,
        harness_timeout_seconds=4 * 60 * 60,
        now=lambda: now,
        run_process=unexpected_run,
    )


def test_claude_job_timeout_stays_inside_snapshotted_token_lifetime():
    now = 1_800_000_000.0
    expires_at_ms = int((now + 3 * 60 * 60) * 1000)

    assert claude_oauth_timeout_seconds(expires_at_ms, 24 * 60 * 60, now=lambda: now) == 2 * 60 * 60 + 45 * 60
    assert claude_oauth_timeout_seconds(expires_at_ms, 60 * 60, now=lambda: now) == 60 * 60
    assert claude_oauth_timeout_seconds(None, 60 * 60, now=lambda: now) == 60 * 60


def test_expiring_claude_credential_refreshes_then_snapshots(monkeypatch, tmp_path):
    now = 1_800_000_000.0
    source = tmp_path / "source"
    target = tmp_path / "job"
    source_path = _write_credential(source, access_token="old", expires_at_ms=int((now + 60) * 1000))
    calls = []
    monkeypatch.setenv("CLAUDE_CODE_MODEL_PROVIDER", "openrouter")
    monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "1")

    def refresh(command, **options):
        calls.append((command, options))
        _write_credential(source, access_token="new", expires_at_ms=int((now + 10_000) * 1000))
        return SimpleNamespace(returncode=0, stdout="discarded", stderr="discarded")

    assert prepare_claude_job_credentials(
        source,
        target,
        harness_timeout_seconds=3600,
        now=lambda: now,
        run_process=refresh,
    )

    assert len(calls) == 1
    command, options = calls[0]
    assert command[0] == "claude"
    assert "--safe-mode" in command
    assert "--bare" not in command
    assert command[command.index("--mcp-config") + 1] == '{"mcpServers":{}}'
    assert options["env"]["CLAUDE_HOME"] == str(source)
    assert options["env"]["CLAUDE_CONFIG_DIR"] == str(source)
    assert "CLAUDE_CODE_MODEL_PROVIDER" not in options["env"]
    assert "CLAUDE_CODE_USE_BEDROCK" not in options["env"]
    assert "old" not in " ".join(command)
    assert "refresh-token" not in " ".join(command)
    assert json.loads(source_path.read_text(encoding="utf-8"))["claudeAiOauth"]["accessToken"] == "new"
    assert (
        json.loads((target / ".credentials.json").read_text(encoding="utf-8"))["claudeAiOauth"]["accessToken"] == "new"
    )
    assert stat.S_IMODE(source_path.stat().st_mode) == 0o600
    assert stat.S_IMODE((target / ".credentials.json").stat().st_mode) == 0o600


def test_concurrent_jobs_share_one_claude_refresh(tmp_path):
    now = 1_800_000_000.0
    source = tmp_path / "source"
    _write_credential(source, access_token="old", expires_at_ms=int((now + 60) * 1000))
    entered = threading.Event()
    release = threading.Event()
    calls = []
    errors = []

    def refresh(_command, **_options):
        calls.append(1)
        entered.set()
        assert release.wait(timeout=2)
        _write_credential(source, access_token="new", expires_at_ms=int((now + 10_000) * 1000))
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    def prepare(target):
        try:
            prepare_claude_job_credentials(
                source,
                target,
                harness_timeout_seconds=3600,
                now=lambda: now,
                run_process=refresh,
            )
        except Exception as exc:  # pragma: no cover - surfaced by the assertion below
            errors.append(exc)

    first = threading.Thread(target=prepare, args=(tmp_path / "job-1",))
    second = threading.Thread(target=prepare, args=(tmp_path / "job-2",))
    first.start()
    assert entered.wait(timeout=2)
    second.start()
    release.set()
    first.join(timeout=2)
    second.join(timeout=2)

    assert not first.is_alive() and not second.is_alive()
    assert errors == []
    assert len(calls) == 1
    for name in ("job-1", "job-2"):
        payload = json.loads((tmp_path / name / ".credentials.json").read_text(encoding="utf-8"))
        assert payload["claudeAiOauth"]["accessToken"] == "new"


def test_failed_refresh_restores_canonical_credential_and_publishes_no_snapshot(tmp_path):
    now = 1_800_000_000.0
    source = tmp_path / "source"
    target = tmp_path / "job"
    source_path = _write_credential(source, access_token="old", expires_at_ms=int((now + 60) * 1000))
    legacy_path = source / "credentials.json"
    source_path.rename(legacy_path)
    source_path = legacy_path
    original = source_path.read_bytes()

    def failed_refresh(_command, **_options):
        (source / ".credentials.json").write_text("not-json", encoding="utf-8")
        return SimpleNamespace(returncode=1, stdout="secret output", stderr="secret error")

    with pytest.raises(ClaudeCredentialError, match="Reconnect Claude in Accounts"):
        prepare_claude_job_credentials(
            source,
            target,
            harness_timeout_seconds=3600,
            now=lambda: now,
            run_process=failed_refresh,
        )

    assert source_path.read_bytes() == original
    assert stat.S_IMODE(source_path.stat().st_mode) == 0o600
    assert not (source / ".credentials.json").exists()
    assert not (target / ".credentials.json").exists()


def test_rate_limited_refresh_is_retryable_without_exposing_provider_output(tmp_path):
    now = 1_800_000_000.0
    source = tmp_path / "source"
    target = tmp_path / "job"
    source_path = _write_credential(source, access_token="old", expires_at_ms=int((now + 60) * 1000))
    original = source_path.read_bytes()

    def rate_limited_refresh(_command, **_options):
        source_path.write_text("partial-secret-value", encoding="utf-8")
        return SimpleNamespace(
            returncode=1,
            stdout=(
                '{"type":"result","subtype":"success","is_error":true,'
                '"result":"You\'ve hit your session limit · resets 10pm (UTC)","retry_after":125}'
            ),
            stderr="provider-secret-value",
        )

    with pytest.raises(ClaudeCredentialRateLimited) as exc_info:
        prepare_claude_job_credentials(
            source,
            target,
            harness_timeout_seconds=3600,
            now=lambda: now,
            run_process=rate_limited_refresh,
        )

    assert exc_info.value.limit_kind == "account_quota_limited"
    assert exc_info.value.retry_after_seconds == 125
    assert exc_info.value.account_home == str(source)
    assert "provider-secret-value" not in str(exc_info.value)
    assert source_path.read_bytes() == original
    assert not (target / ".credentials.json").exists()


def test_claude_credential_symlink_is_rejected_without_launching_cli(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    outside = _write_credential(tmp_path / "outside", access_token="outside", expires_at_ms=9_999_999_999_999)
    (source / ".credentials.json").symlink_to(outside)

    with pytest.raises(ClaudeCredentialError, match="symbolic link"):
        prepare_claude_job_credentials(
            source,
            tmp_path / "job",
            harness_timeout_seconds=3600,
            run_process=lambda *_args, **_kwargs: pytest.fail("CLI must not run"),
        )

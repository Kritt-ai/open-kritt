"""Refresh trusted Claude OAuth credentials before creating disposable job homes."""

from __future__ import annotations

import errno
import json
import os
import re
import stat
import subprocess
import tempfile
import threading
import time
from collections.abc import Callable
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

CLAUDE_CREDENTIAL_FILENAMES = (".credentials.json", "credentials.json")
CLAUDE_AUTH_LOCK_NAME = ".open-kritt-auth.lock"
CLAUDE_OAUTH_EXPIRY_ENV = "OPEN_KRITT_CLAUDE_OAUTH_EXPIRES_AT_MS"
DEFAULT_REFRESH_MARGIN_SECONDS = 15 * 60
DEFAULT_REFRESH_WINDOW_SECONDS = 60 * 60
DEFAULT_REFRESH_TIMEOUT_SECONDS = 120
LOCK_WAIT_SECONDS = 30
STALE_LOCK_SECONDS = 30 * 60
MAX_CREDENTIAL_BYTES = 1024 * 1024

_THREAD_LOCK = threading.Lock()


class ClaudeCredentialError(RuntimeError):
    """A trusted Claude credential could not be safely prepared for a job."""


class ClaudeCredentialRateLimited(RuntimeError):
    """Claude rejected the credential refresh probe because provider capacity was limited."""

    def __init__(
        self,
        *,
        account_home: str,
        limit_kind: str = "rate_limited",
        retry_after_seconds: float = 0.0,
    ):
        if limit_kind == "account_quota_limited":
            message = (
                "Claude reports that this account reached its usage quota during credential refresh. "
                "Wait for the quota window to reset. Diagnostic: account_quota_limited."
            )
        else:
            message = "Claude rate limited the credential refresh check. Wait and try again. Diagnostic: rate_limited."
        super().__init__(message)
        self.account_home = account_home
        self.limit_kind = limit_kind
        self.retry_after_seconds = max(0.0, float(retry_after_seconds))


@dataclass(frozen=True)
class _Credential:
    path: Path
    content: bytes
    expires_at_ms: int
    metadata: os.stat_result


def prepare_claude_job_credentials(
    source_home: Path,
    target_home: Path,
    *,
    harness_timeout_seconds: int,
    now: Callable[[], float] = time.time,
    run_process: Callable[..., subprocess.CompletedProcess[str]] | None = None,
) -> int | None:
    """Refresh near-expiry OAuth once, then atomically snapshot it for a job.

    Returns the snapshot expiry in epoch milliseconds, or ``None`` when no
    credential exists. Invalid credentials and refresh failures are explicit
    so a job never starts with a partial secret.
    """

    refresh_window_seconds = (
        min(max(0, harness_timeout_seconds), DEFAULT_REFRESH_WINDOW_SECONDS) + DEFAULT_REFRESH_MARGIN_SECONDS
    )
    with _THREAD_LOCK, _filesystem_lock(source_home):
        # Login, logout, and another engine process may have changed the file
        # while this worker waited. Read only after holding the shared lock.
        credential = _read_credential(source_home)
        if credential is None:
            return None
        if _expires_within(credential, now(), refresh_window_seconds):
            credential = _refresh_credential(
                source_home,
                credential,
                now=now,
                refresh_window_seconds=refresh_window_seconds,
                run_process=run_process or subprocess.run,
            )
        _atomic_snapshot(credential, target_home / credential.path.name)
    return credential.expires_at_ms


def claude_oauth_timeout_seconds(
    expires_at_ms: int | str | None,
    configured_timeout_seconds: int,
    *,
    now: Callable[[], float] = time.time,
) -> int:
    """Keep a disposable job inside its snapshotted access-token lifetime."""

    configured = max(1, int(configured_timeout_seconds))
    try:
        expires_at = int(expires_at_ms) if expires_at_ms is not None else None
    except (TypeError, ValueError, OverflowError):
        return configured
    if not expires_at or expires_at <= 0:
        return configured
    remaining = int(expires_at / 1000 - now() - DEFAULT_REFRESH_MARGIN_SECONDS)
    return max(1, min(configured, remaining))


def _read_credential(home: Path) -> _Credential | None:
    for name in CLAUDE_CREDENTIAL_FILENAMES:
        path = home / name
        descriptor = -1
        try:
            flags = os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
            descriptor = os.open(path, flags)
        except FileNotFoundError:
            continue
        except OSError as exc:
            if exc.errno == errno.ELOOP:
                raise _reconnect_error("Claude credentials must be a regular file, not a symbolic link.") from exc
            raise _reconnect_error("Claude credentials could not be read.") from exc
        try:
            entry = os.fstat(descriptor)
            if not stat.S_ISREG(entry.st_mode):
                raise _reconnect_error("Claude credentials must be a regular file, not a symbolic link.")
            if entry.st_size > MAX_CREDENTIAL_BYTES:
                raise _reconnect_error("Claude credentials are unexpectedly large.")
            with os.fdopen(descriptor, "rb") as credential_file:
                descriptor = -1
                content = credential_file.read(MAX_CREDENTIAL_BYTES + 1)
            if len(content) > MAX_CREDENTIAL_BYTES:
                raise _reconnect_error("Claude credentials are unexpectedly large.")
            payload = json.loads(content)
        except OSError as exc:
            raise _reconnect_error("Claude credentials could not be read.") from exc
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise _reconnect_error("Claude credentials are not valid JSON.") from exc
        finally:
            if descriptor >= 0:
                os.close(descriptor)
        oauth = payload.get("claudeAiOauth") if isinstance(payload, dict) else None
        if not isinstance(oauth, dict):
            raise _reconnect_error("Claude OAuth credentials are missing.")
        if not _nonempty_text(oauth.get("accessToken")) or not _nonempty_text(oauth.get("refreshToken")):
            raise _reconnect_error("Claude OAuth credentials are incomplete.")
        expires_at_ms = _expiry_milliseconds(oauth.get("expiresAt"))
        if expires_at_ms is None:
            raise _reconnect_error("Claude OAuth credential expiry is invalid.")
        return _Credential(path=path, content=content, expires_at_ms=expires_at_ms, metadata=entry)
    return None


def _nonempty_text(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _expiry_milliseconds(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    try:
        expiry = int(value)  # Claude Code stores expiresAt as epoch milliseconds.
    except (TypeError, ValueError, OverflowError):
        return None
    return expiry if expiry > 0 else None


def _expires_within(credential: _Credential, now: float, seconds: int) -> bool:
    return credential.expires_at_ms <= int((now + seconds) * 1000)


def _refresh_credential(
    home: Path,
    original: _Credential,
    *,
    now: Callable[[], float],
    refresh_window_seconds: int,
    run_process: Callable[..., subprocess.CompletedProcess[str]],
) -> _Credential:
    original_stat = original.metadata
    env = os.environ.copy()
    env.update(
        {
            "HOME": str(home),
            "CLAUDE_HOME": str(home),
            "CLAUDE_CONFIG_DIR": str(home),
            "NO_COLOR": "1",
            "TERM": "dumb",
        }
    )
    # API-key and alternate-provider variables must not bypass the canonical
    # OAuth credential that this probe exists to refresh.
    for name in (
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_MODEL_PROVIDER",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ):
        env.pop(name, None)

    command = [
        "claude",
        "-p",
        "--safe-mode",
        "--disable-slash-commands",
        "--tools",
        "",
        "--permission-mode",
        "dontAsk",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--setting-sources",
        "",
        "--settings",
        "{}",
        "--no-session-persistence",
        "--output-format",
        "json",
    ]

    try:
        with tempfile.TemporaryDirectory(prefix="open-kritt-claude-refresh-") as trusted_cwd:
            result = run_process(
                command,
                input="Reply with OK.",
                text=True,
                capture_output=True,
                check=False,
                timeout=DEFAULT_REFRESH_TIMEOUT_SECONDS,
                cwd=trusted_cwd,
                env=env,
            )
    except (OSError, subprocess.SubprocessError) as exc:
        _restore_credential(original, original_stat)
        raise _reconnect_error("Claude could not refresh its OAuth credential.") from exc

    if result.returncode != 0:
        rate_limit = _refresh_rate_limit(result, account_home=str(home))
        if rate_limit is not None:
            if not _preserve_rotated_credential(home, original, original_stat):
                _restore_credential(original, original_stat)
            raise rate_limit
        _restore_credential(original, original_stat)
        raise _reconnect_error("Claude could not refresh its OAuth credential.")

    try:
        refreshed = _read_credential(home)
    except ClaudeCredentialError:
        _restore_credential(original, original_stat)
        raise
    if refreshed is None or refreshed.expires_at_ms <= original.expires_at_ms:
        _restore_credential(original, original_stat)
        raise _reconnect_error("Claude did not renew its OAuth credential.")
    if _expires_within(refreshed, now(), refresh_window_seconds):
        _restore_credential(original, original_stat)
        raise _reconnect_error("Claude renewed its credential for too short a job window.")

    _secure_canonical_credential(refreshed.path, original_stat)
    _remove_alternate_credentials(home, keep=refreshed.path.name)
    return _read_credential(home) or refreshed


def _preserve_rotated_credential(home: Path, original: _Credential, original_stat: os.stat_result) -> bool:
    """Keep a credential the CLI rotated before a quota-limited prompt failed."""

    try:
        refreshed = _read_credential(home)
    except ClaudeCredentialError:
        return False
    if refreshed is None or refreshed.expires_at_ms <= original.expires_at_ms:
        return False
    _secure_canonical_credential(refreshed.path, original_stat)
    _remove_alternate_credentials(home, keep=refreshed.path.name)
    return True


def _refresh_rate_limit(result: subprocess.CompletedProcess[str], *, account_home: str):
    """Classify only fixed rate-limit signals without retaining provider output."""

    output = f"{result.stdout or ''}\n{result.stderr or ''}"
    normalized = output.lower()
    quota_signals = (
        "usage_limit",
        "usage limit",
        "you've hit your limit",
        "you have hit your limit",
        "session limit",
        "account limit reached",
    )
    rate_limit_signals = (
        "rate_limit",
        "rate limit",
        "too many requests",
    )
    if any(signal in normalized for signal in quota_signals):
        limit_kind = "account_quota_limited"
    elif any(signal in normalized for signal in rate_limit_signals) or re.search(r"(?<!\d)429(?!\d)", normalized):
        limit_kind = "rate_limited"
    else:
        return None

    retry_after = re.search(
        r'(?i)\bretry[-_ ]after["\']?\s*[:=]\s*["\']?(\d+(?:\.\d+)?)',
        output,
    )
    return ClaudeCredentialRateLimited(
        account_home=account_home,
        limit_kind=limit_kind,
        retry_after_seconds=float(retry_after.group(1)) if retry_after else 0.0,
    )


def _restore_credential(credential: _Credential, original_stat: os.stat_result) -> None:
    try:
        _remove_alternate_credentials(credential.path.parent, keep=credential.path.name)
        _atomic_write(credential.path, credential.content, mode=0o600)
        if hasattr(os, "chown"):
            os.chown(credential.path, original_stat.st_uid, original_stat.st_gid)
    except OSError:
        # The caller still receives a credential error; never expose secret
        # contents or subprocess output while reporting restoration failures.
        pass


def _remove_alternate_credentials(home: Path, *, keep: str) -> None:
    for name in CLAUDE_CREDENTIAL_FILENAMES:
        if name != keep:
            (home / name).unlink(missing_ok=True)


def _secure_canonical_credential(path: Path, original_stat: os.stat_result) -> None:
    path.chmod(0o600)
    if hasattr(os, "chown"):
        try:
            os.chown(path, original_stat.st_uid, original_stat.st_gid)
        except PermissionError:
            pass


def _atomic_snapshot(credential: _Credential, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    _atomic_write(destination, credential.content, mode=0o600)


def _atomic_write(destination: Path, content: bytes, *, mode: int) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        dir=destination.parent,
        prefix=f".{destination.name}.",
        suffix=".tmp",
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as target:
            descriptor = -1
            target.write(content)
            target.flush()
            os.fchmod(target.fileno(), mode)
            os.fsync(target.fileno())
        os.replace(temporary, destination)
        destination.chmod(mode)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


@contextmanager
def _filesystem_lock(home: Path):
    home.mkdir(parents=True, exist_ok=True, mode=0o700)
    lock_path = home / CLAUDE_AUTH_LOCK_NAME
    deadline = time.monotonic() + LOCK_WAIT_SECONDS
    while True:
        try:
            lock_path.mkdir(mode=0o700)
            break
        except FileExistsError:
            try:
                entry = lock_path.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISLNK(entry.st_mode) or not stat.S_ISDIR(entry.st_mode):
                raise _reconnect_error("Claude credential lock is not a private directory.") from None
            if time.time() - entry.st_mtime > STALE_LOCK_SECONDS:
                try:
                    lock_path.rmdir()
                except OSError:
                    pass
                else:
                    continue
            if time.monotonic() >= deadline:
                raise ClaudeCredentialError(
                    "Claude credentials are being updated. Try the scan again shortly."
                ) from None
            time.sleep(0.05)
        except OSError as exc:
            raise _reconnect_error("Claude credentials could not be locked.") from exc
    try:
        yield
    finally:
        try:
            lock_path.rmdir()
        except OSError:
            pass


def _reconnect_error(reason: str) -> ClaudeCredentialError:
    return ClaudeCredentialError(f"{reason} Reconnect Claude in Accounts.")

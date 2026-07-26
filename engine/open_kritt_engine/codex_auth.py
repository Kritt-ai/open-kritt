"""Keep persisted Codex credentials private when container-root processes refresh them."""

from __future__ import annotations

import json
import logging
import os
import shutil
import stat
import tempfile
import threading
from collections.abc import Iterator, Mapping
from contextlib import contextmanager, suppress
from pathlib import Path

LOGGER = logging.getLogger("open_kritt_engine")
_PERSISTED_AUTH_LOCK = threading.Lock()


def _usable_auth_file(auth_path: Path) -> bool:
    try:
        auth = json.loads(auth_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(auth, dict) and bool(auth)


def _auth_changed(refreshed: Path, persisted: Path) -> bool:
    try:
        return refreshed.read_bytes() != persisted.read_bytes()
    except OSError:
        return True


def _replace_auth_file(source: Path, destination: Path, original) -> None:
    descriptor, temporary_name = tempfile.mkstemp(dir=destination.parent, prefix=".auth.json.", suffix=".tmp")
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as target, source.open("rb") as refreshed:
            descriptor = -1
            shutil.copyfileobj(refreshed, target)
            target.flush()
            os.fchmod(target.fileno(), stat.S_IMODE(original.st_mode))
            current = os.fstat(target.fileno())
            if current.st_uid != original.st_uid or current.st_gid != original.st_gid:
                os.fchown(target.fileno(), original.st_uid, original.st_gid)
            os.fsync(target.fileno())
        os.replace(temporary, destination)
        destination.chmod(stat.S_IMODE(original.st_mode))
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


@contextmanager
def preserve_codex_auth_metadata(env: Mapping[str, str]) -> Iterator[Mapping[str, str]]:
    """Persist token refreshes while restoring the auth file's owner and mode."""
    home = env.get("CODEX_HOME")
    if not home:
        yield env
        return

    auth_path = Path(home) / "auth.json"
    try:
        auth_path.stat()
    except OSError:
        yield env
        return

    # Model discovery and generation can share the persisted home. Serialize them
    # so two Codex refreshes cannot race on the same refresh token.
    with _PERSISTED_AUTH_LOCK:
        try:
            original = auth_path.stat()
        except OSError:
            yield env
            return

        try:
            yield env
        finally:
            try:
                os.chown(auth_path, original.st_uid, original.st_gid)
            except OSError:
                LOGGER.exception("could not restore Codex auth.json ownership")
            try:
                auth_path.chmod(stat.S_IMODE(original.st_mode))
            except OSError:
                LOGGER.exception("could not restore Codex auth.json permissions")


@contextmanager
def isolated_codex_home(env: Mapping[str, str]) -> Iterator[Mapping[str, str]]:
    """Run Codex in a temporary home and persist only a valid auth refresh."""
    isolated_env = dict(env)
    source_home = Path(isolated_env.get("CODEX_HOME") or "/root/.codex")
    source_auth = source_home / "auth.json"

    with tempfile.TemporaryDirectory(prefix="open-kritt-codex-catalog-") as temporary_name:
        temporary_home = Path(temporary_name)
        isolated_env["CODEX_HOME"] = str(temporary_home)

        try:
            source_auth.stat()
        except OSError:
            for filename in ("config.toml",):
                source = source_home / filename
                if source.is_file():
                    with suppress(OSError):
                        shutil.copy2(source, temporary_home / filename)
            yield isolated_env
            return

        with _PERSISTED_AUTH_LOCK:
            try:
                original = source_auth.stat()
                shutil.copy2(source_auth, temporary_home / "auth.json")
                config = source_home / "config.toml"
                if config.is_file():
                    shutil.copy2(config, temporary_home / "config.toml")
            except OSError:
                yield isolated_env
                return

            try:
                yield isolated_env
            finally:
                refreshed_auth = temporary_home / "auth.json"
                if _usable_auth_file(refreshed_auth) and _auth_changed(refreshed_auth, source_auth):
                    try:
                        _replace_auth_file(refreshed_auth, source_auth, original)
                    except OSError:
                        LOGGER.exception("could not persist refreshed Codex auth.json")

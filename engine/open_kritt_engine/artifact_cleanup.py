import logging
import os
import re
import shutil
import subprocess
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

LOGGER = logging.getLogger("open_kritt_engine.artifact_cleanup")
POST_WORKSPACE_ID_OFFSET = 1_000_000_000
_JOB_WORKSPACE_PATTERN = re.compile(r"metadata-(\d+)")
_PERSISTED_SCAN_CACHE_PATTERN = re.compile(r"scan-(\d+)")
_BROKEN_SCAN_CACHE_PATTERN = re.compile(r"scan-\d+\.broken-\d{8}T\d{6}Z")
_LEGACY_SCAN_WORKSPACE_PATTERN = re.compile(r"workspace-[0-9a-f]{24}")
_TRASH_DIR_NAME = ".open-kritt-trash"


@dataclass(frozen=True)
class ArtifactCleanupResult:
    job_workspaces: int = 0
    persisted_scan_caches: int = 0
    checkout_caches: int = 0
    legacy_scan_workspaces: int = 0
    legacy_checkout_caches: int = 0
    legacy_repo_caches: int = 0

    @property
    def total(self) -> int:
        return (
            self.job_workspaces
            + self.persisted_scan_caches
            + self.legacy_scan_workspaces
            + self.legacy_checkout_caches
            + self.checkout_caches
            + self.legacy_repo_caches
        )


def cleanup_orphaned_job_workspaces(
    data_dir: str,
    *,
    active_workspace_ids: set[int],
    minimum_age_seconds: float = 0,
    now: float | None = None,
    quarantine: list[Path] | None = None,
) -> int:
    return _cleanup_numbered_children(
        Path(data_dir) / "jobs",
        pattern=_JOB_WORKSPACE_PATTERN,
        retained_ids=active_workspace_ids,
        minimum_age_seconds=minimum_age_seconds,
        now=now,
        quarantine=quarantine,
    )


def cleanup_persisted_scan_caches(
    cache_dir: str | None,
    *,
    retained_scan_ids: set[int],
    minimum_age_seconds: float = 0,
    now: float | None = None,
    quarantine: list[Path] | None = None,
) -> int:
    if not cache_dir:
        return 0

    def should_remove(path: Path) -> bool:
        if _BROKEN_SCAN_CACHE_PATTERN.fullmatch(path.name):
            return True
        match = _PERSISTED_SCAN_CACHE_PATTERN.fullmatch(path.name)
        return match is not None and int(match.group(1)) not in retained_scan_ids

    return _cleanup_matching_children(
        Path(cache_dir),
        matches=should_remove,
        minimum_age_seconds=minimum_age_seconds,
        now=now,
        quarantine=quarantine,
    )


def cleanup_checkout_caches(
    cache_dir: str | None,
    *,
    retained_entry_names: set[str],
    retained_entry_prefixes: set[str] | None = None,
    minimum_age_seconds: float = 0,
    now: float | None = None,
    quarantine: list[Path] | None = None,
) -> int:
    """Remove shared checkout entries no active scan can still need."""

    if not cache_dir:
        return 0
    retained_entry_prefixes = retained_entry_prefixes or set()
    return _cleanup_matching_children(
        Path(cache_dir),
        matches=lambda path: path.name not in {".locks", _TRASH_DIR_NAME}
        and path.name not in retained_entry_names
        and not any(path.name.startswith(prefix) for prefix in retained_entry_prefixes),
        minimum_age_seconds=minimum_age_seconds,
        now=now,
        quarantine=quarantine,
    )


def cleanup_legacy_scan_workspaces(
    data_dir: str,
    *,
    minimum_age_seconds: float = 0,
    now: float | None = None,
    quarantine: list[Path] | None = None,
) -> int:
    return _cleanup_matching_children(
        Path(data_dir) / "scan-workspaces",
        matches=lambda path: _LEGACY_SCAN_WORKSPACE_PATTERN.fullmatch(path.name) is not None,
        minimum_age_seconds=minimum_age_seconds,
        now=now,
        quarantine=quarantine,
    )


def cleanup_legacy_checkout_cache(
    data_dir: str,
    configured_cache_dir: str | None,
    *,
    quarantine: list[Path] | None = None,
) -> int:
    legacy = Path(data_dir) / "checkout-cache"
    configured = Path(configured_cache_dir).resolve(strict=False) if configured_cache_dir else None
    if configured == legacy.resolve(strict=False) or not legacy.exists():
        return 0
    return int(_remove_artifact(legacy, quarantine=quarantine))


def cleanup_legacy_repo_cache(
    data_dir: str,
    configured_repo_dir: str | None,
    *,
    quarantine: list[Path] | None = None,
) -> int:
    legacy = Path(data_dir) / "repos"
    configured = Path(configured_repo_dir).resolve(strict=False) if configured_repo_dir else None
    if configured == legacy.resolve(strict=False) or not legacy.exists():
        return 0
    return int(_remove_artifact(legacy, quarantine=quarantine))


def collect_quarantined_artifacts(roots: list[str | Path | None]) -> list[Path]:
    artifacts: list[Path] = []
    seen: set[str] = set()
    for root_value in roots:
        if not root_value:
            continue
        root = Path(root_value)
        key = str(root.resolve(strict=False))
        if key in seen:
            continue
        seen.add(key)
        trash = root / _TRASH_DIR_NAME
        try:
            artifacts.extend(trash.iterdir())
        except OSError:
            continue
    return artifacts


def delete_quarantined_artifacts(artifacts: list[Path]) -> int:
    removed = 0
    parents: set[Path] = set()
    for path in artifacts:
        if path.parent.name != _TRASH_DIR_NAME:
            continue
        parents.add(path.parent)
        try:
            completed = subprocess.run(
                ["rm", "-rf", "--", str(path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                check=False,
            )
        except OSError:
            completed = None
        if completed is None or completed.returncode != 0:
            _remove_artifact(path, ignore_errors=True)
        removed += int(not path.exists() and not path.is_symlink())
    for parent in parents:
        try:
            parent.rmdir()
        except OSError:
            pass
    return removed


def _cleanup_numbered_children(
    root: Path,
    *,
    pattern: re.Pattern[str],
    retained_ids: set[int],
    minimum_age_seconds: float,
    now: float | None,
    quarantine: list[Path] | None,
) -> int:
    def should_remove(path: Path) -> bool:
        match = pattern.fullmatch(path.name)
        return match is not None and int(match.group(1)) not in retained_ids

    return _cleanup_matching_children(
        root,
        matches=should_remove,
        minimum_age_seconds=minimum_age_seconds,
        now=now,
        quarantine=quarantine,
    )


def _cleanup_matching_children(
    root: Path,
    *,
    matches: Callable[[Path], bool],
    minimum_age_seconds: float,
    now: float | None,
    quarantine: list[Path] | None = None,
) -> int:
    if not root.is_dir() or root.is_symlink():
        return 0
    removed = 0
    checked_at = time.time() if now is None else now
    try:
        children = list(root.iterdir())
    except OSError as exc:
        LOGGER.warning("could not inspect artifact directory %s: %s", root, exc)
        return 0
    for child in children:
        if not matches(child) or not _old_enough(child, minimum_age_seconds, checked_at):
            continue
        removed += int(_remove_artifact(child, quarantine=quarantine))
    return removed


def _old_enough(path: Path, minimum_age_seconds: float, now: float) -> bool:
    if minimum_age_seconds <= 0:
        return True
    try:
        return now - path.lstat().st_mtime >= minimum_age_seconds
    except OSError:
        return False


def _remove_artifact(
    path: Path,
    *,
    quarantine: list[Path] | None = None,
    ignore_errors: bool = False,
) -> bool:
    try:
        if quarantine is not None and (path.exists() or path.is_symlink()):
            trash = path.parent / _TRASH_DIR_NAME
            trash.mkdir(mode=0o700, exist_ok=True)
            target = trash / f"{path.name}.{time.time_ns()}.{threading.get_ident()}"
            os.replace(path, target)
            quarantine.append(target)
            return True
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
        elif path.exists():
            shutil.rmtree(path, ignore_errors=ignore_errors)
        return not path.exists() and not path.is_symlink()
    except OSError as exc:
        if ignore_errors:
            return not path.exists() and not path.is_symlink()
        LOGGER.warning("could not remove stale artifact %s: %s", path, exc)
        return False

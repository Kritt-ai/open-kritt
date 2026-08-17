import logging
import re
import shutil
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


@dataclass(frozen=True)
class ArtifactCleanupResult:
    job_workspaces: int = 0
    persisted_scan_caches: int = 0
    legacy_scan_workspaces: int = 0
    legacy_checkout_caches: int = 0

    @property
    def total(self) -> int:
        return (
            self.job_workspaces + self.persisted_scan_caches + self.legacy_scan_workspaces + self.legacy_checkout_caches
        )


def cleanup_orphaned_job_workspaces(
    data_dir: str,
    *,
    active_workspace_ids: set[int],
    minimum_age_seconds: float = 0,
    now: float | None = None,
) -> int:
    return _cleanup_numbered_children(
        Path(data_dir) / "jobs",
        pattern=_JOB_WORKSPACE_PATTERN,
        retained_ids=active_workspace_ids,
        minimum_age_seconds=minimum_age_seconds,
        now=now,
    )


def cleanup_persisted_scan_caches(
    cache_dir: str | None,
    *,
    retained_scan_ids: set[int],
    minimum_age_seconds: float = 0,
    now: float | None = None,
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
    )


def cleanup_legacy_scan_workspaces(
    data_dir: str,
    *,
    minimum_age_seconds: float = 0,
    now: float | None = None,
) -> int:
    return _cleanup_matching_children(
        Path(data_dir) / "scan-workspaces",
        matches=lambda path: _LEGACY_SCAN_WORKSPACE_PATTERN.fullmatch(path.name) is not None,
        minimum_age_seconds=minimum_age_seconds,
        now=now,
    )


def cleanup_legacy_checkout_cache(data_dir: str, configured_cache_dir: str | None) -> int:
    legacy = Path(data_dir) / "checkout-cache"
    configured = Path(configured_cache_dir).resolve(strict=False) if configured_cache_dir else None
    if configured == legacy.resolve(strict=False) or not legacy.exists():
        return 0
    return int(_remove_artifact(legacy))


def _cleanup_numbered_children(
    root: Path,
    *,
    pattern: re.Pattern[str],
    retained_ids: set[int],
    minimum_age_seconds: float,
    now: float | None,
) -> int:
    def should_remove(path: Path) -> bool:
        match = pattern.fullmatch(path.name)
        return match is not None and int(match.group(1)) not in retained_ids

    return _cleanup_matching_children(
        root,
        matches=should_remove,
        minimum_age_seconds=minimum_age_seconds,
        now=now,
    )


def _cleanup_matching_children(
    root: Path,
    *,
    matches: Callable[[Path], bool],
    minimum_age_seconds: float,
    now: float | None,
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
        removed += int(_remove_artifact(child))
    return removed


def _old_enough(path: Path, minimum_age_seconds: float, now: float) -> bool:
    if minimum_age_seconds <= 0:
        return True
    try:
        return now - path.lstat().st_mtime >= minimum_age_seconds
    except OSError:
        return False


def _remove_artifact(path: Path) -> bool:
    try:
        if path.is_symlink() or path.is_file():
            path.unlink(missing_ok=True)
        elif path.exists():
            shutil.rmtree(path)
        return not path.exists() and not path.is_symlink()
    except OSError as exc:
        LOGGER.warning("could not remove stale artifact %s: %s", path, exc)
        return False

"""Persist bounded PoC and impact evidence from an isolated workspace before it is removed."""

import hashlib
import json
import re
import shutil
from pathlib import Path
from typing import Any

from .impact_gate import declared_evidence_paths, normalize_evidence_path

MAX_FILES = 20
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 8 * 1024 * 1024
_NAME_RE = re.compile(r"[A-Za-z0-9._-]{1,120}")


class PocArtifactError(ValueError):
    pass


def _capture_result(
    *,
    artifact_dir: str = "",
    captured: list[str] | None = None,
    unresolved: list[str] | None = None,
    capture_complete: bool,
    reason: str = "",
) -> dict[str, Any]:
    return {
        "artifact_dir": artifact_dir,
        "captured_paths": list(captured or []),
        "unresolved_paths": list(unresolved or []),
        "capture_complete": capture_complete,
        "reason": reason,
    }


def _artifact_name(normalized: str, used: set[str]) -> str:
    parts = normalized.split("/")
    name = parts[-1]
    if not _NAME_RE.fullmatch(name):
        raise PocArtifactError("artifact file name contains unsupported characters")
    if name in used:
        name = "__".join(parts)
        if not _NAME_RE.fullmatch(name) or name in used:
            raise PocArtifactError("artifact file name collides with another artifact")
    used.add(name)
    return name


def _resolve_source(source_root: Path, normalized: str) -> Path:
    source = source_root / normalized
    if not source.is_file():
        raise PocArtifactError("artifact is missing or not a regular file")
    resolved = source.resolve(strict=True)
    if not resolved.is_relative_to(source_root):
        raise PocArtifactError("artifact escapes the isolated workspace")
    return resolved


def capture_evidence(
    data_dir: str,
    repo_dir: str,
    *,
    scan_id: int,
    finding_id: int,
    metadata_id: int,
    result: dict[str, Any],
) -> dict[str, Any]:
    """Copy the declared evidence union out of the workspace; never raises, never truncates."""
    declared = declared_evidence_paths(result if isinstance(result, dict) else {})
    if not declared:
        return _capture_result(capture_complete=True)
    if len(declared) > MAX_FILES:
        return _capture_result(
            unresolved=declared,
            capture_complete=False,
            reason=f"{len(declared)} evidence paths declared; the cap is {MAX_FILES} files after deduplication",
        )
    try:
        source_root = Path(repo_dir).resolve(strict=True)
    except OSError as exc:
        return _capture_result(unresolved=declared, capture_complete=False, reason=f"workspace unavailable: {exc}")
    relative_dir = Path("poc-artifacts") / f"scan-{scan_id}" / f"finding-{finding_id}" / f"metadata-{metadata_id}"
    destination = Path(data_dir) / relative_dir
    temp_dir = destination.with_name(destination.name + ".tmp")
    captured: list[str] = []
    unresolved: list[str] = []
    reasons: list[str] = []
    manifest: list[dict[str, Any]] = []
    used_names: set[str] = set()
    total_bytes = 0
    try:
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
        temp_dir.mkdir(parents=True, mode=0o700)
        for raw in declared:
            normalized = normalize_evidence_path(raw)
            try:
                if normalized is None:
                    raise PocArtifactError("artifact path is absolute or traverses the workspace")
                resolved = _resolve_source(source_root, normalized)
                size = resolved.stat().st_size
                if size > MAX_FILE_BYTES or total_bytes + size > MAX_TOTAL_BYTES:
                    raise PocArtifactError("artifact exceeds the per-file or total size limit")
                name = _artifact_name(normalized, used_names)
                target = temp_dir / name
                shutil.copyfile(resolved, target)
                target.chmod(0o600)
            except (OSError, PocArtifactError) as exc:
                unresolved.append(raw)
                reasons.append(f"{raw}: {exc}")
                continue
            total_bytes += size
            captured.append(normalized)
            manifest.append(
                {
                    "source": normalized,
                    "file": name,
                    "size": size,
                    "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                }
            )
        (temp_dir / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
        if destination.exists():
            shutil.rmtree(destination)
        temp_dir.rename(destination)
    except OSError as exc:
        shutil.rmtree(temp_dir, ignore_errors=True)
        return _capture_result(unresolved=declared, capture_complete=False, reason=f"artifact capture failed: {exc}")
    return _capture_result(
        artifact_dir=relative_dir.as_posix(),
        captured=captured,
        unresolved=unresolved,
        capture_complete=not unresolved,
        reason="; ".join(reasons),
    )

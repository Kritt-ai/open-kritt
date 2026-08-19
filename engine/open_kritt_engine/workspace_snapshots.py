import hashlib
import json
import logging
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger("open_kritt_engine.workspace_snapshots")
SNAPSHOT_LABEL = "open-kritt.workspace-snapshot"
SNAPSHOT_KEY_LABEL = "open-kritt.workspace-snapshot-key"
SNAPSHOT_BUILDER_LABEL = "open-kritt.workspace-snapshot-builder"
SNAPSHOT_LEASE_LABEL = "open-kritt.workspace-snapshot-lease"
SNAPSHOT_FORMAT_VERSION = 1
SNAPSHOT_IMAGE_REPOSITORY = "open-kritt-workspace-snapshot"
_SNAPSHOT_LOCKS: dict[str, threading.Lock] = {}
_SNAPSHOT_LOCKS_GUARD = threading.Lock()


class WorkspaceSnapshotError(RuntimeError):
    pass


def _docker_environment() -> dict[str, str]:
    keys = ("PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "XDG_RUNTIME_DIR")
    return {key: value for key in keys if (value := os.environ.get(key))}


def _docker_binary() -> str:
    docker = shutil.which(os.getenv("ENGINE_DOCKER_BIN", "docker"))
    if not docker:
        raise WorkspaceSnapshotError("Docker is required to build scan workspace snapshots.")
    return docker


def _run_docker(
    arguments: list[str],
    *,
    timeout_seconds: float = 600.0,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    command = [_docker_binary(), *arguments]
    try:
        completed = subprocess.run(
            command,
            text=True,
            capture_output=True,
            timeout=timeout_seconds,
            check=False,
            env=_docker_environment(),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        raise WorkspaceSnapshotError(f"Docker command failed to start: {arguments[0]}") from exc
    if check and completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()[-1000:]
        raise WorkspaceSnapshotError(f"Docker {arguments[0]} failed: {detail or 'unknown error'}")
    return completed


def _snapshot_lock(key: str) -> threading.Lock:
    with _SNAPSHOT_LOCKS_GUARD:
        lock = _SNAPSHOT_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _SNAPSHOT_LOCKS[key] = lock
        return lock


def _base_image_id(base_image: str) -> str:
    result = _run_docker(["image", "inspect", "--format", "{{.Id}}", base_image], timeout_seconds=30)
    image_id = result.stdout.strip()
    if not image_id:
        raise WorkspaceSnapshotError(f"Scan runner image is unavailable: {base_image}")
    return image_id


def workspace_snapshot_key(
    *,
    base_image_id: str,
    checkout_key: str,
    manifest_json: str,
) -> str:
    payload = json.dumps(
        {
            "format_version": SNAPSHOT_FORMAT_VERSION,
            "base_image_id": base_image_id,
            "checkout_key": checkout_key,
            "manifest_json": manifest_json,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def workspace_snapshot_image_name(key: str) -> str:
    return f"{SNAPSHOT_IMAGE_REPOSITORY}:{key[:32]}"


def _snapshot_container_name(kind: str, key: str) -> str:
    return f"open-kritt-workspace-{kind}-{key[:24]}"


def _image_snapshot_key(image: str) -> str | None:
    result = _run_docker(
        ["image", "inspect", "--format", f'{{{{ index .Config.Labels "{SNAPSHOT_KEY_LABEL}" }}}}', image],
        timeout_seconds=30,
        check=False,
    )
    if result.returncode != 0:
        return None
    return result.stdout.strip() or None


def _remove_container(name: str):
    _run_docker(["rm", "--force", name], timeout_seconds=60, check=False)


def _ensure_snapshot_lease(image: str, key: str):
    name = _snapshot_container_name("lease", key)
    inspected = _run_docker(
        ["container", "inspect", "--format", "{{.Image}}", name],
        timeout_seconds=30,
        check=False,
    )
    image_id = _run_docker(["image", "inspect", "--format", "{{.Id}}", image], timeout_seconds=30).stdout.strip()
    if inspected.returncode == 0 and inspected.stdout.strip() == image_id:
        return
    if inspected.returncode == 0:
        _remove_container(name)
    _run_docker(
        [
            "create",
            "--name",
            name,
            "--label",
            f"{SNAPSHOT_LEASE_LABEL}=1",
            "--label",
            f"{SNAPSHOT_KEY_LABEL}={key}",
            image,
            "/bin/true",
        ],
        timeout_seconds=60,
    )


def ensure_workspace_snapshot_image(
    *,
    base_image: str,
    checkout_key: str,
    manifest_json: str,
    workspace_files_dir: str,
    sources: list[tuple[str, str]],
    scan_id: int | str | None = None,
) -> str:
    base_id = _base_image_id(base_image)
    key = workspace_snapshot_key(
        base_image_id=base_id,
        checkout_key=checkout_key,
        manifest_json=manifest_json,
    )
    image = workspace_snapshot_image_name(key)
    with _snapshot_lock(key):
        if _image_snapshot_key(image) == key:
            _ensure_snapshot_lease(image, key)
            return image

        started = time.perf_counter()
        builder = _snapshot_container_name("builder", key)
        _remove_container(builder)
        try:
            create_arguments = [
                "create",
                "--name",
                builder,
                "--label",
                f"{SNAPSHOT_BUILDER_LABEL}=1",
                "--label",
                f"{SNAPSHOT_KEY_LABEL}={key}",
                base_image,
                "/bin/true",
            ]
            _run_docker(create_arguments, timeout_seconds=60)
            for source, destination in sources:
                source_path = Path(source)
                if not source_path.is_dir():
                    raise WorkspaceSnapshotError(f"Workspace snapshot source is unavailable: {source}")
                _run_docker(
                    ["cp", f"{source_path}/.", f"{builder}:{destination}"],
                    timeout_seconds=600,
                )
            for filename in ("WORKSPACE.json", "WORKSPACE.md"):
                source_file = Path(workspace_files_dir) / filename
                if not source_file.is_file():
                    raise WorkspaceSnapshotError(f"Workspace snapshot metadata is unavailable: {source_file}")
                _run_docker(
                    ["cp", str(source_file), f"{builder}:/workspace/{filename}"],
                    timeout_seconds=60,
                )
            changes = [
                "--change",
                "WORKDIR /workspace",
                "--change",
                f"LABEL {SNAPSHOT_LABEL}=1",
                "--change",
                f"LABEL {SNAPSHOT_KEY_LABEL}={key}",
                "--change",
                f"LABEL {SNAPSHOT_BUILDER_LABEL}=0",
            ]
            if scan_id is not None:
                changes.extend(["--change", f"LABEL open-kritt.workspace-scan-id={scan_id}"])
            _run_docker(
                ["commit", *changes, builder, image],
                timeout_seconds=600,
            )
        finally:
            _remove_container(builder)

        if _image_snapshot_key(image) != key:
            raise WorkspaceSnapshotError("Docker did not publish the expected workspace snapshot image.")
        _ensure_snapshot_lease(image, key)
        elapsed_ms = int((time.perf_counter() - started) * 1000)
        LOGGER.info("built workspace snapshot image %s for scan %s in %sms", image, scan_id, elapsed_ms)
        return image


def cleanup_stale_workspace_snapshot_builders():
    result = _run_docker(
        ["ps", "--all", "--quiet", "--filter", f"label={SNAPSHOT_BUILDER_LABEL}=1"],
        timeout_seconds=30,
        check=False,
    )
    for container_id in result.stdout.split():
        lease = _run_docker(
            [
                "container",
                "inspect",
                "--format",
                f'{{{{ index .Config.Labels "{SNAPSHOT_LEASE_LABEL}" }}}}',
                container_id,
            ],
            timeout_seconds=30,
            check=False,
        )
        if lease.returncode == 0 and lease.stdout.strip() == "1":
            continue
        _run_docker(["rm", "--force", container_id], timeout_seconds=60, check=False)


def workspace_snapshot_metadata(image: str) -> dict[str, Any] | None:
    result = _run_docker(
        ["image", "inspect", "--format", "{{json .Config.Labels}}", image],
        timeout_seconds=30,
        check=False,
    )
    if result.returncode != 0:
        return None
    try:
        labels = json.loads(result.stdout)
    except json.JSONDecodeError:
        return None
    return labels if isinstance(labels, dict) else None

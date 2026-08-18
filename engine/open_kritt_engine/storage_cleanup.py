import os
import shutil
import subprocess

SCAN_RUNNER_LABEL = "open-kritt.scan-runner=1"

# Reclaim only dangling (untagged) images. Adding --all would also collect tagged
# images that happen to be unreferenced at prune time, which deletes a custom scan
# runner image between jobs (issue #43); tagged images are kept instead.
IMAGE_PRUNE_ARGS = ("image", "prune", "--force")


def _docker_binary() -> str | None:
    return shutil.which(os.getenv("ENGINE_DOCKER_BIN", "docker"))


def _run_docker_cleanup(command: list[str], *, timeout_seconds: float) -> str:
    completed = subprocess.run(
        command,
        text=True,
        capture_output=True,
        check=False,
        timeout=max(1.0, float(timeout_seconds)),
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "Docker cleanup failed").strip()[-1000:]
        raise RuntimeError(detail)

    output = completed.stdout or ""
    for line in reversed(output.splitlines()):
        if line.strip():
            return line.strip()
    return "completed"


def prune_docker_build_cache(*, keep_storage_bytes: int, timeout_seconds: float = 300.0) -> str | None:
    """Bound unused Docker builder cache and return Docker's summary line.

    Scan runners never build images themselves, but development rebuilds share the
    same Docker daemon and can otherwise exhaust the disk used by scan workspaces.
    Only unused builder cache is removed; images, containers, volumes, and database
    data are outside this operation.
    """

    docker = _docker_binary()
    if not docker:
        return None

    command = [
        docker,
        "builder",
        "prune",
        "--all",
        "--force",
        "--keep-storage",
        str(max(0, int(keep_storage_bytes))),
    ]
    return _run_docker_cleanup(command, timeout_seconds=timeout_seconds)


def prune_unused_docker_images(*, timeout_seconds: float = 300.0) -> str | None:
    """Remove dangling (untagged) images, keeping tagged images such as scan runners."""

    docker = _docker_binary()
    if not docker:
        return None
    return _run_docker_cleanup(
        [docker, *IMAGE_PRUNE_ARGS],
        timeout_seconds=timeout_seconds,
    )


def prune_stopped_scan_containers(*, timeout_seconds: float = 300.0) -> str | None:
    """Remove only stopped containers created by the Open Kritt scan runner."""

    docker = _docker_binary()
    if not docker:
        return None
    return _run_docker_cleanup(
        [docker, "container", "prune", "--force", "--filter", f"label={SCAN_RUNNER_LABEL}"],
        timeout_seconds=timeout_seconds,
    )

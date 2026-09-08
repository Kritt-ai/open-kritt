import os
import shutil
import subprocess

SCAN_RUNNER_LABEL = "open-kritt.scan-runner=1"


def _docker_control_env() -> dict[str, str]:
    keys = ("PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "XDG_RUNTIME_DIR")
    return {key: value for key in keys if (value := os.environ.get(key))}


def _docker_control_run(command: list[str]) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            text=True,
            capture_output=True,
            timeout=30,
            check=False,
            env=_docker_control_env(),
        )
    except (OSError, subprocess.SubprocessError):
        return subprocess.CompletedProcess(command, 1, "", "")


def evict_newest_scan_runner() -> str | None:
    """Kill one recently admitted runner so the coordinator survives pressure.

    Docker lists containers newest first. Evicting the newest runner generally
    discards less provider work than terminating an older session. The runner's
    exit code is classified as retryable capacity pressure by the harness.
    """

    docker = shutil.which(os.getenv("ENGINE_DOCKER_BIN", "docker"))
    if not docker:
        return None
    listed = _docker_control_run(
        [
            docker,
            "ps",
            "--filter",
            f"label={SCAN_RUNNER_LABEL}",
            "--format",
            "{{.Names}}",
        ]
    )
    if listed.returncode != 0:
        return None
    name = next((line.strip() for line in listed.stdout.splitlines() if line.strip()), None)
    if not name:
        return None
    killed = _docker_control_run([docker, "kill", "--signal", "KILL", name])
    return name if killed.returncode == 0 else None

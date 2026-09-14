"""Best-effort resource observations for the UI; never used to schedule work."""

import errno
import json
import logging
import os
import re
import tempfile
from datetime import datetime, timezone

from .memory_budget import MemoryCapacity, system_memory_available_bytes
from .runtime_config import runtime_config_path

LOGGER = logging.getLogger(__name__)
RESOURCE_DIAGNOSTICS_FILENAME = "engine-resource-diagnostics.json"


def publish_resource_diagnostics(capacity: MemoryCapacity, *, data_dir: str | None = None) -> None:
    """Share only numeric resource observations through the existing runtime mount.

    /proc/meminfo describes the engine-visible Linux system. It does not measure
    a runner's cgroup headroom, or necessarily the remote Docker daemon's host.
    """
    temporary = None
    try:
        snapshot = {
            "version": 1,
            "observedAt": datetime.now(timezone.utc).isoformat(),
            "memory": {
                "scope": "engine_linux_system",
                "availableBytes": system_memory_available_bytes(),
                "totalBytes": capacity.total_bytes,
                "reserveBytes": capacity.reserve_bytes,
                "runnerBytes": capacity.runner_bytes,
                "configuredWorkers": capacity.configured_workers,
                "effectiveWorkers": capacity.effective_workers,
            },
        }
        path = runtime_config_path(data_dir).with_name(RESOURCE_DIAGNOSTICS_FILENAME)
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, delete=False) as output:
            temporary = output.name
            json.dump(snapshot, output, allow_nan=False)
            os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    except Exception:
        # Diagnostic failure must not interrupt the supervisor or change admission.
        LOGGER.debug("Resource diagnostics could not be published", exc_info=True)
    finally:
        if temporary is not None:
            try:
                os.unlink(temporary)
            except OSError:
                pass


def local_resource_failure_message(error: str | OSError) -> str | None:
    """Describe explicit local resource signals without copying paths or output."""
    error_number = error.errno if isinstance(error, OSError) else None
    text = str(error).lower()
    if error_number in {errno.ENOSPC, errno.EDQUOT} or re.search(
        r"\b(enospc|no space left on device|disk quota exceeded)\b", text
    ):
        return (
            "Storage exhausted. Available space, required space, and the affected filesystem were not recorded. "
            "Check engine-data and Docker storage; free space or increase the relevant disk/quota before retrying. "
            "Lowering Minimum free storage does not free space. Resource diagnostic: storage_exhausted."
        )
    if error_number == errno.ENOMEM or re.search(r"\b(enomem|cannot allocate memory|heap out of memory)\b", text):
        return (
            "Memory allocation failed. Available and required memory were not recorded. Check container memory "
            "limits and system usage; free memory or provide more memory before retrying. "
            "Resource diagnostic: memory_exhausted."
        )
    cpu_range = re.search(
        r"range of cpus is from [0-9.]+ to ([0-9]{1,7}(?:\.[0-9]{1,2})?), "
        r"as there are only ([0-9]{1,7}) cpus available",
        text,
    )
    if cpu_range and float(cpu_range[1]) == int(cpu_range[2]) and 0 < int(cpu_range[2]) <= 1048576:
        return (
            f"Docker rejected the CPU allocation and reports {int(cpu_range[2])} CPUs available. "
            "The requested value was not recorded. Check Runner CPU limit in Settings; lower it to fit Docker's "
            "capacity or allocate more CPUs to Docker. A lower limit can slow CPU-heavy work. "
            "Resource diagnostic: cpu_unavailable."
        )
    return None

from dataclasses import dataclass
from pathlib import Path

MIB = 1024**2
GIB = 1024**3


def _system_memory_field_bytes(field: str, path: str | Path) -> int | None:
    try:
        lines = Path(path).read_text(encoding="utf-8").splitlines()
    except OSError:
        return None
    for line in lines:
        name, separator, raw = line.partition(":")
        if separator and name == field:
            fields = raw.strip().split()
            try:
                value = int(fields[0])
            except (IndexError, ValueError):
                return None
            multiplier = 1024 if len(fields) > 1 and fields[1].lower() == "kb" else 1
            return value * multiplier
    return None


def system_memory_total_bytes(path: str | Path = "/proc/meminfo") -> int | None:
    """Return the memory visible to the engine's Linux VM/container."""

    return _system_memory_field_bytes("MemTotal", path)


def system_memory_available_bytes(path: str | Path = "/proc/meminfo") -> int | None:
    """Return memory currently available without swapping."""

    return _system_memory_field_bytes("MemAvailable", path)


@dataclass(frozen=True)
class MemoryCapacity:
    configured_workers: int
    effective_workers: int
    total_bytes: int | None
    reserve_bytes: int
    runner_bytes: int

    @property
    def limited(self) -> bool:
        return self.effective_workers < self.configured_workers


def calculate_memory_capacity(
    configured_workers: int,
    *,
    total_bytes: int | None,
    reserve_bytes: int,
    runner_bytes: int,
) -> MemoryCapacity:
    """Turn the configured worker ceiling into a predictable RAM budget."""

    configured = max(0, int(configured_workers))
    reserve = max(0, int(reserve_bytes))
    runner = max(0, int(runner_bytes))
    if configured == 0:
        effective = 0
    elif total_bytes is None or total_bytes <= 0 or runner <= 0:
        # Preserve compatibility on hosts where Linux memory information is
        # unavailable. Scan runners still receive their Docker hard limit.
        effective = configured
    else:
        available_for_runners = max(0, int(total_bytes) - reserve)
        effective = min(configured, available_for_runners // runner)
    return MemoryCapacity(
        configured_workers=configured,
        effective_workers=effective,
        total_bytes=total_bytes,
        reserve_bytes=reserve,
        runner_bytes=runner,
    )

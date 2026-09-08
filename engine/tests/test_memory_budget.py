from open_kritt_engine.memory_budget import (
    GIB,
    MIB,
    calculate_memory_capacity,
    system_memory_available_bytes,
    system_memory_total_bytes,
)


def test_memory_capacity_limits_configured_workers_to_the_ram_budget():
    capacity = calculate_memory_capacity(
        15,
        total_bytes=8 * GIB,
        reserve_bytes=2 * GIB,
        runner_bytes=1536 * MIB,
    )

    assert capacity.effective_workers == 4
    assert capacity.limited


def test_memory_capacity_preserves_the_configured_ceiling_when_it_fits():
    capacity = calculate_memory_capacity(
        5,
        total_bytes=16 * GIB,
        reserve_bytes=2 * GIB,
        runner_bytes=1536 * MIB,
    )

    assert capacity.effective_workers == 5
    assert not capacity.limited


def test_memory_capacity_can_pause_when_the_reserve_consumes_the_budget():
    capacity = calculate_memory_capacity(
        10,
        total_bytes=2 * GIB,
        reserve_bytes=2 * GIB,
        runner_bytes=1024 * MIB,
    )

    assert capacity.effective_workers == 0


def test_memory_capacity_falls_back_when_system_memory_is_unavailable():
    capacity = calculate_memory_capacity(
        7,
        total_bytes=None,
        reserve_bytes=2 * GIB,
        runner_bytes=1536 * MIB,
    )

    assert capacity.effective_workers == 7


def test_system_memory_total_bytes_reads_linux_meminfo(tmp_path):
    meminfo = tmp_path / "meminfo"
    meminfo.write_text(
        "MemTotal:       16777216 kB\nMemFree:         1000000 kB\nMemAvailable:    12582912 kB\n",
        encoding="utf-8",
    )

    assert system_memory_total_bytes(meminfo) == 16 * GIB
    assert system_memory_available_bytes(meminfo) == 12 * GIB

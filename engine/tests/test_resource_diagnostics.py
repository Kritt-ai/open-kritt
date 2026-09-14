import errno
import json

import pytest

from open_kritt_engine import resource_diagnostics
from open_kritt_engine.harnesses import _classified_harness_error, _safe_harness_public_message
from open_kritt_engine.memory_budget import GIB, calculate_memory_capacity


def test_snapshot_publishes_only_resource_observations_next_to_runtime_config(tmp_path, monkeypatch):
    runtime = tmp_path / "runtime.env"
    monkeypatch.setenv("ENGINE_RUNTIME_CONFIG_PATH", str(runtime))
    monkeypatch.setattr(resource_diagnostics, "system_memory_available_bytes", lambda: int(1.5 * GIB))
    capacity = calculate_memory_capacity(4, total_bytes=8 * GIB, reserve_bytes=GIB, runner_bytes=GIB)
    resource_diagnostics.publish_resource_diagnostics(capacity, data_dir="/unused")
    snapshot = json.loads((tmp_path / "engine-resource-diagnostics.json").read_text())
    assert set(snapshot) == {"version", "observedAt", "memory"}
    assert snapshot["memory"] == {
        "scope": "engine_linux_system",
        "availableBytes": int(1.5 * GIB),
        "totalBytes": 8 * GIB,
        "reserveBytes": GIB,
        "runnerBytes": GIB,
        "configuredWorkers": 4,
        "effectiveWorkers": 4,
    }
    assert set(path.name for path in tmp_path.iterdir()) == {"engine-resource-diagnostics.json"}


def test_unavailable_memory_is_null_and_failed_publication_preserves_previous_snapshot(tmp_path, monkeypatch):
    monkeypatch.setenv("ENGINE_RUNTIME_CONFIG_PATH", str(tmp_path / "runtime.env"))
    monkeypatch.setattr(resource_diagnostics, "system_memory_available_bytes", lambda: None)
    capacity = calculate_memory_capacity(2, total_bytes=None, reserve_bytes=GIB, runner_bytes=GIB)
    resource_diagnostics.publish_resource_diagnostics(capacity)
    path = tmp_path / "engine-resource-diagnostics.json"
    previous = path.read_text()
    assert json.loads(previous)["memory"]["availableBytes"] is None

    def fail_replace(*_args):
        raise OSError(errno.ENOSPC, "synthetic full disk")

    monkeypatch.setattr(resource_diagnostics.os, "replace", fail_replace)
    resource_diagnostics.publish_resource_diagnostics(capacity)
    assert path.read_text() == previous
    assert len(list(tmp_path.iterdir())) == 1


@pytest.mark.parametrize(
    "error_number,code",
    [(errno.ENOSPC, "storage_exhausted"), (errno.EDQUOT, "storage_exhausted"), (errno.ENOMEM, "memory_exhausted")],
)
def test_local_errno_messages_exclude_arbitrary_details(error_number, code):
    message = resource_diagnostics.local_resource_failure_message(
        OSError(error_number, "synthetic detail", "/test/file")
    )
    assert f"Resource diagnostic: {code}" in message
    assert "synthetic detail" not in message
    assert "/test/file" not in message


@pytest.mark.parametrize("maximum", ["4", "4.00"])
def test_cpu_rejection_reports_only_the_capacity_docker_recorded(maximum):
    error = _classified_harness_error(
        f"Error response from daemon: Range of CPUs is from 0.01 to {maximum}, as there are only 4 CPUs available",
        harness="test",
        exit_code=125,
    )
    assert "4 CPUs available" in error.public_message
    assert "requested value was not recorded" in error.public_message
    assert error.code == "model_process_error"
    assert error.retryable is True


def test_provider_and_network_failures_are_not_reinterpreted_as_local_shortages():
    for code in ("provider_rejected", "provider_throttled", "network_error"):
        message = _safe_harness_public_message("remote service: no space left on device", code)
        assert "Resource diagnostic:" not in message
    assert resource_diagnostics.local_resource_failure_message("request timed out") is None
    assert resource_diagnostics.local_resource_failure_message("runner exited 137") is None
    assert resource_diagnostics.local_resource_failure_message(OSError(errno.EACCES, "permission denied")) is None

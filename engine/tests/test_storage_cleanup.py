from types import SimpleNamespace

from open_kritt_engine import storage_cleanup


def test_docker_builder_prune_can_remove_all_unused_cache(monkeypatch):
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout="cache rows\nTotal:\t12GB\n", stderr="")

    monkeypatch.setattr(storage_cleanup.shutil, "which", lambda _binary: "/usr/bin/docker")
    monkeypatch.setattr(storage_cleanup.subprocess, "run", run)

    summary = storage_cleanup.prune_docker_build_cache(keep_storage_bytes=0)

    assert summary == "Total:\t12GB"
    assert calls[0][0] == [
        "/usr/bin/docker",
        "builder",
        "prune",
        "--all",
        "--force",
        "--keep-storage",
        "0",
    ]
    assert calls[0][1]["capture_output"] is True


def test_docker_builder_prune_is_optional_when_docker_is_unavailable(monkeypatch):
    monkeypatch.setattr(storage_cleanup.shutil, "which", lambda _binary: None)

    assert storage_cleanup.prune_docker_build_cache(keep_storage_bytes=0) is None


def test_unused_image_prune_keeps_tagged_images(monkeypatch):
    """Auto-prune must not pass --all, so a tagged scan runner image survives (issue #43)."""
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout="Total reclaimed space: 1GB\n", stderr="")

    monkeypatch.setattr(storage_cleanup.shutil, "which", lambda _binary: "/usr/bin/docker")
    monkeypatch.setattr(storage_cleanup.subprocess, "run", run)

    assert storage_cleanup.prune_unused_docker_images() == "Total reclaimed space: 1GB"

    assert "--all" not in calls[0][0]
    assert calls[0][0] == ["/usr/bin/docker", "image", "prune", "--force"]


def test_stopped_container_prune_is_scoped_to_scan_runner_label(monkeypatch):
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(returncode=0, stdout="Total reclaimed space: 0B\n", stderr="")

    monkeypatch.setattr(storage_cleanup.shutil, "which", lambda _binary: "/usr/bin/docker")
    monkeypatch.setattr(storage_cleanup.subprocess, "run", run)

    storage_cleanup.prune_stopped_scan_containers()

    assert calls[0][0] == [
        "/usr/bin/docker",
        "container",
        "prune",
        "--force",
        "--filter",
        "label=open-kritt.scan-runner=1",
    ]

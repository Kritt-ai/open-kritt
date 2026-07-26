import json
import os
import shutil
import subprocess
import threading
from pathlib import Path

import pytest

from open_kritt_engine import repository as repository_module
from open_kritt_engine import workspace as workspace_module
from open_kritt_engine.repository import (
    LOCAL_SNAPSHOT_REVISION,
    RepoError,
    copy_local_snapshot,
    snapshot_local_repo,
)
from open_kritt_engine.workspace import (
    prepare_dependency_workspace,
    prewarm_scan_checkout_cache,
    restore_persistent_scan_checkout_cache,
    save_persistent_scan_checkout_cache,
)


def local_scan(scan_id=1, *, primary="primary", dependencies=None):
    return {
        "id": scan_id,
        "repo_kind": "local",
        "repo_full": primary,
        "commit_sha": "HEAD",
        "dependencies": [dep["repo_full"] for dep in (dependencies or [])],
        "dependencies_detail": dependencies or [],
    }


def configure_isolated_homes(monkeypatch, tmp_path):
    codex_home = tmp_path / "codex-home"
    claude_home = tmp_path / "claude-home"
    codex_home.mkdir()
    claude_home.mkdir()
    monkeypatch.setenv("ENGINE_CODEX_HOME", str(codex_home))
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    monkeypatch.setenv("CLAUDE_HOME", str(claude_home))


def reject_git_subprocesses(monkeypatch):
    real_run = subprocess.run
    calls = []

    def guarded_run(command, *args, **kwargs):
        calls.append(command)
        executable = command[0] if isinstance(command, list | tuple) else str(command).split()[0]
        if Path(str(executable)).name == "git":
            raise AssertionError(f"local repository handling must not invoke Git: {command}")
        return real_run(command, *args, **kwargs)

    monkeypatch.setattr(subprocess, "run", guarded_run)
    return calls


def initialize_dirty_git_repo(repo_dir):
    repo_dir.mkdir()
    (repo_dir / "tracked.txt").write_text("committed\n", encoding="utf-8")
    subprocess.run(["git", "init", "--quiet", str(repo_dir)], check=True)
    subprocess.run(["git", "-C", str(repo_dir), "config", "user.name", "Test User"], check=True)
    subprocess.run(["git", "-C", str(repo_dir), "config", "user.email", "test@example.com"], check=True)
    subprocess.run(["git", "-C", str(repo_dir), "add", "tracked.txt"], check=True)
    subprocess.run(["git", "-C", str(repo_dir), "commit", "--quiet", "-m", "initial"], check=True)
    (repo_dir / "tracked.txt").write_text("modified working tree\n", encoding="utf-8")
    (repo_dir / "untracked.txt").write_text("untracked working tree\n", encoding="utf-8")

    status = subprocess.run(
        ["git", "-C", str(repo_dir), "status", "--porcelain"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout
    assert " M tracked.txt" in status
    assert "?? untracked.txt" in status


def test_snapshot_local_repo_supports_non_git_directory_without_git(monkeypatch, tmp_path):
    local_root = tmp_path / "local-repos"
    source = local_root / "plain-folder"
    source.mkdir(parents=True)
    (source / "app.py").write_text("print('local')\n", encoding="utf-8")
    reject_git_subprocesses(monkeypatch)

    snapshot_dir, revision = snapshot_local_repo("plain-folder", str(tmp_path / "cache"), str(local_root))

    snapshot = Path(snapshot_dir)
    assert revision == LOCAL_SNAPSHOT_REVISION
    assert (snapshot / "app.py").read_text(encoding="utf-8") == "print('local')\n"
    assert not (snapshot / ".git").exists()


def test_snapshot_and_workspace_copy_include_dirty_and_untracked_files_without_git(monkeypatch, tmp_path):
    local_root = tmp_path / "local-repos"
    source = local_root / "dirty-repo"
    local_root.mkdir()
    initialize_dirty_git_repo(source)
    reject_git_subprocesses(monkeypatch)

    snapshot_dir, snapshot_revision = snapshot_local_repo("dirty-repo", str(tmp_path / "cache"), str(local_root))
    workspace_dir, workspace_revision = copy_local_snapshot(snapshot_dir, str(tmp_path / "workspace"))

    for copied in (Path(snapshot_dir), Path(workspace_dir)):
        assert (copied / "tracked.txt").read_text(encoding="utf-8") == "modified working tree\n"
        assert (copied / "untracked.txt").read_text(encoding="utf-8") == "untracked working tree\n"
        assert not (copied / ".git").exists()
    assert snapshot_revision == LOCAL_SNAPSHOT_REVISION
    assert workspace_revision == LOCAL_SNAPSHOT_REVISION


def test_snapshot_local_repo_rejects_traversal_and_absolute_names(tmp_path):
    local_root = tmp_path / "local-repos"
    local_root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()

    for name in ("../outside", str(outside.resolve())):
        with pytest.raises(RepoError, match="directly under LOCAL_REPOS_PATH"):
            snapshot_local_repo(name, str(tmp_path / "cache"), str(local_root))


def test_snapshot_local_repo_rejects_top_level_symlink(tmp_path):
    local_root = tmp_path / "local-repos"
    actual = local_root / "actual"
    actual.mkdir(parents=True)
    (local_root / "linked").symlink_to(actual, target_is_directory=True)

    with pytest.raises(RepoError, match="must not be a symbolic link"):
        snapshot_local_repo("linked", str(tmp_path / "cache"), str(local_root))


@pytest.mark.parametrize("absolute", [False, True], ids=["relative", "absolute"])
def test_snapshot_local_repo_rejects_outbound_symlink(tmp_path, absolute):
    local_root = tmp_path / "local-repos"
    source = local_root / "repo"
    source.mkdir(parents=True)
    outside = local_root / "outside.txt"
    outside.write_text("outside\n", encoding="utf-8")
    target = str(outside.resolve()) if absolute else "../outside.txt"
    (source / "escape").symlink_to(target)

    expected = "absolute symbolic link" if absolute else "symbolic link outside its root"
    with pytest.raises(RepoError, match=expected):
        snapshot_local_repo("repo", str(tmp_path / "cache"), str(local_root))


def test_copy_local_snapshot_rejects_outbound_symlink(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    outside = tmp_path / "outside.txt"
    outside.write_text("outside\n", encoding="utf-8")
    (source / "escape").symlink_to("../outside.txt")

    with pytest.raises(RepoError, match="symbolic link outside its root"):
        copy_local_snapshot(str(source), str(tmp_path / "destination"))


def test_snapshot_local_repo_rejects_special_file(tmp_path):
    if not hasattr(os, "mkfifo"):
        pytest.skip("FIFO creation is unavailable on this platform")
    local_root = tmp_path / "local-repos"
    source = local_root / "repo"
    source.mkdir(parents=True)
    os.mkfifo(source / "named-pipe")

    with pytest.raises(RepoError, match="unsupported special file"):
        snapshot_local_repo("repo", str(tmp_path / "cache"), str(local_root))


def test_prepare_workspace_materializes_local_primary_and_dependency_without_git(monkeypatch, tmp_path):
    local_root = tmp_path / "local-repos"
    primary = local_root / "primary"
    dependency = local_root / "dependency"
    (primary / ".git").mkdir(parents=True)
    dependency.mkdir()
    (primary / "primary.py").write_text("PRIMARY = True\n", encoding="utf-8")
    (primary / "untracked.py").write_text("UNTRACKED = True\n", encoding="utf-8")
    (dependency / "dependency.py").write_text("DEPENDENCY = True\n", encoding="utf-8")
    monkeypatch.setenv("LOCAL_REPOS_PATH", str(local_root))
    configure_isolated_homes(monkeypatch, tmp_path)
    reject_git_subprocesses(monkeypatch)
    scan = local_scan(
        41,
        dependencies=[{"kind": "local", "repo_full": "dependency", "commit_sha": "HEAD"}],
    )

    prepared = prepare_dependency_workspace(
        data_dir=str(tmp_path / "data"),
        checkout_cache_dir=str(tmp_path / "cache"),
        metadata_id=99,
        scan=scan,
    )

    workspace = Path(prepared.repo_dir)
    dependency_entry = prepared.manifest["dependencies"][0]
    dependency_dir = workspace / dependency_entry["alias"]
    assert prepared.checked_out_commit == LOCAL_SNAPSHOT_REVISION
    assert prepared.manifest["primary"]["kind"] == "local"
    assert prepared.manifest["primary"]["requested_commit"] == LOCAL_SNAPSHOT_REVISION
    assert prepared.manifest["primary"]["commit"] == LOCAL_SNAPSHOT_REVISION
    assert dependency_entry["kind"] == "local"
    assert dependency_entry["requested_commit"] == LOCAL_SNAPSHOT_REVISION
    assert dependency_entry["commit"] == LOCAL_SNAPSHOT_REVISION
    assert (workspace / "primary.py").read_text(encoding="utf-8") == "PRIMARY = True\n"
    assert (workspace / "untracked.py").read_text(encoding="utf-8") == "UNTRACKED = True\n"
    assert (dependency_dir / "dependency.py").read_text(encoding="utf-8") == "DEPENDENCY = True\n"
    assert not (workspace / ".git").exists()
    assert (workspace / "WORKSPACE.json").is_file()


def test_local_cache_is_frozen_per_scan_and_fresh_for_new_scan(monkeypatch, tmp_path):
    local_root = tmp_path / "local-repos"
    source = local_root / "primary"
    source.mkdir(parents=True)
    source_file = source / "value.txt"
    source_file.write_text("first snapshot\n", encoding="utf-8")
    monkeypatch.setenv("LOCAL_REPOS_PATH", str(local_root))
    reject_git_subprocesses(monkeypatch)
    cache_dir = tmp_path / "cache"

    first = prewarm_scan_checkout_cache(checkout_cache_dir=str(cache_dir), scan=local_scan(101))
    first_path = Path(first["primary"]["cache_path"])
    source_file.write_text("second snapshot\n", encoding="utf-8")
    (source / "added-later.txt").write_text("new scan only\n", encoding="utf-8")

    repeated = prewarm_scan_checkout_cache(checkout_cache_dir=str(cache_dir), scan=local_scan(101))
    repeated_path = Path(repeated["primary"]["cache_path"])
    fresh = prewarm_scan_checkout_cache(checkout_cache_dir=str(cache_dir), scan=local_scan(102))
    fresh_path = Path(fresh["primary"]["cache_path"])

    assert repeated_path == first_path
    assert (repeated_path / "value.txt").read_text(encoding="utf-8") == "first snapshot\n"
    assert not (repeated_path / "added-later.txt").exists()
    assert fresh_path != first_path
    assert (fresh_path / "value.txt").read_text(encoding="utf-8") == "second snapshot\n"
    assert (fresh_path / "added-later.txt").read_text(encoding="utf-8") == "new scan only\n"


def test_local_cache_save_restore_uses_relative_marker(monkeypatch, tmp_path):
    local_root = tmp_path / "local-repos"
    source = local_root / "primary"
    source.mkdir(parents=True)
    (source / "value.txt").write_text("persisted snapshot\n", encoding="utf-8")
    monkeypatch.setenv("LOCAL_REPOS_PATH", str(local_root))
    reject_git_subprocesses(monkeypatch)
    scan = local_scan(201)
    cache_dir = tmp_path / "cache"
    persist_dir = tmp_path / "persist"

    warmed = prewarm_scan_checkout_cache(checkout_cache_dir=str(cache_dir), scan=scan)
    cache_repo = Path(warmed["primary"]["cache_path"])
    cache_base = cache_repo.parent
    saved = save_persistent_scan_checkout_cache(
        checkout_cache_dir=str(cache_dir),
        checkout_cache_persist_dir=str(persist_dir),
        scan=scan,
    )

    persisted_base = persist_dir / "scan-201" / "cache" / cache_base.name
    persisted_marker = json.loads((persisted_base / workspace_module.CACHE_READY_FILENAME).read_text(encoding="utf-8"))
    assert saved == [cache_base.name]
    assert persisted_marker["version"] == workspace_module.CACHE_MARKER_VERSION
    assert persisted_marker["kind"] == "local"
    assert persisted_marker["repo_dir"] == "primary"
    assert not Path(persisted_marker["repo_dir"]).is_absolute()

    shutil.rmtree(cache_dir)
    (source / "value.txt").write_text("source changed after save\n", encoding="utf-8")
    restored = restore_persistent_scan_checkout_cache(
        checkout_cache_dir=str(cache_dir),
        checkout_cache_persist_dir=str(persist_dir),
        scan=scan,
    )
    monkeypatch.setattr(
        workspace_module,
        "snapshot_local_repo",
        lambda *_args, **_kwargs: pytest.fail("a restored local cache must not resnapshot its source"),
    )
    rewarmed = prewarm_scan_checkout_cache(checkout_cache_dir=str(cache_dir), scan=scan)
    restored_repo = Path(rewarmed["primary"]["cache_path"])
    restored_marker = json.loads(
        (restored_repo.parent / workspace_module.CACHE_READY_FILENAME).read_text(encoding="utf-8")
    )

    assert restored == [cache_base.name]
    assert (restored_repo / "value.txt").read_text(encoding="utf-8") == "persisted snapshot\n"
    assert restored_marker["repo_dir"] == "primary"
    assert not Path(restored_marker["repo_dir"]).is_absolute()


def test_pinned_local_root_never_copies_outbound_symlink_swap(monkeypatch, tmp_path):
    local_root = tmp_path / "local-repos"
    selected = local_root / "selected"
    selected.mkdir(parents=True)
    (selected / "selected-only.txt").write_text("pinned repository\n", encoding="utf-8")
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "outside-only.txt").write_text("must not be copied\n", encoding="utf-8")
    renamed_selected = local_root / "selected-before-swap"
    original_copy = repository_module._copy_local_tree_from_fd
    swapped = False

    def swap_path_after_pin(source_fd, destination, source_label):
        nonlocal swapped
        selected.rename(renamed_selected)
        selected.symlink_to(outside, target_is_directory=True)
        swapped = True
        return original_copy(source_fd, destination, source_label)

    monkeypatch.setattr(repository_module, "_copy_local_tree_from_fd", swap_path_after_pin)
    cache_dir = tmp_path / "cache"

    try:
        snapshot_dir, revision = snapshot_local_repo("selected", str(cache_dir), str(local_root))
    except RepoError:
        snapshot_dir = None
    else:
        snapshot = Path(snapshot_dir)
        assert revision == LOCAL_SNAPSHOT_REVISION
        assert (snapshot / "selected-only.txt").read_text(encoding="utf-8") == "pinned repository\n"
        assert not (snapshot / "outside-only.txt").exists()

    assert swapped
    assert selected.is_symlink()
    assert not any(path.name == "outside-only.txt" for path in cache_dir.rglob("*"))


def test_workspace_manifest_ignores_repo_controlled_predictable_temp_symlink(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    external = tmp_path / "external.txt"
    external.write_text("do not overwrite\n", encoding="utf-8")
    (workspace / ".WORKSPACE.json.tmp").symlink_to(external)
    manifest = {"primary": {"kind": "local", "repo": "primary"}, "dependencies": []}
    manifest_json = json.dumps(manifest, sort_keys=True)

    workspace_module._write_workspace_files(
        str(workspace),
        manifest,
        "Primary repository: primary @ LOCAL_SNAPSHOT",
        manifest_json,
    )

    assert external.read_text(encoding="utf-8") == "do not overwrite\n"
    assert json.loads((workspace / "WORKSPACE.json").read_text(encoding="utf-8")) == manifest
    assert (workspace / "WORKSPACE.md").is_file()


def test_dependency_aliases_avoid_dangling_symlinks_and_workspace_manifest_names(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "dependency").symlink_to("missing-target", target_is_directory=True)

    dangling_alias = workspace_module._dependency_alias(str(workspace), "dependency", set())
    json_alias = workspace_module._dependency_alias(str(workspace), "WORKSPACE.json", set())
    markdown_alias = workspace_module._dependency_alias(str(workspace), "WORKSPACE.md", set())

    assert dangling_alias != "dependency"
    assert dangling_alias == "dependency__2"
    assert json_alias not in {"WORKSPACE.json", "WORKSPACE.md"}
    assert markdown_alias not in {"WORKSPACE.json", "WORKSPACE.md"}


def test_copy_cache_tree_publishes_only_after_staging_is_complete(monkeypatch, tmp_path):
    source = tmp_path / "source-cache"
    source_repo = source / "primary"
    source_repo.mkdir(parents=True)
    (source_repo / "value.txt").write_text("complete snapshot\n", encoding="utf-8")
    workspace_module._write_ready_cache_checkout(
        source,
        str(source_repo),
        LOCAL_SNAPSHOT_REVISION,
        kind="local",
    )
    target = tmp_path / "published-cache"
    real_copytree = shutil.copytree
    copy_complete = threading.Event()
    allow_publication = threading.Event()
    errors = []

    def fail_hardlink_copy(command, *_args, **_kwargs):
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="forced copytree path")

    def blocking_copytree(source_path, staging_path, *args, **kwargs):
        assert Path(staging_path) != target
        assert not target.exists()
        result = real_copytree(source_path, staging_path, *args, **kwargs)
        copy_complete.set()
        if not allow_publication.wait(timeout=5):
            raise AssertionError("test did not release staged cache publication")
        assert not target.exists()
        return result

    def copy_in_background():
        try:
            workspace_module._copy_cache_tree(source, target)
        except BaseException as exc:  # Surface thread failures in the test process.
            errors.append(exc)
            copy_complete.set()

    monkeypatch.setattr(workspace_module.subprocess, "run", fail_hardlink_copy)
    monkeypatch.setattr(workspace_module.shutil, "copytree", blocking_copytree)
    thread = threading.Thread(target=copy_in_background, daemon=True)
    thread.start()

    assert copy_complete.wait(timeout=5)
    assert not target.exists()
    allow_publication.set()
    thread.join(timeout=5)

    assert not thread.is_alive()
    assert errors == []
    assert (target / "primary" / "value.txt").read_text(encoding="utf-8") == "complete snapshot\n"
    assert workspace_module._read_ready_cache_checkout(target) == (
        str(target / "primary"),
        LOCAL_SNAPSHOT_REVISION,
    )


def test_copy_cache_tree_refuses_to_publish_incomplete_source(monkeypatch, tmp_path):
    source = tmp_path / "incomplete-cache"
    (source / "primary").mkdir(parents=True)
    (source / "primary" / "partial.txt").write_text("partial\n", encoding="utf-8")
    target = tmp_path / "published-cache"

    def fail_hardlink_copy(command, *_args, **_kwargs):
        return subprocess.CompletedProcess(command, 1, stdout="", stderr="forced copytree path")

    monkeypatch.setattr(workspace_module.subprocess, "run", fail_hardlink_copy)

    workspace_module._copy_cache_tree(source, target)

    assert not target.exists()

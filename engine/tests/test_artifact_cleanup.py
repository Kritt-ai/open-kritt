import os

from open_kritt_engine.artifact_cleanup import (
    cleanup_checkout_caches,
    cleanup_legacy_checkout_cache,
    cleanup_legacy_repo_cache,
    cleanup_legacy_scan_workspaces,
    cleanup_orphaned_job_workspaces,
    cleanup_persisted_scan_caches,
    delete_quarantined_artifacts,
)


def test_orphaned_job_cleanup_preserves_running_and_recent_workspaces(tmp_path):
    jobs = tmp_path / "jobs"
    active = jobs / "metadata-10"
    orphan = jobs / "metadata-11"
    recent = jobs / "metadata-12"
    unrelated = jobs / "notes"
    for path in (active, orphan, recent, unrelated):
        path.mkdir(parents=True)
        (path / "artifact").write_text("x", encoding="utf-8")
    os.utime(active, (100, 100))
    os.utime(orphan, (100, 100))
    os.utime(recent, (950, 950))

    removed = cleanup_orphaned_job_workspaces(
        str(tmp_path),
        active_workspace_ids={10},
        minimum_age_seconds=300,
        now=1000,
    )

    assert removed == 1
    assert active.exists()
    assert not orphan.exists()
    assert recent.exists()
    assert unrelated.exists()


def test_orphaned_job_cleanup_unlinks_only_matching_symlinks(tmp_path):
    jobs = tmp_path / "jobs"
    jobs.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    link = jobs / "metadata-20"
    link.symlink_to(outside, target_is_directory=True)

    assert cleanup_orphaned_job_workspaces(str(tmp_path), active_workspace_ids=set()) == 1
    assert not link.is_symlink()
    assert outside.exists()


def test_persisted_scan_cache_cleanup_keeps_only_retained_scans(tmp_path):
    cache = tmp_path / "persist"
    for name in ("scan-1", "scan-2", "scan-2.broken-20260707T131522Z", "scan-not-an-id"):
        (cache / name).mkdir(parents=True)

    removed = cleanup_persisted_scan_caches(str(cache), retained_scan_ids={2})

    assert removed == 2
    assert not (cache / "scan-1").exists()
    assert (cache / "scan-2").exists()
    assert not (cache / "scan-2.broken-20260707T131522Z").exists()
    assert (cache / "scan-not-an-id").exists()


def test_shared_checkout_cleanup_preserves_active_locks_and_recent_entries(tmp_path):
    cache = tmp_path / "checkout-cache"
    active = cache / "owner__active@commit"
    active_resolved_head = cache / "owner__head@resolved-commit"
    stale = cache / "owner__stale@commit"
    recent = cache / "owner__recent@commit"
    locks = cache / ".locks"
    for path in (active, active_resolved_head, stale, recent, locks):
        path.mkdir(parents=True)
    os.utime(active, (100, 100))
    os.utime(stale, (100, 100))
    os.utime(recent, (950, 950))

    removed = cleanup_checkout_caches(
        str(cache),
        retained_entry_names={active.name},
        retained_entry_prefixes={"owner__head@"},
        minimum_age_seconds=300,
        now=1000,
    )

    assert removed == 1
    assert active.exists()
    assert active_resolved_head.exists()
    assert not stale.exists()
    assert recent.exists()
    assert locks.exists()


def test_cleanup_can_quarantine_before_slow_recursive_deletion(tmp_path):
    cache = tmp_path / "persist"
    stale = cache / "scan-1"
    stale.mkdir(parents=True)
    (stale / "many-files").mkdir()
    (stale / "many-files" / "artifact").write_text("x", encoding="utf-8")
    quarantine = []

    removed = cleanup_persisted_scan_caches(
        str(cache),
        retained_scan_ids=set(),
        quarantine=quarantine,
    )

    assert removed == 1
    assert not stale.exists()
    assert len(quarantine) == 1
    assert quarantine[0].is_dir()
    assert delete_quarantined_artifacts(quarantine) == 1
    assert not quarantine[0].exists()


def test_legacy_scan_and_checkout_caches_are_removed_only_from_known_paths(tmp_path):
    legacy_scan = tmp_path / "scan-workspaces" / "workspace-1234567890abcdef12345678"
    unrelated_scan = tmp_path / "scan-workspaces" / "keep-me"
    legacy_checkout = tmp_path / "checkout-cache"
    for path in (legacy_scan, unrelated_scan, legacy_checkout):
        path.mkdir(parents=True)

    assert cleanup_legacy_scan_workspaces(str(tmp_path)) == 1
    assert not legacy_scan.exists()
    assert unrelated_scan.exists()
    assert cleanup_legacy_checkout_cache(str(tmp_path), str(tmp_path / "temporary-cache")) == 1
    assert not legacy_checkout.exists()


def test_configured_legacy_checkout_cache_is_never_removed(tmp_path):
    legacy_checkout = tmp_path / "checkout-cache"
    legacy_checkout.mkdir()

    assert cleanup_legacy_checkout_cache(str(tmp_path), str(legacy_checkout)) == 0
    assert legacy_checkout.exists()


def test_legacy_repo_cache_is_removed_unless_still_configured(tmp_path):
    legacy_repos = tmp_path / "repos"
    legacy_repos.mkdir()

    assert cleanup_legacy_repo_cache(str(tmp_path), str(tmp_path / "jobs")) == 1
    assert not legacy_repos.exists()

    legacy_repos.mkdir()
    assert cleanup_legacy_repo_cache(str(tmp_path), str(legacy_repos)) == 0
    assert legacy_repos.exists()

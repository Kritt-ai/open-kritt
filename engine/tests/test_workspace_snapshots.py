from subprocess import CompletedProcess

import open_kritt_engine.workspace_snapshots as workspace_snapshots
from open_kritt_engine.workspace_snapshots import workspace_snapshot_image_name, workspace_snapshot_key


def test_workspace_snapshot_key_is_stable_and_tracks_image_checkout_and_manifest():
    arguments = {
        "base_image_id": "sha256:base",
        "checkout_key": '{"repo":"owner/repo","commit":"abc"}',
        "manifest_json": '{"primary":{"path":"/workspace"}}',
    }

    first = workspace_snapshot_key(**arguments)
    assert first == workspace_snapshot_key(**arguments)
    assert first != workspace_snapshot_key(**{**arguments, "base_image_id": "sha256:other"})
    assert first != workspace_snapshot_key(**{**arguments, "checkout_key": '{"commit":"def"}'})
    assert first != workspace_snapshot_key(**{**arguments, "manifest_json": '{"dependencies":[]}'})
    assert workspace_snapshot_image_name(first).startswith("open-kritt-workspace-snapshot:")


def test_cleanup_stale_builders_preserves_snapshot_leases(monkeypatch):
    calls = []

    def fake_run(arguments, **_kwargs):
        calls.append(arguments)
        if arguments[:2] == ["ps", "--all"]:
            return CompletedProcess(arguments, 0, stdout="builder-id\nlease-id\n", stderr="")
        if arguments[-1] == "lease-id" and arguments[:2] == ["container", "inspect"]:
            return CompletedProcess(arguments, 0, stdout="1\n", stderr="")
        return CompletedProcess(arguments, 0, stdout="", stderr="")

    monkeypatch.setattr(workspace_snapshots, "_run_docker", fake_run)

    workspace_snapshots.cleanup_stale_workspace_snapshot_builders()

    removed = [arguments[-1] for arguments in calls if arguments[:2] == ["rm", "--force"]]
    assert removed == ["builder-id"]

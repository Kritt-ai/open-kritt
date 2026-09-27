import json
import os

from open_kritt_engine.poc_artifacts import MAX_FILES, capture_evidence


def result(poc_paths=(), impact_paths=(), chain_paths=()):
    return {
        "bug_status": "reproduced",
        "impact_status": "proven",
        "poc_artifact_paths": list(poc_paths),
        "impact_artifact_paths": list(impact_paths),
        "impact_chain": [{"id": "hop-1", "status": "proven", "evidence_paths": list(chain_paths)}],
    }


def workspace_with(tmp_path, names):
    workspace = tmp_path / "workspace"
    workspace.mkdir(exist_ok=True)
    for name in names:
        target = workspace / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(name)
    return workspace


def capture(tmp_path, workspace, record, metadata_id=20):
    return capture_evidence(
        str(tmp_path / "data"),
        str(workspace),
        scan_id=4,
        finding_id=9,
        metadata_id=metadata_id,
        result=record,
    )


def test_capture_unions_and_dedupes_declared_paths_and_survives_cleanup(tmp_path):
    workspace = workspace_with(tmp_path, ["poc.py", "attack.log", "logs/balances.json"])
    capture_result = capture(
        tmp_path,
        workspace,
        result(["poc.py", "attack.log"], ["attack.log", "./logs/balances.json"], ["logs/balances.json"]),
    )
    assert capture_result["capture_complete"] is True
    assert capture_result["captured_paths"] == ["poc.py", "attack.log", "logs/balances.json"]
    assert capture_result["unresolved_paths"] == []
    assert capture_result["artifact_dir"] == "poc-artifacts/scan-4/finding-9/metadata-20"
    assert capture_result["reason"] == ""
    assert MAX_FILES == 20

    stored = tmp_path / "data" / capture_result["artifact_dir"]
    manifest = json.loads((stored / "manifest.json").read_text())
    assert [entry["source"] for entry in manifest] == ["poc.py", "attack.log", "logs/balances.json"]
    assert {entry["file"] for entry in manifest} == {"poc.py", "attack.log", "balances.json"}
    assert all(entry["sha256"] for entry in manifest)
    for child in workspace.rglob("*"):
        if child.is_file():
            child.unlink()
    assert (stored / "balances.json").read_text() == "logs/balances.json"


def test_cap_overflow_marks_capture_incomplete_without_copying(tmp_path):
    names = [f"f{i}.log" for i in range(MAX_FILES + 1)]
    workspace = workspace_with(tmp_path, names)
    capture_result = capture(tmp_path, workspace, result(names))
    assert capture_result["capture_complete"] is False
    assert capture_result["artifact_dir"] == ""
    assert capture_result["captured_paths"] == []
    assert sorted(capture_result["unresolved_paths"]) == sorted(names)
    assert str(MAX_FILES) in capture_result["reason"]
    assert not (tmp_path / "data").exists()


def test_traversal_absolute_and_missing_paths_are_unresolved(tmp_path):
    workspace = workspace_with(tmp_path, ["attack.log"])
    (tmp_path / "secret").write_text("secret")
    capture_result = capture(
        tmp_path, workspace, result(["../secret", str(tmp_path / "secret"), "missing.log", "attack.log"])
    )
    assert capture_result["capture_complete"] is False
    assert capture_result["captured_paths"] == ["attack.log"]
    assert capture_result["unresolved_paths"] == ["../secret", str(tmp_path / "secret"), "missing.log"]
    assert capture_result["artifact_dir"]
    assert not (tmp_path / "data" / capture_result["artifact_dir"] / "secret").exists()


def test_symlinks_are_resolved_inside_the_workspace_only(tmp_path):
    workspace = workspace_with(tmp_path, ["real.log"])
    (tmp_path / "outside.log").write_text("outside")
    os.symlink(workspace / "real.log", workspace / "inside-link.log")
    os.symlink(tmp_path / "outside.log", workspace / "escape-link.log")
    capture_result = capture(tmp_path, workspace, result(["inside-link.log", "escape-link.log"]))
    assert capture_result["captured_paths"] == ["inside-link.log"]
    assert capture_result["unresolved_paths"] == ["escape-link.log"]
    assert capture_result["capture_complete"] is False
    stored = tmp_path / "data" / capture_result["artifact_dir"]
    assert (stored / "inside-link.log").read_text() == "real.log"
    assert not (stored / "escape-link.log").exists()


def test_duplicate_basenames_get_distinct_artifact_names(tmp_path):
    workspace = workspace_with(tmp_path, ["a/out.log", "b/out.log"])
    capture_result = capture(tmp_path, workspace, result(["a/out.log", "b/out.log"]))
    assert capture_result["capture_complete"] is True
    manifest = json.loads((tmp_path / "data" / capture_result["artifact_dir"] / "manifest.json").read_text())
    files = [entry["file"] for entry in manifest]
    assert len(set(files)) == 2


def test_no_declared_paths_is_complete_without_an_artifact_dir(tmp_path):
    workspace = workspace_with(tmp_path, [])
    capture_result = capture(tmp_path, workspace, result())
    assert capture_result == {
        "artifact_dir": "",
        "captured_paths": [],
        "unresolved_paths": [],
        "capture_complete": True,
        "reason": "",
    }


def test_missing_workspace_is_reported_not_raised(tmp_path):
    capture_result = capture(tmp_path, tmp_path / "nope", result(["attack.log"]))
    assert capture_result["capture_complete"] is False
    assert capture_result["artifact_dir"] == ""
    assert capture_result["reason"]

import shutil
from pathlib import Path
from subprocess import CompletedProcess

import pytest

import open_kritt_engine.workspace_snapshots as workspace_snapshots
from open_kritt_engine.known_issues import (
    CORPUS_DIR,
    build_known_issues_corpus,
    find_known_issue_pdfs,
    pdftotext_converter,
)
from open_kritt_engine.workspace import workspace_layout

MINIMAL_PDF = b"""%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 52>>stream
BT /F1 12 Tf 10 50 Td (SSV-17 Stale Cluster Balance) Tj ET
endstream endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
"""


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    for relative in (
        "contracts/audits/2026-04-10_Quantstamp_v2.0.0.pdf",
        "docs/security-review.pdf",
        "lib/openzeppelin/audits/2017-03.pdf",
        "node_modules/pkg/audit.pdf",
        "docs/whitepaper.pdf",
    ):
        path = repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"%PDF-1.4 " + relative.encode())
    return repo


def test_finds_audit_pdfs_and_skips_vendored_and_unrelated_documents(tmp_path):
    assert find_known_issue_pdfs(_repo(tmp_path)) == [
        "contracts/audits/2026-04-10_Quantstamp_v2.0.0.pdf",
        "docs/security-review.pdf",
    ]


def test_builds_text_corpus_and_index_outside_the_source_tree(tmp_path):
    repo = _repo(tmp_path)
    target = tmp_path / "workspace"
    target.mkdir()

    entries = build_known_issues_corpus(
        repo, target, cache_dir=tmp_path / "cache", converter=lambda _path: "page one\fpage two\f"
    )

    assert [entry["source"] for entry in entries] == [
        "contracts/audits/2026-04-10_Quantstamp_v2.0.0.pdf",
        "docs/security-review.pdf",
    ]
    first = entries[0]
    assert first["status"] == "converted"
    assert first["pages"] == 2
    assert len(first["sha256"]) == 64
    text = target / first["text_path"]
    assert text.parent == target / CORPUS_DIR
    assert "page two" in text.read_text(encoding="utf-8")
    index = (target / CORPUS_DIR / "INDEX.md").read_text(encoding="utf-8")
    assert "contracts/audits/2026-04-10_Quantstamp_v2.0.0.pdf" in index
    assert first["text_path"] in index
    assert not (repo / CORPUS_DIR).exists()


def test_reuses_cached_text_for_an_unchanged_pdf(tmp_path):
    repo = _repo(tmp_path)
    cache = tmp_path / "cache"
    first_target, second_target = tmp_path / "one", tmp_path / "two"
    first_target.mkdir()
    second_target.mkdir()
    build_known_issues_corpus(repo, first_target, cache_dir=cache, converter=lambda _path: "cached text\f")

    def fail(_path):
        raise AssertionError("converter must not run for a cached PDF")

    entries = build_known_issues_corpus(repo, second_target, cache_dir=cache, converter=fail)

    assert all(entry["status"] == "converted" for entry in entries)
    assert "cached text" in (second_target / entries[0]["text_path"]).read_text(encoding="utf-8")


def test_marks_a_pdf_that_cannot_be_converted_as_unreadable(tmp_path):
    repo = _repo(tmp_path)
    target = tmp_path / "workspace"
    target.mkdir()

    def broken(_path):
        raise RuntimeError("syntax error")

    entries = build_known_issues_corpus(repo, target, cache_dir=tmp_path / "cache", converter=broken)

    assert {entry["status"] for entry in entries} == {"unreadable"}
    assert all(entry["text_path"] is None for entry in entries)
    assert "unreadable" in (target / CORPUS_DIR / "INDEX.md").read_text(encoding="utf-8")


def test_repository_without_audit_pdfs_builds_no_corpus(tmp_path):
    repo = tmp_path / "repo"
    (repo / "src").mkdir(parents=True)
    target = tmp_path / "workspace"
    target.mkdir()

    assert build_known_issues_corpus(repo, target, cache_dir=tmp_path / "cache", converter=str) == []
    assert not (target / CORPUS_DIR).exists()


@pytest.mark.skipif(shutil.which("pdftotext") is None, reason="requires poppler pdftotext")
def test_pdftotext_converter_extracts_real_pdf_text(tmp_path):
    pdf = tmp_path / "audit.pdf"
    pdf.write_bytes(MINIMAL_PDF)
    assert "SSV-17 Stale Cluster Balance" in pdftotext_converter(pdf)


def test_workspace_layout_points_the_model_at_the_known_issues_corpus():
    manifest = {
        "primary": {"repo": "owner/repo", "commit": "abc"},
        "dependencies": [],
        "known_issues": [
            {"source": "audits/a.pdf", "text_path": f"{CORPUS_DIR}/audits_a.txt", "status": "converted", "pages": 3},
            {"source": "audits/b.pdf", "text_path": None, "status": "unreadable", "pages": 0},
        ],
    }

    layout = workspace_layout("/workspace", manifest)

    assert f"{CORPUS_DIR}/INDEX.md" in layout
    assert "before claiming novelty" in layout
    assert "1 unreadable" in layout


def test_workspace_layout_without_corpus_is_unchanged():
    manifest = {"primary": {"repo": "owner/repo", "commit": "abc"}, "dependencies": []}
    assert "known-issues" not in workspace_layout("/workspace", manifest)


def test_snapshot_image_includes_the_known_issues_corpus(tmp_path, monkeypatch):
    files = tmp_path / "files"
    (files / CORPUS_DIR).mkdir(parents=True)
    (files / CORPUS_DIR / "INDEX.md").write_text("index\n", encoding="utf-8")
    (files / "WORKSPACE.json").write_text("{}\n", encoding="utf-8")
    (files / "WORKSPACE.md").write_text("# ws\n", encoding="utf-8")
    source = tmp_path / "source"
    source.mkdir()
    calls = []
    published = {"key": None}

    def fake_run(arguments, **_kwargs):
        calls.append(arguments)
        if arguments[:1] == ["commit"]:
            published["key"] = "ready"
        return CompletedProcess(arguments, 0, stdout="", stderr="")

    monkeypatch.setattr(workspace_snapshots, "_run_docker", fake_run)
    monkeypatch.setattr(workspace_snapshots, "_base_image_id", lambda _image: "sha256:base")
    monkeypatch.setattr(
        workspace_snapshots,
        "_image_snapshot_key",
        lambda _image: (
            published["key"]
            and workspace_snapshots.workspace_snapshot_key(
                base_image_id="sha256:base", checkout_key="k", manifest_json="{}"
            )
        ),
    )
    monkeypatch.setattr(workspace_snapshots, "_ensure_snapshot_lease", lambda *_args: None)

    workspace_snapshots.ensure_workspace_snapshot_image(
        base_image="base",
        checkout_key="k",
        manifest_json="{}",
        workspace_files_dir=str(files),
        sources=[(str(source), "/workspace")],
    )

    copies = [arguments for arguments in calls if arguments[:1] == ["cp"]]
    assert any(
        arguments[1] == str(files / ".open-kritt") and arguments[2].endswith(":/workspace/.open-kritt")
        for arguments in copies
    )

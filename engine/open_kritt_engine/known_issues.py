"""Searchable text corpus of a target's own audit reports.

Audit reports usually ship as PDFs, which models cannot search, so novelty
checks against them stay unverified. The engine converts in-repository audit
PDFs to text once, caches the result by content hash, and places the text
beside the workspace metadata (outside the scanned source tree).
"""

import hashlib
import json
import os
import re
import subprocess
import tempfile
from collections.abc import Callable
from pathlib import Path
from typing import Any

ENGINE_WORKSPACE_DIR = ".open-kritt"
CORPUS_DIR = f"{ENGINE_WORKSPACE_DIR}/known-issues"
AUDIT_NAME = re.compile(r"audit|security|review|assessment|pentest", re.IGNORECASE)
SKIP_DIRS = frozenset(
    {".git", ".open-kritt", "lib", "node_modules", "vendor", "out", "cache", "build", "dist", "target", "artifacts"}
)
MAX_PDF_BYTES = 50 * 1024 * 1024
MAX_PDFS = 40
CONVERT_TIMEOUT_SECONDS = 120

Converter = Callable[[Path], str]


def pdftotext_converter(path: Path) -> str:
    completed = subprocess.run(
        ["pdftotext", "-layout", "-enc", "UTF-8", str(path), "-"],
        capture_output=True,
        timeout=CONVERT_TIMEOUT_SECONDS,
        check=True,
    )
    return completed.stdout.decode("utf-8", errors="replace")


def find_known_issue_pdfs(source_root: Path) -> list[str]:
    root = Path(source_root)
    found: list[str] = []
    for directory, subdirs, names in os.walk(root):
        subdirs[:] = sorted(name for name in subdirs if name not in SKIP_DIRS)
        for name in sorted(names):
            if not name.lower().endswith(".pdf"):
                continue
            relative = (Path(directory) / name).relative_to(root)
            if AUDIT_NAME.search(str(relative)) and (Path(directory) / name).stat().st_size <= MAX_PDF_BYTES:
                found.append(relative.as_posix())
                if len(found) >= MAX_PDFS:
                    return found
    return found


def _text_name(relative: str) -> str:
    stem = re.sub(r"[^A-Za-z0-9_.-]+", "_", relative.removesuffix(".pdf")).strip("._-")
    return f"{stem or 'audit'}.txt"


def _cached_text(cache_dir: Path, digest: str, pdf: Path, converter: Converter) -> str:
    cached = cache_dir / f"{digest}.txt"
    if cached.is_file():
        return cached.read_text(encoding="utf-8")
    text = converter(pdf)
    cache_dir.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(dir=cache_dir, prefix=f".{digest}.", suffix=".tmp")
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(text)
    os.replace(temporary, cached)
    return text


def _index(entries: list[dict[str, Any]]) -> str:
    lines = [
        "# Known-issue corpus",
        "",
        "Text extracted from the target's own audit reports. Search these files (search_text / grep) for the",
        "root cause, affected function, and invariant before claiming a finding is novel.",
        "",
    ]
    for entry in entries:
        if entry["status"] == "converted":
            lines.append(f"- {entry['source']} -> {entry['text_path']} ({entry['pages']} pages)")
        else:
            lines.append(f"- {entry['source']} -> unreadable ({entry['error']}); novelty against it is unverified")
    return "\n".join(lines) + "\n"


def build_known_issues_corpus(
    source_root: Path,
    target_root: Path,
    *,
    cache_dir: Path,
    converter: Converter = pdftotext_converter,
) -> list[dict[str, Any]]:
    sources = find_known_issue_pdfs(Path(source_root))
    if not sources:
        return []
    corpus = Path(target_root) / CORPUS_DIR
    corpus.mkdir(parents=True, exist_ok=True)
    entries: list[dict[str, Any]] = []
    for relative in sources:
        pdf = Path(source_root) / relative
        digest = hashlib.sha256(pdf.read_bytes()).hexdigest()
        entry: dict[str, Any] = {"source": relative, "sha256": digest}
        try:
            text = _cached_text(Path(cache_dir), digest, pdf, converter)
        except Exception as exc:  # any converter failure leaves an explicit gap
            entries.append(
                {**entry, "status": "unreadable", "text_path": None, "pages": 0, "error": type(exc).__name__}
            )
            continue
        text_path = f"{CORPUS_DIR}/{_text_name(relative)}"
        (Path(target_root) / text_path).write_text(text, encoding="utf-8")
        pages = text.count("\f") or (1 if text.strip() else 0)
        entries.append({**entry, "status": "converted", "text_path": text_path, "pages": pages})
    (corpus / "INDEX.md").write_text(_index(entries), encoding="utf-8")
    (corpus / "index.json").write_text(json.dumps(entries, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return entries

import json
import logging
import re
import shutil
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

LOGGER = logging.getLogger("open_kritt_engine")
MODEL_ERROR_OUTPUT_DIR = "model-error-outputs"
MODEL_ERROR_OUTPUT_LIMIT = 5
_MODEL_ERROR_OUTPUT_LOCK = threading.Lock()


def _safe_file_name(name: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(name).name).strip("._")
    return safe or "output.txt"


def _write_text(path: Path, text: str):
    path.write_text(text, encoding="utf-8", errors="replace")


def _rotate_outputs(root: Path):
    entries = []
    for path in root.iterdir():
        if not path.is_dir() or path.name.startswith("."):
            continue
        try:
            entries.append((path.stat().st_mtime_ns, path.name, path))
        except OSError:
            continue
    entries.sort(reverse=True)
    for _mtime, _name, stale in entries[MODEL_ERROR_OUTPUT_LIMIT:]:
        shutil.rmtree(stale, ignore_errors=True)


def record_model_error_output(
    data_dir: str,
    *,
    scan_id: int,
    metadata_id: int,
    attempt: int,
    error: BaseException | str,
    output: Any,
    kind: str = "step",
    workflow_id: int | None = None,
    step_id: int | None = None,
) -> str | None:
    created_at = datetime.now(timezone.utc)
    root = Path(data_dir) / MODEL_ERROR_OUTPUT_DIR
    timestamp = created_at.strftime("%Y%m%dT%H%M%S.%fZ")
    dirname = f"{timestamp}-{time.time_ns()}-{kind}-scan-{scan_id}-metadata-{metadata_id}-attempt-{attempt}"
    if step_id is not None:
        dirname += f"-step-{step_id}"
    final_path = root / dirname
    tmp_path = root / f".{dirname}.tmp"

    stdout = str(getattr(output, "stdout", "") or "")
    stderr = str(getattr(output, "stderr", "") or "")
    files = getattr(output, "files", None) or {}
    returncode = getattr(output, "returncode", None)

    try:
        with _MODEL_ERROR_OUTPUT_LOCK:
            root.mkdir(parents=True, exist_ok=True)
            root.chmod(0o700)
            if tmp_path.exists():
                shutil.rmtree(tmp_path, ignore_errors=True)
            tmp_path.mkdir()
            _write_text(tmp_path / "stdout.txt", stdout)
            _write_text(tmp_path / "stderr.txt", stderr)
            _write_text(tmp_path / "error.txt", str(error))

            written_files = ["stdout.txt", "stderr.txt", "error.txt"]
            reserved = set(written_files) | {"metadata.json"}
            for name, contents in sorted(files.items()):
                safe_name = _safe_file_name(str(name))
                if safe_name in reserved:
                    safe_name = f"model-{safe_name}"
                _write_text(tmp_path / safe_name, str(contents or ""))
                written_files.append(safe_name)
                reserved.add(safe_name)

            metadata = {
                "created_at": created_at.isoformat().replace("+00:00", "Z"),
                "kind": kind,
                "scan_id": scan_id,
                "workflow_id": workflow_id,
                "step_id": step_id,
                "metadata_id": metadata_id,
                "attempt": attempt,
                "error": str(error),
                "returncode": returncode,
                "stdout_bytes": len(stdout.encode("utf-8")),
                "stderr_bytes": len(stderr.encode("utf-8")),
                "files": written_files,
            }
            _write_text(tmp_path / "metadata.json", json.dumps(metadata, indent=2, sort_keys=True))
            tmp_path.rename(final_path)
            _rotate_outputs(root)
    except OSError:
        LOGGER.exception("failed to record model error output for scan %s metadata %s", scan_id, metadata_id)
        return None
    return str(final_path)

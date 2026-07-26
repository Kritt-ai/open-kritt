import os
from pathlib import Path

RUNTIME_CONFIG_FILENAME = "engine-runtime.env"
RUNTIME_ENV_ALIASES = {
    "ENGINE_WORKER_COUNT": ("ENGINE_WORKER_COUNT", "ENGINE_WORKERS"),
    "ENGINE_MAX_CONCURRENT_SCANS": ("ENGINE_MAX_CONCURRENT_SCANS",),
    "ENGINE_MAX_WORKERS_PER_SCAN": ("ENGINE_MAX_WORKERS_PER_SCAN",),
    "ENGINE_AUTOSCALE_SCAN_WORKERS_ON_PROVIDER_CAPACITY": ("ENGINE_AUTOSCALE_SCAN_WORKERS_ON_PROVIDER_CAPACITY",),
    "ENGINE_CODEX_HOME": ("ENGINE_CODEX_HOME", "CODEX_HOME"),
    "ENGINE_CLAUDE_HOME": ("ENGINE_CLAUDE_HOME", "CLAUDE_HOME"),
    "ENGINE_WORKSPACE_SETUP_CONCURRENCY": ("ENGINE_WORKSPACE_SETUP_CONCURRENCY",),
    "ENGINE_RETRY_COUNT": ("ENGINE_RETRY_COUNT",),
    "ENGINE_HARNESS_TIMEOUT_SECONDS": ("ENGINE_HARNESS_TIMEOUT_SECONDS",),
}


def runtime_config_path(data_dir: str | None = None) -> Path:
    raw = os.getenv("ENGINE_RUNTIME_CONFIG_PATH")
    if raw:
        return Path(raw)
    return Path(data_dir or os.getenv("ENGINE_DATA_DIR", "/data")) / RUNTIME_CONFIG_FILENAME


def ensure_runtime_config_file(data_dir: str | None = None) -> Path:
    path = runtime_config_path(data_dir)
    if path.exists():
        return path

    path.parent.mkdir(parents=True, exist_ok=True)
    values = {
        "ENGINE_WORKER_COUNT": os.getenv("ENGINE_WORKER_COUNT") or os.getenv("ENGINE_WORKERS") or "2",
        "ENGINE_MAX_CONCURRENT_SCANS": os.getenv("ENGINE_MAX_CONCURRENT_SCANS") or "1",
        "ENGINE_MAX_WORKERS_PER_SCAN": os.getenv("ENGINE_MAX_WORKERS_PER_SCAN") or "0",
        "ENGINE_AUTOSCALE_SCAN_WORKERS_ON_PROVIDER_CAPACITY": os.getenv(
            "ENGINE_AUTOSCALE_SCAN_WORKERS_ON_PROVIDER_CAPACITY"
        )
        or "true",
        "ENGINE_CODEX_HOME": os.getenv("ENGINE_CODEX_HOME") or os.getenv("CODEX_HOME") or "/root/.codex",
        "ENGINE_CLAUDE_HOME": os.getenv("ENGINE_CLAUDE_HOME") or os.getenv("CLAUDE_HOME") or "/root/.claude",
        "ENGINE_WORKSPACE_SETUP_CONCURRENCY": os.getenv("ENGINE_WORKSPACE_SETUP_CONCURRENCY") or "2",
        "ENGINE_RETRY_COUNT": os.getenv("ENGINE_RETRY_COUNT") or "2",
        "ENGINE_HARNESS_TIMEOUT_SECONDS": os.getenv("ENGINE_HARNESS_TIMEOUT_SECONDS") or "7200",
    }

    lines = [
        "# open-kritt live engine runtime config",
        "# Edit this file while the engine is running to change future job pickup.",
        "# Explicit environment values are synced here once at each engine startup.",
        "# Existing Codex calls keep their current account until they finish.",
        "# ENGINE_WORKER_COUNT=0 pauses new job pickup without killing running jobs.",
        "# ENGINE_MAX_CONCURRENT_SCANS caps immediate scans; queued work waits for an empty active pool.",
        "# ENGINE_MAX_WORKERS_PER_SCAN=0 shares workers evenly; a positive value adds a hard per-scan cap.",
        "# ENGINE_AUTOSCALE_SCAN_WORKERS_ON_PROVIDER_CAPACITY lowers only the affected scan's cap after provider throttles.",
        "# ENGINE_RETRY_COUNT and ENGINE_HARNESS_TIMEOUT_SECONDS apply to future model calls.",
        "# ENGINE_WORKSPACE_SETUP_CONCURRENCY requires an engine recreation to take effect.",
        "# ENGINE_CODEX_HOME is the Codex home copied into future job workspaces.",
        "# ENGINE_CLAUDE_HOME is the Claude home copied into future job workspaces.",
        "",
    ]
    lines.extend(f"{key}={_quote_env_value(value)}" for key, value in values.items())
    lines.append("")
    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text("\n".join(lines), encoding="utf-8")
    os.replace(tmp_path, path)
    return path


def sync_runtime_config_file(data_dir: str | None = None) -> Path:
    """Apply explicitly supplied startup environment values to the live config.

    The runtime file remains the source for live account selection. Once
    ENGINE_CODEX_HOME exists there, preserve Accounts/setup changes across engine
    restarts instead of restoring a stale Compose environment value.
    """
    path = ensure_runtime_config_file(data_dir)
    updates: dict[str, str] = {}
    for runtime_name, aliases in RUNTIME_ENV_ALIASES.items():
        for env_name in aliases:
            if env_name in os.environ:
                updates[runtime_name] = os.environ[env_name]
                break
    if not updates:
        return path

    try:
        original = path.read_text(encoding="utf-8")
    except OSError:
        return path
    lines = original.splitlines()
    found: set[str] = set()
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("export "):
            stripped = stripped[len("export ") :].strip()
        if "=" not in stripped or stripped.startswith("#"):
            continue
        key = stripped.split("=", 1)[0].strip()
        if key in updates:
            found.add(key)
            if key not in {"ENGINE_CODEX_HOME", "ENGINE_CLAUDE_HOME"}:
                lines[index] = f"{key}={_quote_env_value(updates[key])}"
    remaining = {key: value for key, value in updates.items() if key not in found}
    if remaining:
        if lines and lines[-1]:
            lines.append("")
        lines.extend(f"{key}={_quote_env_value(value)}" for key, value in remaining.items())
    updated = "\n".join(lines) + "\n"
    if updated == original:
        return path

    tmp_path = path.with_suffix(path.suffix + ".tmp")
    tmp_path.write_text(updated, encoding="utf-8")
    os.replace(tmp_path, path)
    return path


def read_runtime_config(data_dir: str | None = None) -> dict[str, str]:
    path = ensure_runtime_config_file(data_dir)
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return {}
    return parse_env_text(text)


def runtime_value(name: str, default: str | None = None, *, data_dir: str | None = None) -> str | None:
    if data_dir is None:
        return os.getenv(name, default)
    value = read_runtime_config(data_dir).get(name)
    if value is not None:
        return value
    return os.getenv(name, default)


def runtime_int(
    name: str,
    default: int,
    *,
    data_dir: str | None = None,
    minimum: int | None = None,
    maximum: int | None = None,
) -> int:
    raw = runtime_value(name, str(default), data_dir=data_dir)
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        return default
    if minimum is not None and value < minimum:
        return default
    if maximum is not None and value > maximum:
        return default
    return value


def runtime_bool(name: str, default: bool, *, data_dir: str | None = None) -> bool:
    raw = runtime_value(name, "true" if default else "false", data_dir=data_dir)
    normalized = str(raw or "").strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    return default


def parse_env_text(text: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        values[key] = _unquote_env_value(value.strip())
    return values


def _quote_env_value(value: str) -> str:
    value = str(value)
    if not value or any(ch.isspace() for ch in value) or any(ch in value for ch in "\"'#"):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def _unquote_env_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        body = value[1:-1]
        if value[0] == '"':
            return body.replace('\\"', '"').replace("\\\\", "\\")
        return body
    return value

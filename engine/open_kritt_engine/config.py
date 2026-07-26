import os
from dataclasses import dataclass
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from .runtime_config import runtime_int, sync_runtime_config_file


def _float_env(name, default):
    raw = os.getenv(name)
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _bool_env(name, default):
    raw = os.getenv(name)
    if not raw:
        return default
    value = raw.strip().lower()
    if value in {"1", "true", "yes", "on"}:
        return True
    if value in {"0", "false", "no", "off"}:
        return False
    return default


def psycopg_database_url(url):
    """Prisma URLs may include ?schema=public; libpq does not accept it."""
    parts = urlsplit(url)
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True) if k != "schema"]
    return urlunsplit((parts.scheme, parts.netloc, parts.path, urlencode(query), parts.fragment))


@dataclass(frozen=True)
class EngineConfig:
    database_url: str
    poll_seconds: float
    worker_count: int
    workspace_setup_concurrency: int
    retry_count: int
    harness_timeout_seconds: int
    data_dir: str
    min_free_storage_bytes: int
    scan_cache_retention_days: float
    checkout_cache_dir: str
    checkout_cache_persist_dir: str | None
    repo_dir: str
    github_token: str | None
    codex_model_provider: str | None
    model_catalog_refresh_seconds: float
    model_catalog_timeout_seconds: float
    codex_auto_update: bool
    codex_update_interval_seconds: float
    codex_update_timeout_seconds: float

    @classmethod
    def from_env(cls):
        raw_db = os.getenv(
            "DATABASE_URL",
            "postgresql://open_kritt:open_kritt_password@db:5432/open_kritt?schema=public",
        )
        data_dir = os.getenv("ENGINE_DATA_DIR", "/data")
        sync_runtime_config_file(data_dir)
        worker_count = runtime_int(
            "ENGINE_WORKER_COUNT",
            2,
            data_dir=data_dir,
            minimum=0,
            maximum=128,
        )
        setup_concurrency = runtime_int(
            "ENGINE_WORKSPACE_SETUP_CONCURRENCY",
            2,
            data_dir=data_dir,
            minimum=1,
            maximum=32,
        )
        return cls(
            database_url=psycopg_database_url(raw_db),
            poll_seconds=_float_env("ENGINE_POLL_SECONDS", 5.0),
            worker_count=worker_count,
            workspace_setup_concurrency=setup_concurrency,
            retry_count=runtime_int("ENGINE_RETRY_COUNT", 2, data_dir=data_dir, minimum=0, maximum=10),
            harness_timeout_seconds=runtime_int(
                "ENGINE_HARNESS_TIMEOUT_SECONDS",
                7200,
                data_dir=data_dir,
                minimum=60,
                maximum=86400,
            ),
            data_dir=data_dir,
            min_free_storage_bytes=int(max(0.0, _float_env("ENGINE_MIN_FREE_STORAGE_GB", 20.0)) * 1024**3),
            scan_cache_retention_days=max(0.0, _float_env("ENGINE_SCAN_CACHE_RETENTION_DAYS", 7.0)),
            checkout_cache_dir=os.getenv("ENGINE_CHECKOUT_CACHE_DIR", os.path.join(data_dir, "checkout-cache")),
            checkout_cache_persist_dir=os.getenv("ENGINE_CHECKOUT_CACHE_PERSIST_DIR") or None,
            repo_dir=os.getenv("ENGINE_REPO_DIR", os.path.join(data_dir, "jobs")),
            github_token=os.getenv("GITHUB_TOKEN") or None,
            codex_model_provider=os.getenv("CODEX_MODEL_PROVIDER") or None,
            model_catalog_refresh_seconds=max(30.0, _float_env("ENGINE_MODEL_CATALOG_REFRESH_SECONDS", 300.0)),
            model_catalog_timeout_seconds=max(1.0, _float_env("ENGINE_MODEL_CATALOG_TIMEOUT_SECONDS", 10.0)),
            codex_auto_update=_bool_env("ENGINE_CODEX_AUTO_UPDATE", False),
            codex_update_interval_seconds=max(60.0, _float_env("ENGINE_CODEX_UPDATE_INTERVAL_SECONDS", 86400.0)),
            codex_update_timeout_seconds=max(10.0, _float_env("ENGINE_CODEX_UPDATE_TIMEOUT_SECONDS", 120.0)),
        )

#!/usr/bin/env python3
import base64
import hashlib
import hmac
import ipaddress
import json
import os
import re
import secrets
import time
import uuid
from collections import defaultdict
from datetime import date, datetime, timezone
from decimal import Decimal
from http.cookies import CookieError, SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from math import isfinite
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib import error as urlerror
from urllib import request as urlrequest

import psycopg
from psycopg.rows import dict_row


def bind_address_is_loopback(value):
    address = (value or "").strip().lower().strip("[]").rstrip(".")
    if address == "localhost":
        return True
    try:
        return ipaddress.ip_address(address).is_loopback
    except ValueError:
        return False


DATABASE_URL = os.getenv(
    "EXECUTOR_VIEW_DATABASE_URL",
    os.getenv(
        "DATABASE_URL",
        "postgresql://open_kritt:open_kritt_password@localhost:5432/open_kritt",
    ),
)
HOST = os.getenv("EXECUTOR_VIEW_HOST", "127.0.0.1")
PORT = int(os.getenv("EXECUTOR_VIEW_PORT", "8090"))
PUBLISHED_BIND_ADDRESS = os.getenv("EXECUTOR_VIEW_PUBLISHED_BIND_ADDRESS", HOST).strip()
REQUIRE_AUTH = os.getenv("EXECUTOR_VIEW_REQUIRE_AUTH", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
} or not bind_address_is_loopback(PUBLISHED_BIND_ADDRESS)
ACCESS_TOKEN_CONFIGURED = bool(os.getenv("EXECUTOR_VIEW_ACCESS_TOKEN", "").strip())
ACCESS_TOKEN = os.getenv(
    "EXECUTOR_VIEW_ACCESS_TOKEN", ""
).strip() or secrets.token_urlsafe(32)
SESSION_TOKEN = hmac.new(
    ACCESS_TOKEN.encode("utf-8"), b"open-kritt-executor-view-session", hashlib.sha256
).hexdigest()
INTERNAL_TOKEN_FILE = os.getenv("EXECUTOR_VIEW_INTERNAL_TOKEN_FILE", "").strip()


def load_or_create_internal_token():
    configured = os.getenv("EXECUTOR_VIEW_INTERNAL_TOKEN", "").strip()
    if configured:
        return configured
    if not INTERNAL_TOKEN_FILE:
        return ""
    path = Path(INTERNAL_TOKEN_FILE)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        descriptor = None
    if descriptor is not None:
        try:
            os.write(descriptor, (secrets.token_urlsafe(32) + "\n").encode("utf-8"))
        finally:
            os.close(descriptor)
    try:
        path.chmod(0o600)
        if path.stat().st_size > 4096:
            return ""
        return path.read_text(encoding="utf-8").strip()
    except OSError:
        return ""


INTERNAL_ACCESS_TOKEN = load_or_create_internal_token()
ALLOWED_HOSTS = {
    part.strip().lower().rstrip(".")
    for part in os.getenv("EXECUTOR_VIEW_ALLOWED_HOSTS", "").split(",")
    if part.strip()
}
ALLOWED_HOSTS.update(
    part.strip().lower().rstrip(".")
    for part in os.getenv("EXECUTOR_VIEW_INTERNAL_HOSTS", "").split(",")
    if part.strip()
)
SECURE_COOKIE = os.getenv("EXECUTOR_VIEW_SECURE_COOKIE", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
STEP_RESULTS_TABLE = "workflows.step_results"
CODEX_HOME_RAW = os.getenv(
    "EXECUTOR_VIEW_CODEX_HOME",
    os.getenv("ENGINE_CODEX_HOME", os.getenv("CODEX_HOME", "/root/.codex")),
)
CLAUDE_HOME_RAW = os.getenv(
    "EXECUTOR_VIEW_CLAUDE_HOME", os.getenv("CLAUDE_HOME", "/root/.claude")
)
CODEX_ACCOUNTS_ROOT = Path(
    os.getenv("EXECUTOR_VIEW_CODEX_ACCOUNTS_ROOT", "/codex-accounts")
).expanduser()
CODEX_PRIMARY_HOME = Path(
    os.getenv("EXECUTOR_VIEW_CODEX_PRIMARY_HOME", "/root/.codex")
).expanduser()
PROVIDER_CREDENTIALS_PATH = Path(
    os.getenv("OPEN_KRITT_PROVIDER_CREDENTIALS_PATH", "/credentials/providers.json")
).expanduser()
ENGINE_DATA_DIR = Path(
    os.getenv("EXECUTOR_VIEW_ENGINE_DATA_DIR", os.getenv("ENGINE_DATA_DIR", "/data"))
)
ENGINE_RUNTIME_CONFIG_PATH = Path(
    os.getenv(
        "EXECUTOR_VIEW_ENGINE_RUNTIME_CONFIG_PATH",
        os.getenv(
            "ENGINE_RUNTIME_CONFIG_PATH", str(ENGINE_DATA_DIR / "engine-runtime.env")
        ),
    )
)
CODEX_ACCOUNT_CACHE_SECONDS = int(
    os.getenv("EXECUTOR_VIEW_CODEX_ACCOUNT_CACHE_SECONDS", "20")
)
CODEX_USAGE_URL = os.getenv(
    "EXECUTOR_VIEW_CODEX_USAGE_URL", "https://chatgpt.com/backend-api/wham/usage"
)
CODEX_RESET_URL = os.getenv(
    "EXECUTOR_VIEW_CODEX_RESET_URL",
    "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume",
)
CODEX_USAGE_TIMEOUT_SECONDS = float(
    os.getenv("EXECUTOR_VIEW_CODEX_USAGE_TIMEOUT_SECONDS", "5")
)
CODEX_RESET_TIMEOUT_SECONDS = float(
    os.getenv("EXECUTOR_VIEW_CODEX_RESET_TIMEOUT_SECONDS", "10")
)
CODEX_USAGE_CACHE_SECONDS = int(
    os.getenv("EXECUTOR_VIEW_CODEX_USAGE_CACHE_SECONDS", "60")
)
ACCOUNT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
ACCOUNT_OVERVIEW_CACHE_SECONDS = int(
    os.getenv("EXECUTOR_VIEW_ACCOUNT_CACHE_SECONDS", str(CODEX_ACCOUNT_CACHE_SECONDS))
)
CLAUDE_USAGE_URL = os.getenv(
    "EXECUTOR_VIEW_CLAUDE_USAGE_URL", "https://api.anthropic.com/api/oauth/usage"
)
CLAUDE_USAGE_TIMEOUT_SECONDS = float(
    os.getenv("EXECUTOR_VIEW_CLAUDE_USAGE_TIMEOUT_SECONDS", "4")
)
CLAUDE_USAGE_CACHE_SECONDS = int(
    os.getenv("EXECUTOR_VIEW_CLAUDE_USAGE_CACHE_SECONDS", "60")
)
OPENROUTER_KEY_URL = os.getenv(
    "EXECUTOR_VIEW_OPENROUTER_KEY_URL", "https://openrouter.ai/api/v1/key"
)
OPENROUTER_TIMEOUT_SECONDS = float(
    os.getenv("EXECUTOR_VIEW_OPENROUTER_TIMEOUT_SECONDS", "5")
)
OPENROUTER_KEY_CACHE_SECONDS = int(
    os.getenv("EXECUTOR_VIEW_OPENROUTER_KEY_CACHE_SECONDS", "60")
)
DEEP_ACCOUNT_REFRESH = os.getenv("EXECUTOR_VIEW_DEEP_ACCOUNT_REFRESH", "0").lower() in (
    "1",
    "true",
    "yes",
)
CODEX_SOURCE_SESSION_SCAN_LIMIT = int(
    os.getenv("EXECUTOR_VIEW_CODEX_SOURCE_SESSION_SCAN_LIMIT", "120")
)
CODEX_JOB_HOME_SCAN_LIMIT = int(
    os.getenv("EXECUTOR_VIEW_CODEX_JOB_HOME_SCAN_LIMIT", "400")
)
PREVIEW_TEXT_LIMIT = int(os.getenv("EXECUTOR_VIEW_PREVIEW_TEXT_LIMIT", "2000"))
DETAIL_ATTEMPT_LIMIT = int(os.getenv("EXECUTOR_VIEW_DETAIL_ATTEMPT_LIMIT", "50"))
SCAN_LIST_LIMIT = int(os.getenv("EXECUTOR_VIEW_SCAN_LIST_LIMIT", "50"))
PROMPT_PREVIEW_TEXT_LIMIT = int(
    os.getenv("EXECUTOR_VIEW_PROMPT_PREVIEW_TEXT_LIMIT", "600")
)
RECENT_ATTEMPT_LIMIT = int(
    os.getenv("EXECUTOR_VIEW_RECENT_ATTEMPT_LIMIT", str(DETAIL_ATTEMPT_LIMIT))
)
CODEX_ACCOUNT_CACHE = {"expires_at": 0.0, "data": None}
CODEX_USAGE_CACHE = {}
CLAUDE_USAGE_CACHE = {"expires_at": 0.0, "credential": None, "data": None}
OPENROUTER_KEY_CACHE = {"expires_at": 0.0, "credential": None, "data": None}
ACCOUNT_OVERVIEW_CACHE = {"expires_at": 0.0, "data": None}
SCAN_STATUS_ACTIONS = {"pause": "paused", "resume": "running", "start": "running"}
CYBER_RISK_FLAG_TEXT = (
    "This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. "
    "To get authorized for security work, join the Trusted Access for Cyber program"
)
CYBER_RISK_FIX_LINKS = [
    {"label": "ChatGPT cyber access", "url": "https://chatgpt.com/cyber"},
    {
        "label": "Enterprise trusted access",
        "url": "https://openai.com/form/enterprise-trusted-access-for-cyber/",
    },
]
OPENROUTER_LIMIT_FIX_LINKS = [
    {"label": "OpenRouter keys", "url": "https://openrouter.ai/settings/keys"},
    {"label": "OpenRouter credits", "url": "https://openrouter.ai/settings/credits"},
    {"label": "Limits docs", "url": "https://openrouter.ai/docs/api/reference/limits"},
]


def mutation_request_allowed(headers):
    """Allow JSON mutations from this UI or non-browser internal clients."""

    content_type = (headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()
    if content_type != "application/json":
        return False
    fetch_site = (headers.get("Sec-Fetch-Site") or "").strip().lower()
    if fetch_site and fetch_site not in {"same-origin", "none"}:
        return False
    origin = (headers.get("Origin") or "").strip()
    if not origin:
        return True
    parsed = urlparse(origin)
    host = (headers.get("Host") or "").strip().lower()
    return (
        parsed.scheme in {"http", "https"}
        and parsed.netloc.lower() == host
        and parsed.path in {"", "/"}
        and not parsed.params
        and not parsed.query
        and not parsed.fragment
    )


def request_host_access(headers):
    """Return (allowed, loopback) for a syntactically valid Host header."""

    raw = (headers.get("Host") or "").strip()
    if (
        not raw
        or any(char.isspace() for char in raw)
        or any(char in raw for char in "/@,\\")
    ):
        return False, False
    try:
        parsed = urlparse(f"//{raw}")
        hostname = (parsed.hostname or "").lower().rstrip(".")
        parsed.port  # validate a present port
    except ValueError:
        return False, False
    if not hostname:
        return False, False
    if hostname == "localhost":
        return True, True
    try:
        if ipaddress.ip_address(hostname).is_loopback:
            return True, True
    except ValueError:
        pass
    return hostname in ALLOWED_HOSTS, False


def request_token_allowed(headers):
    authorization = (headers.get("Authorization") or "").strip()
    if authorization.lower().startswith("bearer "):
        return hmac.compare_digest(authorization[7:].strip(), ACCESS_TOKEN)
    cookie_header = headers.get("Cookie") or ""
    try:
        cookies = SimpleCookie(cookie_header)
        session = cookies.get("executor_view_session")
    except (CookieError, KeyError):
        session = None
    return bool(session and hmac.compare_digest(session.value, SESSION_TOKEN))


def request_internal_token_allowed(headers):
    if not INTERNAL_ACCESS_TOKEN:
        return False
    authorization = (headers.get("Authorization") or "").strip()
    return authorization.lower().startswith("bearer ") and hmac.compare_digest(
        authorization[7:].strip(), INTERNAL_ACCESS_TOKEN
    )


def internal_request_path_allowed(method, path):
    if method == "GET" and path == "/api/state":
        return True
    parts = [part for part in path.split("/") if part]
    if (
        method == "GET"
        and len(parts) == 3
        and parts[:2] == ["api", "accounts"]
        and parts[2] in {"codex", "claude", "openrouter"}
    ):
        return True
    return (
        method == "POST"
        and len(parts) == 5
        and parts[:3] == ["api", "accounts", "codex"]
        and parts[4] == "reset"
    )


def request_peer_is_loopback(client_address):
    try:
        return ipaddress.ip_address(str(client_address[0]).split("%", 1)[0]).is_loopback
    except (ValueError, TypeError, IndexError):
        return False


def request_token_required(peer_loopback, host_loopback):
    """Require auth unless a loopback-only request can be established.

    Docker Desktop forwards host-loopback ports through a non-loopback gateway,
    so the socket peer alone cannot identify a local browser. REQUIRE_AUTH is
    already forced on for every non-loopback published bind; for loopback-only
    publication, a validated loopback Host header is the remaining local signal.
    """

    return REQUIRE_AUTH or not (peer_loopback or host_loopback)


def redact_log_value(value):
    text = str(value)
    if ACCESS_TOKEN:
        text = text.replace(ACCESS_TOKEN, "[REDACTED]")
    if INTERNAL_ACCESS_TOKEN:
        text = text.replace(INTERNAL_ACCESS_TOKEN, "[REDACTED]")
    return re.sub(r"(?i)([?&]token=)[^&\s]+", r"\1[REDACTED]", text)


def encode(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    raise TypeError(f"{type(value).__name__} is not JSON serializable")


def scalar_id(value):
    return None if value is None else str(value)


def repeat_runs(scan):
    config = (
        scan.get("configuration") if isinstance(scan.get("configuration"), dict) else {}
    )
    try:
        return max(1, int(config.get("repeat_runs", 1)))
    except (TypeError, ValueError):
        return 1


def configured_post_script_ids(scan):
    ids = []

    def add(value):
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return
        if parsed > 0 and parsed not in ids:
            ids.append(parsed)

    add(scan.get("post_script_id"))
    config = (
        scan.get("configuration") if isinstance(scan.get("configuration"), dict) else {}
    )
    configured = config.get("post_script_ids") or config.get("post_scripts") or []
    if isinstance(configured, str):
        try:
            configured = json.loads(configured)
        except json.JSONDecodeError:
            configured = [part.strip() for part in configured.split(",")]
    if isinstance(configured, list):
        for item in configured:
            add(item.get("id") if isinstance(item, dict) else item)
    return ids


def configured_agent_skill_ids(scan):
    ids = []

    def add(value):
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return
        if parsed > 0 and parsed not in ids:
            ids.append(parsed)

    configured = scan.get("agent_skill_ids") or []
    if isinstance(configured, list):
        for item in configured:
            add(item.get("id") if isinstance(item, dict) else item)

    config = (
        scan.get("configuration") if isinstance(scan.get("configuration"), dict) else {}
    )
    configured = config.get("agent_skill_ids") or config.get("agent_skills") or []
    if isinstance(configured, str):
        try:
            configured = json.loads(configured)
        except json.JSONDecodeError:
            configured = [part.strip() for part in configured.split(",")]
    if isinstance(configured, list):
        for item in configured:
            add(item.get("id") if isinstance(item, dict) else item)
    return ids


def line_key(step_id, prev_id, prev_table, repeat_run):
    return (
        f"{int(step_id)}|{int(prev_id or 0)}|{prev_table or ''}|{int(repeat_run or 1)}"
    )


def metadata_key(row):
    return line_key(
        row["step_id"], row.get("prev_id"), row.get("prev_table"), row.get("repeat_run")
    )


def state_key(step_id, state):
    return line_key(step_id, state["prev_id"], state["prev_table"], state["repeat_run"])


def millis(value):
    if value is None:
        return None
    if isinstance(value, Decimal):
        return int(value)
    return int(value)


def compact_error(value):
    if not value:
        return None
    text = " ".join(str(value).split())
    return text or None


def known_error(value):
    text = compact_error(value)
    if not text:
        return None
    lower = text.lower()
    if (
        CYBER_RISK_FLAG_TEXT in text
        or "openai has flagged these tasks as unauthorized" in lower
    ):
        return {
            "key": "openai_cyber_access_blocked",
            "title": "Cyber access blocked",
            "message": "OpenAI blocked this security task. Request cyber access or run the scan on another provider/model.",
            "fixLinks": CYBER_RISK_FIX_LINKS,
        }
    if "key limit exceeded (total limit)" in lower and (
        "openrouter" in lower or "api error: 403" in lower
    ):
        return {
            "key": "openrouter_key_limit_exceeded",
            "title": "OpenRouter key limit exceeded",
            "message": "This OpenRouter API key hit its total credit limit. Raise or remove the key limit, add credits, or switch keys before resuming.",
            "fixLinks": OPENROUTER_LIMIT_FIX_LINKS,
        }
    if (
        "this request requires more credits, or fewer max_tokens" in lower
        and "openrouter" in lower
    ):
        return {
            "key": "openrouter_credit_or_token_limit",
            "title": "OpenRouter credits or key limit too low",
            "message": "OpenRouter rejected the request because the key/account budget is too low for the requested output. Add credits, raise the key limit, or lower max tokens.",
            "fixLinks": OPENROUTER_LIMIT_FIX_LINKS,
        }
    return None


def clean_error(value):
    known = known_error(value)
    if known:
        return f"{known['title']}. {known['message']}"
    return compact_error(value)


def display_error(value):
    if not value:
        return None
    return clip_text(value)


def subagent_count(row):
    value = row.get("subagent_count")
    if value is not None:
        try:
            return max(0, int(value))
        except (TypeError, ValueError):
            return 0
    raw = (
        row.get("raw_token_usage")
        if isinstance(row.get("raw_token_usage"), dict)
        else {}
    )
    subagents = raw.get("subagents") if isinstance(raw.get("subagents"), dict) else {}
    try:
        return max(0, int(subagents.get("count") or 0))
    except (TypeError, ValueError):
        return 0


PHASE_LABELS = {
    "building_workspace": "Building workspace",
    "running_harness": "Running harness",
    "writing_db": "Writing to DB",
    "completed": "Completed",
    "failed": "Failed",
    "pending": "Pending",
    "prewarming_cache": "Prewarming cache",
    "running": "Running",
    "post_processing": "Post-processing",
    "paused": "Paused",
}


def effective_phase(row):
    status = row.get("status")
    if status in ("completed", "failed", "paused", "pending"):
        return status
    phase = row.get("phase")
    if phase:
        return phase
    if status == "running":
        return "running_harness" if row.get("prompt_filled") else "building_workspace"
    return status or "unknown"


def phase_label(phase):
    return PHASE_LABELS.get(phase, str(phase or "unknown").replace("_", " ").title())


def clip_text(value):
    if value is None:
        return None
    text = str(value)
    if PREVIEW_TEXT_LIMIT <= 0 or len(text) <= PREVIEW_TEXT_LIMIT:
        return text
    omitted = len(text) - PREVIEW_TEXT_LIMIT
    return f"{text[:PREVIEW_TEXT_LIMIT]}\n\n[truncated {omitted} chars]"


def clip_prompt_text(value):
    if value is None:
        return None
    text = str(value)
    if PROMPT_PREVIEW_TEXT_LIMIT <= 0 or len(text) <= PROMPT_PREVIEW_TEXT_LIMIT:
        return text
    omitted = len(text) - PROMPT_PREVIEW_TEXT_LIMIT
    return f"{text[:PROMPT_PREVIEW_TEXT_LIMIT]}\n\n[preview truncated {omitted} chars; open to load full prompt]"


def fetch_full_prompt(kind, prompt_id):
    tables = {
        "step": "workflows.step_metadata",
        "post": "workflows.post_process_metadata",
    }
    table = tables.get(kind)
    if not table:
        return None, "unsupported prompt kind"
    try:
        numeric_id = int(prompt_id)
    except (TypeError, ValueError):
        return None, "invalid prompt id"

    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        row = conn.execute(
            f"SELECT prompt_filled FROM {table} WHERE id = %s",
            (numeric_id,),
        ).fetchone()
    if not row:
        return None, "prompt not found"
    prompt = row.get("prompt_filled") or ""
    return {
        "id": scalar_id(numeric_id),
        "kind": kind,
        "promptFilled": prompt,
        "length": len(prompt),
    }, None


def output_preview(rows):
    out = []
    for row in rows:
        out.append(
            {
                "id": scalar_id(row.get("id")),
                "json": row.get("json_answer") or {},
                "insertedAt": row.get("inserted_at"),
                "rank": row.get("rank"),
            }
        )
    return out


def row_time(row):
    value = row.get("inserted_at")
    if isinstance(value, datetime):
        return value.timestamp()
    return 0


def activity_time(row):
    value = (
        row.get("updated_at")
        or row.get("updatedAt")
        or row.get("inserted_at")
        or row.get("insertedAt")
    )
    if isinstance(value, datetime):
        return value.timestamp()
    return row_time(row)


def update_scan_status(scan_id, action):
    target = SCAN_STATUS_ACTIONS.get(action)
    if not target:
        return None, f"unsupported action: {action}"
    try:
        numeric_id = int(scan_id)
    except (TypeError, ValueError):
        return None, "invalid scan id"

    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        row = conn.execute(
            """
            UPDATE public.scans
            SET status = %(status)s,
                updated_at = now(),
                reasoning = CASE WHEN %(status)s = 'running' THEN NULL ELSE reasoning END
            WHERE id = %(scan_id)s
            RETURNING id, repo_full, status, model, model_provider, thinking_effort, updated_at
            """,
            {"scan_id": numeric_id, "status": target},
        ).fetchone()
        conn.commit()
    if not row:
        return None, "scan not found"
    return row, None


def codex_accounts_for_state(force=False):
    if force or CODEX_ACCOUNT_CACHE["data"] is not None:
        return fetch_codex_accounts(force=force)
    return empty_codex_accounts()


def empty_codex_accounts():
    return {
        "generatedAt": datetime.now(timezone.utc),
        "configuredRaw": CODEX_HOME_RAW,
        "engineDataDir": str(ENGINE_DATA_DIR),
        "runtimeConfigPath": str(ENGINE_RUNTIME_CONFIG_PATH),
        "workerCount": current_worker_count(),
        "observedJobAccounts": 0,
        "active": 0,
        "total": 0,
        "limited": 0,
        "stale": 0,
        "accounts": [],
    }


def accounts_for_state(force=False):
    if force or ACCOUNT_OVERVIEW_CACHE["data"] is not None:
        return fetch_accounts(force=force)
    return build_account_overview(
        empty_codex_accounts(),
        empty_claude_accounts(),
        fetch_openrouter_accounts(force=False),
        fetched=False,
    )


def fetch_state(force_accounts=False):
    accounts = accounts_for_state(force=force_accounts)
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        status_counts = conn.execute(
            "SELECT status, count(*) AS count FROM public.scans GROUP BY status"
        ).fetchall()
        scans = conn.execute(
            """
            SELECT *
            FROM public.scans
            ORDER BY
                CASE status
                    WHEN 'post_processing' THEN 0
                    WHEN 'prewarming_cache' THEN 1
                    WHEN 'running' THEN 2
                    WHEN 'pending' THEN 3
                    WHEN 'paused' THEN 4
                    WHEN 'failed' THEN 5
                    WHEN 'completed' THEN 6
                    ELSE 7
                END,
                inserted_at ASC
            LIMIT %s
            """,
            (SCAN_LIST_LIMIT,),
        ).fetchall()
        if not scans:
            return {
                "generatedAt": datetime.now(timezone.utc),
                "summary": summarize_scan_counts(status_counts, displayed=0),
                "codexAccounts": accounts["codex"],
                "accounts": accounts,
                "scans": [],
            }

        scan_ids = [s["id"] for s in scans]
        workflow_ids = sorted({s["workflow_id"] for s in scans})
        post_script_ids = sorted(
            {
                post_script_id
                for s in scans
                for post_script_id in configured_post_script_ids(s)
            }
        )
        agent_skill_ids = sorted(
            {skill_id for s in scans for skill_id in configured_agent_skill_ids(s)}
        )

        workflows = conn.execute(
            "SELECT * FROM public.llm_workflows WHERE id = ANY(%s)", (workflow_ids,)
        ).fetchall()
        post_scripts = conn.execute(
            "SELECT id, name FROM public.post_scripts WHERE id = ANY(%s)",
            (post_script_ids or [0],),
        ).fetchall()
        agent_skills = conn.execute(
            "SELECT id, name, source_url FROM public.agent_skills WHERE id = ANY(%s)",
            (agent_skill_ids or [0],),
        ).fetchall()
        all_step_ids = sorted(
            {sid for wf in workflows for sid in (wf.get("step_ids") or [])}
        )
        steps = conn.execute(
            "SELECT * FROM public.steps WHERE id = ANY(%s)", (all_step_ids or [0],)
        ).fetchall()
        metadata = conn.execute(
            """
            WITH ranked AS (
                SELECT id,
                       row_number() OVER (PARTITION BY scan_id ORDER BY inserted_at DESC, id DESC) AS detail_rank
                FROM workflows.step_metadata m
                WHERE scan_id = ANY(%s)
                  AND coalesce(kind, 'step') = 'step'
            )
            SELECT m.id, scan_id, workflow_id, step_id, prev_id, prev_table, repeat_run, status, phase, error,
                   stub, stub_explanation,
                   CASE WHEN detail_rank <= %s THEN left(prompt_template, %s) END AS prompt_template,
                   CASE WHEN detail_rank <= %s THEN left(prompt_filled, %s) END AS prompt_filled,
                   checked_out_commit, run_started_at, run_time_ms,
                   CASE WHEN detail_rank <= %s THEN raw_token_usage END AS raw_token_usage,
                   token_count_cached_input, token_count_input, token_count_output,
                   token_count_reasoning_output, token_count_total, codex_session_id,
                   codex_source_home, codex_account_id, codex_account_email,
                   model, harness, thinking_effort, model_provider, subagent_count,
                   detail_rank <= %s AS has_detail,
                   inserted_at, updated_at
            FROM workflows.step_metadata m
            JOIN ranked ON ranked.id = m.id
            ORDER BY inserted_at ASC
            """,
            (
                scan_ids,
                DETAIL_ATTEMPT_LIMIT,
                PROMPT_PREVIEW_TEXT_LIMIT,
                DETAIL_ATTEMPT_LIMIT,
                PROMPT_PREVIEW_TEXT_LIMIT,
                DETAIL_ATTEMPT_LIMIT,
                DETAIL_ATTEMPT_LIMIT,
            ),
        ).fetchall()
        results = conn.execute(
            """
            WITH detailed_lines AS (
                SELECT DISTINCT scan_id, step_id,
                       coalesce(prev_id, 0) AS prev_id,
                       coalesce(prev_table, '') AS prev_table,
                       coalesce(repeat_run, 1) AS repeat_run
                FROM (
                    SELECT scan_id, step_id, prev_id, prev_table, repeat_run,
                           row_number() OVER (PARTITION BY scan_id ORDER BY inserted_at DESC, id DESC) AS detail_rank
                    FROM workflows.step_metadata
                    WHERE scan_id = ANY(%s)
                      AND coalesce(kind, 'step') = 'step'
                ) ranked
                WHERE detail_rank <= %s
            )
            SELECT r.id, r.scan_id, r.workflow_id, r.step_id, r.prev_id, r.prev_table, r.repeat_run,
                   CASE WHEN d.scan_id IS NOT NULL THEN r.json_answer END AS json_answer,
                   r.inserted_at
            FROM workflows.step_results r
            LEFT JOIN detailed_lines d
              ON d.scan_id = r.scan_id
             AND d.step_id = r.step_id
             AND d.prev_id = coalesce(r.prev_id, 0)
             AND d.prev_table = coalesce(r.prev_table, '')
             AND d.repeat_run = coalesce(r.repeat_run, 1)
            WHERE r.scan_id = ANY(%s)
            ORDER BY id ASC
            """,
            (scan_ids, DETAIL_ATTEMPT_LIMIT, scan_ids),
        ).fetchall()
        vulnerabilities = conn.execute(
            """
            WITH detailed_metadata AS (
                SELECT id
                FROM (
                    SELECT id, scan_id,
                           row_number() OVER (PARTITION BY scan_id ORDER BY inserted_at DESC, id DESC) AS detail_rank
                    FROM workflows.step_metadata
                    WHERE scan_id = ANY(%s)
                      AND coalesce(kind, 'step') = 'step'
                ) ranked
                WHERE detail_rank <= %s
            )
            SELECT v.id, v.scan_id, v.workflow_id, v.scan_metadata_id, v.prev_id, v.prev_table,
                   v.repeat_run, v.rank,
                   CASE WHEN dm.id IS NOT NULL THEN v.json_answer END AS json_answer,
                   v.json_answer ->> 'exploitable' AS exploitable_value,
                   v.dedupe_is_canonical, v.dedupe_canonical_id, v.bounty_rank,
                   v.inserted_at, v.updated_at
            FROM workflows.vulnerabilities v
            LEFT JOIN detailed_metadata dm ON dm.id = v.scan_metadata_id
            WHERE v.scan_id = ANY(%s)
            ORDER BY v.id ASC
            """,
            (scan_ids, DETAIL_ATTEMPT_LIMIT, scan_ids),
        ).fetchall()
        post_metadata = conn.execute(
            """
            WITH ranked AS (
                SELECT id,
                       row_number() OVER (PARTITION BY scan_id ORDER BY inserted_at DESC, id DESC) AS detail_rank
                FROM workflows.post_process_metadata p
                WHERE scan_id = ANY(%s)
            )
            SELECT p.id, scan_id, workflow_id, post_script_id, post_script_name, vulnerability_id,
                   kind, batch_index, target_vulnerability_ids, status, phase, error,
                   CASE WHEN detail_rank <= %s THEN left(prompt_template, %s) END AS prompt_template,
                   CASE WHEN detail_rank <= %s THEN left(prompt_filled, %s) END AS prompt_filled,
                   CASE WHEN detail_rank <= %s THEN output_json END AS output_json,
                   checked_out_commit, run_started_at, run_time_ms,
                   CASE WHEN detail_rank <= %s THEN raw_token_usage END AS raw_token_usage,
                   token_count_cached_input, token_count_input, token_count_output,
                   token_count_reasoning_output, token_count_total, codex_session_id,
                   codex_source_home, codex_account_id, codex_account_email, model,
                   harness, thinking_effort, model_provider, subagent_count,
                   detail_rank <= %s AS has_detail,
                   inserted_at, updated_at
            FROM workflows.post_process_metadata p
            JOIN ranked ON ranked.id = p.id
            ORDER BY inserted_at ASC
            """,
            (
                scan_ids,
                DETAIL_ATTEMPT_LIMIT,
                PROMPT_PREVIEW_TEXT_LIMIT,
                DETAIL_ATTEMPT_LIMIT,
                PROMPT_PREVIEW_TEXT_LIMIT,
                DETAIL_ATTEMPT_LIMIT,
                DETAIL_ATTEMPT_LIMIT,
                DETAIL_ATTEMPT_LIMIT,
            ),
        ).fetchall()
        enrichments = conn.execute(
            """
            SELECT id, scan_id, vulnerability_id, post_script_id, post_script_name,
                   result, stub, stub_explanation, inserted_at, updated_at
            FROM workflows.vulnerability_enrichments
            WHERE scan_id = ANY(%s)
            ORDER BY id ASC
            """,
            (scan_ids,),
        ).fetchall()

    workflow_by_id = {wf["id"]: wf for wf in workflows}
    post_by_id = {ps["id"]: ps for ps in post_scripts}
    skill_by_id = {skill["id"]: skill for skill in agent_skills}
    step_by_id = {step["id"]: step for step in steps}
    metadata_by_scan = defaultdict(list)
    results_by_scan = defaultdict(list)
    vulnerabilities_by_scan = defaultdict(list)
    post_metadata_by_scan = defaultdict(list)
    enrichments_by_scan = defaultdict(list)
    for row in metadata:
        metadata_by_scan[row["scan_id"]].append(row)
    for row in results:
        results_by_scan[row["scan_id"]].append(row)
    for row in vulnerabilities:
        vulnerabilities_by_scan[row["scan_id"]].append(row)
    for row in post_metadata:
        post_metadata_by_scan[row["scan_id"]].append(row)
    for row in enrichments:
        enrichments_by_scan[row["scan_id"]].append(row)

    detailed = [
        build_scan(
            scan,
            workflow_by_id,
            post_by_id,
            skill_by_id,
            step_by_id,
            metadata_by_scan,
            results_by_scan,
            vulnerabilities_by_scan,
            post_metadata_by_scan,
            enrichments_by_scan,
        )
        for scan in scans
    ]
    return {
        "generatedAt": datetime.now(timezone.utc),
        "summary": summarize_scan_counts(status_counts, displayed=len(scans)),
        "codexAccounts": accounts["codex"],
        "accounts": accounts,
        "scans": detailed,
    }


def split_home_list(raw):
    raw = (raw or "").strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(item).strip() for item in parsed if str(item).strip()]
    except json.JSONDecodeError:
        pass
    separator = "," if "," in raw else os.pathsep
    return [
        part.strip().strip('"').strip("'")
        for part in raw.split(separator)
        if part.strip()
    ]


def summarize_scan_counts(status_counts, displayed):
    counts = {
        str(row.get("status")): int(row.get("count") or 0) for row in status_counts
    }
    total = sum(counts.values())
    return {
        "scans": total,
        "displayedScans": displayed,
        "scanLimit": SCAN_LIST_LIMIT,
        "truncated": displayed < total,
        "pending": counts.get("pending", 0),
        "running": counts.get("prewarming_cache", 0) + counts.get("running", 0),
        "postProcessing": counts.get("post_processing", 0),
        "paused": counts.get("paused", 0),
        "failed": counts.get("failed", 0),
        "completed": counts.get("completed", 0),
    }


def read_runtime_config():
    try:
        text = ENGINE_RUNTIME_CONFIG_PATH.read_text(encoding="utf-8")
    except OSError:
        return {}
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("export "):
            line = line[len("export ") :].strip()
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = unquote_env_value(value.strip())
    return values


def unquote_env_value(value):
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        body = value[1:-1]
        if value[0] == '"':
            return body.replace('\\"', '"').replace("\\\\", "\\")
        return body
    return value


def current_codex_home_raw():
    runtime_config = read_runtime_config()
    if "ENGINE_CODEX_HOME" in runtime_config:
        return runtime_config["ENGINE_CODEX_HOME"]
    return CODEX_HOME_RAW


def current_worker_count():
    raw = (
        read_runtime_config().get("ENGINE_WORKER_COUNT")
        or os.getenv("ENGINE_WORKER_COUNT")
        or os.getenv("ENGINE_WORKERS")
        or ""
    )
    try:
        return max(0, int(raw))
    except (TypeError, ValueError):
        return None


def resolve_codex_home(path):
    source = Path(path).expanduser()
    if (source / "auth.json").exists() or source.name == ".codex":
        return source
    nested = source / ".codex"
    if nested.exists():
        return nested
    return source


def configured_codex_homes():
    seen = set()
    homes = []
    for raw_path in split_home_list(current_codex_home_raw()):
        source = Path(raw_path).expanduser()
        candidates = []
        if (
            source.exists()
            and source.name != ".codex"
            and not (source / "auth.json").exists()
            and not (source / ".codex").exists()
        ):
            candidates = sorted(
                path for path in source.glob("*/.codex") if path.is_dir()
            )
        else:
            candidates = [resolve_codex_home(raw_path)]
        for candidate in candidates:
            key = str(candidate)
            if key not in seen:
                seen.add(key)
                homes.append(candidate)
    return homes


def fetch_codex_accounts(force=False):
    now = time.monotonic()
    if (
        not force
        and CODEX_ACCOUNT_CACHE["data"] is not None
        and now < CODEX_ACCOUNT_CACHE["expires_at"]
    ):
        return CODEX_ACCOUNT_CACHE["data"]
    job_rate_limits = latest_job_rate_limits_by_identity()
    homes, observed_job_accounts = effective_codex_homes()
    accounts = [codex_account(home, job_rate_limits, force=force) for home in homes]
    active = sum(1 for account in accounts if account["active"])
    limited = sum(1 for account in accounts if account["statusKind"] == "limited")
    stale = sum(
        1
        for account in accounts
        if account.get("statusKind") == "stale"
        or (
            account.get("active")
            and not (account.get("rateLimits") or {}).get("observedAt")
        )
    )
    data = {
        "generatedAt": datetime.now(timezone.utc),
        "configuredRaw": current_codex_home_raw(),
        "engineDataDir": str(ENGINE_DATA_DIR),
        "runtimeConfigPath": str(ENGINE_RUNTIME_CONFIG_PATH),
        "workerCount": current_worker_count(),
        "observedJobAccounts": observed_job_accounts,
        "active": active,
        "total": len(accounts),
        "limited": limited,
        "stale": stale,
        "accounts": accounts,
    }
    CODEX_ACCOUNT_CACHE["data"] = data
    CODEX_ACCOUNT_CACHE["expires_at"] = now + CODEX_ACCOUNT_CACHE_SECONDS
    return data


def fetch_accounts(force=False):
    now = time.monotonic()
    if (
        not force
        and ACCOUNT_OVERVIEW_CACHE["data"] is not None
        and now < ACCOUNT_OVERVIEW_CACHE["expires_at"]
    ):
        return ACCOUNT_OVERVIEW_CACHE["data"]
    if force and not DEEP_ACCOUNT_REFRESH:
        # A normal UI refresh must still read the effective runtime homes and
        # local job attribution. Claude subscription usage and OpenRouter key
        # metadata are both part of the explicit Accounts refresh.
        codex = fetch_codex_accounts(force=True)
        claude = fetch_claude_accounts(force=True)
        openrouter = fetch_openrouter_accounts(force=True)
        data = build_account_overview(codex, claude, openrouter, fetched=True)
        ACCOUNT_OVERVIEW_CACHE["data"] = data
        ACCOUNT_OVERVIEW_CACHE["expires_at"] = now + ACCOUNT_OVERVIEW_CACHE_SECONDS
        return data
    codex = fetch_codex_accounts(force=force)
    claude = fetch_claude_accounts(force=force)
    openrouter = fetch_openrouter_accounts(force=force)
    data = build_account_overview(codex, claude, openrouter, fetched=True)
    ACCOUNT_OVERVIEW_CACHE["data"] = data
    ACCOUNT_OVERVIEW_CACHE["expires_at"] = now + ACCOUNT_OVERVIEW_CACHE_SECONDS
    return data


def fetch_account_provider(kind, force=False):
    fetchers = {
        "codex": fetch_codex_accounts,
        "claude": fetch_claude_accounts,
        "openrouter": fetch_openrouter_accounts,
    }
    fetcher = fetchers.get(kind)
    if not fetcher:
        raise ValueError("unknown account provider")
    return build_account_provider(kind, fetcher(force=force))


def build_account_provider(kind, data):
    metadata = {
        "codex": (
            "Codex",
            "Configured Codex home and latest observed rate-limit windows.",
        ),
        "claude": (
            "Claude",
            "Claude Code login home, account profile, and subscription usage windows.",
        ),
        "openrouter": (
            "OpenRouter",
            "Verified OpenRouter key status, credit usage, limits, and masked metadata.",
        ),
    }
    label, description = metadata[kind]
    return {
        "kind": kind,
        "label": label,
        "description": description,
        "active": data.get("active", 0),
        "total": data.get("total", 0),
        "limited": data.get("limited", 0),
        "stale": data.get("stale", 0) if kind != "openrouter" else 0,
        "accounts": data.get("accounts", []),
        "configuredRaw": data.get("configuredRaw"),
    }


def build_account_overview(codex, claude, openrouter, fetched=True):
    providers = [
        build_account_provider("codex", codex),
        build_account_provider("claude", claude),
        build_account_provider("openrouter", openrouter),
    ]
    return {
        "generatedAt": datetime.now(timezone.utc),
        "fetched": fetched,
        "runtimeConfigPath": str(ENGINE_RUNTIME_CONFIG_PATH),
        "engineDataDir": str(ENGINE_DATA_DIR),
        "workerCount": current_worker_count(),
        "providerCount": len(providers),
        "activeProviders": sum(
            1 for provider in providers if provider.get("active", 0) > 0
        ),
        "total": sum(provider.get("total", 0) for provider in providers),
        "active": sum(provider.get("active", 0) for provider in providers),
        "limited": sum(provider.get("limited", 0) for provider in providers),
        "stale": sum(provider.get("stale", 0) for provider in providers),
        "observedJobAccounts": codex.get("observedJobAccounts", 0),
        "codex": codex,
        "claude": claude,
        "openrouter": openrouter,
        "providers": providers,
    }


def empty_claude_accounts():
    return {
        "generatedAt": datetime.now(timezone.utc),
        "configuredRaw": CLAUDE_HOME_RAW,
        "active": 0,
        "total": 0,
        "limited": 0,
        "stale": 0,
        "accounts": [],
    }


def fetch_claude_accounts(force=False):
    home = Path(CLAUDE_HOME_RAW).expanduser()
    api_key = configured_secret("ANTHROPIC_API_KEY")
    auth = load_claude_auth(home)
    oauth = load_claude_oauth(home)
    usage = claude_usage_for_account(oauth.get("accessToken"), force=force)
    auth_error = claude_auth_error(oauth, usage)
    active = bool(api_key or (auth.get("credentialSources") and not auth_error))
    rate_limits = None
    if not auth_error and usage and (usage.get("primary") or usage.get("secondary")):
        rate_limits = {
            "observedAt": usage.get("observedAt"),
            "source": "Claude Code usage API",
            "primary": usage.get("primary"),
            "secondary": usage.get("secondary"),
        }
    limited = any(
        (numeric_value((limit_data or {}).get("usedPercent")) or 0) >= 100
        for limit_data in (
            (rate_limits or {}).get("primary"),
            (rate_limits or {}).get("secondary"),
        )
    )
    stale = bool(
        not auth_error and oauth.get("accessToken") and usage and usage.get("stale")
    )
    if api_key:
        status_kind = "available"
        status = "api key configured"
    elif auth_error:
        status_kind = "expired"
        status = "sign-in required"
    elif auth.get("credentialSources"):
        status_kind = "available"
        status = "logged in"
    elif auth.get("profileSources"):
        status_kind = "warning"
        status = "profile found; login required"
    elif home.exists():
        status_kind = "warning"
        status = "no credentials found"
    else:
        status_kind = "missing"
        status = "missing config"
    if limited:
        status_kind = "limited"
        status = "limit reached"
    elif stale:
        status_kind = "stale"
        status = "usage status stale"

    details = []
    add_detail(details, "Provider", "Claude Code")
    if api_key:
        add_detail(details, "ANTHROPIC_API_KEY", masked_secret(api_key), mono=True)
        add_detail(details, "Key fingerprint", secret_fingerprint(api_key), mono=True)
    if auth.get("email"):
        add_detail(details, "Email", auth.get("email"))
    if auth.get("name"):
        add_detail(details, "Name", auth.get("name"))
    if auth.get("organization"):
        add_detail(details, "Organization", auth.get("organization"))
    if auth.get("rateLimitTier"):
        add_detail(details, "Rate limit tier", auth.get("rateLimitTier"))
    if auth.get("credentialSources"):
        add_detail(details, "Credential source", ", ".join(auth["credentialSources"]))
    elif auth.get("profileSources"):
        add_detail(details, "Profile source", ", ".join(auth["profileSources"]))
    if usage and usage.get("observedAt"):
        usage_checked = parse_datetime(usage.get("observedAt"))
        add_detail(
            details,
            "Usage updated",
            usage_checked.strftime("%Y-%m-%d %H:%M UTC")
            if usage_checked
            else usage.get("observedAt"),
        )
    if usage and usage.get("error"):
        add_detail(details, "Usage check", usage.get("error"))
    if auth_error:
        add_detail(details, "Authentication", auth_error)

    account = {
        "id": "default",
        "provider": "Claude",
        "label": auth.get("email") or auth.get("name") or "Claude Code",
        "path": str(home),
        "email": auth.get("email"),
        "name": auth.get("name"),
        "plan": auth.get("subscriptionType") or oauth.get("subscriptionType"),
        "active": active,
        "canRemove": bool(auth.get("credentialSources")),
        "status": status,
        "statusKind": status_kind,
        "authError": auth_error,
        "details": details,
        "rateLimits": rate_limits,
    }
    return {
        "generatedAt": datetime.now(timezone.utc),
        "configuredRaw": CLAUDE_HOME_RAW,
        "active": 1 if active else 0,
        "total": 1 if active else 0,
        "limited": 1 if limited else 0,
        "stale": 1 if stale else 0,
        "accounts": [account],
    }


def load_claude_auth(home):
    candidates = [
        home / ".credentials.json",
        home / "credentials.json",
        home / ".claude.json",
        home / "settings.json",
        home / "claude.json",
    ]
    if home.name == ".claude":
        candidates.append(home.parent / ".claude.json")
    credential_sources = []
    profile_sources = []
    parsed = []
    for path in candidates:
        if not path.exists() or not path.is_file():
            continue
        try:
            if path.stat().st_size > 1024 * 1024:
                continue
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        profile_sources.append(path.name)
        if (
            path.name in (".credentials.json", "credentials.json")
            and isinstance(data, dict)
            and data
        ):
            credential_sources.append(path.name)
        parsed.append(data)
    return {
        "sources": profile_sources,
        "credentialSources": credential_sources,
        "profileSources": profile_sources,
        "email": first_json_value(parsed, {"email", "user_email", "account_email"}),
        "name": first_json_value(parsed, {"name", "username", "display_name"}),
        "organization": first_json_value(
            parsed,
            {
                "organization",
                "organization_name",
                "organization_id",
                "organization_uuid",
                "org_id",
            },
        ),
        "subscriptionType": first_json_value(
            parsed, {"subscriptiontype", "subscription_type"}
        ),
        "rateLimitTier": first_json_value(parsed, {"ratelimittier", "rate_limit_tier"}),
    }


def load_claude_oauth(home):
    """Load only the OAuth fields needed for usage checks.

    The returned access token is consumed locally and must never be included in
    an executor-view response, detail field, error, or log message.
    """

    for path in (home / ".credentials.json", home / "credentials.json"):
        if not path.exists() or not path.is_file():
            continue
        try:
            if path.stat().st_size > 1024 * 1024:
                continue
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        oauth = payload.get("claudeAiOauth") if isinstance(payload, dict) else None
        if not isinstance(oauth, dict):
            continue
        access_token = oauth.get("accessToken")
        access_token = access_token.strip() if isinstance(access_token, str) else ""
        if access_token:
            return {
                "accessToken": access_token,
                "expiresAt": oauth.get("expiresAt"),
                "subscriptionType": format_account_value(oauth.get("subscriptionType")),
                "rateLimitTier": format_account_value(oauth.get("rateLimitTier")),
            }
    return {}


def claude_auth_error(oauth, usage):
    """Return a sanitized, actionable error when Claude is not authenticated."""

    status_code = numeric_value((usage or {}).get("statusCode"))
    if status_code in (401, 403):
        return (
            f"Claude rejected the saved login (HTTP {int(status_code)}). "
            "Sign in to Claude again to renew this account."
        )

    expires_at = numeric_value((oauth or {}).get("expiresAt"))
    if expires_at is not None:
        # Claude Code stores OAuth expiry as Unix epoch milliseconds.
        expiry_seconds = (
            expires_at / 1000 if expires_at > 10_000_000_000 else expires_at
        )
        if expiry_seconds <= datetime.now(timezone.utc).timestamp():
            return "Claude's saved OAuth login has expired. Sign in to Claude again to renew this account."
    return None


def claude_usage_for_account(access_token, force=False):
    if not access_token:
        return None
    now = time.monotonic()
    credential = secret_fingerprint(access_token)
    cached = (
        CLAUDE_USAGE_CACHE.get("data")
        if CLAUDE_USAGE_CACHE.get("credential") == credential
        else None
    )
    if cached and now < CLAUDE_USAGE_CACHE.get("expires_at", 0):
        return cached
    if not force:
        if cached:
            cached = dict(cached)
            cached["stale"] = True
            cached["error"] = "Claude usage data is waiting for refresh"
        return cached

    result = fetch_claude_usage(access_token)
    if result.get("primary") or result.get("secondary"):
        result["stale"] = False
        CLAUDE_USAGE_CACHE["data"] = result
        CLAUDE_USAGE_CACHE["credential"] = credential
        CLAUDE_USAGE_CACHE["expires_at"] = now + CLAUDE_USAGE_CACHE_SECONDS
        return result
    if cached:
        fallback = dict(cached)
        fallback["stale"] = True
        fallback["error"] = result.get("error") or "Claude usage check failed"
        fallback["statusCode"] = result.get("statusCode")
        fallback["attemptedAt"] = result.get("checkedAt")
        CLAUDE_USAGE_CACHE["data"] = fallback
        CLAUDE_USAGE_CACHE["credential"] = credential
        CLAUDE_USAGE_CACHE["expires_at"] = now + CLAUDE_USAGE_CACHE_SECONDS
        return fallback
    result["stale"] = True
    CLAUDE_USAGE_CACHE["data"] = result
    CLAUDE_USAGE_CACHE["credential"] = credential
    CLAUDE_USAGE_CACHE["expires_at"] = now + CLAUDE_USAGE_CACHE_SECONDS
    return result


def fetch_claude_usage(access_token):
    """Fetch a sanitized subset of Claude subscription usage.

    Claude Code uses this OAuth endpoint for its own usage view. Keep the raw
    response and bearer token inside this function; callers receive only the
    two normalized limit windows and a generic error when the probe fails.
    """

    checked_at = datetime.now(timezone.utc).isoformat()
    req = urlrequest.Request(
        CLAUDE_USAGE_URL,
        headers={
            "Authorization": f"Bearer {access_token}",
            "Accept": "application/json",
            "Content-Type": "application/json",
            "anthropic-beta": "oauth-2025-04-20",
            "User-Agent": "open-kritt-executor-view",
        },
        method="GET",
    )
    try:
        with urlrequest.urlopen(req, timeout=CLAUDE_USAGE_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read(1024 * 256).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("unexpected Claude usage response")
            primary = format_claude_limit(
                payload.get("five_hour"), window_minutes=5 * 60
            )
            secondary = format_claude_limit(
                payload.get("seven_day"), window_minutes=7 * 24 * 60
            )
            if not primary and not secondary:
                raise ValueError("Claude usage response had no limit windows")
            return {
                "checkedAt": checked_at,
                "observedAt": checked_at,
                "statusCode": response.status,
                "primary": primary,
                "secondary": secondary,
            }
    except urlerror.HTTPError as exc:
        return {
            "checkedAt": checked_at,
            "statusCode": exc.code,
            "error": f"Claude usage returned HTTP {exc.code}",
        }
    except (
        OSError,
        TimeoutError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValueError,
    ) as exc:
        return {
            "checkedAt": checked_at,
            "error": f"Claude usage check failed ({type(exc).__name__})",
        }


def format_claude_limit(raw, window_minutes):
    if not isinstance(raw, dict):
        return None
    used = numeric_value(raw.get("utilization"))
    if used is None or not isfinite(used):
        return None
    elif used < 0:
        used = 0
    resets_at = parse_datetime(raw.get("resets_at"))
    return {
        "usedPercent": used,
        "remainingPercent": max(0, 100 - used),
        "windowMinutes": window_minutes,
        "resetsAt": resets_at,
    }


def empty_openrouter_accounts():
    return {
        "generatedAt": datetime.now(timezone.utc),
        "configuredRaw": "OPENROUTER_API_KEY",
        "active": 0,
        "total": 0,
        "limited": 0,
        "accounts": [],
    }


def fetch_openrouter_accounts(force=False):
    api_key = configured_secret("OPENROUTER_API_KEY") or configured_secret(
        "EXECUTOR_VIEW_OPENROUTER_API_KEY"
    )
    model_provider = os.getenv("CODEX_MODEL_PROVIDER") or os.getenv(
        "EXECUTOR_VIEW_CODEX_MODEL_PROVIDER"
    )
    if not api_key:
        account = {
            "provider": "OpenRouter",
            "label": "OpenRouter API key",
            "path": "OPENROUTER_API_KEY",
            "active": False,
            "status": "missing key",
            "statusKind": "missing",
            "details": openrouter_base_details(model_provider),
        }
        return {
            "generatedAt": datetime.now(timezone.utc),
            "configuredRaw": "OPENROUTER_API_KEY",
            "active": 0,
            "total": 0,
            "limited": 0,
            "accounts": [account],
        }

    remote_enabled = os.getenv(
        "EXECUTOR_VIEW_OPENROUTER_REMOTE_CHECK", "1"
    ).lower() in ("1", "true", "yes")
    remote = (
        openrouter_key_info_for_account(api_key, force=force) if remote_enabled else {}
    )
    payload = remote.get("data") if isinstance(remote.get("data"), dict) else {}
    status_code = remote.get("statusCode")
    usage = finite_numeric_value(payload.get("usage"))
    limit = finite_numeric_value(payload.get("limit"))
    remaining = finite_numeric_value(payload.get("limit_remaining"))
    used_percent = (
        usage / limit * 100 if usage is not None and limit and limit > 0 else None
    )
    limited = (remaining is not None and remaining <= 0) or (
        remaining is None and usage is not None and limit is not None and usage >= limit
    )
    expires_at = parse_datetime(payload.get("expires_at"))
    expired = bool(expires_at and expires_at <= datetime.now(timezone.utc))
    if status_code in (401, 403):
        status_kind = "expired"
        status = "key rejected"
        active = False
    elif expired:
        status_kind = "expired"
        status = "key expired"
        active = False
    elif remote.get("error"):
        status_kind = "warning"
        status = "check failed"
        active = True
    elif payload:
        status_kind = "limited" if limited else "available"
        status = "limit reached" if limited else "verified"
        active = True
    else:
        status_kind = "available"
        status = "key configured"
        active = True

    details = openrouter_base_details(model_provider)
    add_detail(details, "OPENROUTER_API_KEY", masked_secret(api_key), mono=True)
    add_detail(details, "Key fingerprint", secret_fingerprint(api_key), mono=True)
    if payload:
        add_detail(details, "Today", format_usd(payload.get("usage_daily")))
        add_detail(details, "This week", format_usd(payload.get("usage_weekly")))
        add_detail(details, "This month", format_usd(payload.get("usage_monthly")))
        add_detail(details, "Tier", "Free" if payload.get("is_free_tier") else "Paid")
        key_type = (
            "Management"
            if payload.get("is_management_key")
            else "Provisioning"
            if payload.get("is_provisioning_key")
            else "Standard"
        )
        add_detail(details, "Key type", key_type)
        add_detail(
            details,
            "Limit reset",
            str(payload.get("limit_reset") or "Never").capitalize(),
        )
        add_detail(
            details,
            "BYOK counts toward limit",
            format_account_value(payload.get("include_byok_in_limit")),
        )
        add_detail(details, "BYOK usage", format_usd(payload.get("byok_usage")))
        add_detail(
            details,
            "Expires",
            expires_at.strftime("%Y-%m-%d %H:%M UTC")
            if expires_at
            else "No expiration",
        )
    if remote.get("checkedAt"):
        checked_at = parse_datetime(remote.get("checkedAt"))
        add_detail(
            details,
            "Checked",
            checked_at.strftime("%Y-%m-%d %H:%M UTC")
            if checked_at
            else remote.get("checkedAt"),
        )
    if remote.get("error"):
        add_detail(details, "Last check", remote.get("error"))
    if force and not remote_enabled:
        add_detail(details, "Remote check", "disabled; local key configuration shown")

    account = {
        "provider": "OpenRouter",
        "label": payload.get("label") or payload.get("name") or "OpenRouter API key",
        "path": "OPENROUTER_API_KEY",
        "active": active,
        "status": status,
        "statusKind": status_kind,
        "details": details,
        "credit": {
            "usage": usage,
            "limit": limit,
            "remaining": remaining,
            "usedPercent": used_percent,
            "dailyUsage": finite_numeric_value(payload.get("usage_daily")),
            "weeklyUsage": finite_numeric_value(payload.get("usage_weekly")),
            "monthlyUsage": finite_numeric_value(payload.get("usage_monthly")),
            "limitReset": format_account_value(payload.get("limit_reset")),
            "expiresAt": expires_at,
        }
        if payload
        else None,
    }
    return {
        "generatedAt": datetime.now(timezone.utc),
        "configuredRaw": "OPENROUTER_API_KEY",
        "active": 1 if active else 0,
        "total": 1,
        "limited": 1 if limited else 0,
        "accounts": [account],
    }


def openrouter_base_details(model_provider):
    details = []
    if model_provider:
        add_detail(details, "Codex provider", model_provider)
    return details


def openrouter_key_info_for_account(api_key, force=False):
    now = time.monotonic()
    credential = secret_fingerprint(api_key)
    cached = (
        OPENROUTER_KEY_CACHE.get("data")
        if OPENROUTER_KEY_CACHE.get("credential") == credential
        else None
    )
    if cached and now < OPENROUTER_KEY_CACHE.get("expires_at", 0):
        return cached
    if not force:
        if cached:
            fallback = dict(cached)
            fallback["stale"] = True
            fallback["error"] = "OpenRouter key data is waiting for refresh"
            return fallback
        return {}

    result = fetch_openrouter_key_info(api_key)
    if isinstance(result.get("data"), dict) and result["data"]:
        OPENROUTER_KEY_CACHE["data"] = result
        OPENROUTER_KEY_CACHE["credential"] = credential
        OPENROUTER_KEY_CACHE["expires_at"] = now + OPENROUTER_KEY_CACHE_SECONDS
        return result
    if cached:
        fallback = dict(result)
        fallback["data"] = cached.get("data")
        fallback["stale"] = True
        OPENROUTER_KEY_CACHE["data"] = fallback
        OPENROUTER_KEY_CACHE["credential"] = credential
        OPENROUTER_KEY_CACHE["expires_at"] = now + OPENROUTER_KEY_CACHE_SECONDS
        return fallback
    OPENROUTER_KEY_CACHE["data"] = result
    OPENROUTER_KEY_CACHE["credential"] = credential
    OPENROUTER_KEY_CACHE["expires_at"] = now + OPENROUTER_KEY_CACHE_SECONDS
    return result


def fetch_openrouter_key_info(api_key):
    checked_at = datetime.now(timezone.utc)
    req = urlrequest.Request(
        OPENROUTER_KEY_URL,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Accept": "application/json",
            "User-Agent": "open-kritt-executor-view",
        },
        method="GET",
    )
    try:
        with urlrequest.urlopen(req, timeout=OPENROUTER_TIMEOUT_SECONDS) as response:
            body = response.read(1024 * 256)
            payload = json.loads(body.decode("utf-8"))
            return {
                "checkedAt": checked_at.isoformat(),
                "statusCode": response.status,
                "data": payload.get("data") if isinstance(payload, dict) else {},
            }
    except urlerror.HTTPError as exc:
        return {
            "checkedAt": checked_at.isoformat(),
            "statusCode": exc.code,
            "error": f"OpenRouter returned HTTP {exc.code}",
        }
    except (OSError, TimeoutError, json.JSONDecodeError) as exc:
        return {
            "checkedAt": checked_at.isoformat(),
            "error": f"{type(exc).__name__}: {exc}",
        }


def configured_secret(name):
    if name == "OPENROUTER_API_KEY":
        state = managed_provider_credential_state()
        managed = state["credentials"].get("openrouter")
        if managed:
            return managed
        if "openrouter" in state["disabledEnvironmentProviders"]:
            return None
    value = os.getenv(name)
    value = value.strip() if isinstance(value, str) else ""
    return value or None


def managed_provider_credential_state():
    empty = {"credentials": {}, "disabledEnvironmentProviders": set()}
    try:
        if PROVIDER_CREDENTIALS_PATH.stat().st_size > 1024 * 1024:
            return empty
        payload = json.loads(PROVIDER_CREDENTIALS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return empty
    if not isinstance(payload, dict):
        return empty

    credentials = {}
    raw_credentials = payload.get("credentials")
    if isinstance(raw_credentials, dict):
        value = raw_credentials.get("openrouter")
        if isinstance(value, str) and value.strip():
            credentials["openrouter"] = value.strip()

    raw_disabled = payload.get("disabledEnvironmentProviders")
    disabled = (
        {
            provider
            for provider in raw_disabled
            if isinstance(provider, str) and provider == "openrouter"
        }
        if isinstance(raw_disabled, list)
        else set()
    )
    return {
        "credentials": credentials,
        "disabledEnvironmentProviders": disabled,
    }


def masked_secret(value):
    text = str(value or "")
    if not text:
        return ""
    if len(text) <= 10:
        return "*" * len(text)
    return f"{text[:6]}...{text[-4:]}"


def secret_fingerprint(value):
    if not value:
        return ""
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()[:12]


def first_json_value(items, keys):
    for item in items:
        found = first_json_value_in(item, {key.lower() for key in keys})
        if found:
            return found
    return None


def first_json_value_in(value, keys):
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = str(key).lower()
            if (
                lowered in keys
                and isinstance(child, (str, int, float, bool))
                and not is_sensitive_key(lowered)
            ):
                text = str(child).strip()
                if text:
                    return text
        for key, child in value.items():
            if is_sensitive_key(str(key).lower()):
                continue
            found = first_json_value_in(child, keys)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = first_json_value_in(child, keys)
            if found:
                return found
    return None


def is_sensitive_key(key):
    return any(
        part in key
        for part in ("token", "secret", "password", "api_key", "apikey", "key")
    )


def add_detail(details, label, value, mono=False):
    if value is None or value == "":
        return
    details.append({"label": label, "value": str(value), "mono": mono})


def format_account_value(value):
    if value is None or value == "":
        return None
    if isinstance(value, bool):
        return "yes" if value else "no"
    if isinstance(value, (int, float)):
        return f"{value:g}"
    if isinstance(value, (list, dict)):
        try:
            return json.dumps(value, separators=(",", ":"), sort_keys=True)
        except (TypeError, ValueError):
            return str(value)
    return str(value)


def finite_numeric_value(value):
    parsed = numeric_value(value)
    return parsed if parsed is not None and isfinite(parsed) else None


def format_usd(value):
    parsed = finite_numeric_value(value)
    return f"${parsed:,.2f}" if parsed is not None else None


def numeric_value(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def codex_account(home, job_rate_limits, force=False):
    auth = load_codex_auth(home)
    identity = codex_account_identity(auth, home)
    usage = codex_usage_for_account(home, force=force) if auth.get("exists") else None
    source_rate_limits = latest_rate_limits(
        home,
        session_limit=CODEX_SOURCE_SESSION_SCAN_LIMIT,
        source="account home",
    )
    rate_limits = newest_rate_limits(
        source_rate_limits, job_rate_limits.get(identity, {})
    )
    if usage and (usage.get("primary") or usage.get("secondary")):
        live_rate_limits = {
            "observedAt": parse_datetime(usage.get("observedAt")),
            "raw": {
                "primary": usage.get("primary"),
                "secondary": usage.get("secondary"),
                "plan_type": usage.get("planType"),
                "rate_limit_reached_type": usage.get("rateLimitReachedType"),
            },
            "source": "Codex account usage API",
        }
        rate_limits = newest_rate_limits(rate_limits, live_rate_limits)
    auth_payload = auth.get("idTokenPayload") or {}
    auth_info = auth_payload.get("https://api.openai.com/auth") or {}
    subscription_until = parse_datetime(
        auth_info.get("chatgpt_subscription_active_until")
    )
    last_checked = parse_datetime(auth_info.get("chatgpt_subscription_last_checked"))
    now = datetime.now(timezone.utc)
    reached = (rate_limits.get("raw") or {}).get("rate_limit_reached_type")
    usage_status_code = (usage or {}).get("refreshStatusCode") or (usage or {}).get(
        "statusCode"
    )
    sign_in_required = usage_status_code == 401
    status_kind = "available"
    status = "available"
    active = bool(auth.get("exists"))
    if not auth.get("exists"):
        status_kind = "missing"
        status = "missing auth"
        active = False
    elif sign_in_required:
        status_kind = "expired"
        status = "sign in again"
        active = False
    elif subscription_until and subscription_until <= now:
        # This claim describes a ChatGPT plan entitlement, not whether Codex
        # can authenticate. A refreshable auth home may keep running jobs after
        # the last subscription check expires.
        status_kind = "warning"
        status = "subscription check stale"
    elif reached:
        status_kind = "limited"
        status = "limit reached"
    elif (
        subscription_until
        and (subscription_until.timestamp() - now.timestamp()) <= 3 * 24 * 60 * 60
    ):
        status_kind = "warning"
        status = "expires soon"
    if usage and usage.get("stale") and status_kind == "available":
        status_kind = "stale"
        status = "usage status stale"

    account_id = removable_codex_account_id(home)
    details = []
    add_detail(details, "Provider", "Codex")
    if sign_in_required:
        add_detail(
            details,
            "Authentication",
            "Token rejected; sign in to Codex again.",
        )
    elif usage and usage.get("observedAt"):
        usage_checked = parse_datetime(usage.get("observedAt"))
        add_detail(
            details,
            "Usage updated",
            usage_checked.strftime("%Y-%m-%d %H:%M UTC")
            if usage_checked
            else usage.get("observedAt"),
        )
    if usage and usage.get("error") and not sign_in_required:
        add_detail(details, "Usage check", usage.get("error"))
    email = usage.get("email") if usage else None
    email = email or auth.get("email")
    return {
        "id": account_id,
        "label": email or account_label(home),
        "path": str(home),
        "identity": identity,
        "email": email,
        "name": auth.get("name"),
        "plan": auth_info.get("chatgpt_plan_type")
        or (usage.get("planType") if usage else None)
        or (rate_limits.get("raw") or {}).get("plan_type"),
        "active": active,
        "canRemove": account_id is not None,
        "status": status,
        "statusKind": status_kind,
        "details": details,
        "subscriptionUntil": subscription_until,
        "subscriptionLastChecked": last_checked,
        "rateLimitReachedType": reached,
        "rateLimits": None
        if sign_in_required
        else {
            "observedAt": rate_limits.get("observedAt"),
            "source": rate_limits.get("source"),
            "sourcePath": rate_limits.get("sourcePath"),
            "metadataId": scalar_id(rate_limits.get("metadataId")),
            "primary": format_limit((rate_limits.get("raw") or {}).get("primary")),
            "secondary": format_limit((rate_limits.get("raw") or {}).get("secondary")),
            "planType": (rate_limits.get("raw") or {}).get("plan_type"),
            "manualResetCredits": format_manual_reset_credits(
                (usage or {}).get("manualResetCredits")
            ),
        },
    }


def removable_codex_account_id(home):
    if home == CODEX_PRIMARY_HOME:
        return "primary"
    try:
        relative = home.relative_to(CODEX_ACCOUNTS_ROOT)
    except ValueError:
        return None
    if len(relative.parts) != 2 or relative.parts[1] != ".codex":
        return None
    account_id = relative.parts[0]
    if not ACCOUNT_ID_PATTERN.fullmatch(account_id):
        return None
    return account_id


def account_label(home):
    return home.parent.name if home.name == ".codex" else home.name


def load_codex_auth(home):
    auth_path = home / "auth.json"
    out = {"exists": auth_path.exists()}
    if not auth_path.exists():
        return out
    try:
        auth = json.loads(auth_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return out
    tokens = auth.get("tokens") if isinstance(auth.get("tokens"), dict) else {}
    payload = decode_jwt_payload(tokens.get("id_token"))
    out.update(
        {
            "authMode": auth.get("auth_mode"),
            "lastRefresh": parse_datetime(auth.get("last_refresh")),
            "email": payload.get("email"),
            "name": payload.get("name"),
            "accountId": tokens.get("account_id"),
            "idTokenPayload": payload,
        }
    )
    return out


def load_codex_usage_credential(home):
    """Load the Codex login fields needed for a local usage probe.

    The access token is consumed locally and must never be returned by an API,
    included in a detail field, or written to a log.
    """

    auth_path = home / "auth.json"
    try:
        if not auth_path.is_file() or auth_path.stat().st_size > 1024 * 1024:
            return {}
        auth = json.loads(auth_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    tokens = auth.get("tokens") if isinstance(auth.get("tokens"), dict) else {}
    access_token = tokens.get("access_token")
    access_token = access_token.strip() if isinstance(access_token, str) else ""
    if not access_token:
        return {}
    payload = decode_jwt_payload(tokens.get("id_token"))
    auth_info = payload.get("https://api.openai.com/auth") or {}
    account_id = tokens.get("account_id") or auth_info.get("chatgpt_account_id")
    account_id = account_id.strip() if isinstance(account_id, str) else ""
    return {"accessToken": access_token, "accountId": account_id}


def codex_usage_for_account(home, force=False):
    credential = load_codex_usage_credential(home)
    access_token = credential.get("accessToken")
    if not access_token:
        return None
    account_id = credential.get("accountId") or ""
    cache_key = secret_fingerprint(f"{access_token}\n{account_id}")
    now = time.monotonic()
    cached_entry = CODEX_USAGE_CACHE.get(cache_key) or {}
    cached = cached_entry.get("data")
    if not force and cached and now < cached_entry.get("expires_at", 0):
        return cached
    if not force and cached:
        fallback = dict(cached)
        fallback["stale"] = True
        fallback["error"] = "Codex usage data is waiting for refresh"
        return fallback

    result = fetch_codex_usage(access_token, account_id)
    if result.get("primary") or result.get("secondary"):
        result["stale"] = False
        CODEX_USAGE_CACHE[cache_key] = {
            "data": result,
            "expires_at": now + CODEX_USAGE_CACHE_SECONDS,
        }
        return result
    if cached:
        fallback = dict(cached)
        fallback["stale"] = True
        fallback["error"] = result.get("error") or "Codex usage check failed"
        fallback["refreshStatusCode"] = result.get("statusCode")
        fallback["attemptedAt"] = result.get("checkedAt")
        CODEX_USAGE_CACHE[cache_key] = {
            "data": fallback,
            "expires_at": now + CODEX_USAGE_CACHE_SECONDS,
        }
        return fallback
    result["stale"] = True
    CODEX_USAGE_CACHE[cache_key] = {
        "data": result,
        "expires_at": now + CODEX_USAGE_CACHE_SECONDS,
    }
    if len(CODEX_USAGE_CACHE) > 64:
        CODEX_USAGE_CACHE.clear()
        CODEX_USAGE_CACHE[cache_key] = {
            "data": result,
            "expires_at": now + CODEX_USAGE_CACHE_SECONDS,
        }
    return result


def fetch_codex_usage(access_token, account_id=""):
    """Fetch a sanitized subset of the usage attached to a Codex login."""

    checked_at = datetime.now(timezone.utc).isoformat()
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "User-Agent": "open-kritt-executor-view",
    }
    if account_id:
        headers["ChatGPT-Account-ID"] = account_id
    req = urlrequest.Request(CODEX_USAGE_URL, headers=headers, method="GET")
    try:
        with urlrequest.urlopen(req, timeout=CODEX_USAGE_TIMEOUT_SECONDS) as response:
            payload = json.loads(response.read(1024 * 256).decode("utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("unexpected Codex usage response")
            rate_limit = payload.get("rate_limit")
            rate_limit = rate_limit if isinstance(rate_limit, dict) else {}
            primary = format_codex_api_limit(rate_limit.get("primary_window"))
            secondary = format_codex_api_limit(rate_limit.get("secondary_window"))
            if not primary and not secondary:
                raise ValueError("Codex usage response had no limit windows")
            email = payload.get("email")
            reached = format_account_value(payload.get("rate_limit_reached_type"))
            if not reached and rate_limit.get("allowed") is False:
                reached = "rate_limit"
            return {
                "checkedAt": checked_at,
                "observedAt": checked_at,
                "statusCode": response.status,
                "email": email if isinstance(email, str) else None,
                "planType": format_account_value(payload.get("plan_type")),
                "rateLimitReachedType": reached,
                "allowed": rate_limit.get("allowed"),
                "primary": primary,
                "secondary": secondary,
                "manualResetCredits": format_manual_reset_credits(
                    payload.get("rate_limit_reset_credits")
                ),
            }
    except urlerror.HTTPError as exc:
        return {
            "checkedAt": checked_at,
            "statusCode": exc.code,
            "error": f"Codex usage returned HTTP {exc.code}",
        }
    except (
        OSError,
        TimeoutError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValueError,
    ) as exc:
        return {
            "checkedAt": checked_at,
            "error": f"Codex usage check failed ({type(exc).__name__})",
        }


def consume_codex_reset_credit(account_id):
    """Consume one eligible reset credit without exposing account credentials."""

    if not ACCOUNT_ID_PATTERN.fullmatch(account_id or ""):
        return None, "Codex account not found", 404
    home = next(
        (
            candidate
            for candidate in configured_codex_homes()
            if removable_codex_account_id(candidate) == account_id
        ),
        None,
    )
    if home is None:
        return None, "Codex account not found", 404

    credential = load_codex_usage_credential(home)
    access_token = credential.get("accessToken")
    if not access_token:
        return None, "Codex account is not signed in", 422

    usage = codex_usage_for_account(home, force=True) or {}
    credits = usage.get("manualResetCredits") or {}
    available = finite_numeric_value(credits.get("availableCount"))
    applicable = finite_numeric_value(credits.get("applicableAvailableCount"))
    if available is None or available < 1:
        return None, "No manual resets are available", 409
    if applicable is not None and applicable < 1:
        return None, "No current usage window is eligible for a reset", 409

    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/json",
        "Content-Type": "application/json",
        "User-Agent": "open-kritt-executor-view",
    }
    account_header = credential.get("accountId") or ""
    if account_header:
        headers["ChatGPT-Account-ID"] = account_header
    request_id = str(uuid.uuid4())
    request = urlrequest.Request(
        CODEX_RESET_URL,
        headers=headers,
        data=json.dumps({"redeem_request_id": request_id}).encode("utf-8"),
        method="POST",
    )
    try:
        with urlrequest.urlopen(
            request, timeout=CODEX_RESET_TIMEOUT_SECONDS
        ) as response:
            payload = json.loads(response.read(1024 * 64).decode("utf-8"))
    except urlerror.HTTPError as exc:
        return None, f"Codex reset request returned HTTP {exc.code}", 502
    except (
        OSError,
        TimeoutError,
        UnicodeDecodeError,
        json.JSONDecodeError,
        ValueError,
    ) as exc:
        return None, f"Codex reset request failed ({type(exc).__name__})", 502

    code = payload.get("code") if isinstance(payload, dict) else None
    outcomes = {
        "reset": "reset",
        "nothing_to_reset": "nothingToReset",
        "no_credit": "noCredit",
        "already_redeemed": "alreadyRedeemed",
    }
    outcome = outcomes.get(code)
    if outcome == "nothingToReset":
        return None, "No current usage window is eligible for a reset", 409
    if outcome == "noCredit":
        return None, "No manual resets are available", 409
    if outcome not in {"reset", "alreadyRedeemed"}:
        return None, "Codex returned an unexpected reset response", 502

    cache_key = secret_fingerprint(
        f"{access_token}\n{credential.get('accountId') or ''}"
    )
    CODEX_USAGE_CACHE.pop(cache_key, None)
    CODEX_ACCOUNT_CACHE.update({"expires_at": 0.0, "data": None})
    ACCOUNT_OVERVIEW_CACHE.update({"expires_at": 0.0, "data": None})
    windows_reset = finite_numeric_value(payload.get("windows_reset"))
    return (
        {
            "outcome": outcome,
            "windowsReset": max(0, int(windows_reset))
            if windows_reset is not None
            else None,
        },
        None,
        200,
    )


def format_codex_api_limit(raw):
    if not isinstance(raw, dict):
        return None
    used = finite_numeric_value(raw.get("used_percent"))
    if used is None:
        return None
    used = max(0, used)
    window_seconds = finite_numeric_value(raw.get("limit_window_seconds"))
    window_minutes = window_seconds / 60 if window_seconds is not None else None
    if window_minutes is not None and window_minutes.is_integer():
        window_minutes = int(window_minutes)
    return {
        "usedPercent": used,
        "remainingPercent": max(0, 100 - used),
        "windowMinutes": window_minutes,
        "resetsAt": parse_datetime(raw.get("reset_at")),
    }


def format_manual_reset_credits(raw):
    if not isinstance(raw, dict):
        return None

    def count(snake_key, camel_key):
        value = finite_numeric_value(raw.get(snake_key, raw.get(camel_key)))
        return max(0, int(value)) if value is not None else None

    available = count("available_count", "availableCount")
    applicable = count("applicable_available_count", "applicableAvailableCount")
    if available is None and applicable is None:
        return None
    return {"availableCount": available, "applicableAvailableCount": applicable}


def codex_account_identity(auth, home):
    payload = auth.get("idTokenPayload") or {}
    auth_info = payload.get("https://api.openai.com/auth") or {}
    return (
        auth_info.get("chatgpt_account_id")
        or auth.get("accountId")
        or payload.get("sub")
        or auth.get("email")
        or str(home)
    )


def decode_jwt_payload(token):
    if not token or token.count(".") < 2:
        return {}
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        return json.loads(
            base64.urlsafe_b64decode(part.encode("utf-8")).decode("utf-8")
        )
    except Exception:
        return {}


def latest_job_rate_limits_by_identity():
    latest_by_identity = {}
    for metadata_id, home in job_codex_homes():
        auth = load_codex_auth(home)
        if not auth.get("exists"):
            continue
        identity = codex_account_identity(auth, home)
        rate_limits = latest_rate_limits(
            home,
            session_limit=40,
            source="job home",
            metadata_id=metadata_id,
        )
        if rate_limits:
            latest_by_identity[identity] = newest_rate_limits(
                latest_by_identity.get(identity, {}), rate_limits
            )
    return latest_by_identity


def job_codex_homes():
    jobs = ENGINE_DATA_DIR / "jobs"
    if not jobs.exists():
        return []
    candidates = []
    try:
        for home in jobs.glob("metadata-*/home/.codex"):
            metadata_id = metadata_id_from_job_home(home)
            if metadata_id is not None:
                candidates.append((metadata_id, home))
    except OSError:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[:CODEX_JOB_HOME_SCAN_LIMIT]


def effective_codex_homes():
    homes = configured_codex_homes()
    observed_identities = set()
    for _, home in job_codex_homes():
        auth = load_codex_auth(home)
        if not auth.get("exists"):
            continue
        identity = codex_account_identity(auth, home)
        observed_identities.add(identity)
    return homes, len(observed_identities)


def metadata_id_from_job_home(home):
    for part in home.parts:
        if part.startswith("metadata-"):
            try:
                return int(part.split("-", 1)[1])
            except (IndexError, ValueError):
                return None
    return None


def newest_rate_limits(left, right):
    if not left:
        return right or {}
    if not right:
        return left or {}
    return (
        right
        if datetime_sort_key(right.get("observedAt"))
        >= datetime_sort_key(left.get("observedAt"))
        else left
    )


def latest_rate_limits(home, session_limit=400, source=None, metadata_id=None):
    sessions = home / "sessions"
    latest = None
    if not sessions.exists():
        return {}
    try:
        files = sorted(
            sessions.rglob("*.jsonl"),
            key=lambda item: item.stat().st_mtime,
            reverse=True,
        )[:session_limit]
    except OSError:
        return {}
    for path in files:
        for line in tail_lines(path):
            if '"rate_limits"' not in line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            payload = (
                event.get("payload") if isinstance(event.get("payload"), dict) else {}
            )
            raw = payload.get("rate_limits") or event.get("rate_limits")
            if not isinstance(raw, dict) or not (
                raw.get("primary") or raw.get("secondary")
            ):
                continue
            observed_at = parse_datetime(event.get("timestamp"))
            if latest is None or datetime_sort_key(observed_at) > datetime_sort_key(
                latest.get("observedAt")
            ):
                latest = {
                    "observedAt": observed_at,
                    "raw": raw,
                    "source": source,
                    "sourcePath": str(path),
                    "metadataId": metadata_id,
                }
    return latest or {}


def datetime_sort_key(value):
    return value.timestamp() if isinstance(value, datetime) else 0


def tail_lines(path, max_bytes=2 * 1024 * 1024):
    try:
        size = path.stat().st_size
        with path.open("rb") as handle:
            if size > max_bytes:
                handle.seek(size - max_bytes)
                handle.readline()
            data = handle.read()
    except OSError:
        return []
    return data.decode("utf-8", errors="ignore").splitlines()


def parse_datetime(value):
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc)
    text = str(value).strip()
    try:
        if text.isdigit():
            return datetime.fromtimestamp(int(text), timezone.utc)
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def format_limit(raw):
    if not isinstance(raw, dict):
        return None
    used = raw.get("used_percent", raw.get("usedPercent"))
    try:
        used = float(used)
    except (TypeError, ValueError):
        used = None
    resets_at = parse_datetime(raw.get("resets_at", raw.get("resetsAt")))
    window_minutes = raw.get("window_minutes", raw.get("windowMinutes"))
    if window_minutes is None:
        window_seconds = finite_numeric_value(raw.get("limit_window_seconds"))
        window_minutes = window_seconds / 60 if window_seconds is not None else None
    return {
        "usedPercent": used,
        "remainingPercent": None if used is None else max(0, 100 - used),
        "windowMinutes": window_minutes,
        "resetsAt": resets_at,
    }


def build_scan(
    scan,
    workflow_by_id,
    post_by_id,
    skill_by_id,
    step_by_id,
    metadata_by_scan,
    results_by_scan,
    vulnerabilities_by_scan,
    post_metadata_by_scan,
    enrichments_by_scan,
):
    workflow = workflow_by_id.get(scan["workflow_id"])
    post_script = post_by_id.get(scan["post_script_id"])
    agent_skills = [
        skill_by_id[skill_id]
        for skill_id in configured_agent_skill_ids(scan)
        if skill_id in skill_by_id
    ]
    steps = (
        [
            step_by_id[sid]
            for sid in (workflow.get("step_ids") or [])
            if sid in step_by_id
        ]
        if workflow
        else []
    )
    metadata = metadata_by_scan[scan["id"]]
    results = results_by_scan[scan["id"]]
    vulnerabilities = vulnerabilities_by_scan[scan["id"]]
    post_metadata = post_metadata_by_scan[scan["id"]]
    enrichments = enrichments_by_scan[scan["id"]]

    completed_keys = {
        metadata_key(row) for row in metadata if row.get("status") == "completed"
    }
    claimed_keys = {
        metadata_key(row)
        for row in metadata
        if row.get("status") in ("completed", "running")
    }
    results_by_line = defaultdict(list)
    result_count_by_step = defaultdict(int)
    for row in results:
        key = line_key(
            row["step_id"],
            row.get("prev_id"),
            row.get("prev_table"),
            row.get("repeat_run"),
        )
        results_by_line[key].append(row)
        result_count_by_step[row["step_id"]] += 1

    queue = build_queue(scan, steps, completed_keys, claimed_keys, results_by_line)
    latest_by_line = {}
    completed_by_line = {}
    for row in metadata:
        key = metadata_key(row)
        if key not in latest_by_line or row_time(row) > row_time(latest_by_line[key]):
            latest_by_line[key] = row
        if row.get("status") == "completed" and (
            key not in completed_by_line
            or row_time(row) > row_time(completed_by_line[key])
        ):
            completed_by_line[key] = row

    vuln_count_by_step = defaultdict(int)
    metadata_by_id = {row["id"]: row for row in metadata}
    vulnerabilities_by_metadata = defaultdict(list)
    for vuln in vulnerabilities:
        meta = metadata_by_id.get(vuln["scan_metadata_id"])
        if meta:
            vuln_count_by_step[meta["step_id"]] += 1
            vulnerabilities_by_metadata[vuln["scan_metadata_id"]].append(vuln)

    steps_by_id = {step["id"]: step for step in steps}
    running_jobs = [
        attempt_job(row, steps_by_id)
        for row in metadata
        if row.get("status") == "running"
    ]
    active = running_jobs[0] if running_jobs else None
    step_summaries = [
        summarize_step(
            step,
            metadata,
            queue["expected_by_step"].get(step["id"], set()),
            latest_by_line,
            completed_by_line,
            result_count_by_step[step["id"]],
            vuln_count_by_step[step["id"]],
            active,
            scan["status"] == "failed",
        )
        for step in steps
    ]

    expected_total = sum(step["expected"] for step in step_summaries)
    completed_total = sum(step["completed"] for step in step_summaries)
    running_total = sum(step["running"] for step in step_summaries)
    findings = len(vulnerabilities)
    exploitable = sum(
        1
        for v in vulnerabilities
        if v.get("exploitable_value") == "true"
        or (v.get("json_answer") or {}).get("exploitable") in (True, "true")
    )
    runtimes = [
        millis(row.get("run_time_ms"))
        for row in metadata
        if row.get("run_time_ms") is not None
    ]
    total_subagents = sum(subagent_count(row) for row in metadata) + sum(
        subagent_count(row) for row in post_metadata
    )
    configured_post_script_count = len(configured_post_script_ids(scan))
    post = summarize_post_processing(
        vulnerabilities,
        post_metadata,
        enrichments,
        expected_post_script_count=configured_post_script_count,
    )

    return {
        "scan": {
            "id": scalar_id(scan["id"]),
            "repoFull": scan["repo_full"],
            "commitSha": scan["commit_sha"],
            "repoScope": scan["repo_scope"],
            "model": scan["model"],
            "modelProvider": scan.get("model_provider") or "openrouter",
            "thinkingEffort": scan.get("thinking_effort") or "medium",
            "harness": scan["harness"],
            "status": scan["status"],
            "workflowId": scalar_id(scan["workflow_id"]),
            "workflowName": workflow.get("name") if workflow else None,
            "postScriptName": post_script.get("name") if post_script else None,
            "agentSkills": [
                {
                    "name": skill.get("name"),
                    "sourceUrl": skill.get("source_url"),
                }
                for skill in agent_skills
            ],
            "agentSkillNames": [skill.get("name") for skill in agent_skills],
            "agentSkillCount": len(agent_skills),
            "repeatRuns": repeat_runs(scan),
            "findings": findings,
            "exploitable": exploitable,
            "insertedAt": scan["inserted_at"],
            "updatedAt": scan["updated_at"],
            "reasoning": scan.get("reasoning"),
        },
        "queue": {
            "pendingCount": len(queue["pending"]),
            "activeJob": active,
            "activeJobs": running_jobs,
            "runningCount": running_total,
            "nextJobs": queue["pending"][:10],
            "completedTotal": completed_total,
            "expectedTotal": expected_total,
            "progressPct": round((completed_total / expected_total) * 100)
            if expected_total
            else 0,
        },
        "steps": step_summaries,
        "attempts": summarize_attempts(
            metadata, steps_by_id, results_by_line, vulnerabilities_by_metadata
        ),
        "postProcessing": post,
        "errors": summarize_errors(scan, metadata, post_metadata, steps_by_id),
        "totals": {
            "attempts": len(metadata),
            "completedAttempts": sum(
                1 for row in metadata if row.get("status") == "completed"
            ),
            "runningAttempts": sum(
                1 for row in metadata if row.get("status") == "running"
            ),
            "failedAttempts": sum(
                1 for row in metadata if row.get("status") == "failed"
            ),
            "noResultAttempts": sum(1 for row in metadata if row.get("stub")),
            "stepResults": len(results),
            "vulnerabilities": len(vulnerabilities),
            "canonicalVulnerabilities": post["canonicalCount"],
            "duplicateVulnerabilities": post["duplicateCount"],
            "enrichments": post["enrichmentCount"],
            "postAttempts": post["attempts"],
            "runningPostAttempts": post["runningAttempts"],
            "subagents": total_subagents,
            "avgRuntimeMs": round(sum(runtimes) / len(runtimes)) if runtimes else None,
            "totalRuntimeMs": sum(runtimes),
        },
    }


def summarize_post_processing(
    vulnerabilities, post_metadata, enrichments, expected_post_script_count
):
    canonical = [
        row for row in vulnerabilities if row.get("dedupe_is_canonical") is True
    ]
    duplicates = [
        row for row in vulnerabilities if row.get("dedupe_is_canonical") is False
    ]
    unprocessed = [
        row for row in vulnerabilities if row.get("dedupe_is_canonical") is None
    ]
    ranked = [row for row in canonical if row.get("bounty_rank") is not None]
    running = [
        post_process_job(row) for row in post_metadata if row.get("status") == "running"
    ]
    recent = summarize_post_attempts(post_metadata)
    runtimes = [
        millis(row.get("run_time_ms"))
        for row in post_metadata
        if row.get("run_time_ms") is not None
    ]
    enrichment_targets = len(canonical) * max(0, expected_post_script_count)
    total_targets = len(vulnerabilities) + len(canonical) + enrichment_targets
    completed_targets = (
        len(vulnerabilities)
        - len(unprocessed)
        + len(ranked)
        + min(len(enrichments), enrichment_targets)
    )
    progress_pct = (
        round((completed_targets / total_targets) * 100) if total_targets else 0
    )
    return {
        "canonicalCount": len(canonical),
        "duplicateCount": len(duplicates),
        "unprocessedDedupeCount": len(unprocessed),
        "rankedCount": len(ranked),
        "unrankedCanonicalCount": max(0, len(canonical) - len(ranked)),
        "enrichmentCount": len(enrichments),
        "pendingEnrichmentCount": max(0, enrichment_targets - len(enrichments)),
        "postScriptEnabled": expected_post_script_count > 0,
        "postScriptCount": expected_post_script_count,
        "attempts": len(post_metadata),
        "completedAttempts": sum(
            1 for row in post_metadata if row.get("status") == "completed"
        ),
        "runningAttempts": sum(
            1 for row in post_metadata if row.get("status") == "running"
        ),
        "failedAttempts": sum(
            1 for row in post_metadata if row.get("status") == "failed"
        ),
        "activeJobs": running,
        "recentAttempts": recent,
        "progressPct": progress_pct,
        "avgRuntimeMs": round(sum(runtimes) / len(runtimes)) if runtimes else None,
        "totalRuntimeMs": sum(runtimes),
    }


def post_process_job(row):
    phase = effective_phase(row)
    return {
        "id": scalar_id(row["id"]),
        "kind": row.get("kind"),
        "batchIndex": row.get("batch_index"),
        "vulnerabilityId": scalar_id(row.get("vulnerability_id")),
        "postScriptName": row.get("post_script_name"),
        "targetIds": [
            scalar_id(value) for value in (row.get("target_vulnerability_ids") or [])
        ],
        "status": row.get("status"),
        "phase": phase,
        "phaseLabel": phase_label(phase),
        "startedAt": row.get("run_started_at") or row.get("inserted_at"),
        "elapsedMs": int(
            (
                datetime.now(timezone.utc)
                - (row.get("run_started_at") or row.get("inserted_at"))
            ).total_seconds()
            * 1000
        )
        if row.get("run_started_at") or row.get("inserted_at")
        else None,
        "model": row.get("model"),
        "harness": row.get("harness"),
        "thinkingEffort": row.get("thinking_effort"),
        "modelProvider": row.get("model_provider"),
        "subagentCount": subagent_count(row),
        "codexSourceHome": row.get("codex_source_home"),
        "codexAccountId": row.get("codex_account_id"),
        "codexAccountEmail": row.get("codex_account_email"),
    }


def summarize_post_attempts(post_metadata):
    out = []
    for row in sorted(post_metadata, key=row_time, reverse=True)[:RECENT_ATTEMPT_LIMIT]:
        phase = effective_phase(row)
        out.append(
            {
                "id": scalar_id(row["id"]),
                "kind": row.get("kind"),
                "batchIndex": row.get("batch_index"),
                "vulnerabilityId": scalar_id(row.get("vulnerability_id")),
                "targetIds": [
                    scalar_id(value)
                    for value in (row.get("target_vulnerability_ids") or [])
                ],
                "postScriptName": row.get("post_script_name"),
                "status": row.get("status"),
                "phase": phase,
                "phaseLabel": phase_label(phase),
                "runStartedAt": row.get("run_started_at"),
                "runTimeMs": millis(row.get("run_time_ms")),
                "elapsedMs": int(
                    (
                        datetime.now(timezone.utc)
                        - (row.get("run_started_at") or row.get("inserted_at"))
                    ).total_seconds()
                    * 1000
                )
                if row.get("status") == "running"
                and (row.get("run_started_at") or row.get("inserted_at"))
                else None,
                "insertedAt": row.get("inserted_at"),
                "checkedOutCommit": row.get("checked_out_commit"),
                "codexSessionId": row.get("codex_session_id"),
                "codexSourceHome": row.get("codex_source_home"),
                "codexAccountId": row.get("codex_account_id"),
                "codexAccountEmail": row.get("codex_account_email"),
                "error": clean_error(row.get("error")),
                "knownError": known_error(row.get("error")),
                "rawError": display_error(row.get("error")),
                "promptTemplate": clip_prompt_text(row.get("prompt_template")),
                "promptFilled": clip_prompt_text(row.get("prompt_filled")),
                "outputJson": row.get("output_json"),
                "rawTokenUsage": row.get("raw_token_usage"),
                "model": row.get("model"),
                "harness": row.get("harness"),
                "thinkingEffort": row.get("thinking_effort"),
                "modelProvider": row.get("model_provider"),
                "subagentCount": subagent_count(row),
                "tokens": {
                    "cachedInput": row.get("token_count_cached_input"),
                    "input": row.get("token_count_input"),
                    "output": row.get("token_count_output"),
                    "reasoningOutput": row.get("token_count_reasoning_output"),
                    "total": row.get("token_count_total"),
                },
            }
        )
    return out


def build_queue(scan, steps, completed_keys, claimed_keys, results_by_line):
    depths = sorted({step["depth"] for step in steps})
    by_depth = {
        depth: sorted(
            [step for step in steps if step["depth"] == depth],
            key=lambda item: item["id"],
        )
        for depth in depths
    }
    states = [
        {"prev_id": 0, "prev_table": None, "repeat_run": run}
        for run in range(1, repeat_runs(scan) + 1)
    ]
    expected_by_step = defaultdict(set)
    pending = []

    for depth in depths:
        next_states = []
        for state in states:
            for step in by_depth[depth]:
                key = state_key(step["id"], state)
                expected_by_step[step["id"]].add(key)
                if key not in completed_keys:
                    if key not in claimed_keys:
                        pending.append(job_from_state(step, state))
                    continue
                if step["is_last_step"]:
                    continue
                for row in results_by_line.get(key, []):
                    next_states.append(
                        {
                            "prev_id": row["id"],
                            "prev_table": STEP_RESULTS_TABLE,
                            "repeat_run": state["repeat_run"],
                        }
                    )
        states = next_states

    pending.sort(key=lambda job: (-job["depth"], job["repeatRun"], int(job["stepId"])))
    return {"expected_by_step": expected_by_step, "pending": pending}


def job_from_state(step, state):
    return {
        "stepId": scalar_id(step["id"]),
        "stepName": step.get("name") or f"Step {step['id']}",
        "depth": step["depth"],
        "prevId": state["prev_id"],
        "prevTable": state["prev_table"],
        "repeatRun": state["repeat_run"],
    }


def attempt_job(row, steps_by_id):
    step = steps_by_id.get(row["step_id"], {})
    phase = effective_phase(row)
    return {
        "stepId": scalar_id(row["step_id"]),
        "stepName": step.get("name") or f"Step {row['step_id']}",
        "depth": step.get("depth"),
        "prevId": row.get("prev_id") or 0,
        "prevTable": row.get("prev_table"),
        "repeatRun": row.get("repeat_run") or 1,
        "metadataId": scalar_id(row["id"]),
        "phase": phase,
        "phaseLabel": phase_label(phase),
        "codexSourceHome": row.get("codex_source_home"),
        "codexAccountId": row.get("codex_account_id"),
        "codexAccountEmail": row.get("codex_account_email"),
        "model": row.get("model"),
        "harness": row.get("harness"),
        "thinkingEffort": row.get("thinking_effort"),
        "modelProvider": row.get("model_provider"),
        "subagentCount": subagent_count(row),
        "startedAt": row.get("run_started_at") or row.get("inserted_at"),
        "elapsedMs": int(
            (
                datetime.now(timezone.utc)
                - (row.get("run_started_at") or row.get("inserted_at"))
            ).total_seconds()
            * 1000
        )
        if row.get("run_started_at") or row.get("inserted_at")
        else None,
    }


def summarize_step(
    step,
    metadata,
    expected_keys,
    latest_by_line,
    completed_by_line,
    result_count,
    vuln_count,
    active_job,
    scan_failed,
):
    rows = [row for row in metadata if row["step_id"] == step["id"]]
    latest_rows = {
        key: latest_by_line[key] for key in expected_keys if key in latest_by_line
    }
    completed_rows = [
        completed_by_line[key] for key in expected_keys if key in completed_by_line
    ]
    completed_keys = set(completed_by_line.keys())
    completed = len(completed_rows)
    running = sum(
        1
        for key, row in latest_rows.items()
        if key not in completed_keys and row.get("status") == "running"
    )
    failed_lineages = sum(
        1
        for key, row in latest_rows.items()
        if key not in completed_keys and row.get("status") == "failed"
    )
    no_result_lineages = sum(1 for row in completed_rows if row.get("stub"))
    expected = len(expected_keys)
    active = active_job and active_job["stepId"] == scalar_id(step["id"])
    pending = max(0, expected - completed - running)
    latest = max(rows, key=row_time) if rows else None
    runtimes = [
        millis(row.get("run_time_ms"))
        for row in rows
        if row.get("run_time_ms") is not None
    ]

    status = "waiting"
    if expected > 0 and completed >= expected:
        status = "completed"
    elif active:
        status = "running"
    elif scan_failed and failed_lineages:
        status = "failed"
    elif pending:
        status = "pending"
    elif rows:
        status = latest.get("status") or "waiting"
    current_phase = (
        active_job.get("phase")
        if active
        else (effective_phase(latest) if latest else status)
    )

    return {
        "id": scalar_id(step["id"]),
        "name": step.get("name") or f"Step {step['id']}",
        "depth": step["depth"],
        "multiOutput": bool(step["multi_output"]),
        "isLast": bool(step["is_last_step"]),
        "status": status,
        "phase": current_phase,
        "phaseLabel": phase_label(current_phase),
        "expected": expected,
        "completed": completed,
        "running": running,
        "pending": pending,
        "failedLineages": failed_lineages,
        "noResultLineages": no_result_lineages,
        "attempts": len(rows),
        "failedAttempts": sum(1 for row in rows if row.get("status") == "failed"),
        "completedAttempts": sum(1 for row in rows if row.get("status") == "completed"),
        "noResultAttempts": sum(1 for row in rows if row.get("stub")),
        "outputRows": vuln_count if step["is_last_step"] else result_count,
        "avgRuntimeMs": round(sum(runtimes) / len(runtimes)) if runtimes else None,
        "lastRuntimeMs": millis(latest.get("run_time_ms")) if latest else None,
        "totalRuntimeMs": sum(runtimes),
        "latestAt": latest.get("inserted_at") if latest else None,
        "latestStatus": latest.get("status") if latest else None,
        "latestError": clean_error(latest.get("error"))
        if latest and not latest.get("stub")
        else None,
        "latestKnownError": known_error(latest.get("error"))
        if latest and not latest.get("stub")
        else None,
    }


def summarize_attempts(
    metadata, steps_by_id, results_by_line, vulnerabilities_by_metadata
):
    out = []
    for row in sorted(metadata, key=row_time, reverse=True)[:RECENT_ATTEMPT_LIMIT]:
        step = steps_by_id.get(row["step_id"])
        phase = effective_phase(row)
        outputs = []
        if row.get("status") == "completed":
            if step and step.get("is_last_step"):
                outputs = vulnerabilities_by_metadata.get(row["id"], [])
            else:
                outputs = results_by_line.get(metadata_key(row), [])
        out.append(
            {
                "id": scalar_id(row["id"]),
                "stepId": scalar_id(row["step_id"]),
                "stepName": step.get("name") if step else f"Step {row['step_id']}",
                "depth": step.get("depth") if step else None,
                "status": row.get("status"),
                "phase": phase,
                "phaseLabel": phase_label(phase),
                "noResult": bool(row.get("stub")),
                "stubExplanation": row.get("stub_explanation"),
                "prevId": scalar_id(row.get("prev_id") or 0),
                "prevTable": row.get("prev_table"),
                "repeatRun": row.get("repeat_run") or 1,
                "runStartedAt": row.get("run_started_at"),
                "runTimeMs": millis(row.get("run_time_ms")),
                "elapsedMs": int(
                    (
                        datetime.now(timezone.utc)
                        - (row.get("run_started_at") or row.get("inserted_at"))
                    ).total_seconds()
                    * 1000
                )
                if row.get("status") == "running"
                and (row.get("run_started_at") or row.get("inserted_at"))
                else None,
                "insertedAt": row.get("inserted_at"),
                "checkedOutCommit": row.get("checked_out_commit"),
                "codexSessionId": row.get("codex_session_id"),
                "codexSourceHome": row.get("codex_source_home"),
                "codexAccountId": row.get("codex_account_id"),
                "codexAccountEmail": row.get("codex_account_email"),
                "error": clean_error(row.get("error")),
                "knownError": known_error(row.get("error")),
                "rawError": display_error(row.get("error")),
                "promptTemplate": clip_prompt_text(row.get("prompt_template")),
                "promptFilled": clip_prompt_text(row.get("prompt_filled")),
                "outputCount": len(outputs),
                "outputs": output_preview(outputs),
                "rawTokenUsage": row.get("raw_token_usage"),
                "model": row.get("model"),
                "harness": row.get("harness"),
                "thinkingEffort": row.get("thinking_effort"),
                "modelProvider": row.get("model_provider"),
                "subagentCount": subagent_count(row),
                "tokens": {
                    "cachedInput": row.get("token_count_cached_input"),
                    "input": row.get("token_count_input"),
                    "output": row.get("token_count_output"),
                    "reasoningOutput": row.get("token_count_reasoning_output"),
                    "total": row.get("token_count_total"),
                },
            }
        )
    return out


def scan_reasoning_error(scan):
    reasoning = scan.get("reasoning") if isinstance(scan.get("reasoning"), dict) else {}
    raw_error = reasoning.get("error") or reasoning.get("message")
    message = clean_error(raw_error)
    if not message:
        return None
    return {
        "id": f"scan-{scalar_id(scan['id'])}",
        "metadataId": None,
        "kind": "scan",
        "source": "Scan",
        "title": "Scan failure",
        "status": scan.get("status"),
        "phase": scan.get("status"),
        "phaseLabel": phase_label(scan.get("status")),
        "message": message,
        "knownError": known_error(raw_error),
        "runTimeMs": None,
        "insertedAt": scan.get("inserted_at"),
        "updatedAt": scan.get("updated_at"),
        "codexAccountEmail": None,
        "codexAccountId": None,
        "codexSourceHome": None,
    }


def metadata_source(row):
    kind = row.get("kind") or "step"
    if kind == "post_script":
        return row.get("post_script_name") or "Post-script"
    if kind == "dedupe":
        return "Dedupe"
    if kind == "ranker":
        return "Ranker"
    return "Workflow step"


def metadata_title(row, steps_by_id):
    kind = row.get("kind") or "step"
    if kind != "step":
        source = metadata_source(row)
        return (
            f"{source} batch {row.get('batch_index')}"
            if row.get("batch_index") is not None
            else source
        )
    step = steps_by_id.get(row.get("step_id"))
    if not step:
        return f"Step {row.get('step_id')}"
    step_name = step.get("name") or f"Step {row.get('step_id')}"
    return f"d{step.get('depth')} · {step_name}"


def metadata_error(row, steps_by_id):
    if row.get("stub"):
        return None
    raw_error = row.get("error")
    message = clean_error(raw_error)
    if not message:
        return None
    phase = effective_phase(row)
    return {
        "id": scalar_id(row["id"]),
        "metadataId": scalar_id(row["id"]),
        "kind": row.get("kind") or "step",
        "source": metadata_source(row),
        "title": metadata_title(row, steps_by_id),
        "status": row.get("status"),
        "phase": phase,
        "phaseLabel": phase_label(phase),
        "message": message,
        "knownError": known_error(raw_error),
        "runTimeMs": millis(row.get("run_time_ms")),
        "insertedAt": row.get("inserted_at"),
        "updatedAt": row.get("updated_at"),
        "codexAccountEmail": row.get("codex_account_email"),
        "codexAccountId": row.get("codex_account_id"),
        "codexSourceHome": row.get("codex_source_home"),
    }


def summarize_errors(scan, metadata, post_metadata, steps_by_id):
    errors = []
    scan_error = scan_reasoning_error(scan)
    if scan_error:
        errors.append(scan_error)
    for row in metadata:
        error = metadata_error(row, steps_by_id)
        if error:
            errors.append(error)
    for row in post_metadata:
        error = metadata_error(row, steps_by_id)
        if error:
            errors.append(error)
    errors.sort(key=activity_time, reverse=True)
    return errors[:16]


HTML = r"""<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>open-kritt executor</title>
  <style>
    :root {
      --bg:#f7f7f4; --surface:#ffffff; --surface2:#eeeeea; --side:#f0f0eb;
      --text:#191a17; --muted:#656961; --faint:#8b8f86; --border:#d9d9d1;
      --accent:#2563eb; --run:#0f8b8d; --ok:#28834f; --fail:#c2412d; --pend:#b7791f;
      --runbg:#e2f4f2; --okbg:#e8f5ed; --failbg:#fae9e5; --pendbg:#fff3d7;
    }
    * { box-sizing:border-box; }
    body { margin:0; font:14px Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--text); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; }
    .app { height:100vh; display:flex; flex-direction:column; overflow:hidden; }
    header { flex:none; border-bottom:1px solid var(--border); padding:22px 30px 18px; background:var(--bg); }
    .top { display:flex; align-items:flex-start; justify-content:space-between; gap:18px; }
    h1 { font-size:27px; line-height:1; margin:0; letter-spacing:-.02em; }
    .sub { color:var(--muted); font-size:13px; margin-top:7px; }
    .pill { display:inline-flex; align-items:center; gap:7px; border-radius:20px; padding:4px 11px; font-size:12px; background:var(--surface2); color:var(--muted); }
    .pill.run { background:var(--runbg); color:var(--run); }
    .dot { width:7px; height:7px; border-radius:50%; background:currentColor; }
    .stats { display:grid; grid-template-columns:repeat(6,minmax(92px,1fr)); gap:10px; margin-top:18px; }
    .stat, .metric, .panel { border:1px solid var(--border); border-radius:8px; background:var(--surface); }
    .stat { padding:10px 12px; }
    .label { color:var(--faint); letter-spacing:.06em; font-size:10px; text-transform:uppercase; }
    .value { font-size:22px; line-height:1.1; font-weight:650; margin-top:5px; }
    main { flex:1; min-height:0; display:grid; grid-template-columns:330px minmax(0,1fr); overflow:hidden; }
    aside { border-right:1px solid var(--border); background:var(--side); padding:16px; overflow:auto; }
    .queue-title { color:var(--faint); font-size:10.5px; letter-spacing:.07em; margin:2px 0 10px 4px; }
    .scan { border:1px solid var(--border); border-radius:8px; padding:12px; margin-bottom:9px; cursor:pointer; }
    .scan.active { background:var(--surface); box-shadow:0 8px 24px rgba(0,0,0,.06); }
    .row { display:flex; justify-content:space-between; align-items:flex-start; gap:10px; }
    .name { font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .small { color:var(--faint); font-size:11px; }
    .badge { display:inline-flex; align-items:center; gap:6px; font-size:11.5px; border-radius:20px; padding:3px 9px; white-space:nowrap; }
    .completed { color:var(--ok); background:var(--okbg); }
    .prewarming_cache { color:var(--pend); background:var(--pendbg); }
    .running { color:var(--run); background:var(--runbg); }
    .building_workspace { color:var(--pend); background:var(--pendbg); }
    .running_harness { color:var(--run); background:var(--runbg); }
    .writing_db { color:var(--accent); background:#e8f0ff; }
    .post_processing { color:var(--run); background:var(--runbg); }
    .paused { color:var(--muted); background:var(--surface2); }
    .pending, .queued, .waiting { color:var(--pend); background:var(--pendbg); }
    .failed { color:var(--fail); background:var(--failbg); }
    .progress { height:6px; background:var(--surface2); border-radius:99px; overflow:hidden; }
    .bar { height:100%; background:var(--run); border-radius:99px; }
    .phase-run-strip { margin-top:12px; display:flex; flex-direction:column; gap:8px; }
    .phase-run-strip.compact { margin-top:8px; gap:6px; }
    .phase-run-strip.empty { color:var(--faint); font-size:11px; }
    .phase-run-list { display:flex; gap:6px; flex-wrap:wrap; min-width:0; }
    .phase-run-pill { display:inline-flex; align-items:center; gap:6px; max-width:100%; border:1px solid var(--border); border-radius:7px; background:var(--surface2); color:var(--muted); padding:3px 7px; font-size:11px; line-height:1.2; }
    .phase-run-pill span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:150px; }
    .phase-run-pill strong { color:var(--text); font-size:12px; }
    .phase-run-pill.active { color:var(--run); background:var(--runbg); border-color:#b6d9d6; }
    section.content { overflow:auto; padding:24px 28px 34px; }
    .detail-top { display:flex; justify-content:space-between; align-items:flex-start; gap:18px; margin-bottom:20px; }
    .title { font-size:23px; font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    button { height:32px; padding:0 14px; border-radius:8px; border:1px solid var(--border); background:var(--surface); color:var(--muted); cursor:pointer; }
    button.primary-action { color:var(--run); border-color:#8ec8c3; background:var(--runbg); }
    button.pause-action { color:var(--pend); border-color:#e2bf6f; background:var(--pendbg); }
    button:disabled { opacity:.55; cursor:not-allowed; }
    .grid { display:grid; grid-template-columns:1.4fr repeat(6,minmax(100px,.6fr)); gap:10px; margin-bottom:18px; }
    .wide-metric { padding:14px; }
    .metric { padding:14px; }
    .section-title { font-size:15px; font-weight:650; margin:4px 0 3px; }
    .section-sub { color:var(--muted); font-size:12.5px; margin-bottom:10px; }
    .step { display:grid; grid-template-columns:minmax(220px,1.4fr) minmax(150px,.8fr) repeat(4,minmax(96px,.5fr)); gap:14px; align-items:center; padding:14px 16px; border-bottom:1px solid var(--border); }
    .step.active { background:var(--runbg); }
    .chip { color:var(--faint); background:var(--surface2); border-radius:5px; padding:3px 7px; font-size:10.5px; }
    .attempt { border-bottom:1px solid var(--border); }
    .attempt-main { display:grid; grid-template-columns:minmax(170px,1fr) 100px 92px 108px minmax(180px,1.4fr); gap:14px; align-items:start; padding:11px 14px; }
    .attempt-details { padding:0 14px 14px; }
    details { border:1px solid var(--border); border-radius:8px; background:#fbfbf8; margin-top:10px; }
    summary { cursor:pointer; padding:8px 10px; color:var(--muted); font-size:12px; }
    pre { margin:0; padding:11px 12px; overflow:visible; border-top:1px solid var(--border); white-space:pre-wrap; word-break:break-word; font-size:11.5px; line-height:1.45; background:#fff; }
    .prompt-summary { display:inline-flex; align-items:center; gap:8px; }
    .prompt-spinner { width:11px; height:11px; border:2px solid var(--border); border-top-color:var(--accent); border-radius:50%; animation:spin .7s linear infinite; }
    .prompt-spinner[hidden] { display:none; }
    .prompt-status { color:var(--faint); font-size:11px; }
    @keyframes spin { to { transform:rotate(360deg); } }
    .cols { display:grid; grid-template-columns:minmax(0,1fr) 340px; gap:16px; }
    .next { padding:11px 13px; border-bottom:1px solid var(--border); }
    .error { color:var(--fail); font-size:11.5px; line-height:1.35; margin-top:7px; }
    .status-log { display:grid; grid-template-columns:minmax(0,1fr) minmax(280px,.65fr); gap:12px; margin-bottom:22px; }
    .status-box { border:1px solid var(--border); border-radius:8px; background:var(--surface); padding:13px 14px; min-width:0; }
    .status-box.error-box { border-color:#efc2bb; background:#fff7f5; }
    .status-lines { display:grid; gap:8px; margin-top:10px; }
    .status-line { border:1px solid var(--border); border-radius:7px; padding:8px 9px; background:#fbfbf8; min-width:0; }
    .status-line.error-line { border-color:#efc2bb; background:#fff; }
    .status-line-title { display:flex; justify-content:space-between; gap:10px; color:var(--muted); font-size:11px; margin-bottom:5px; }
    .status-line-message { color:var(--fail); font-size:11.5px; line-height:1.4; overflow-wrap:anywhere; }
    .known-error-chip { display:inline-flex; align-items:center; max-width:100%; border:1px solid #efc2bb; border-radius:999px; padding:2px 7px; background:var(--failbg); color:var(--fail); font-size:10.5px; white-space:nowrap; }
    .known-error-links { display:flex; flex-wrap:wrap; gap:8px; margin-top:6px; font-size:11px; line-height:1.2; }
    .known-error-links a { color:var(--accent); text-decoration:none; border-bottom:1px solid rgba(37,99,235,.28); }
    @media (max-width: 1000px) {
      main { grid-template-columns:1fr; }
      aside { max-height:260px; border-right:0; border-bottom:1px solid var(--border); }
      .grid, .cols, .status-log { grid-template-columns:1fr; }
      .step, .attempt { grid-template-columns:1fr; }
      .stats { grid-template-columns:repeat(2,1fr); }
    }
  </style>
</head>
<body>
<div class="app">
  <header>
    <div class="top">
      <div>
        <div style="display:flex;align-items:center;gap:12px"><h1 id="page-title">Executor</h1><span id="engine-pill" class="pill"><span class="dot"></span><span>loading</span></span></div>
        <div id="page-sub" class="sub">Standalone queue view reading directly from Postgres. Refreshes every 5 seconds.</div>
      </div>
      <div style="display:flex;align-items:center;gap:10px"><span id="refresh-age" class="mono small"></span><button id="refresh-button" onclick="load({manual:true})">Refresh</button></div>
    </div>
    <div id="stats" class="stats"></div>
  </header>
  <main id="main">
    <aside><div class="mono queue-title">SCAN QUEUE</div><div id="queue"></div></aside>
    <section class="content"><div id="detail"></div></section>
  </main>
</div>
<script>
let state = null;
let selectedId = null;
let openDetails = new Set();
let fullPromptCache = new Map();
let autoRenderDeferred = false;

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const knownErrorBadge = (item) => item?.knownError ? `<span class="known-error-chip">${esc(item.knownError.title || 'Known error')}</span>` : '';
const knownErrorLinks = (item) => {
  const links = item?.knownError?.fixLinks || [];
  if (!links.length) return '';
  return `<div class="known-error-links">${links.map(link => `<a href="${esc(link.url)}" target="_blank" rel="noreferrer">${esc(link.label || link.url)}</a>`).join('')}</div>`;
};
const agentSkillLinks = (scan) => {
  const skills = scan.agentSkills?.length ? scan.agentSkills : (scan.agentSkillNames || []).map(name => ({name}));
  return skills.map(skill => skill.sourceUrl
    ? `<a href="${esc(skill.sourceUrl)}" target="_blank" rel="noreferrer" style="color:var(--accent);text-decoration:none">${esc(skill.name)}</a>`
    : esc(skill.name)
  ).join(' · ');
};
const ms = (v) => {
  if (v == null || Number.isNaN(Number(v))) return '—';
  v = Number(v);
  if (v < 1000) return `${v}ms`;
  const s = v / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const rounded = Math.round(s);
  return `${Math.floor(rounded / 60)}m ${rounded % 60}s`;
};
const age = (v) => {
  if (!v) return '—';
  const s = Math.max(0, Math.floor((Date.now() - new Date(v).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
};
const time = (v) => v ? new Date(v).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit', second:'2-digit'}) : '—';
const statusBadge = (s, label = null) => `<span class="badge ${esc(s)}"><span class="dot"></span>${esc(label || s || 'unknown')}</span>`;
const phaseBadge = (item) => statusBadge(item?.phase || item?.status, item?.phaseLabel || item?.status);
const progress = (v) => `<div class="progress"><div class="bar" style="width:${Math.max(0, Math.min(100, Number(v)||0))}%"></div></div>`;
const pretty = (v) => JSON.stringify(v ?? null, null, 2);
const tokenSummary = (attempt) => {
  const t = attempt.tokens || {};
  const raw = [t.input && `in ${t.input}`, t.output && `out ${t.output}`, t.reasoningOutput && `reason ${t.reasoningOutput}`, t.total && `total ${t.total}`].filter(Boolean).join(' · ');
  return raw || 'no token data';
};
const subagentSummary = (item) => `subagents ${Number(item?.subagentCount || 0)}`;
const runConfigSummary = (item) => [item?.harness, item?.modelProvider, item?.model, item?.thinkingEffort && `thinking ${item.thinkingEffort}`].filter(Boolean).join(' · ') || 'run config unknown';
const accountSummary = (item) => {
  if (!item) return '';
  if (item.codexAccountEmail) return item.codexAccountEmail;
  if (item.codexAccountId) return item.codexAccountId;
  if (item.codexSourceHome) return item.codexSourceHome.split('/').slice(-2).join('/');
  return '';
};

document.addEventListener('toggle', (event) => {
  const detail = event.target;
  if (!detail?.matches?.('details[data-detail]')) return;
  if (detail.open) openDetails.add(detail.dataset.detail);
  else openDetails.delete(detail.dataset.detail);
  if (detail.open) loadFullPrompt(detail);
  else resumeDeferredAutoRender();
}, true);

function captureOpenDetails() {
  document.querySelectorAll('details[data-detail][open]').forEach((detail) => openDetails.add(detail.dataset.detail));
}

function restoreOpenDetails() {
  document.querySelectorAll('details[data-detail]').forEach((detail) => {
    if (openDetails.has(detail.dataset.detail)) {
      detail.open = true;
      loadFullPrompt(detail);
    }
  });
}

function fullPromptKey(detail) {
  return `${detail.dataset.promptKind || ''}:${detail.dataset.promptId || ''}`;
}

function promptLoadingState(detail, loading, message='') {
  const spinner = detail.querySelector('[data-prompt-spinner]');
  const status = detail.querySelector('[data-prompt-status]');
  if (spinner) spinner.hidden = !loading;
  if (status) status.textContent = message;
}

async function loadFullPrompt(detail) {
  if (!detail?.matches?.('details[data-full-prompt]') || !detail.open) return;
  const target = detail.querySelector('[data-full-prompt-target]');
  if (!target) return;
  const key = fullPromptKey(detail);
  if (fullPromptCache.has(key)) {
    target.textContent = fullPromptCache.get(key);
    promptLoadingState(detail, false, 'full');
    return;
  }
  if (detail.dataset.promptLoading === '1') return;
  detail.dataset.promptLoading = '1';
  promptLoadingState(detail, true, 'loading');
  try {
    const url = new URL('/api/prompt', window.location.origin);
    url.searchParams.set('kind', detail.dataset.promptKind || '');
    url.searchParams.set('id', detail.dataset.promptId || '');
    const res = await fetch(url, {cache: 'no-store'});
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload.error || `HTTP ${res.status}`);
    const prompt = payload.promptFilled || '';
    fullPromptCache.set(key, prompt);
    target.textContent = prompt;
    promptLoadingState(detail, false, `full · ${prompt.length.toLocaleString()} chars`);
  } catch (err) {
    promptLoadingState(detail, false, `failed: ${err.message || err}`);
  } finally {
    detail.dataset.promptLoading = '0';
  }
}

function shouldDeferAutoRender() {
  return Boolean(document.querySelector('details[data-detail][open]'));
}

function resumeDeferredAutoRender() {
  if (!autoRenderDeferred || shouldDeferAutoRender()) return;
  render();
}

function setRefreshText(suffix='') {
  const el = document.getElementById('refresh-age');
  if (el && state) el.textContent = `updated ${age(state.generatedAt)}${suffix}`;
}

async function load(options = {}) {
  const refreshButton = document.getElementById('refresh-button');
  const previousLabel = refreshButton?.textContent || 'Refresh';
  if (options.manual && refreshButton) {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing';
  }
  try {
    const url = new URL('/api/state', window.location.origin);
    if (options.manual) url.searchParams.set('_', String(Date.now()));
    const res = await fetch(url, {cache: 'no-store'});
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state = await res.json();
    if (!selectedId || !state.scans.some(s => s.scan.id === selectedId)) {
      selectedId = (state.scans.find(s => s.scan.status === 'post_processing' || s.scan.status === 'prewarming_cache' || s.scan.status === 'running') || state.scans[0] || {scan:{}}).scan.id || null;
    }
    if (!options.manual && shouldDeferAutoRender()) {
      autoRenderDeferred = true;
      setRefreshText(' · live paused while reading');
      return;
    }
    autoRenderDeferred = false;
    render();
  } catch (err) {
    if (options.manual) alert(`Refresh failed: ${err.message || err}`);
    else console.error(err);
  } finally {
    if (options.manual && refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = previousLabel;
    }
  }
}

async function scanAction(scanId, action, button) {
  if (button) button.disabled = true;
  const res = await fetch(`/api/scans/${encodeURIComponent(scanId)}/status`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({action}),
  });
  if (!res.ok) {
    const payload = await res.json().catch(() => ({}));
    if (button) button.disabled = false;
    alert(payload.error || `Failed to ${action} scan`);
    return;
  }
  await load({manual:true});
}

function render() {
  autoRenderDeferred = false;
  captureOpenDetails();
  document.getElementById('page-title').textContent = 'Executor';
  const scanWindow = state.summary.truncated
    ? ` Showing ${state.summary.displayedScans} of ${state.summary.scans} scans (limit ${state.summary.scanLimit}).`
    : ` Showing all ${state.summary.scans} scans.`;
  document.getElementById('page-sub').textContent = `Standalone queue view reading directly from Postgres.${scanWindow} Refreshes every 5 seconds.`;
  const active = (state.summary.running || 0) > 0 || (state.summary.postProcessing || 0) > 0;
  document.getElementById('engine-pill').className = `pill ${active ? 'run' : ''}`;
  document.getElementById('engine-pill').innerHTML = `<span class="dot"></span><span>${active ? 'running' : 'idle'}</span>`;
  setRefreshText();
  document.getElementById('stats').innerHTML = [
    ['Scans', state.summary.scans, 'var(--text)'],
    ['Queued Scans', state.summary.pending, 'var(--pend)'],
    ['Running Scans', state.summary.running, 'var(--run)'],
    ['Post Process', state.summary.postProcessing, 'var(--run)'],
    ['Paused Scans', state.summary.paused, 'var(--muted)'],
    ['Failed Scans', state.summary.failed, 'var(--fail)'],
    ['Completed', state.summary.completed, 'var(--ok)'],
  ].map(([label, value, color]) => `<div class="stat"><div class="mono label">${label}</div><div class="value" style="color:${color}">${value}</div></div>`).join('');
  document.getElementById('queue').innerHTML = state.scans.map(scanCard).join('') || '<div class="scan small">No scans yet.</div>';
  const selected = state.scans.find(s => s.scan.id === selectedId) || state.scans[0];
  document.getElementById('detail').innerHTML = selected ? detail(selected) : '<div class="small">Select a scan.</div>';
  restoreOpenDetails();
}

function runningByPhase(entry, compact=false) {
  const order = ['prewarming_cache', 'building_workspace', 'running_harness', 'writing_db', 'post_processing', 'running'];
  const byPhase = new Map();
  for (const job of entry.queue?.activeJobs || []) {
    const phase = job.phase || 'running';
    const current = byPhase.get(phase) || {
      phase,
      label: job.phaseLabel || String(phase).replaceAll('_', ' '),
      running: 0,
    };
    current.running += 1;
    byPhase.set(phase, current);
  }
  const items = [...byPhase.values()].sort((a, b) => {
    const ai = order.indexOf(a.phase);
    const bi = order.indexOf(b.phase);
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || a.label.localeCompare(b.label);
  });
  if (!items.length) return compact ? '' : '<div class="phase-run-strip empty">No running jobs.</div>';
  return `<div class="phase-run-strip ${compact ? 'compact' : ''}">
    ${!compact ? '<span class="mono label">Running by phase</span>' : ''}
    <div class="phase-run-list">
      ${items.map(item => `<span class="phase-run-pill active"><span>${esc(item.label)}</span><strong>${item.running}</strong></span>`).join('')}
    </div>
  </div>`;
}

function scanCard(entry) {
  const s = entry.scan;
  const q = entry.queue;
  const latestError = (entry.errors || [])[0];
  return `<div class="scan ${s.id === selectedId ? 'active' : ''}" onclick="selectedId='${esc(s.id)}';render()">
    <div class="row"><div style="min-width:0"><div class="name">${esc(s.repoFull)}</div><div class="mono small" style="margin-top:4px">${esc(s.workflowName)} · ${esc(s.model)}</div></div>${statusBadge(s.status)}</div>
    <div style="margin-top:12px">${progress(q.progressPct)}</div>
    <div class="row mono small" style="margin-top:8px"><span>${q.completedTotal}/${q.expectedTotal || 0} lineages</span><span style="color:var(--run)">${q.runningCount} running</span><span style="color:var(--pend)">${q.pendingCount} queued</span></div>
    ${runningByPhase(entry, true)}
    ${q.activeJobs?.length ? `<div class="small" style="margin-top:8px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">active: ${q.activeJobs.slice(0, 3).map(j => `${esc(j.phaseLabel || 'Running')} d${j.depth} prev ${j.prevId}`).join(' · ')}${q.activeJobs.length > 3 ? ` · +${q.activeJobs.length - 3}` : ''}</div>` : ''}
    ${latestError ? `<div class="error" title="${esc(latestError.message)}">${esc(latestError.source)}: ${esc(latestError.message)}</div>` : ''}
    <div class="mono small" style="display:flex;gap:12px;margin-top:9px;flex-wrap:wrap"><span>${entry.totals.attempts} attempts</span><span>${entry.totals.stepResults} rows</span><span>${entry.totals.vulnerabilities} findings</span><span>${entry.postProcessing.canonicalCount} canonical</span><span>${entry.postProcessing.runningAttempts} post running</span><span>${entry.totals.subagents || 0} subagents</span><span>${s.agentSkillCount || 0} skills</span></div>
  </div>`;
}

function detail(entry) {
  const s = entry.scan;
  const q = entry.queue;
  const p = entry.postProcessing;
  const activeIds = new Set((q.activeJobs || []).map(j => j.stepId));
  const recentAttempts = [
    ...(entry.attempts || []).map(attempt => ({insertedAt: attempt.insertedAt, html: attemptRow(attempt)})),
    ...(p.recentAttempts || []).map(attempt => ({insertedAt: attempt.insertedAt, html: postAttemptRow(attempt)})),
  ]
    .sort((a, b) => new Date(b.insertedAt || 0).getTime() - new Date(a.insertedAt || 0).getTime())
    .slice(0, 60);
  return `<div>
    <div class="detail-top">
      <div style="min-width:0"><div style="display:flex;align-items:center;gap:11px"><div class="title">${esc(s.repoFull)}</div>${statusBadge(s.status)}</div><div class="mono small" style="margin-top:7px">scan #${esc(s.id)} · ${esc(s.workflowName)} · ${esc(s.harness)} · ${esc(s.model)} · thinking ${esc(s.thinkingEffort)}</div>${(s.agentSkills?.length || s.agentSkillNames?.length) ? `<div class="mono small" style="margin-top:7px;color:var(--muted)">skills: ${agentSkillLinks(s)}</div>` : ''}</div>
      <div style="display:flex;align-items:center;gap:9px;flex:none">${scanActionButton(s)}<button onclick="location.href='http://localhost:5173/scans/${esc(s.id)}'">Open scan</button></div>
    </div>
    <div class="grid">
      <div class="panel wide-metric"><div class="row"><div><div class="mono label">QUEUE PROGRESS</div><div class="value">${q.completedTotal} / ${q.expectedTotal || 0} lineages</div></div><div class="value" style="color:var(--run)">${q.progressPct}%</div></div><div style="margin-top:12px">${progress(q.progressPct)}</div><div class="row small" style="margin-top:10px"><span>${q.runningCount} running jobs</span><span>${q.pendingCount} queued jobs</span></div>${runningByPhase(entry)}</div>
      ${metric('Attempts', entry.totals.attempts)}
      ${metric('Running', entry.totals.runningAttempts, 'var(--run)')}
      ${metric('Failures', entry.totals.failedAttempts, 'var(--fail)')}
      ${metric('No Finding', entry.totals.noResultAttempts, 'var(--ok)')}
      ${metric('Step Rows', entry.totals.stepResults, 'var(--accent)')}
      ${metric('Findings', entry.totals.vulnerabilities, 'var(--ok)')}
      ${metric('Canonical', p.canonicalCount, 'var(--ok)')}
      ${metric('Duplicates', p.duplicateCount, 'var(--pend)')}
      ${metric('Ranked', p.rankedCount, 'var(--accent)')}
      ${metric('Enriched', p.enrichmentCount, 'var(--run)')}
      ${metric('Avg Time', ms(entry.totals.avgRuntimeMs))}
    </div>
    ${statusPanel(entry)}
    <div class="section-title">Post-processing</div><div class="section-sub">Built-in dedupe/ranker and configured post-script enrichments.</div>
    <div class="panel" style="padding:14px;margin-bottom:22px">
      <div class="row"><div><div class="mono label">POST PROGRESS</div><div class="value">${p.completedAttempts} / ${p.attempts || 0} attempts</div></div><div class="value" style="color:var(--run)">${p.progressPct}%</div></div>
      <div style="margin-top:12px">${progress(p.progressPct)}</div>
      <div class="row small" style="margin-top:10px;flex-wrap:wrap"><span>${p.runningAttempts} running</span><span>${p.failedAttempts} failed</span><span>${p.unprocessedDedupeCount} not deduped</span><span>${p.unrankedCanonicalCount} unranked canonical</span><span>${p.pendingEnrichmentCount} pending enrichments</span></div>
    </div>
    <div class="section-title">Workflow Steps</div><div class="section-sub">Expected/completed counts are lineages, not just static steps.</div>
    <div class="panel" style="overflow:hidden;margin-bottom:22px">${entry.steps.map(step => stepRow(step, activeIds.has(step.id))).join('')}</div>
    <div class="cols">
      <div>
        <div class="section-title">Recent Attempts</div><div class="section-sub">Latest workflow, dedupe, ranker, and post-script metadata rows written by the executor.</div><div class="panel" style="overflow:hidden;margin-bottom:16px">${recentAttempts.length ? recentAttempts.map(row => row.html).join('') : '<div class="small" style="padding:18px">No attempts recorded yet.</div>'}</div>
        <div class="section-title">Post Attempts</div><div class="section-sub">Latest dedupe/ranker/post-script metadata rows.</div><div class="panel" style="overflow:hidden">${p.recentAttempts.length ? p.recentAttempts.map(postAttemptRow).join('') : '<div class="small" style="padding:18px">No post-processing attempts recorded yet.</div>'}</div>
      </div>
      <div>
        <div class="section-title">Running Jobs</div><div class="section-sub">Claimed metadata rows currently executing or setting up isolated workspaces.</div>
        <div class="panel" style="overflow:hidden;margin-bottom:16px">${q.activeJobs?.length ? q.activeJobs.map(runningJob).join('') : '<div class="small" style="padding:16px">No running jobs.</div>'}</div>
        <div class="section-title">Running Post Jobs</div><div class="section-sub">Claimed post-processing metadata rows.</div>
        <div class="panel" style="overflow:hidden;margin-bottom:16px">${p.activeJobs?.length ? p.activeJobs.map(postJob).join('') : '<div class="small" style="padding:16px">No running post-processing jobs.</div>'}</div>
        <div class="section-title">Queued Jobs</div><div class="section-sub">Unclaimed work left in priority order.</div>
        <div class="panel" style="overflow:hidden">${q.nextJobs.length ? q.nextJobs.map(nextJob).join('') : '<div class="small" style="padding:16px">No queued jobs. Claimed jobs are shown above.</div>'}</div>
      </div>
    </div>
  </div>`;
}

function scanActionButton(scan) {
  if (scan.status === 'prewarming_cache' || scan.status === 'running' || scan.status === 'post_processing' || scan.status === 'pending') {
    return `<button class="pause-action" onclick="scanAction('${esc(scan.id)}','pause', this)">Pause</button>`;
  }
  if (scan.status === 'paused' || scan.status === 'failed' || scan.status === 'stopped') {
    return `<button class="primary-action" onclick="scanAction('${esc(scan.id)}','resume', this)">Resume</button>`;
  }
  return '';
}

function metric(label, value, color='var(--text)') {
  return `<div class="metric"><div class="mono label">${esc(label)}</div><div class="value" style="color:${color}">${esc(value)}</div></div>`;
}

function statusPanel(entry) {
  const active = [
    ...(entry.queue?.activeJobs || []).map(job => ({...job, group: 'workflow'})),
    ...(entry.postProcessing?.activeJobs || []).map(job => ({...job, group: 'post'})),
  ];
  const errors = entry.errors || [];
  if (!active.length && !errors.length) return '';
  return `<div class="section-title">Status & Errors</div><div class="section-sub">Current executor activity and the latest captured scan, workflow, and post-processing failures.</div>
    <div class="status-log">
      <div class="status-box">
        <div class="row"><div><div class="mono label">ACTIVE JOBS</div><div class="value">${active.length}</div></div><div>${statusBadge(entry.scan.status)}</div></div>
        <div class="status-lines">
          ${active.length ? active.slice(0, 8).map(activeLine).join('') : '<div class="small">No claimed jobs are currently running.</div>'}
        </div>
      </div>
      <div class="status-box error-box">
        <div class="row"><div><div class="mono label">RECENT ERRORS</div><div class="value" style="color:var(--fail)">${errors.length}</div></div>${errors[0] ? phaseBadge(errors[0]) : ''}</div>
        <div class="status-lines">
          ${errors.length ? errors.slice(0, 8).map(errorLine).join('') : '<div class="small">No error rows captured for this scan.</div>'}
        </div>
      </div>
    </div>`;
}

function activeLine(job) {
  const account = accountSummary(job);
  const name = job.stepName || job.postScriptName || job.kind || job.phaseLabel || 'Job';
  const target = job.depth != null ? `d${job.depth} · ${name}` : `${name}${job.batchIndex != null ? ` · batch ${job.batchIndex}` : ''}`;
  return `<div class="status-line">
    <div class="status-line-title"><span>${esc(job.group)} · ${esc(target)}</span><span>${ms(job.elapsedMs)}</span></div>
    <div>${phaseBadge(job)}</div>
    <div class="mono small" style="margin-top:5px">${account ? `account ${esc(account)}` : 'account not attributed yet'}</div>
  </div>`;
}

function errorLine(error) {
  const account = accountSummary(error);
  return `<div class="status-line error-line">
    <div class="status-line-title"><span>${esc(error.source)} · ${esc(error.title || error.kind || 'error')} ${knownErrorBadge(error)}</span><span>${esc(error.metadataId ? `metadata ${error.metadataId}` : time(error.updatedAt || error.insertedAt))}</span></div>
    <div class="status-line-message">${esc(error.message || '')}</div>
    ${knownErrorLinks(error)}
    <div class="mono small" style="margin-top:5px">${esc(error.phaseLabel || error.status || '')}${error.runTimeMs != null ? ` · ${ms(error.runTimeMs)}` : ''}${account ? ` · ${esc(account)}` : ''}</div>
  </div>`;
}

function stepRow(step, active) {
  const pct = step.expected ? Math.round((step.completed / step.expected) * 100) : 0;
  return `<div class="step ${active ? 'active' : ''}">
    <div style="min-width:0"><div style="display:flex;align-items:center;gap:8px"><span class="mono chip">d${step.depth}</span><span class="name">${esc(step.name)}</span>${active ? '<span class="mono small" style="color:var(--run)">active</span>' : ''}</div><div class="mono small" style="margin-top:5px">${step.isLast ? 'terminal' : 'intermediate'} · ${step.multiOutput ? 'multi' : 'single'} output · ${step.outputRows} rows</div>${step.latestError ? `<div class="error">${esc(step.latestError)}</div>` : ''}</div>
    <div>${phaseBadge(step)}<div style="margin-top:9px">${progress(pct)}</div><div class="mono small" style="margin-top:5px">${step.completed}/${step.expected || 0} complete · ${step.running} running · ${step.pending} pending</div></div>
    ${stepMetric('Attempts', step.attempts, `${step.failedAttempts} failed · ${step.noResultAttempts} no finding`)}
    ${stepMetric('Avg Time', ms(step.avgRuntimeMs), `last ${ms(step.lastRuntimeMs)}`)}
    ${stepMetric('Total Time', ms(step.totalRuntimeMs), step.latestAt ? age(step.latestAt) : 'no runs')}
    ${stepMetric('Branches', step.expected || 0, `${step.failedLineages} failed · ${step.noResultLineages} no finding`)}
  </div>`;
}

function stepMetric(label, value, sub) {
  return `<div style="min-width:0"><div class="mono label">${esc(label)}</div><div style="font-size:15px;font-weight:650;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(value)}</div><div class="mono small" style="margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(sub)}</div></div>`;
}

function attemptRow(attempt) {
  const failed = attempt.status === 'failed';
  const runtime = attempt.status === 'running' ? `${ms(attempt.elapsedMs)} running` : ms(attempt.runTimeMs);
  const outputs = (attempt.outputs || []).map(output => `<pre>${esc(pretty(output.json))}</pre>`).join('') || '<pre>No persisted outputs for this attempt.</pre>';
  const noResultText = attempt.stubExplanation || 'No explanation captured for this no-finding response.';
  const account = accountSummary(attempt);
  return `<div class="attempt">
    <div class="attempt-main">
      <div style="min-width:0"><div style="display:flex;align-items:center;gap:7px"><div class="name" style="font-size:12.5px">d${attempt.depth} · ${esc(attempt.stepName)}</div>${attempt.noResult ? '<span class="chip mono" style="color:var(--ok);border-color:rgba(40,131,79,.35);background:rgba(40,131,79,.08)">no finding</span>' : ''}</div><div class="mono small" style="margin-top:4px">metadata ${esc(attempt.id)} · prev ${esc(attempt.prevId)} · repeat ${attempt.repeatRun}${account ? ` · account ${esc(account)}` : ''} · ${esc(runConfigSummary(attempt))} · ${esc(subagentSummary(attempt))}</div></div>
      ${phaseBadge(attempt)}
      <div class="mono small">${runtime}</div>
      <div class="mono small">${time(attempt.insertedAt)}</div>
      <div style="min-width:0;color:${failed ? 'var(--fail)' : 'var(--muted)'};font-size:11.5px;line-height:1.35;overflow:hidden;text-overflow:ellipsis">${failed ? `${knownErrorBadge(attempt)} ${esc(attempt.error || '')}${knownErrorLinks(attempt)}` : esc(`${attempt.outputCount || 0} outputs · ${tokenSummary(attempt)}`)}</div>
    </div>
    <div class="attempt-details">
      ${failed ? `<details data-detail="${esc(attempt.id)}:error">
        <summary>Error log</summary>
        <pre>${esc(attempt.rawError || attempt.error || '')}</pre>
      </details>` : ''}
      <details data-detail="${esc(attempt.id)}:rendered" data-full-prompt="rendered" data-prompt-kind="step" data-prompt-id="${esc(attempt.id)}">
        <summary><span class="prompt-summary">Rendered prompt <span class="prompt-spinner" data-prompt-spinner hidden></span><span class="prompt-status" data-prompt-status></span></span></summary>
        <pre data-full-prompt-target>${esc(attempt.promptFilled || '')}</pre>
      </details>
      <details data-detail="${esc(attempt.id)}:template">
        <summary>Prompt template</summary>
        <pre>${esc(attempt.promptTemplate || '')}</pre>
      </details>
      <details data-detail="${esc(attempt.id)}:outputs">
        <summary>Outputs (${attempt.outputCount || 0})</summary>
        ${outputs}
      </details>
      ${attempt.noResult ? `<details data-detail="${esc(attempt.id)}:stub-explanation">
        <summary>No-finding explanation</summary>
        <pre>${esc(noResultText)}</pre>
      </details>` : ''}
      <details data-detail="${esc(attempt.id)}:tokens">
        <summary>Token usage</summary>
        <pre>${esc(pretty({tokens: attempt.tokens, raw: attempt.rawTokenUsage}))}</pre>
      </details>
    </div>
  </div>`;
}

function nextJob(job, idx) {
  return `<div class="next"><div class="row"><span class="name" style="font-size:12.5px">d${job.depth} · ${esc(job.stepName)}</span><span class="mono small" style="color:var(--faint)">#${idx+1}</span></div><div class="mono small" style="margin-top:4px">prev ${job.prevId || 0} · repeat ${job.repeatRun}</div></div>`;
}

function runningJob(job) {
  const account = accountSummary(job);
  return `<div class="next"><div class="row"><span class="name" style="font-size:12.5px">d${job.depth} · ${esc(job.stepName)}</span><span class="mono small" style="color:var(--run)">${ms(job.elapsedMs)}</span></div><div style="margin-top:7px">${phaseBadge(job)}</div><div class="mono small" style="margin-top:4px">metadata ${job.metadataId} · prev ${job.prevId || 0} · repeat ${job.repeatRun}${account ? ` · account ${esc(account)}` : ''} · ${esc(runConfigSummary(job))} · ${esc(subagentSummary(job))}</div></div>`;
}

function postAttemptRow(attempt) {
  const failed = attempt.status === 'failed';
  const runtime = attempt.status === 'running' ? `${ms(attempt.elapsedMs)} running` : ms(attempt.runTimeMs);
  const targetSummary = (attempt.targetIds || []).length ? `${(attempt.targetIds || []).length} targets` : (attempt.vulnerabilityId ? `vuln ${attempt.vulnerabilityId}` : 'no target ids');
  const detailPrefix = `post-${attempt.id}`;
  const account = accountSummary(attempt);
  return `<div class="attempt">
    <div class="attempt-main">
      <div style="min-width:0"><div style="display:flex;align-items:center;gap:7px"><div class="name" style="font-size:12.5px">${esc(attempt.kind)}${attempt.batchIndex != null ? ` · batch ${esc(attempt.batchIndex)}` : ''}</div>${attempt.postScriptName ? `<span class="chip mono">${esc(attempt.postScriptName)}</span>` : ''}</div><div class="mono small" style="margin-top:4px">metadata ${esc(attempt.id)} · ${esc(targetSummary)}${account ? ` · account ${esc(account)}` : ''} · ${esc(runConfigSummary(attempt))} · ${esc(subagentSummary(attempt))}</div></div>
      ${phaseBadge(attempt)}
      <div class="mono small">${runtime}</div>
      <div class="mono small">${time(attempt.insertedAt)}</div>
      <div style="min-width:0;color:${failed ? 'var(--fail)' : 'var(--muted)'};font-size:11.5px;line-height:1.35;overflow:hidden;text-overflow:ellipsis">${failed ? `${knownErrorBadge(attempt)} ${esc(attempt.error || '')}${knownErrorLinks(attempt)}` : esc(tokenSummary(attempt))}</div>
    </div>
    <div class="attempt-details">
      ${failed ? `<details data-detail="${esc(detailPrefix)}:error">
        <summary>Error log</summary>
        <pre>${esc(attempt.rawError || attempt.error || '')}</pre>
      </details>` : ''}
      <details data-detail="${esc(detailPrefix)}:rendered" data-full-prompt="rendered" data-prompt-kind="post" data-prompt-id="${esc(attempt.id)}">
        <summary><span class="prompt-summary">Rendered prompt <span class="prompt-spinner" data-prompt-spinner hidden></span><span class="prompt-status" data-prompt-status></span></span></summary>
        <pre data-full-prompt-target>${esc(attempt.promptFilled || '')}</pre>
      </details>
      <details data-detail="${esc(detailPrefix)}:template">
        <summary>Prompt template</summary>
        <pre>${esc(attempt.promptTemplate || '')}</pre>
      </details>
      <details data-detail="${esc(detailPrefix)}:output">
        <summary>Harness output</summary>
        <pre>${esc(pretty(attempt.outputJson))}</pre>
      </details>
      <details data-detail="${esc(detailPrefix)}:targets">
        <summary>Target vulnerability IDs</summary>
        <pre>${esc(pretty(attempt.targetIds || []))}</pre>
      </details>
      <details data-detail="${esc(detailPrefix)}:tokens">
        <summary>Token usage</summary>
        <pre>${esc(pretty({tokens: attempt.tokens, raw: attempt.rawTokenUsage}))}</pre>
      </details>
    </div>
  </div>`;
}

function postJob(job) {
  const targetSummary = (job.targetIds || []).length ? `${(job.targetIds || []).length} targets` : (job.vulnerabilityId ? `vuln ${job.vulnerabilityId}` : 'no targets');
  const account = accountSummary(job);
  return `<div class="next">
    <div class="row"><span class="name" style="font-size:12.5px">${esc(job.kind)}${job.batchIndex != null ? ` · batch ${esc(job.batchIndex)}` : ''}</span><span class="mono small" style="color:var(--run)">${ms(job.elapsedMs)}</span></div>
    <div style="margin-top:7px">${phaseBadge(job)}</div>
    <div class="mono small" style="margin-top:4px">metadata ${job.id} · ${esc(targetSummary)}${account ? ` · account ${esc(account)}` : ''}</div>
    <div class="mono small" style="margin-top:4px">${esc(runConfigSummary(job))} · ${esc(subagentSummary(job))}</div>
  </div>`;
}

load();
setInterval(load, 5000);
</script>
</body>
</html>
"""


class Handler(BaseHTTPRequestHandler):
    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header(
            "Content-Security-Policy",
            "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; "
            "form-action 'self'; connect-src 'self'; img-src 'self' data:; "
            "style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
        )
        super().end_headers()

    def _authorize(self, parsed, *, allow_bootstrap=False):
        host_allowed, host_loopback = request_host_access(self.headers)
        if not host_allowed:
            self._authorization_error(421, "request Host is not allowed")
            return False
        if request_internal_token_allowed(
            self.headers
        ) and internal_request_path_allowed(self.command, parsed.path):
            return True
        peer_loopback = request_peer_is_loopback(self.client_address)
        if not request_token_required(
            peer_loopback, host_loopback
        ) or request_token_allowed(self.headers):
            return True
        if allow_bootstrap:
            supplied = (parse_qs(parsed.query).get("token") or [""])[0]
            if supplied and hmac.compare_digest(supplied, ACCESS_TOKEN):
                self.send_response(303)
                self.send_header("Location", parsed.path or "/")
                self.send_header(
                    "Set-Cookie",
                    f"executor_view_session={SESSION_TOKEN}; Path=/; HttpOnly; SameSite=Strict"
                    + ("; Secure" if SECURE_COOKIE else ""),
                )
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return False
        self._authorization_error(401, "executor view access token required")
        return False

    def _authorization_error(self, status, message):
        body = json.dumps({"error": message}).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/health":
            host_allowed, _host_loopback = request_host_access(self.headers)
            if not host_allowed:
                self._authorization_error(421, "request Host is not allowed")
                return
            body = b'{"status":"ok"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if not self._authorize(parsed, allow_bootstrap=path == "/"):
            return
        if path == "/api/prompt":
            try:
                query = parse_qs(parsed.query)
                payload, fetch_error = fetch_full_prompt(
                    (query.get("kind") or [""])[0],
                    (query.get("id") or [""])[0],
                )
                if fetch_error:
                    body = json.dumps({"error": fetch_error}).encode("utf-8")
                    self.send_response(
                        404 if fetch_error == "prompt not found" else 422
                    )
                else:
                    body = json.dumps(payload, default=encode).encode("utf-8")
                    self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as exc:
                body = json.dumps({"error": str(exc)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return

        if path == "/api/state":
            try:
                query = parse_qs(parsed.query)
                force_accounts = (query.get("refresh_accounts") or ["0"])[
                    0
                ].lower() in ("1", "true", "yes")
                body = json.dumps(
                    fetch_state(force_accounts=force_accounts), default=encode
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as exc:
                body = json.dumps({"error": str(exc)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return

        parts = [part for part in path.split("/") if part]
        if (
            len(parts) == 3
            and parts[:2] == ["api", "accounts"]
            and parts[2] in {"codex", "claude", "openrouter"}
        ):
            try:
                query = parse_qs(parsed.query)
                force = (query.get("refresh") or ["0"])[0].lower() in (
                    "1",
                    "true",
                    "yes",
                )
                body = json.dumps(
                    fetch_account_provider(parts[2], force=force), default=encode
                ).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as exc:
                body = json.dumps({"error": str(exc)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return

        body = HTML.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        parsed = urlparse(self.path)
        if not self._authorize(parsed):
            return
        parts = [part for part in parsed.path.split("/") if part]
        if (
            len(parts) == 5
            and parts[:3] == ["api", "accounts", "codex"]
            and parts[4] == "reset"
        ):
            if not request_internal_token_allowed(self.headers):
                body = json.dumps({"error": "internal access token required"}).encode(
                    "utf-8"
                )
                self.send_response(403)
            elif not mutation_request_allowed(self.headers):
                body = json.dumps(
                    {"error": "cross-origin or non-JSON mutation rejected"}
                ).encode("utf-8")
                self.send_response(403)
            else:
                result, error, status = consume_codex_reset_credit(parts[3])
                body = json.dumps(
                    {"error": error} if error else result, default=encode
                ).encode("utf-8")
                self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if (
            len(parts) == 4
            and parts[0] == "api"
            and parts[1] == "scans"
            and parts[3] == "status"
        ):
            if not mutation_request_allowed(self.headers):
                body = json.dumps(
                    {"error": "cross-origin or non-JSON mutation rejected"}
                ).encode("utf-8")
                self.send_response(403)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                payload = (
                    json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                    if length
                    else {}
                )
                row, error = update_scan_status(parts[2], payload.get("action"))
                if error:
                    body = json.dumps({"error": error}).encode("utf-8")
                    self.send_response(422 if error != "scan not found" else 404)
                else:
                    body = json.dumps({"scan": row}, default=encode).encode("utf-8")
                    self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Cache-Control", "no-store")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as exc:
                body = json.dumps({"error": str(exc)}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            return

        body = json.dumps({"error": "not found"}).encode("utf-8")
        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        if (
            urlparse(self.path).path == "/health"
            and len(args) > 1
            and str(args[1]) == "200"
        ):
            return
        safe_args = tuple(redact_log_value(arg) for arg in args)
        print(f"{self.address_string()} - {fmt % safe_args}")


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"executor view listening on http://{HOST}:{PORT}")
    print(
        f"database: {DATABASE_URL.split('@')[-1] if '@' in DATABASE_URL else DATABASE_URL}"
    )
    if (
        REQUIRE_AUTH or not bind_address_is_loopback(HOST) or ALLOWED_HOSTS
    ) and not ACCESS_TOKEN_CONFIGURED:
        print(f"executor view remote access token: {ACCESS_TOKEN}")
    server.serve_forever()


if __name__ == "__main__":
    main()

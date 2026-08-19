"""Refresh sanitized provider model catalogs for the scan creation UI."""

from __future__ import annotations

import json
import logging
import os
import re
import selectors
import subprocess
import time
from collections.abc import Callable, Mapping
from contextlib import nullcontext, suppress
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .codex_auth import isolated_codex_home
from .provider_credentials import provider_environment

LOGGER = logging.getLogger("open_kritt_engine")
ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models"
OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models/user"
OPENROUTER_DEFAULT_MODEL_ID = "z-ai/glm-5.2"
CATALOG_REFRESH_ERROR = "Unable to refresh the provider model catalog."
MAX_CATALOG_MODELS = 500
MAX_CATALOG_PAGES = 10
MAX_JSONL_BUFFER_BYTES = 5 * 1024 * 1024
MAX_HTTP_CATALOG_BYTES = 5 * 1024 * 1024
THINKING_EFFORT_ORDER = ("default", "low", "medium", "high", "xhigh", "max", "ultra")
SUPPORTED_THINKING_EFFORTS = frozenset(THINKING_EFFORT_ORDER)
OPENROUTER_GATEWAY_EFFORTS = ("low", "medium", "high", "xhigh", "max")
GPT_VERSION_RE = re.compile(r"^gpt-(\d+)(?:\.(\d+))?(?=$|[-.])", re.IGNORECASE)
GPT_CYBER_RESTRICTION_AFTER = (5, 4)
GPT_CYBER_RESTRICTION_NOTE = "This model may have cybersecurity usage restrictions."
GPT_CYBER_RESTRICTION_URL = "https://chatgpt.com/cyber"
MODEL_NOTES = {
    "claude-fable-5": "Cyber requests may route to Opus 4.8.",
}
CLAUDE_MODEL_THINKING_EFFORTS = {
    "claude-fable-5": ("low", "medium", "high", "xhigh", "max"),
    "claude-opus-5": ("low", "medium", "high", "xhigh", "max"),
    "claude-opus-4-8": ("low", "medium", "high", "xhigh", "max"),
    "claude-opus-4-7": ("low", "medium", "high", "xhigh", "max"),
    "claude-opus-4-6": ("low", "medium", "high", "max"),
    "claude-sonnet-5": ("low", "medium", "high", "xhigh", "max"),
    "claude-sonnet-4-6": ("low", "medium", "high", "max"),
}


class ModelCatalogError(RuntimeError):
    """An upstream model catalog could not be safely retrieved."""


def _clean_text(value: Any, *, limit: int = 200) -> str:
    if not isinstance(value, str):
        return ""
    if any(ord(char) < 32 for char in value):
        return ""
    value = value.strip()
    if not value or len(value) > limit:
        return ""
    return value


def _truthy(value: Any) -> bool:
    return value is True or (isinstance(value, str) and value.strip().lower() == "true")


def _model_note(model_id: str) -> tuple[str, str]:
    match = GPT_VERSION_RE.match(model_id)
    if match:
        version = (int(match.group(1)), int(match.group(2) or 0))
        if version > GPT_CYBER_RESTRICTION_AFTER:
            return GPT_CYBER_RESTRICTION_NOTE, GPT_CYBER_RESTRICTION_URL
    return _clean_text(MODEL_NOTES.get(model_id)), ""


def _thinking_efforts(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []

    efforts: set[str] = set()
    for item in value:
        if isinstance(item, Mapping):
            item = item.get("reasoningEffort") or item.get("reasoning_effort") or item.get("effort")
        effort = _clean_text(item).lower()
        if effort in SUPPORTED_THINKING_EFFORTS:
            efforts.add(effort)
    return [effort for effort in THINKING_EFFORT_ORDER if effort in efforts]


def _openrouter_thinking_efforts(entry: Mapping[str, Any]) -> list[str]:
    """Return only effort levels explicitly exposed by OpenRouter metadata."""

    reasoning = entry.get("reasoning")
    if not isinstance(reasoning, Mapping):
        return ["default"]
    if "supported_efforts" not in reasoning:
        # The model can reason, but does not expose an effort selector. Omitting
        # the CLI effort flag lets OpenRouter/model policy choose the default.
        return ["default"]
    if reasoning.get("supported_efforts") is None:
        # OpenRouter documents null as accepting every gateway effort value.
        return list(OPENROUTER_GATEWAY_EFFORTS)
    return _thinking_efforts(reasoning.get("supported_efforts")) or ["default"]


def _openrouter_is_text_model(entry: Mapping[str, Any]) -> bool:
    """Reject models explicitly limited to non-text output."""

    architecture = entry.get("architecture")
    if not isinstance(architecture, Mapping):
        return True
    output_modalities = architecture.get("output_modalities")
    if not isinstance(output_modalities, list):
        return True
    return "text" in {_clean_text(modality).lower() for modality in output_modalities}


def normalize_catalog_models(entries: Any) -> tuple[list[dict[str, Any]], str]:
    """Return a bounded, UI-safe catalog and a selected default model ID."""
    if not isinstance(entries, list):
        return [], ""

    models: list[dict[str, Any]] = []
    seen: set[str] = set()
    preferred_default: int | None = None
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        model_id = _clean_text(entry.get("model") or entry.get("slug") or entry.get("id"))
        if not model_id or model_id in seen:
            continue

        seen.add(model_id)
        label = _clean_text(entry.get("displayName") or entry.get("display_name") or entry.get("label")) or model_id
        note, note_url = _model_note(model_id)
        model = {
            "id": model_id,
            "label": label,
            "thinkingEfforts": _thinking_efforts(
                entry.get("supportedReasoningEfforts") or entry.get("supported_reasoning_efforts")
            ),
            "isDefault": False,
        }
        if note:
            model["note"] = note
        if note_url:
            model["noteUrl"] = note_url
        models.append(model)
        if preferred_default is None and _truthy(entry.get("isDefault") or entry.get("is_default")):
            preferred_default = len(models) - 1
        if len(models) >= MAX_CATALOG_MODELS:
            break

    if not models:
        return [], ""
    default_index = preferred_default if preferred_default is not None else 0
    models[default_index]["isDefault"] = True
    return models, models[default_index]["id"]


def _codex_env(env: Mapping[str, str]) -> dict[str, str]:
    result = dict(env)
    if not result.get("CODEX_API_KEY") and result.get("OPENAI_API_KEY"):
        result["CODEX_API_KEY"] = result["OPENAI_API_KEY"]
    configured_home = (result.get("ENGINE_CODEX_HOME") or "").split(",", 1)[0].strip()
    if configured_home:
        result["CODEX_HOME"] = configured_home
    return result


def codex_is_configured(env: Mapping[str, str]) -> bool:
    if _clean_text(env.get("CODEX_API_KEY")) or _clean_text(env.get("OPENAI_API_KEY")):
        return True
    home = _codex_env(env).get("CODEX_HOME") or "/root/.codex"
    auth_path = Path(home) / "auth.json"
    try:
        auth = json.loads(auth_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return False
    return isinstance(auth, dict) and bool(auth)


class _JsonlReader:
    def __init__(self, stream):
        self._fd = stream.fileno()
        self._selector = selectors.DefaultSelector()
        self._selector.register(self._fd, selectors.EVENT_READ)
        self._buffer = b""

    def close(self):
        self._selector.close()

    def read_message(self, deadline: float) -> dict[str, Any]:
        while True:
            newline = self._buffer.find(b"\n")
            if newline >= 0:
                raw = self._buffer[:newline]
                self._buffer = self._buffer[newline + 1 :]
                if not raw.strip():
                    continue
                try:
                    message = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, json.JSONDecodeError):
                    continue
                if isinstance(message, dict):
                    return message
                continue

            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise ModelCatalogError("Timed out while reading the Codex model catalog")
            if not self._selector.select(remaining):
                raise ModelCatalogError("Timed out while reading the Codex model catalog")
            try:
                chunk = os.read(self._fd, 64 * 1024)
            except OSError as exc:
                raise ModelCatalogError("Could not read the Codex model catalog") from exc
            if not chunk:
                raise ModelCatalogError("Codex model catalog process exited unexpectedly")
            self._buffer += chunk
            if len(self._buffer) > MAX_JSONL_BUFFER_BYTES:
                raise ModelCatalogError("Codex model catalog response was too large")


def _write_jsonl(proc, payload: dict[str, Any]) -> None:
    if proc.stdin is None:
        raise ModelCatalogError("Could not start the Codex model catalog process")
    try:
        proc.stdin.write((json.dumps(payload, separators=(",", ":")) + "\n").encode("utf-8"))
        proc.stdin.flush()
    except (BrokenPipeError, OSError) as exc:
        raise ModelCatalogError("Could not request the Codex model catalog") from exc


def _read_response(reader: _JsonlReader, request_id: int, deadline: float) -> dict[str, Any]:
    while True:
        message = reader.read_message(deadline)
        if message.get("id") != request_id:
            continue
        if "error" in message or not isinstance(message.get("result"), dict):
            raise ModelCatalogError("Codex model catalog request failed")
        return message["result"]


def _stop_process(proc) -> None:
    with suppress(Exception):
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=1)
    for stream_name in ("stdin", "stdout"):
        with suppress(Exception):
            stream = getattr(proc, stream_name, None)
            if stream is not None:
                stream.close()


def fetch_codex_models(
    env: Mapping[str, str],
    timeout_seconds: float,
    *,
    cli_gate: Any | None = None,
) -> tuple[list[dict[str, Any]], str]:
    """List models through Codex App Server without retaining raw protocol output."""
    usage = cli_gate.use() if cli_gate is not None else nullcontext()
    with usage:
        return _fetch_codex_models(env, timeout_seconds)


def _fetch_codex_models(env: Mapping[str, str], timeout_seconds: float) -> tuple[list[dict[str, Any]], str]:
    with isolated_codex_home(_codex_env(env)) as app_server_env:
        return _fetch_codex_models_from_env(app_server_env, timeout_seconds)


def _fetch_codex_models_from_env(env: Mapping[str, str], timeout_seconds: float) -> tuple[list[dict[str, Any]], str]:
    deadline = time.monotonic() + max(1.0, timeout_seconds)
    try:
        proc = subprocess.Popen(
            ["codex", "app-server"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            text=False,
            bufsize=0,
        )
    except OSError as exc:
        raise ModelCatalogError("Could not start Codex model catalog lookup") from exc

    reader: _JsonlReader | None = None
    try:
        if proc.stdout is None:
            raise ModelCatalogError("Could not start Codex model catalog lookup")
        reader = _JsonlReader(proc.stdout)
        _write_jsonl(
            proc,
            {
                "id": 1,
                "method": "initialize",
                "params": {"clientInfo": {"name": "open-kritt", "version": "1"}},
            },
        )
        _read_response(reader, 1, deadline)
        _write_jsonl(proc, {"method": "initialized"})

        entries: list[Any] = []
        cursor: str | None = None
        cursors: set[str] = set()
        request_id = 2
        for _ in range(MAX_CATALOG_PAGES):
            params: dict[str, Any] = {"limit": 100, "includeHidden": False}
            if cursor:
                params["cursor"] = cursor
            _write_jsonl(proc, {"id": request_id, "method": "model/list", "params": params})
            result = _read_response(reader, request_id, deadline)
            request_id += 1
            page = result.get("data") or result.get("models")
            if not isinstance(page, list):
                raise ModelCatalogError("Codex model catalog response was invalid")
            entries.extend(page)
            if len(entries) >= MAX_CATALOG_MODELS:
                break
            next_cursor = _clean_text(result.get("nextCursor") or result.get("next_cursor"))
            if not next_cursor or next_cursor in cursors:
                break
            cursors.add(next_cursor)
            cursor = next_cursor

        models, default_model = normalize_catalog_models(entries)
        if not models:
            raise ModelCatalogError("Codex model catalog was empty")
        return models, default_model
    finally:
        if reader is not None:
            reader.close()
        _stop_process(proc)


def fetch_anthropic_models(api_key: str, timeout_seconds: float) -> tuple[list[dict[str, Any]], str]:
    """List models available to the configured Anthropic API key."""
    deadline = time.monotonic() + max(1.0, timeout_seconds)
    entries: list[Any] = []
    after_id: str | None = None
    seen_cursors: set[str] = set()

    for _ in range(MAX_CATALOG_PAGES):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ModelCatalogError("Timed out while reading the Anthropic model catalog")
        query = {"limit": "100"}
        if after_id:
            query["after_id"] = after_id
        request = Request(
            f"{ANTHROPIC_MODELS_URL}?{urlencode(query)}",
            headers={"x-api-key": api_key, "anthropic-version": "2023-06-01"},
        )
        try:
            with urlopen(request, timeout=max(0.1, remaining)) as response:  # noqa: S310 - fixed provider URL
                payload = json.load(response)
        except (HTTPError, URLError, OSError, TimeoutError, json.JSONDecodeError) as exc:
            raise ModelCatalogError("Could not read the Anthropic model catalog") from exc
        if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
            raise ModelCatalogError("Anthropic model catalog response was invalid")
        page = payload["data"]
        entries.extend(page)
        if len(entries) >= MAX_CATALOG_MODELS or not payload.get("has_more"):
            break
        cursor = _clean_text(payload.get("last_id"))
        if not cursor or cursor in seen_cursors:
            break
        seen_cursors.add(cursor)
        after_id = cursor

    enriched_entries = []
    for entry in entries:
        if not isinstance(entry, Mapping):
            enriched_entries.append(entry)
            continue
        model_id = _clean_text(entry.get("id"))
        efforts = CLAUDE_MODEL_THINKING_EFFORTS.get(model_id, ("default",))
        enriched_entries.append({**entry, "supportedReasoningEfforts": list(efforts)})

    models, default_model = normalize_catalog_models(enriched_entries)
    if not models:
        raise ModelCatalogError("Anthropic model catalog was empty")
    return models, default_model


def fetch_openrouter_models(api_key: str, timeout_seconds: float) -> tuple[list[dict[str, Any]], str]:
    """List text models available under the configured OpenRouter account policy."""

    request = Request(
        OPENROUTER_MODELS_URL,
        headers={"Authorization": f"Bearer {api_key}"},
    )
    try:
        with urlopen(request, timeout=max(1.0, timeout_seconds)) as response:  # noqa: S310 - fixed provider URL
            raw_payload = response.read(MAX_HTTP_CATALOG_BYTES + 1)
        if len(raw_payload) > MAX_HTTP_CATALOG_BYTES:
            raise ModelCatalogError("OpenRouter model catalog response was too large")
        payload = json.loads(raw_payload)
    except (HTTPError, URLError, OSError, TimeoutError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ModelCatalogError("Could not read the OpenRouter model catalog") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
        raise ModelCatalogError("OpenRouter model catalog response was invalid")

    entries: list[dict[str, Any]] = []
    seen_ids: set[str] = set()
    for raw in payload["data"]:
        if not isinstance(raw, Mapping) or not _openrouter_is_text_model(raw):
            continue
        model_id = _clean_text(raw.get("id"))
        if not model_id or model_id in seen_ids:
            continue
        seen_ids.add(model_id)
        entries.append(
            {
                "model": model_id,
                "displayName": raw.get("name"),
                "supportedReasoningEfforts": _openrouter_thinking_efforts(raw),
                "isDefault": model_id == OPENROUTER_DEFAULT_MODEL_ID,
            }
        )
        if len(entries) > MAX_CATALOG_MODELS:
            candidate = entries.pop()
            if candidate["isDefault"] and not any(entry["isDefault"] for entry in entries):
                entries[-1] = candidate

    models, default_model = normalize_catalog_models(entries)
    if not models:
        raise ModelCatalogError("OpenRouter model catalog was empty")
    return models, default_model


CatalogFetcher = Callable[[], tuple[list[dict[str, Any]], str]]


class ModelCatalogRefresher:
    """Fetch configured provider catalogs and persist only safe fields."""

    def __init__(
        self,
        db,
        *,
        timeout_seconds: float = 10.0,
        env: Mapping[str, str] | None = None,
        fetch_codex: CatalogFetcher | None = None,
        fetch_anthropic: CatalogFetcher | None = None,
        fetch_openrouter: CatalogFetcher | None = None,
        codex_cli_gate: Any | None = None,
    ):
        self.db = db
        self.timeout_seconds = max(1.0, timeout_seconds)
        self._configured_env = dict(env) if env is not None else None
        self.fetch_codex = fetch_codex
        self.fetch_anthropic = fetch_anthropic
        self.fetch_openrouter = fetch_openrouter
        self.codex_cli_gate = codex_cli_gate

    def refresh(self, env: Mapping[str, str] | None = None) -> dict[str, bool]:
        env = (
            dict(env)
            if env is not None
            else dict(self._configured_env)
            if self._configured_env is not None
            else provider_environment()
        )
        outcomes: dict[str, bool] = {}
        if codex_is_configured(env):
            fetch_codex = self.fetch_codex or (
                lambda: fetch_codex_models(env, self.timeout_seconds, cli_gate=self.codex_cli_gate)
            )
            outcomes["codex"] = self._refresh_provider("codex", fetch_codex)
        if _clean_text(env.get("ANTHROPIC_API_KEY")):
            fetch_anthropic = self.fetch_anthropic or (
                lambda: fetch_anthropic_models(env["ANTHROPIC_API_KEY"], self.timeout_seconds)
            )
            outcomes["claude"] = self._refresh_provider("claude", fetch_anthropic)
        if _clean_text(env.get("OPENROUTER_API_KEY")):
            fetch_openrouter = self.fetch_openrouter or (
                lambda: fetch_openrouter_models(env["OPENROUTER_API_KEY"], self.timeout_seconds)
            )
            outcomes["openrouter"] = self._refresh_provider("openrouter", fetch_openrouter)
        return outcomes

    def _refresh_provider(self, provider: str, fetcher: CatalogFetcher) -> bool:
        try:
            models, default_model = fetcher()
            if not models or not default_model or not any(model.get("id") == default_model for model in models):
                raise ModelCatalogError("Provider model catalog was empty or invalid")
            with self.db.connect() as conn:
                self.db.upsert_model_catalog(
                    conn,
                    provider=provider,
                    models=models,
                    default_model=default_model,
                )
                conn.commit()
            LOGGER.info("refreshed %s model catalog (%s models)", provider, len(models))
            return True
        except Exception:
            self._record_failure(provider)
            LOGGER.warning("could not refresh %s model catalog", provider)
            return False

    def _record_failure(self, provider: str) -> None:
        try:
            with self.db.connect() as conn:
                self.db.record_model_catalog_error(conn, provider=provider, error=CATALOG_REFRESH_ERROR)
                conn.commit()
        except Exception:
            LOGGER.warning("could not persist %s model catalog refresh status", provider)

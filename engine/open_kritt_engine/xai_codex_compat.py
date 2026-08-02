"""xAI-only Codex Responses API compatibility.

Codex CLI targets OpenAI's Responses surface. Direct xAI (api.x.ai) supports a
compatible subset, but rejects a few OpenAI-only fields that Codex still emits:

* ``external_web_access`` / ``search_context_size`` on web search tools
* ``web_search_preview`` tool type (xAI expects ``web_search``)
* ``encrypted_content`` on re-sent ``reasoning`` items ("compaction blob")

This module is **scoped to the xAI provider only**. OpenAI Codex, Claude, and
OpenRouter harness paths never import the proxy or rewrite path unless the
selected product provider is ``xai``.

Architecture: a tiny localhost reverse proxy is started next to the Codex
process (including inside nested scan containers). Codex talks to
``http://127.0.0.1:<port>/v1``; the proxy rewrites request JSON and forwards to
``https://api.x.ai``.
"""

from __future__ import annotations

import argparse
import json
import os
import select
import socket
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

XAI_UPSTREAM_ORIGIN = "https://api.x.ai"
XAI_PUBLIC_CODEX_BASE_URL = f"{XAI_UPSTREAM_ORIGIN}/v1"

# OpenAI-only keys Codex attaches to web_search tools; xAI rejects them.
_OPENAI_WEB_SEARCH_DROP_KEYS = frozenset(
    {
        "external_web_access",
        "search_context_size",
        "user_location",
    }
)

# Server-side tool types accepted by xAI Responses (see api.x.ai tool docs).
_XAI_SERVER_TOOL_TYPES = frozenset(
    {
        "web_search",
        "x_search",
        "code_execution",
        "code_interpreter",
        "mcp",
        "shell",
        "image_generation",
        "file_search",
        "collections_search",
    }
)


def rewrite_web_search_tool(tool: dict[str, Any]) -> dict[str, Any]:
    """Normalize a Codex/OpenAI web search tool into xAI ``web_search``."""

    rewritten: dict[str, Any] = {"type": "web_search"}
    filters = tool.get("filters")
    if isinstance(filters, dict):
        kept = {
            key: filters[key]
            for key in ("allowed_domains", "excluded_domains")
            if key in filters
        }
        if kept:
            rewritten["filters"] = kept
    for key in ("enable_image_understanding", "enable_image_search"):
        if key in tool:
            rewritten[key] = tool[key]
    return rewritten


def rewrite_tools(tools: Any) -> Any:
    """Rewrite or drop tool definitions Codex emits that xAI cannot accept."""

    if not isinstance(tools, list):
        return tools
    rewritten: list[Any] = []
    for tool in tools:
        if not isinstance(tool, dict):
            rewritten.append(tool)
            continue
        tool_type = tool.get("type")
        if tool_type in {"web_search", "web_search_preview"}:
            rewritten.append(rewrite_web_search_tool(tool))
            continue
        if tool_type == "function":
            rewritten.append(tool)
            continue
        if tool_type in _XAI_SERVER_TOOL_TYPES:
            cleaned = {key: value for key, value in tool.items() if key not in _OPENAI_WEB_SEARCH_DROP_KEYS}
            rewritten.append(cleaned)
            continue
        # Unknown server tool shapes (OpenAI-only) — drop rather than 400.
    return rewritten


def rewrite_input_items(items: Any) -> Any:
    """Strip OpenAI reasoning ciphertext that xAI treats as a compaction blob."""

    if not isinstance(items, list):
        return items
    rewritten: list[Any] = []
    for item in items:
        if not isinstance(item, dict):
            rewritten.append(item)
            continue
        if item.get("type") == "reasoning":
            cleaned = dict(item)
            cleaned.pop("encrypted_content", None)
            if cleaned.get("content") is None:
                cleaned.pop("content", None)
            rewritten.append(cleaned)
            continue
        rewritten.append(item)
    return rewritten


def rewrite_responses_request_body(body: Any) -> Any:
    """Return a request body safe to send to xAI ``/v1/responses``."""

    if not isinstance(body, dict):
        return body
    rewritten = dict(body)
    if "tools" in rewritten:
        rewritten["tools"] = rewrite_tools(rewritten["tools"])
    if "input" in rewritten:
        rewritten["input"] = rewrite_input_items(rewritten["input"])
    return rewritten


def inject_xai_base_url(command: list[str], base_url: str) -> list[str]:
    """Force Codex to use the compat proxy for the xAI model provider only."""

    result: list[str] = []
    skip_next = False
    for index, part in enumerate(command):
        if skip_next:
            skip_next = False
            continue
        if part == "-c" and index + 1 < len(command):
            value = command[index + 1]
            if value.startswith("model_providers.xai.base_url="):
                skip_next = True
                continue
        result.append(part)
    # Insert provider base_url overrides before the final stdin marker if present.
    insert_at = len(result)
    if result and result[-1] == "-":
        insert_at = len(result) - 1
    injection = [
        "-c",
        f'model_providers.xai.base_url="{base_url}"',
    ]
    return result[:insert_at] + injection + result[insert_at:]


# Features Codex enables that emit tool/args xAI Responses rejects (namespace,
# browser surfaces, etc.). Kept here so harness/workspace share one list.
XAI_CODEX_DISABLED_FEATURES = (
    "multi_agent",
    "apps",
    "browser_use",
    "browser_use_external",
    "in_app_browser",
    "image_generation",
    "computer_use",
    "remote_compaction_v2",
)


def install_compat_script(codex_home: Path | str) -> Path:
    """Copy this module into a job Codex home so nested scan runners can exec it."""

    destination = Path(codex_home) / "xai_codex_compat.py"
    destination.parent.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).resolve()
    if destination.resolve() != source:
        destination.write_text(source.read_text(encoding="utf-8"), encoding="utf-8")
        try:
            destination.chmod(0o600)
        except OSError:
            pass
    return destination


def wrap_codex_command_for_xai(command: list[str], *, codex_home: str | None = None) -> list[str]:
    """Prefix a Codex argv with the xAI rewrite-proxy runner (xAI provider only)."""

    if not command:
        return command
    # Avoid double-wrapping.
    if len(command) >= 3 and command[0] in {"python", "python3"} and "xai_codex_compat" in command[1]:
        return command
    if command[:3] == [sys.executable, "-m", "open_kritt_engine.xai_codex_compat"]:
        return command

    if codex_home:
        script = Path(codex_home) / "xai_codex_compat.py"
        if script.is_file():
            return ["python3", str(script), "exec", "--", *command]
    return [sys.executable, "-m", "open_kritt_engine.xai_codex_compat", "exec", "--", *command]

class _ProxyHandler(BaseHTTPRequestHandler):
    upstream_origin = XAI_UPSTREAM_ORIGIN

    def log_message(self, format: str, *args) -> None:  # noqa: A003 — BaseHTTPRequestHandler API
        return

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
        out_body = raw
        if content_type in {"application/json", "text/json"} or raw[:1] in (b"{", b"["):
            try:
                parsed = json.loads(raw.decode("utf-8"))
                out_body = json.dumps(rewrite_responses_request_body(parsed)).encode("utf-8")
            except (UnicodeDecodeError, json.JSONDecodeError, TypeError, ValueError):
                out_body = raw

        headers = {
            key: value
            for key, value in self.headers.items()
            if key.lower()
            not in {
                "host",
                "content-length",
                "transfer-encoding",
                "connection",
            }
        }
        headers["Content-Length"] = str(len(out_body))
        headers.setdefault("Content-Type", "application/json")
        # Prefer the caller's Authorization (Codex reads XAI_API_KEY via env_key).
        if "Authorization" not in headers and os.environ.get("XAI_API_KEY"):
            headers["Authorization"] = f"Bearer {os.environ['XAI_API_KEY']}"

        upstream = f"{self.upstream_origin}{self.path}"
        request = urllib.request.Request(upstream, data=out_body, method="POST", headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=600) as response:
                self._relay_response(response)
        except urllib.error.HTTPError as exc:
            payload = exc.read()
            self.send_response(exc.code)
            self.send_header("Content-Type", exc.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as exc:  # noqa: BLE001 — surface as 502 to Codex
            payload = json.dumps({"error": f"xai_codex_compat proxy error: {exc}"}).encode("utf-8")
            self.send_response(502)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def do_GET(self) -> None:  # noqa: N802
        # Health / discovery only — do not proxy arbitrary GETs.
        if self.path in {"/", "/health", "/v1/health"}:
            payload = b'{"status":"ok","service":"xai-codex-compat"}'
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(404)
        self.end_headers()

    def _relay_response(self, response) -> None:
        status = getattr(response, "status", 200)
        self.send_response(status)
        # Stream SSE / chunked bodies through without re-buffering the full payload
        # when possible; fall back to read() for small non-streaming replies.
        content_type = response.headers.get("Content-Type", "application/json")
        self.send_header("Content-Type", content_type)
        # Avoid advertising a wrong Content-Length for streamed responses.
        if "text/event-stream" in content_type or response.headers.get("Transfer-Encoding") == "chunked":
            self.end_headers()
            while True:
                chunk = response.read(65536)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
            return
        body = response.read()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


class XaiCodexCompatProxy:
    """Localhost-only reverse proxy that rewrites Codex→xAI Responses traffic."""

    def __init__(self, *, host: str = "127.0.0.1", port: int = 0):
        self._host = host
        self._port = port
        self._server: ThreadingHTTPServer | None = None
        self._thread: threading.Thread | None = None

    @property
    def base_url(self) -> str:
        if not self._server:
            raise RuntimeError("xAI Codex compat proxy is not running")
        host, port = self._server.server_address[:2]
        return f"http://{host}:{port}/v1"

    def start(self) -> str:
        if self._server is not None:
            return self.base_url
        server = ThreadingHTTPServer((self._host, self._port), _ProxyHandler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, name="xai-codex-compat", daemon=True)
        thread.start()
        self._server = server
        self._thread = thread
        return self.base_url

    def stop(self) -> None:
        server = self._server
        self._server = None
        if server is not None:
            server.shutdown()
            server.server_close()
        thread = self._thread
        self._thread = None
        if thread is not None and thread.is_alive():
            thread.join(timeout=2)

    def __enter__(self) -> "XaiCodexCompatProxy":
        self.start()
        return self

    def __exit__(self, *exc) -> None:
        self.stop()


def wait_for_tcp(host: str, port: int, *, timeout_seconds: float = 5.0) -> None:
    deadline = timeout_seconds
    remaining = deadline
    while remaining > 0:
        try:
            with socket.create_connection((host, port), timeout=min(0.5, remaining)):
                return
        except OSError:
            remaining -= 0.05
            select.select([], [], [], 0.05)
    raise RuntimeError(f"xAI Codex compat proxy did not open {host}:{port}")


def run_command_with_proxy(command: list[str], *, env: dict[str, str] | None = None) -> int:
    """Start a local rewrite proxy, point xAI base_url at it, run ``command``."""

    with XaiCodexCompatProxy() as proxy:
        host, port = urlparse(proxy.base_url).hostname, urlparse(proxy.base_url).port
        if host and port:
            wait_for_tcp(host, port)
        child_cmd = inject_xai_base_url(list(command), proxy.base_url)
        child_env = os.environ.copy()
        if env:
            child_env.update(env)
        proc = subprocess.run(child_cmd, env=child_env, check=False)
        return int(proc.returncode)


def _cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="xAI Codex Responses compatibility helper")
    sub = parser.add_subparsers(dest="command", required=True)

    exec_parser = sub.add_parser("exec", help="Run a command with the rewrite proxy active")
    exec_parser.add_argument("cmd", nargs=argparse.REMAINDER, help="Command after --")

    rewrite_parser = sub.add_parser("rewrite-json", help="Rewrite a Responses JSON body on stdin")
    rewrite_parser.add_argument("--pretty", action="store_true")

    args = parser.parse_args(argv)
    if args.command == "rewrite-json":
        data = json.load(sys.stdin)
        out = rewrite_responses_request_body(data)
        json.dump(out, sys.stdout, indent=2 if args.pretty else None)
        sys.stdout.write("\n")
        return 0
    if args.command == "exec":
        cmd = list(args.cmd or [])
        if cmd and cmd[0] == "--":
            cmd = cmd[1:]
        if not cmd:
            parser.error("exec requires a command after --")
        return run_command_with_proxy(cmd)
    parser.error(f"unknown command {args.command}")
    return 2


def main() -> None:
    raise SystemExit(_cli())


if __name__ == "__main__":
    main()

"""CLI runtime adapters for externally authenticated local model tools."""

import json
import logging
import os
import re
from dataclasses import dataclass

from ..capabilities import ProviderCapabilities
from ..types import RawLLMResponse
from .errors import CLIAuthenticationRequired, CLIUnavailable, RuntimeErrorBase
from .process import ProcessResult, ProcessRunner, SubprocessRunner
from .streaming import StreamEvent
from .types import RuntimeDetection, RuntimeDiagnostics, RuntimeRequest

LOGGER = logging.getLogger("open_kritt_engine.llm.runtime.cli")


@dataclass
class CLIRuntimeProvider:
    """Base runtime for subprocess-backed CLIs.

    The runtime invokes existing user-installed tools and never reads, copies,
    or stores credentials. Subclasses define executable detection and command
    construction only.
    """

    id: str
    adapter_id: str
    executable_names: tuple[str, ...]
    default_capabilities: ProviderCapabilities
    runner: ProcessRunner | None = None

    def __post_init__(self):
        if self.runner is None:
            self.runner = SubprocessRunner()

    def detect(self) -> RuntimeDetection:
        """Detect executable, version, authentication state, and capabilities."""
        executable = self.detect_executable()
        if executable is None:
            return RuntimeDetection(
                available=False,
                authenticated=None,
                capabilities=self.default_capabilities,
                diagnostics=(f"Executable not found: {', '.join(self.executable_names)}",),
            )
        version = self.detect_version(executable)
        authenticated, auth_diagnostic = self.detect_auth(executable)
        return RuntimeDetection(
            available=True,
            authenticated=authenticated,
            executable=executable,
            version=version,
            capabilities=self.default_capabilities,
            diagnostics=(auth_diagnostic,) if auth_diagnostic else (),
        )

    def detect_executable(self, env: dict[str, str] | None = None) -> str | None:
        runtime_env = self.runtime_env(env)
        for key in self.executable_env_keys():
            configured = runtime_env.get(key)
            if configured and os.path.isfile(configured):
                return configured
        return self.runner.which(self.executable_names, path=runtime_env.get("PATH"))

    def executable_env_keys(self) -> tuple[str, ...]:
        lowered = {name.lower() for name in self.executable_names}
        keys: list[str] = []
        if "codex" in lowered:
            keys.extend(["OPEN_KRITT_CODEX_BIN", "CODEX_BIN", "CODEX_CLI_PATH"])
        if "claude" in lowered:
            keys.extend(["OPEN_KRITT_CLAUDE_BIN", "CLAUDE_BIN", "CLAUDE_CLI_PATH"])
        return tuple(keys)

    def detect_version(self, executable: str) -> str | None:
        result = self._probe([executable, "--version"], timeout_seconds=5)
        text = (result.stdout or result.stderr).strip() if result is not None else ""
        return text.splitlines()[0] if text else None

    def detect_auth(self, executable: str, env: dict[str, str] | None = None) -> tuple[bool | None, str]:
        result = self._probe(
            self.auth_probe_command(executable),
            timeout_seconds=10,
            input_text=self.auth_probe_input_text(),
            env=env,
        )
        if result is None:
            return None, "Authentication probe could not run."
        if result.returncode == 0:
            return True, ""
        diagnostic = _short_diagnostic(result.stderr or result.stdout or "CLI authentication probe failed.")
        if _looks_auth_failure(diagnostic):
            return False, diagnostic
        return None, diagnostic

    def auth_probe_command(self, executable: str) -> list[str]:
        return [executable, "--version"]

    def auth_probe_input_text(self) -> str:
        return ""

    def build_command(self, executable: str, request: RuntimeRequest) -> list[str]:
        raise NotImplementedError

    def execute(self, request: RuntimeRequest) -> RawLLMResponse:
        """Run the CLI and return stdout/stderr as an unparsed raw response."""
        executable = self.detect_executable(request.env)
        if executable is None:
            raise CLIUnavailable(executable_names=self.executable_names)
        LOGGER.info("provider=%s model=%s executable=%s repo=%s", request.provider_id, request.llm.model, executable, request.llm.repo_dir)
        authenticated, diagnostic = self.detect_auth(executable, request.env)
        if authenticated is False:
            raise CLIAuthenticationRequired(diagnostic, executable=executable)
        LOGGER.info("provider=%s authenticated=%s diagnostic=%s", request.provider_id, authenticated, diagnostic)

        command = self.build_command(executable, request)
        env = self.runtime_env(request.env)
        LOGGER.info("provider=%s command=%s timeout=%s", request.provider_id, _redacted_command(command), request.llm.timeout_seconds)
        try:
            if request.llm.allow_streaming and request.stream_callback is not None:
                proc = self.runner.run_stream(
                    command,
                    input_text=request.llm.prompt,
                    cwd=request.llm.repo_dir,
                    timeout_seconds=request.llm.timeout_seconds,
                    env=env,
                    callback=request.stream_callback,
                    cancellation_token=request.cancellation_token,
                )
            else:
                proc = self.runner.run(
                    command,
                    input_text=request.llm.prompt,
                    cwd=request.llm.repo_dir,
                    timeout_seconds=request.llm.timeout_seconds,
                    env=env,
                )
        except RuntimeErrorBase:
            raise

        if request.cancellation_token is not None and request.cancellation_token.cancelled():
            if request.stream_callback is not None:
                request.stream_callback(StreamEvent(kind="cancelled"))
            status = "failed"
            warnings = ("cancelled",)
        else:
            status = "completed" if proc.returncode == 0 else "failed"
            warnings = () if proc.returncode == 0 else ("cli_nonzero_exit",)
        LOGGER.info(
            "provider=%s exit_code=%s stdout=%s stderr=%s",
            request.provider_id,
            proc.returncode,
            _short_diagnostic(proc.stdout),
            _short_diagnostic(proc.stderr),
        )

        return RawLLMResponse(
            provider_id=request.provider_id,
            adapter_id=request.adapter_id,
            model=request.llm.model,
            status=status,
            raw_text=proc.stdout,
            content_blocks=self.content_blocks(proc.stdout),
            stdout=proc.stdout,
            stderr=proc.stderr,
            exit_code=proc.returncode,
            timing={"total_ms": proc.elapsed_ms},
            capabilities_used={
                "runtime": "cli",
                "streaming": bool(request.llm.allow_streaming and request.stream_callback is not None),
            },
            warnings=warnings,
        )

    def content_blocks(self, stdout: str) -> tuple[dict, ...]:
        return ()

    def diagnostics(self, request: RuntimeRequest, command: list[str], proc: ProcessResult) -> RuntimeDiagnostics:
        return RuntimeDiagnostics(
            provider_id=request.provider_id,
            adapter_id=request.adapter_id,
            executable=command[0] if command else None,
            command=tuple(command),
            elapsed_ms=proc.elapsed_ms,
            stdout_bytes=len(proc.stdout.encode("utf-8")),
            stderr_bytes=len(proc.stderr.encode("utf-8")),
            exit_code=proc.returncode,
        )

    def runtime_env(self, overrides: dict[str, str] | None = None) -> dict[str, str]:
        allowed = (
            "PATH",
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "TMP",
            "TEMP",
            "LANG",
            "LC_ALL",
            "LC_CTYPE",
            "COMSPEC",
            "ComSpec",
            "SystemRoot",
            "WINDIR",
            "windir",
            "OPEN_KRITT_CODEX_BIN",
            "CODEX_BIN",
            "CODEX_CLI_PATH",
            "OPEN_KRITT_CLAUDE_BIN",
            "CLAUDE_BIN",
            "CLAUDE_CLI_PATH",
        )
        env = {key: value for key in allowed if (value := os.environ.get(key))}
        if overrides:
            env.update({str(key): str(value) for key, value in overrides.items() if value is not None})
        return env

    def _probe(
        self,
        command: list[str],
        *,
        timeout_seconds: int,
        input_text: str = "",
        env: dict[str, str] | None = None,
    ) -> ProcessResult | None:
        try:
            return self.runner.run(
                command,
                input_text=input_text,
                cwd=None,
                timeout_seconds=timeout_seconds,
                env=self.runtime_env(env),
            )
        except RuntimeErrorBase:
            return None


class ClaudeCodeRuntime(CLIRuntimeProvider):
    """Runtime adapter for the installed ``claude`` executable."""

    def __init__(self, runner: ProcessRunner | None = None):
        super().__init__(
            id="claude-code",
            adapter_id="cli:claude-code",
            executable_names=("claude",),
            default_capabilities=ProviderCapabilities(
                streaming=True,
                tools=True,
                thinking=True,
                json_mode=True,
                structured_outputs=True,
                cli_execution=True,
            ),
            runner=runner,
        )

    def auth_probe_command(self, executable: str) -> list[str]:
        return [executable, "-p", "Return OK.", "--output-format", "text"]

    def detect(self) -> RuntimeDetection:
        detection = super().detect()
        if not detection.available or detection.executable is None:
            return detection
        help_result = self._probe([detection.executable, "--help"], timeout_seconds=5)
        if help_result is None:
            return RuntimeDetection(
                available=detection.available,
                authenticated=detection.authenticated,
                executable=detection.executable,
                version=detection.version,
                capabilities=ProviderCapabilities(cli_execution=True),
                diagnostics=(*detection.diagnostics, "Claude help probe could not run; only CLI execution is advertised."),
            )
        help_text = f"{help_result.stdout}\n{help_result.stderr}"
        capabilities = ProviderCapabilities(
            streaming="stream-json" in help_text,
            tools="--tools" in help_text,
            thinking="--effort" in help_text or "reasoning" in help_text.lower(),
            json_mode="--output-format" in help_text,
            structured_outputs="--json-schema" in help_text,
            vision="image" in help_text.lower() or "vision" in help_text.lower(),
            cli_execution=True,
            max_context_tokens=200_000 if "200" in help_text and "context" in help_text.lower() else None,
        )
        return RuntimeDetection(
            available=detection.available,
            authenticated=detection.authenticated,
            executable=detection.executable,
            version=detection.version,
            capabilities=capabilities,
            diagnostics=detection.diagnostics,
        )

    def build_command(self, executable: str, request: RuntimeRequest) -> list[str]:
        stream_output = request.llm.allow_streaming and request.stream_callback is not None
        command = [
            executable,
            "-p",
            "--model",
            request.llm.model,
            "--input-format",
            "text",
            "--output-format",
            "stream-json" if stream_output else "json",
        ]
        if request.llm.allow_tools:
            command.extend(["--tools", "default"])
        if request.llm.thinking_effort and request.llm.thinking_effort != "default":
            command.extend(["--effort", request.llm.thinking_effort])
        if stream_output:
            command.append("--verbose")
        return command

    def content_blocks(self, stdout: str) -> tuple[dict, ...]:
        blocks: list[dict] = []
        for line in stdout.splitlines() or [stdout]:
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(value, dict):
                continue
            result = value.get("result")
            if isinstance(result, str):
                blocks.append({"text": result, "source": "claude_result"})
            message = value.get("message")
            if isinstance(message, dict):
                content = message.get("content")
                if isinstance(content, str):
                    blocks.append({"text": content, "source": "claude_message"})
                elif isinstance(content, list):
                    for item in content:
                        if isinstance(item, dict) and isinstance(item.get("text"), str):
                            blocks.append({"text": item["text"], "source": "claude_content_block"})
            content = value.get("content")
            if isinstance(content, str):
                blocks.append({"text": content, "source": "claude_content"})
        return tuple(blocks)


class CodexRuntime(CLIRuntimeProvider):
    """Runtime adapter for the installed ``codex`` executable."""

    def __init__(self, runner: ProcessRunner | None = None):
        super().__init__(
            id="codex",
            adapter_id="cli:codex",
            executable_names=("codex",),
            default_capabilities=ProviderCapabilities(
                streaming=True,
                tools=True,
                thinking=True,
                json_mode=True,
                structured_outputs=True,
                cli_execution=True,
            ),
            runner=runner,
        )

    def auth_probe_command(self, executable: str) -> list[str]:
        return [executable, "exec", "--json", "-m", "default", "-"]

    def auth_probe_input_text(self) -> str:
        return "Return OK."

    def detect(self) -> RuntimeDetection:
        detection = super().detect()
        if not detection.available or detection.executable is None:
            return detection
        help_result = self._probe([detection.executable, "exec", "--help"], timeout_seconds=5)
        if help_result is None:
            return RuntimeDetection(
                available=detection.available,
                authenticated=detection.authenticated,
                executable=detection.executable,
                version=detection.version,
                capabilities=ProviderCapabilities(cli_execution=True),
                diagnostics=(*detection.diagnostics, "Codex help probe could not run; only CLI execution is advertised."),
            )
        help_text = f"{help_result.stdout}\n{help_result.stderr}"
        capabilities = ProviderCapabilities(
            streaming="--json" in help_text,
            tools="sandbox" in help_text.lower() or "approval" in help_text.lower(),
            thinking="reasoning" in help_text.lower() or "effort" in help_text.lower(),
            json_mode="--json" in help_text,
            structured_outputs="output-schema" in help_text or "-o" in help_text,
            cli_execution=True,
        )
        return RuntimeDetection(
            available=detection.available,
            authenticated=detection.authenticated,
            executable=detection.executable,
            version=detection.version,
            capabilities=capabilities,
            diagnostics=detection.diagnostics,
        )

    def build_command(self, executable: str, request: RuntimeRequest) -> list[str]:
        command = [executable, "exec", "--json", "-m", request.llm.model]
        if request.llm.allow_tools:
            command.append("--dangerously-bypass-approvals-and-sandbox")
        else:
            command.extend(["--sandbox", "read-only"])
        if request.llm.thinking_effort and request.llm.thinking_effort != "default":
            command.extend(["-c", f'model_reasoning_effort="{request.llm.thinking_effort}"'])
        command.append("-")
        return command

    def content_blocks(self, stdout: str) -> tuple[dict, ...]:
        blocks: list[dict] = []
        for line in stdout.splitlines() or [stdout]:
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                blocks.append({"text": line, "source": "codex_stdout"})
                continue
            if isinstance(value, dict):
                for key in ("text", "content", "output", "message"):
                    item = value.get(key)
                    if isinstance(item, str):
                        blocks.append({"text": item, "source": f"codex_{key}"})
                    elif isinstance(item, dict):
                        content = item.get("content") or item.get("text")
                        if isinstance(content, str):
                            blocks.append({"text": content, "source": f"codex_{key}"})
                    elif isinstance(item, list):
                        for part in item:
                            if isinstance(part, dict) and isinstance(part.get("text"), str):
                                blocks.append({"text": part["text"], "source": f"codex_{key}_part"})
                if isinstance(value.get("payload"), dict):
                    blocks.append({"text": json.dumps(value["payload"]), "source": "codex_payload"})
        return tuple(blocks)


def _short_diagnostic(text: str) -> str:
    stripped = _redact_secrets(text.strip())
    if len(stripped) <= 500:
        return stripped
    return stripped[-500:]


def _redacted_command(command: list[str]) -> str:
    return " ".join("[REDACTED]" if any(marker in str(part).lower() for marker in ("api_key", "token", "bearer ")) else str(part) for part in command)


def _redact_secrets(text: str) -> str:
    redacted = re.sub(r"(?i)\b(sk-[a-z0-9_-]{8,})\b", "[REDACTED]", text)
    redacted = re.sub(r"(?i)\b(api[_ -]?key\s*[:=]\s*)[^\s'\";]+", r"\1[REDACTED]", redacted)
    redacted = re.sub(r"(?i)\b(bearer\s+)[a-z0-9._-]+", r"\1[REDACTED]", redacted)
    return redacted


def _looks_auth_failure(text: str) -> bool:
    lowered = text.lower()
    auth_markers = (
        "not logged in",
        "not authenticated",
        "login required",
        "authentication required",
        "unauthenticated",
        "invalid api key",
        "missing api key",
        "no api key",
        "credential",
        "credentials",
    )
    return any(marker in lowered for marker in auth_markers)

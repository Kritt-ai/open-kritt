import json
from collections.abc import Callable
from dataclasses import dataclass
from time import monotonic
from typing import Any

from ...harnesses import (
    ClaudeHarness,
    CodexHarness,
    CursorHarness,
    HarnessError,
    HarnessResult,
    OpenAICompatibleHarness,
)
from ..capabilities import LEGACY_PROVIDER_CAPABILITIES, ProviderCapabilities
from ..types import LLMRequest, ProviderContext, ProviderHealth, RawLLMResponse

HarnessFactory = Callable[[int], Any]


@dataclass(frozen=True)
class LegacyHarnessProvider:
    """Compatibility provider that exposes an existing harness as LLMProvider."""

    id: str
    label: str
    harness_name: str
    harness_factory: HarnessFactory
    capability_defaults: ProviderCapabilities

    def capabilities(self, ctx: ProviderContext | None = None) -> ProviderCapabilities:
        return self.capability_defaults

    def health(self, ctx: ProviderContext | None = None) -> ProviderHealth:
        return ProviderHealth(status="unknown", message="Legacy harness health probes are not enabled yet.")

    def supports_streaming(self) -> bool:
        return self.capability_defaults.supports_streaming()

    def supports_tools(self) -> bool:
        return self.capability_defaults.supports_tools()

    def supports_thinking(self) -> bool:
        return self.capability_defaults.supports_thinking()

    def supports_vision(self) -> bool:
        return self.capability_defaults.supports_vision()

    def generate(self, ctx: ProviderContext, request: LLMRequest) -> RawLLMResponse:
        started = monotonic()
        harness = self.harness_factory(request.timeout_seconds)
        try:
            result = harness.run(
                prompt=request.prompt,
                schema=request.schema or {},
                repo_dir=request.repo_dir or ".",
                model=request.model,
                thinking_effort=request.thinking_effort,
                env=dict(ctx.env or {}),
                allow_tools=request.allow_tools,
            )
        except HarnessError as exc:
            output = exc.output
            return RawLLMResponse(
                provider_id=self.id,
                adapter_id=f"legacy:{self.harness_name}",
                model=request.model,
                status=_status_from_harness_error(exc),
                raw_text=(output.stdout if output is not None else ""),
                stdout=(output.stdout if output is not None else ""),
                stderr=(output.stderr if output is not None else str(exc)),
                exit_code=(output.returncode if output is not None else exc.exit_code),
                timing={"total_ms": _elapsed_ms(started)},
                warnings=(f"legacy_harness_error:{exc.code}",),
            )

        return _raw_response_from_harness_result(
            provider_id=self.id,
            adapter_id=f"legacy:{self.harness_name}",
            model=request.model,
            started=started,
            result=result,
        )


def legacy_provider(provider_id: str, *, model_provider: str | None = None, codex_model_provider: str | None = None):
    if provider_id == "codex":
        return LegacyHarnessProvider(
            id="codex",
            label="Codex CLI",
            harness_name="codex",
            harness_factory=lambda timeout: CodexHarness(
                timeout,
                model_provider=model_provider,
                codex_model_provider=codex_model_provider,
            ),
            capability_defaults=LEGACY_PROVIDER_CAPABILITIES["codex"],
        )
    if provider_id == "claude-code":
        return LegacyHarnessProvider(
            id="claude-code",
            label="Claude Code",
            harness_name="claude-code",
            harness_factory=lambda timeout: ClaudeHarness(timeout, model_provider),
            capability_defaults=LEGACY_PROVIDER_CAPABILITIES["claude-code"],
        )
    if provider_id == "cursor":
        return LegacyHarnessProvider(
            id="cursor",
            label="Cursor Agent",
            harness_name="cursor",
            harness_factory=lambda timeout: CursorHarness(timeout, model_provider),
            capability_defaults=LEGACY_PROVIDER_CAPABILITIES["cursor"],
        )
    if provider_id == "openai-compatible":
        return LegacyHarnessProvider(
            id="openai-compatible",
            label="OpenAI-Compatible HTTP",
            harness_name="openai-compatible",
            harness_factory=lambda timeout: OpenAICompatibleHarness(timeout, model_provider),
            capability_defaults=LEGACY_PROVIDER_CAPABILITIES["openai-compatible"],
        )
    raise KeyError(f"unknown legacy provider {provider_id!r}")


def _raw_response_from_harness_result(
    *,
    provider_id: str,
    adapter_id: str,
    model: str,
    started: float,
    result: HarnessResult,
) -> RawLLMResponse:
    output = result.output
    payload = result.payload if isinstance(result.payload, dict) else None
    raw_text = ""
    if output is not None:
        raw_text = output.stdout or ""
    if not raw_text and payload is not None:
        raw_text = json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return RawLLMResponse(
        provider_id=provider_id,
        adapter_id=adapter_id,
        model=model,
        status="completed",
        raw_text=raw_text,
        raw_provider_payload=payload,
        stdout=(output.stdout if output is not None else ""),
        stderr=(output.stderr if output is not None else ""),
        exit_code=(output.returncode if output is not None else 0),
        usage=result.usage,
        timing={"total_ms": _elapsed_ms(started)},
        capabilities_used={"legacy_harness": True},
    )


def _status_from_harness_error(exc: HarnessError):
    if exc.code in {"rate_limited", "provider_throttled", "account_quota_limited", "quota_exceeded"}:
        return "rate_limited"
    if exc.code == "timeout":
        return "timeout"
    if exc.code in {"cyber_safety_blocked", "provider_rejected"}:
        return "blocked"
    return "failed"


def _elapsed_ms(started: float) -> float:
    return round((monotonic() - started) * 1000, 3)


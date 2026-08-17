from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Literal

LLMMode = Literal["scan_step", "generation", "post_process", "repair"]
ProviderStatus = Literal["available", "missing", "unauthenticated", "unhealthy", "unknown"]
ResponseStatus = Literal["completed", "blocked", "rate_limited", "failed", "timeout"]


@dataclass(frozen=True)
class ProviderContext:
    env: Mapping[str, str] | None = None
    data_dir: str | None = None
    metadata: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class ProviderHealth:
    status: ProviderStatus = "unknown"
    message: str = ""
    details: Mapping[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class LLMRequest:
    prompt: str
    schema: dict[str, Any] | None
    model: str
    mode: LLMMode
    repo_dir: str | None = None
    allow_tools: bool = True
    allow_streaming: bool = False
    thinking_effort: str | None = None
    timeout_seconds: int = 600
    metadata: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class RawLLMResponse:
    provider_id: str
    adapter_id: str
    model: str
    status: ResponseStatus
    raw_text: str = ""
    request_id: str | None = None
    finish_reason: str | None = None
    content_blocks: tuple[Mapping[str, Any], ...] = ()
    raw_provider_payload: Mapping[str, Any] | None = None
    stdout: str = ""
    stderr: str = ""
    exit_code: int | None = None
    usage: Mapping[str, Any] | None = None
    timing: Mapping[str, float] = field(default_factory=dict)
    capabilities_used: Mapping[str, Any] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()


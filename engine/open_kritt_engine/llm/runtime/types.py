from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ..capabilities import ProviderCapabilities
from ..types import LLMRequest
from .streaming import CancellationToken, StreamEvent

ProgressCallback = Callable[[StreamEvent], None]


@dataclass(frozen=True)
class RuntimeRequest:
    llm: LLMRequest
    provider_id: str
    adapter_id: str
    capabilities: ProviderCapabilities
    stream_callback: ProgressCallback | None = None
    cancellation_token: CancellationToken | None = None
    env: dict[str, str] | None = None
    metadata: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class RuntimeDetection:
    available: bool
    authenticated: bool | None = None
    executable: str | None = None
    version: str | None = None
    models: tuple[str, ...] = ()
    capabilities: ProviderCapabilities = field(default_factory=ProviderCapabilities)
    diagnostics: tuple[str, ...] = ()


@dataclass(frozen=True)
class RuntimeDiagnostics:
    provider_id: str
    adapter_id: str
    executable: str | None = None
    command: tuple[str, ...] = ()
    request_summary: dict[str, Any] = field(default_factory=dict)
    elapsed_ms: float = 0.0
    stdout_bytes: int = 0
    stderr_bytes: int = 0
    exit_code: int | None = None
    warnings: tuple[str, ...] = ()

"""Capability probing and short-lived capability caching."""

from dataclasses import dataclass, field
from time import monotonic
from typing import Protocol

from .capabilities import ProviderCapabilities
from .runtime.types import RuntimeDetection


class DetectableRuntime(Protocol):
    """Runtime subset required by capability probing."""

    id: str

    def detect(self) -> RuntimeDetection:
        """Return runtime availability and detected capabilities."""
        ...


@dataclass(frozen=True)
class CapabilityProbeResult:
    """Cached result of runtime capability detection."""

    provider_id: str
    capabilities: ProviderCapabilities
    source: str
    diagnostics: tuple[str, ...] = ()
    elapsed_ms: float = 0.0


@dataclass
class CapabilityCache:
    """In-memory TTL cache for runtime capability probe results."""

    ttl_seconds: float = 300.0
    _entries: dict[str, tuple[float, CapabilityProbeResult]] = field(default_factory=dict)

    def get(self, key: str) -> CapabilityProbeResult | None:
        """Return a cached result while it is still within the TTL."""
        entry = self._entries.get(key)
        if entry is None:
            return None
        created, result = entry
        if monotonic() - created > self.ttl_seconds:
            self._entries.pop(key, None)
            return None
        return result

    def set(self, key: str, result: CapabilityProbeResult) -> None:
        """Store a capability probe result."""
        self._entries[key] = (monotonic(), result)


class CapabilityProbe:
    """Probe runtime capabilities with caching."""

    def __init__(self, cache: CapabilityCache | None = None):
        self.cache = cache or CapabilityCache()

    def probe(self, runtime: DetectableRuntime) -> CapabilityProbeResult:
        """Detect capabilities for a runtime, reusing cached results when valid."""
        cached = self.cache.get(runtime.id)
        if cached is not None:
            return cached
        started = monotonic()
        detection = runtime.detect()
        result = CapabilityProbeResult(
            provider_id=runtime.id,
            capabilities=detection.capabilities,
            source="runtime_detection",
            diagnostics=detection.diagnostics,
            elapsed_ms=round((monotonic() - started) * 1000, 3),
        )
        self.cache.set(runtime.id, result)
        return result

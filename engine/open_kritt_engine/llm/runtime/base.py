"""Runtime interface for executing model requests.

Runtime adapters own transport concerns only: HTTP calls, CLI subprocesses,
stream callbacks, cancellation, and diagnostics. They must return
``RawLLMResponse`` without parsing model content.
"""

from typing import Protocol

from ..types import RawLLMResponse
from .types import RuntimeDetection, RuntimeRequest


class LLMRuntime(Protocol):
    """Transport-level adapter that executes a normalized runtime request."""

    id: str
    adapter_id: str

    def detect(self) -> RuntimeDetection:
        """Return availability, authentication, and capability diagnostics."""
        ...

    def execute(self, request: RuntimeRequest) -> RawLLMResponse:
        """Execute a request and return the unparsed provider response."""
        ...

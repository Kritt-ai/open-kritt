"""Provider interface for model backends.

Providers describe backend capabilities and produce raw model responses.
Parsing, schema validation, repair, and confidence scoring belong to the
universal response pipeline, not provider adapters.
"""

from typing import Protocol

from ..capabilities import ProviderCapabilities
from ..types import LLMRequest, ProviderContext, ProviderHealth, RawLLMResponse


class LLMProvider(Protocol):
    """Backend adapter contract used by provider-agnostic workflows."""

    id: str
    label: str

    def capabilities(self, ctx: ProviderContext | None = None) -> ProviderCapabilities:
        """Return advertised or detected provider capabilities."""
        ...

    def health(self, ctx: ProviderContext | None = None) -> ProviderHealth:
        """Return provider availability and actionable diagnostics."""
        ...

    def generate(self, ctx: ProviderContext, request: LLMRequest) -> RawLLMResponse:
        """Generate a raw response without parsing provider output."""
        ...

    def supports_streaming(self) -> bool:
        """Return whether streaming execution is supported."""
        ...

    def supports_tools(self) -> bool:
        """Return whether tool execution is supported."""
        ...

    def supports_thinking(self) -> bool:
        """Return whether explicit reasoning controls are supported."""
        ...

    def supports_vision(self) -> bool:
        """Return whether image or vision inputs are supported."""
        ...

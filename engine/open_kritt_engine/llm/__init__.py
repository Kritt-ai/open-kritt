"""Provider-agnostic LLM execution foundation.

Phase 1 introduces stable provider contracts without changing the legacy
harness execution path.
"""

from .capabilities import ProviderCapabilities
from .types import LLMRequest, ProviderContext, ProviderHealth, RawLLMResponse

__all__ = [
    "LLMRequest",
    "ProviderCapabilities",
    "ProviderContext",
    "ProviderHealth",
    "ProviderRegistry",
    "RawLLMResponse",
    "default_provider_registry",
]


def __getattr__(name):
    if name in {"ProviderRegistry", "default_provider_registry"}:
        from .registry import ProviderRegistry, default_provider_registry

        return {"ProviderRegistry": ProviderRegistry, "default_provider_registry": default_provider_registry}[name]
    raise AttributeError(name)

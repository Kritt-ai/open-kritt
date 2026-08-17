from dataclasses import dataclass, field

from .providers.base import LLMProvider
from .providers.legacy import legacy_provider


@dataclass
class ProviderRegistry:
    _providers: dict[str, LLMProvider] = field(default_factory=dict)

    def register(self, provider: LLMProvider) -> None:
        if not provider.id:
            raise ValueError("provider id is required")
        if provider.id in self._providers:
            raise ValueError(f"provider {provider.id!r} is already registered")
        self._providers[provider.id] = provider

    def get(self, provider_id: str) -> LLMProvider:
        try:
            return self._providers[provider_id]
        except KeyError as exc:
            raise KeyError(f"unknown LLM provider {provider_id!r}") from exc

    def ids(self) -> tuple[str, ...]:
        return tuple(sorted(self._providers))

    def providers(self) -> tuple[LLMProvider, ...]:
        return tuple(self._providers[provider_id] for provider_id in self.ids())


def default_provider_registry(
    *,
    model_provider: str | None = None,
    codex_model_provider: str | None = None,
) -> ProviderRegistry:
    registry = ProviderRegistry()
    for provider_id in ("codex", "claude-code", "cursor", "openai-compatible"):
        registry.register(
            legacy_provider(
                provider_id,
                model_provider=model_provider,
                codex_model_provider=codex_model_provider,
            )
        )
    return registry


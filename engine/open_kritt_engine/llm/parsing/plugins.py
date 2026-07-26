from dataclasses import dataclass, field
from typing import Protocol

from .types import JSONCandidate, NormalizedResponse


class ParserPlugin(Protocol):
    name: str

    def parse(self, normalized: NormalizedResponse) -> tuple[JSONCandidate, ...]:
        ...


@dataclass
class ParserPluginRegistry:
    _plugins: dict[str, ParserPlugin] = field(default_factory=dict)

    def register(self, plugin: ParserPlugin) -> None:
        if plugin.name in self._plugins:
            raise ValueError(f"parser plugin {plugin.name!r} is already registered")
        self._plugins[plugin.name] = plugin

    def get(self, name: str) -> ParserPlugin:
        return self._plugins[name]

    def all(self) -> tuple[ParserPlugin, ...]:
        return tuple(self._plugins[name] for name in sorted(self._plugins))


@dataclass(frozen=True)
class NoopParserPlugin:
    name: str = "noop"

    def parse(self, normalized: NormalizedResponse) -> tuple[JSONCandidate, ...]:
        return ()


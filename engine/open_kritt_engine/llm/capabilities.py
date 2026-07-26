from dataclasses import dataclass


@dataclass(frozen=True)
class ProviderCapabilities:
    streaming: bool = False
    tools: bool = False
    thinking: bool = False
    vision: bool = False
    json_mode: bool = False
    structured_outputs: bool = False
    function_calling: bool = False
    local_execution: bool = False
    cli_execution: bool = False
    max_context_tokens: int | None = None
    max_output_tokens: int | None = None
    supports_system_prompt: bool = True
    supports_schema_hint: bool = True
    supports_temperature: bool = False

    def supports_streaming(self) -> bool:
        return self.streaming

    def supports_tools(self) -> bool:
        return self.tools

    def supports_thinking(self) -> bool:
        return self.thinking

    def supports_vision(self) -> bool:
        return self.vision


LEGACY_PROVIDER_CAPABILITIES: dict[str, ProviderCapabilities] = {
    "codex": ProviderCapabilities(
        streaming=True,
        tools=True,
        thinking=True,
        json_mode=True,
        structured_outputs=True,
        cli_execution=True,
        supports_temperature=False,
    ),
    "claude-code": ProviderCapabilities(
        streaming=True,
        tools=True,
        thinking=True,
        json_mode=True,
        structured_outputs=True,
        cli_execution=True,
        supports_temperature=False,
    ),
    "cursor": ProviderCapabilities(
        streaming=False,
        tools=True,
        thinking=True,
        json_mode=True,
        structured_outputs=False,
        cli_execution=True,
        supports_temperature=False,
    ),
    "openai-compatible": ProviderCapabilities(
        streaming=False,
        tools=False,
        thinking=False,
        json_mode=True,
        structured_outputs=True,
        function_calling=False,
        supports_temperature=True,
    ),
}


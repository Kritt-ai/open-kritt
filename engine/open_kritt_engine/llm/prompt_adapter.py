import json
from dataclasses import dataclass, field
from typing import Any

from .capabilities import ProviderCapabilities


@dataclass(frozen=True)
class AdaptedPrompt:
    prompt: str
    request_options: dict[str, Any] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()


class PromptAdapter:
    def adapt(
        self,
        *,
        provider_id: str,
        prompt: str,
        schema: dict[str, Any] | None,
        capabilities: ProviderCapabilities,
    ) -> AdaptedPrompt:
        schema_text = json.dumps(schema, sort_keys=True, indent=2) if schema is not None else ""
        request_options: dict[str, Any] = {}
        warnings: list[str] = []

        if capabilities.structured_outputs or capabilities.supports_schema_hint:
            request_options["schema"] = schema
        if capabilities.json_mode:
            request_options["json_mode"] = True
        if capabilities.supports_temperature:
            request_options["temperature"] = 0

        provider = provider_id.lower()
        if provider in {"openai", "openai-compatible", "litellm", "openrouter", "agentrouter"}:
            if capabilities.structured_outputs:
                request_options["response_format"] = "json_schema"
            adapted = prompt
        elif provider in {"anthropic", "claude", "claude-code"}:
            adapted = (
                f"{prompt.rstrip()}\n\n"
                "<output_contract>\n"
                "Return only the final JSON object. Do not include analysis outside the JSON.\n"
                f"{schema_text}\n"
                "</output_contract>"
            )
        elif provider == "gemini":
            adapted = f"{prompt.rstrip()}\n\nJSON schema:\n```json\n{schema_text}\n```"
        elif provider == "ollama":
            adapted = (
                f"{prompt.rstrip()}\n\n"
                "Return one compact JSON object only. No markdown, comments, or reasoning text."
            )
        elif provider in {"deepseek", "qwen", "kimi", "minimax"}:
            adapted = (
                f"{prompt.rstrip()}\n\n"
                "FINAL_OUTPUT_JSON_START\n"
                f"{schema_text}\n"
                "FINAL_OUTPUT_JSON_END\n"
                "Return only JSON between the delimiters."
            )
        else:
            adapted = f"{prompt.rstrip()}\n\nReturn JSON matching this schema:\n{schema_text}" if schema else prompt
            warnings.append("generic_prompt_adapter")

        return AdaptedPrompt(prompt=adapted, request_options=request_options, warnings=tuple(warnings))


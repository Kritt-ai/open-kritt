"""HTTP runtime adapters that return provider responses without parsing them."""

import builtins
import json
from email.utils import parsedate_to_datetime
from dataclasses import dataclass
from datetime import datetime, timezone
from time import monotonic
from typing import Protocol

from ..capabilities import ProviderCapabilities
from ..types import RawLLMResponse
from .errors import ProviderConfigurationError, RateLimited, TransportError
from .errors import TimeoutError as RuntimeTimeoutError
from .types import RuntimeDetection, RuntimeRequest


class HTTPClient(Protocol):
    """Minimal synchronous JSON HTTP client used by runtime adapters."""

    def post_json(
        self,
        url: str,
        *,
        headers: dict[str, str],
        payload: dict,
        timeout_seconds: int,
    ) -> tuple[int, dict[str, str], str]:
        ...


@dataclass
class HTTPRuntimeProvider:
    """Base runtime for HTTP model providers."""

    id: str
    adapter_id: str
    base_url: str | None
    api_key: str | None
    client: HTTPClient
    default_capabilities: ProviderCapabilities
    api_key_required: bool = True

    def detect(self) -> RuntimeDetection:
        """Validate local runtime configuration and return static capabilities."""
        diagnostics = []
        if not self.base_url:
            diagnostics.append("HTTP runtime base URL is missing.")
        if self.api_key_required and not self.api_key:
            diagnostics.append("HTTP runtime API key is missing.")
        return RuntimeDetection(
            available=not diagnostics,
            authenticated=(bool(self.api_key) if self.api_key_required else True) if self.base_url else None,
            capabilities=self.default_capabilities,
            diagnostics=tuple(diagnostics),
        )

    def execute(self, request: RuntimeRequest) -> RawLLMResponse:
        """Execute an HTTP request and return the raw provider payload/text."""
        if not self.base_url:
            raise ProviderConfigurationError("HTTP runtime base URL is missing.")
        if self.api_key_required and not self.api_key:
            raise ProviderConfigurationError("HTTP runtime API key is missing.")
        started = monotonic()
        payload = {
            "model": request.llm.model,
            "prompt": request.llm.prompt,
            "stream": bool(request.llm.allow_streaming),
        }
        if request.llm.schema is not None:
            payload["schema"] = request.llm.schema
        try:
            status_code, headers, text = self.client.post_json(
                self.base_url,
                headers=self._headers(),
                payload=payload,
                timeout_seconds=request.llm.timeout_seconds,
            )
        except RuntimeTimeoutError:
            raise
        except builtins.TimeoutError as exc:
            raise RuntimeTimeoutError(f"HTTP runtime timed out: {exc}") from exc
        except OSError as exc:
            raise TransportError(str(exc)) from exc

        if status_code == 429:
            raise RateLimited(
                "HTTP runtime was rate limited.",
                status_code=status_code,
                retry_after_seconds=_retry_after_seconds(headers),
            )
        if status_code >= 500:
            raise TransportError("HTTP runtime returned a server error.", status_code=status_code)
        if status_code >= 400:
            raise ProviderConfigurationError("HTTP runtime rejected the request.", status_code=status_code)

        parsed = _json_or_none(text)
        return RawLLMResponse(
            provider_id=request.provider_id,
            adapter_id=request.adapter_id,
            model=request.llm.model,
            status="completed",
            raw_text=text,
            request_id=headers.get("x-request-id") or headers.get("X-Request-ID"),
            raw_provider_payload=parsed,
            timing={"total_ms": round((monotonic() - started) * 1000, 3)},
            capabilities_used={"runtime": "http", "streaming": bool(request.llm.allow_streaming)},
        )

    def _headers(self) -> dict[str, str]:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        return headers


class OpenAIRuntime(HTTPRuntimeProvider):
    def __init__(self, *, base_url: str | None, api_key: str | None, client: HTTPClient):
        super().__init__(
            id="openai",
            adapter_id="http:openai",
            base_url=base_url,
            api_key=api_key,
            client=client,
            default_capabilities=ProviderCapabilities(
                streaming=True,
                json_mode=True,
                structured_outputs=True,
                function_calling=True,
                vision=True,
            ),
        )


class AnthropicRuntime(HTTPRuntimeProvider):
    def __init__(self, *, base_url: str | None, api_key: str | None, client: HTTPClient):
        super().__init__(
            id="anthropic",
            adapter_id="http:anthropic",
            base_url=base_url,
            api_key=api_key,
            client=client,
            default_capabilities=ProviderCapabilities(
                streaming=True,
                tools=True,
                thinking=True,
                json_mode=False,
                structured_outputs=False,
                vision=True,
            ),
        )


class GeminiRuntime(HTTPRuntimeProvider):
    def __init__(self, *, base_url: str | None, api_key: str | None, client: HTTPClient):
        super().__init__(
            id="gemini",
            adapter_id="http:gemini",
            base_url=base_url,
            api_key=api_key,
            client=client,
            default_capabilities=ProviderCapabilities(
                streaming=True,
                tools=True,
                thinking=True,
                json_mode=True,
                structured_outputs=True,
                vision=True,
            ),
        )


class LiteLLMRuntime(HTTPRuntimeProvider):
    def __init__(self, *, base_url: str | None, api_key: str | None, client: HTTPClient):
        super().__init__(
            id="litellm",
            adapter_id="http:litellm",
            base_url=base_url,
            api_key=api_key,
            client=client,
            default_capabilities=ProviderCapabilities(streaming=True, json_mode=True),
        )


class OpenRouterRuntime(HTTPRuntimeProvider):
    def __init__(self, *, base_url: str | None, api_key: str | None, client: HTTPClient):
        super().__init__(
            id="openrouter",
            adapter_id="http:openrouter",
            base_url=base_url,
            api_key=api_key,
            client=client,
            default_capabilities=ProviderCapabilities(streaming=True, json_mode=True),
        )


class AgentRouterRuntime(HTTPRuntimeProvider):
    def __init__(self, *, base_url: str | None, api_key: str | None, client: HTTPClient):
        super().__init__(
            id="agentrouter",
            adapter_id="http:agentrouter",
            base_url=base_url,
            api_key=api_key,
            client=client,
            default_capabilities=ProviderCapabilities(streaming=True, json_mode=True),
        )


class OllamaRuntime(HTTPRuntimeProvider):
    def __init__(self, *, base_url: str | None, client: HTTPClient):
        super().__init__(
            id="ollama",
            adapter_id="http:ollama",
            base_url=base_url,
            api_key=None,
            client=client,
            default_capabilities=ProviderCapabilities(
                streaming=True,
                thinking=True,
                json_mode=True,
                local_execution=True,
            ),
            api_key_required=False,
        )


def _json_or_none(text: str):
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _retry_after_seconds(headers: dict[str, str]) -> float | None:
    value = headers.get("retry-after") or headers.get("Retry-After")
    if not value:
        return None
    try:
        return max(0.0, float(value))
    except (TypeError, ValueError):
        pass
    try:
        retry_at = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=timezone.utc)
    return max(0.0, (retry_at - datetime.now(timezone.utc)).total_seconds())

from time import monotonic
from typing import Any

from ..types import RawLLMResponse
from .types import NormalizedResponse, StageArtifact


class ResponseNormalizer:
    def normalize(self, response: RawLLMResponse) -> tuple[NormalizedResponse, StageArtifact]:
        started = monotonic()
        warnings: list[str] = []
        text_parts: list[str] = []

        if response.raw_text:
            text_parts.append(response.raw_text)
        elif response.stdout:
            text_parts.append(response.stdout)

        for block in response.content_blocks:
            block_text = _block_text(block)
            if block_text:
                text_parts.append(block_text)

        text = "\n".join(part for part in text_parts if part)
        if response.warnings:
            warnings.extend(response.warnings)
        if not text.strip():
            warnings.append("empty_response")

        normalized = NormalizedResponse(
            original=response,
            text=text.replace("\r\n", "\n").replace("\r", "\n").strip(),
            warnings=tuple(warnings),
        )
        return normalized, StageArtifact(
            stage="normalizer",
            input=response,
            output=normalized,
            elapsed_ms=_elapsed_ms(started),
            warnings=tuple(warnings),
        )


def _block_text(block: Any) -> str:
    if isinstance(block, dict):
        value = block.get("text") or block.get("content")
        return value if isinstance(value, str) else ""
    value = getattr(block, "text", "")
    return value if isinstance(value, str) else ""


def _elapsed_ms(started: float) -> float:
    return round((monotonic() - started) * 1000, 3)


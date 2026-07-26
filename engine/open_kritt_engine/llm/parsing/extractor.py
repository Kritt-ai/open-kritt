"""JSON candidate extraction from normalized model text."""

import json
import re
from collections.abc import Iterator
from time import monotonic
from typing import Any

from .types import JSONCandidate, NormalizedResponse, StageArtifact

FENCED_JSON_RE = re.compile(r"```(?:json|JSON)?\s*(.*?)```", re.DOTALL)


class JSONExtractor:
    """Extract and rank possible JSON snippets without validating schema."""

    def extract(self, normalized: NormalizedResponse) -> tuple[tuple[JSONCandidate, ...], StageArtifact]:
        """Return all candidate JSON snippets found in normalized model output."""
        started = monotonic()
        text = normalized.text or ""
        warnings: list[str] = []
        candidates: list[JSONCandidate] = []

        stripped = text.strip()
        if stripped and _starts_json(stripped):
            candidates.append(JSONCandidate(text=stripped, source="direct", confidence=0.95, start=0, end=len(text)))

        for match in FENCED_JSON_RE.finditer(text):
            body = match.group(1).strip()
            if body:
                candidates.append(
                    JSONCandidate(
                        text=body,
                        source="fenced",
                        confidence=0.90,
                        start=match.start(1),
                        end=match.end(1),
                    )
                )

        for start, end, snippet in _balanced_json_values(text):
            candidates.append(
                JSONCandidate(
                    text=snippet,
                    source="balanced",
                    confidence=0.82,
                    start=start,
                    end=end,
                )
            )
            candidates.extend(_embedded_json_candidates(snippet, start))

        partial = _partial_json_candidate(text)
        if partial is not None:
            start, snippet = partial
            if _balanced_end(text, start) is None:
                candidates.append(
                    JSONCandidate(
                        text=snippet,
                        source="partial",
                        confidence=0.45,
                        start=start,
                        end=len(text),
                        warnings=("unbalanced_candidate",),
                    )
                )

        deduped = _dedupe_and_rank(candidates)
        if not deduped:
            warnings.append("no_json_candidate")

        return tuple(deduped), StageArtifact(
            stage="extractor",
            input=normalized,
            output=tuple(deduped),
            elapsed_ms=_elapsed_ms(started),
            warnings=tuple(warnings),
        )


def _starts_json(text: str) -> bool:
    return text.startswith("{") or text.startswith("[")


def _balanced_json_values(text: str) -> list[tuple[int, int, str]]:
    results: list[tuple[int, int, str]] = []
    for index, char in enumerate(text):
        if char not in "{[":
            continue
        end = _balanced_end(text, index)
        if end is None:
            continue
        snippet = text[index : end + 1].strip()
        if snippet:
            results.append((index, end + 1, snippet))
    return results


def _balanced_end(text: str, start: int) -> int | None:
    stack = [text[start]]
    in_string = False
    escaped = False
    for index in range(start + 1, len(text)):
        char = text[index]
        if escaped:
            escaped = False
            continue
        if char == "\\" and in_string:
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if char in "{[":
            stack.append(char)
        elif char == "}":
            if not stack or stack[-1] != "{":
                return None
            stack.pop()
        elif char == "]":
            if not stack or stack[-1] != "[":
                return None
            stack.pop()
        if not stack:
            return index
    return None


def _partial_json_candidate(text: str) -> tuple[int, str] | None:
    positions = [index for index, char in enumerate(text) if char in "{["]
    if not positions:
        return None
    start = positions[0]
    return start, text[start:].strip()


def _dedupe_and_rank(candidates: list[JSONCandidate]) -> list[JSONCandidate]:
    seen: set[str] = set()
    unique: list[JSONCandidate] = []
    for candidate in candidates:
        key = _canonical_candidate_key(candidate.text)
        if key in seen:
            continue
        seen.add(key)
        unique.append(candidate)
    unique.sort(key=lambda item: (_source_rank(item.source), -len(item.text), -(item.confidence or 0.0)))
    return unique


def _canonical_candidate_key(text: str) -> str:
    stripped = text.strip()
    try:
        return json.dumps(json.loads(stripped), sort_keys=True, separators=(",", ":"))
    except json.JSONDecodeError:
        return stripped


def _source_rank(source: str) -> int:
    return {"direct": 0, "fenced": 1, "balanced": 2, "embedded": 3, "partial": 4}.get(source, 9)


def _embedded_json_candidates(wrapper_text: str, wrapper_start: int) -> list[JSONCandidate]:
    try:
        wrapper = json.loads(wrapper_text)
    except json.JSONDecodeError:
        return []
    candidates: list[JSONCandidate] = []
    for embedded_text in _iter_embedded_strings(wrapper):
        stripped = embedded_text.strip()
        if not stripped:
            continue
        for match in FENCED_JSON_RE.finditer(stripped):
            body = match.group(1).strip()
            if body:
                candidates.append(
                    JSONCandidate(
                        text=body,
                        source="embedded",
                        confidence=0.88,
                        start=wrapper_start,
                        end=wrapper_start + len(wrapper_text),
                    )
                )
        if _starts_json(stripped):
            candidates.append(
                JSONCandidate(
                    text=stripped,
                    source="embedded",
                    confidence=0.86,
                    start=wrapper_start,
                    end=wrapper_start + len(wrapper_text),
                )
            )
        for _start, _end, snippet in _balanced_json_values(stripped):
            candidates.append(
                JSONCandidate(
                    text=snippet,
                    source="embedded",
                    confidence=0.84,
                    start=wrapper_start,
                    end=wrapper_start + len(wrapper_text),
                )
            )
    return candidates


def _iter_embedded_strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
        return
    if isinstance(value, dict):
        for child in value.values():
            yield from _iter_embedded_strings(child)
        return
    if isinstance(value, list):
        for child in value:
            yield from _iter_embedded_strings(child)


def _elapsed_ms(started: float) -> float:
    return round((monotonic() - started) * 1000, 3)

import re
from typing import Protocol

from .types import RepairAction


class RepairStrategy(Protocol):
    name: str

    def applies(self, text: str) -> bool:
        ...

    def apply(self, text: str) -> tuple[str, RepairAction, tuple[str, ...]]:
        ...


class MarkdownFenceRemoval:
    name = "markdown_fence_removal"
    _fence = re.compile(r"^\s*```(?:json|JSON)?\s*|\s*```\s*$")

    def applies(self, text: str) -> bool:
        return bool(self._fence.search(text))

    def apply(self, text: str) -> tuple[str, RepairAction, tuple[str, ...]]:
        next_text = self._fence.sub("", text).strip()
        return next_text, RepairAction(self.name, next_text != text), ()


class PrefixSuffixRemoval:
    name = "prefix_suffix_removal"

    def applies(self, text: str) -> bool:
        start = _first_json_opener(text)
        end = _last_json_closer(text)
        return start not in (None, 0) or (end is not None and end < len(text.rstrip()) - 1)

    def apply(self, text: str) -> tuple[str, RepairAction, tuple[str, ...]]:
        next_text = _trim_json_boundaries(text)
        return next_text, RepairAction(self.name, next_text != text), ()


class JSONBoundaryRecovery:
    name = "json_boundary_recovery"

    def applies(self, text: str) -> bool:
        return _first_json_opener(text) is not None

    def apply(self, text: str) -> tuple[str, RepairAction, tuple[str, ...]]:
        next_text = _trim_json_boundaries(text)
        return next_text, RepairAction(self.name, next_text != text), ()


class UnicodeRepair:
    name = "unicode_repair"

    def applies(self, text: str) -> bool:
        return any(char in text for char in ("\u201c", "\u201d", "\u2018", "\u2019", "\ufeff"))

    def apply(self, text: str) -> tuple[str, RepairAction, tuple[str, ...]]:
        next_text = (
            text.replace("\ufeff", "")
            .replace("\u201c", '"')
            .replace("\u201d", '"')
            .replace("\u2018", "'")
            .replace("\u2019", "'")
        )
        return next_text, RepairAction(self.name, next_text != text), ()


class EscapeRepair:
    name = "escape_repair"
    _invalid_escape = re.compile(r'\\(?!["\\/bfnrtu])')

    def applies(self, text: str) -> bool:
        return bool(self._invalid_escape.search(text))

    def apply(self, text: str) -> tuple[str, RepairAction, tuple[str, ...]]:
        next_text = _repair_invalid_escapes(text)
        return next_text, RepairAction(self.name, next_text != text), ()


class CommentRepair:
    name = "comment_repair"

    def applies(self, text: str) -> bool:
        return _contains_json_comments(text)

    def apply(self, text: str) -> tuple[str, RepairAction, tuple[str, ...]]:
        next_text = _strip_json_comments(text)
        return next_text, RepairAction(self.name, next_text != text), ()


class CommaRepair:
    name = "comma_repair"
    _trailing_comma = re.compile(r",\s*([}\]])")
    _duplicate_comma = re.compile(r",\s*,+")

    def applies(self, text: str) -> bool:
        return bool(self._trailing_comma.search(text) or self._duplicate_comma.search(text))

    def apply(self, text: str) -> tuple[str, RepairAction, tuple[str, ...]]:
        next_text = self._duplicate_comma.sub(",", text)
        next_text = self._trailing_comma.sub(r"\1", next_text)
        return next_text, RepairAction(self.name, next_text != text), ()


class BracketRepair:
    name = "bracket_repair"

    def applies(self, text: str) -> bool:
        return bool(_unclosed_stack(text))

    def apply(self, text: str) -> tuple[str, RepairAction, tuple[str, ...]]:
        stack, in_string, warnings = _scan_balance(text)
        if in_string:
            return text, RepairAction(self.name, applied=False, reason="inside_string"), (
                *warnings,
                "truncated_inside_string_not_repaired",
            )
        suffix = "".join("}" if opener == "{" else "]" for opener in reversed(stack))
        next_text = text + suffix
        return next_text, RepairAction(self.name, next_text != text), tuple(warnings)


class QuoteRepair:
    name = "quote_repair"

    def applies(self, text: str) -> bool:
        return "'" in text and '"' not in text

    def apply(self, text: str) -> tuple[str, RepairAction, tuple[str, ...]]:
        # Only apply the narrow case of fully single-quoted pseudo-JSON. Mixed
        # quote styles are too ambiguous for deterministic repair.
        next_text = text.replace("'", '"')
        return next_text, RepairAction(self.name, next_text != text, reason="single_quote_pseudo_json"), ()


class DuplicateKeyResolver:
    name = "duplicate_key_resolver"

    def applies(self, text: str) -> bool:
        return False

    def apply(self, text: str) -> tuple[str, RepairAction, tuple[str, ...]]:
        return text, RepairAction(self.name, applied=False, skipped=True, reason="validator_reports_ambiguity"), ()


class TruncationRecovery:
    name = "truncation_recovery"

    def applies(self, text: str) -> bool:
        stack, in_string, _warnings = _scan_balance(text)
        return bool(stack) or in_string

    def apply(self, text: str) -> tuple[str, RepairAction, tuple[str, ...]]:
        _stack, in_string, _warnings = _scan_balance(text)
        if in_string:
            return text, RepairAction(self.name, applied=False, reason="inside_string"), (
                "truncated_inside_string_not_repaired",
            )
        return BracketRepair().apply(text)


def default_repair_strategies() -> tuple[RepairStrategy, ...]:
    return (
        MarkdownFenceRemoval(),
        PrefixSuffixRemoval(),
        JSONBoundaryRecovery(),
        UnicodeRepair(),
        EscapeRepair(),
        CommentRepair(),
        CommaRepair(),
        BracketRepair(),
        QuoteRepair(),
        DuplicateKeyResolver(),
        TruncationRecovery(),
    )


def _first_json_opener(text: str) -> int | None:
    positions = [position for position in (text.find("{"), text.find("[")) if position >= 0]
    return min(positions) if positions else None


def _last_json_closer(text: str) -> int | None:
    return max(text.rfind("}"), text.rfind("]"))


def _trim_json_boundaries(text: str) -> str:
    start = _first_json_opener(text)
    end = _last_json_closer(text)
    if start is None:
        return text.strip()
    if end is not None and end >= start:
        return text[start : end + 1].strip()
    return text[start:].strip()


def _repair_invalid_escapes(text: str) -> str:
    out: list[str] = []
    in_string = False
    escaped = False
    valid_escapes = {'"', "\\", "/", "b", "f", "n", "r", "t", "u"}
    for char in text:
        if escaped:
            if char in valid_escapes:
                out.append(char)
            else:
                out.append("\\")
                out.append(char)
            escaped = False
            continue
        if char == "\\" and in_string:
            out.append(char)
            escaped = True
            continue
        if char == '"':
            in_string = not in_string
        out.append(char)
    if escaped:
        out.append("\\")
    return "".join(out)


def _contains_json_comments(text: str) -> bool:
    in_string = False
    escaped = False
    for index, char in enumerate(text):
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
        next_char = text[index + 1] if index + 1 < len(text) else ""
        if char == "/" and next_char in {"/", "*"}:
            return True
    return False


def _strip_json_comments(text: str) -> str:
    out: list[str] = []
    index = 0
    in_string = False
    escaped = False
    while index < len(text):
        char = text[index]
        next_char = text[index + 1] if index + 1 < len(text) else ""
        if escaped:
            out.append(char)
            escaped = False
            index += 1
            continue
        if char == "\\" and in_string:
            out.append(char)
            escaped = True
            index += 1
            continue
        if char == '"':
            in_string = not in_string
            out.append(char)
            index += 1
            continue
        if not in_string and char == "/" and next_char == "/":
            index += 2
            while index < len(text) and text[index] not in "\r\n":
                index += 1
            continue
        if not in_string and char == "/" and next_char == "*":
            index += 2
            while index + 1 < len(text) and not (text[index] == "*" and text[index + 1] == "/"):
                index += 1
            index = min(index + 2, len(text))
            continue
        out.append(char)
        index += 1
    return "".join(out)


def _unclosed_stack(text: str) -> list[str]:
    stack, in_string, _warnings = _scan_balance(text)
    return [] if in_string else stack


def _scan_balance(text: str) -> tuple[list[str], bool, list[str]]:
    stack: list[str] = []
    in_string = False
    escaped = False
    warnings: list[str] = []
    for char in text:
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
            if stack and stack[-1] == "{":
                stack.pop()
            else:
                warnings.append("unexpected_closing_brace")
        elif char == "]":
            if stack and stack[-1] == "[":
                stack.pop()
            else:
                warnings.append("unexpected_closing_bracket")
    return stack, in_string, warnings

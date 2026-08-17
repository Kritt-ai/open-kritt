import json
from time import monotonic
from typing import Any

from jsonschema import Draft202012Validator

from .types import RepairResult, StageArtifact, ValidationIssue, ValidationResult


class SchemaValidator:
    def validate(
        self,
        repair: RepairResult,
        schema: dict[str, Any] | None,
    ) -> tuple[ValidationResult, StageArtifact]:
        started = monotonic()
        issues: list[ValidationIssue] = []
        warnings: list[str] = []
        try:
            value, duplicate_keys = _loads_without_duplicates(repair.text)
        except json.JSONDecodeError as exc:
            result = ValidationResult(
                valid=False,
                issues=(ValidationIssue(path="$", message=str(exc), code="invalid_json"),),
            )
            return result, StageArtifact(
                stage="validator",
                input=repair,
                output=result,
                elapsed_ms=_elapsed_ms(started),
                errors=tuple(issue.message for issue in result.issues),
            )

        if duplicate_keys:
            issues.append(
                ValidationIssue(
                    path="$",
                    message="duplicate object key(s): " + ", ".join(sorted(set(duplicate_keys))),
                    code="duplicate_keys",
                )
            )
        if not isinstance(value, dict):
            issues.append(ValidationIssue(path="$", message="top-level JSON value must be an object", code="not_object"))

        if schema is not None and not issues:
            schema_errors = sorted(Draft202012Validator(schema).iter_errors(value), key=lambda error: list(error.path))
            issues.extend(
                ValidationIssue(
                    path=_schema_path(error.path),
                    message=error.message,
                    code="schema_error",
                )
                for error in schema_errors
            )

        result = ValidationResult(
            valid=not issues,
            value=value if isinstance(value, dict) and not issues else None,
            issues=tuple(issues),
            warnings=tuple(warnings),
        )
        return result, StageArtifact(
            stage="validator",
            input=repair,
            output=result,
            elapsed_ms=_elapsed_ms(started),
            errors=tuple(issue.message for issue in issues),
            warnings=tuple(warnings),
        )


def _loads_without_duplicates(text: str) -> tuple[Any, list[str]]:
    duplicate_keys: list[str] = []

    def hook(pairs):
        seen = set()
        out = {}
        for key, value in pairs:
            if key in seen:
                duplicate_keys.append(str(key))
            seen.add(key)
            out[key] = value
        return out

    return json.loads(text, object_pairs_hook=hook), duplicate_keys


def _schema_path(path) -> str:
    parts = list(path)
    if not parts:
        return "$"
    return "$." + ".".join(str(part) for part in parts)


def _elapsed_ms(started: float) -> float:
    return round((monotonic() - started) * 1000, 3)


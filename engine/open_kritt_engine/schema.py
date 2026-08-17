import json
from typing import Any

from jsonschema import Draft202012Validator

EXTRACTOR_HELPER_FIELD = "_kritt_extractor_helper"

FIELD_TYPE_MAP = {
    "string": {"type": "string"},
    "number": {"type": "number"},
    "boolean": {"type": "boolean"},
    "array": {"type": "array", "items": {"type": "string"}},
    "object": {"type": "object", "additionalProperties": True},
}


class OutputValidationError(ValueError):
    def __init__(self, errors: list[dict[str, str]] | str):
        if isinstance(errors, str):
            errors = [{"field": "<root>", "message": errors}]
        self.errors = errors
        detail = "; ".join(f"{item['field']}: {item['message']}" for item in errors[:3])
        super().__init__(detail or "Generated output is invalid.")


def _schema_error_field(error) -> str:
    if not error.path:
        if error.validator == "required":
            missing = error.message.split("'")
            if len(missing) >= 2 and missing[1]:
                return missing[1]
        if error.validator == "additionalProperties":
            extra = error.message.split("'")
            if len(extra) >= 2 and extra[1]:
                return extra[1]
        return "<root>"
    return ".".join(str(part) for part in error.path)


def _missing_required_fields(error) -> list[str]:
    if error.validator != "required":
        return []
    missing = error.message.split("'")
    if len(missing) >= 2 and missing[1]:
        return [missing[1]]
    return []


def normalize_output_format(raw: Any) -> dict[str, str]:
    value = raw
    if isinstance(value, str):
        value = json.loads(value)

    out: dict[str, str] = {}
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict) and item.get("key"):
                out[str(item["key"])] = str(item.get("type") or "string")
    elif isinstance(value, dict):
        for key, field in value.items():
            if key in ("fields", "options") and isinstance(field, dict):
                if key == "fields":
                    for nested_key, nested_field in field.items():
                        out[str(nested_key)] = _field_type(nested_field)
                continue
            out[str(key)] = _field_type(field)
    return out


def _field_type(value: Any) -> str:
    if isinstance(value, dict) and "type" in value:
        return str(value["type"])
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return "array"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, dict):
        return "object"
    return "string"


def output_schema(raw_output_format: Any, multi_output: bool) -> dict[str, Any]:
    fields = normalize_output_format(raw_output_format)
    properties = {key: FIELD_TYPE_MAP.get(kind, {"type": "string"}) for key, kind in fields.items()}
    item_schema = {
        "type": "object",
        "properties": properties,
        "required": list(properties.keys()),
        "additionalProperties": False,
    }
    results_schema: dict[str, Any] = {
        "type": "array",
        "items": item_schema,
    }
    if not multi_output:
        results_schema["maxItems"] = 1
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            EXTRACTOR_HELPER_FIELD: {"type": "boolean", "const": True},
            "stub": {"type": "boolean"},
            "stub_explanation": {"type": "string"},
            "results": results_schema,
        },
        "required": [EXTRACTOR_HELPER_FIELD, "stub", "stub_explanation", "results"],
        "additionalProperties": False,
    }


def payload_validation_errors(payload: Any, schema: dict[str, Any], multi_output: bool) -> list[dict[str, str]]:
    validation_errors = sorted(Draft202012Validator(schema).iter_errors(payload), key=lambda e: list(e.path))
    errors = []
    missing_required: list[str] = []
    for error in validation_errors:
        missing_required.extend(_missing_required_fields(error))
        errors.append({"field": _schema_error_field(error), "message": error.message})
    if missing_required:
        ordered_missing = []
        for field in missing_required:
            if field not in ordered_missing:
                ordered_missing.append(field)
        errors.insert(
            0,
            {
                "field": "<required>",
                "message": "Missing required field(s): " + ", ".join(ordered_missing),
            },
        )
    if errors:
        return errors
    results = payload["results"]
    if payload["stub"] and results:
        return [{"field": "results", "message": "stub=true must use an empty results array"}]
    if payload["stub"] and not payload["stub_explanation"].strip():
        return [{"field": "stub_explanation", "message": "stub=true requires a non-empty stub_explanation"}]
    if not payload["stub"] and not results:
        return [{"field": "results", "message": "stub=false requires at least one result"}]
    if not multi_output and len(results) > 1:
        return [{"field": "results", "message": "single-output step returned more than one result"}]
    return []


def validate_payload(payload: Any, schema: dict[str, Any], multi_output: bool) -> list[dict[str, Any]]:
    errors = payload_validation_errors(payload, schema, multi_output)
    if errors:
        raise OutputValidationError(errors)
    return payload["results"]

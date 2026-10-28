import json
from typing import Any

from jsonschema import Draft202012Validator

from .adaptive_discovery import discovery_schema, validate_discovery

EXTRACTOR_HELPER_FIELD = "_kritt_extractor_helper"

FIELD_TYPE_MAP = {
    "string": {"type": "string"},
    "number": {"type": "number"},
    "boolean": {"type": "boolean"},
    "array": {"type": "array", "items": {"type": "string"}},
    "object": {"type": "object", "additionalProperties": True},
}


class OutputValidationError(ValueError):
    pass


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


def output_schema(raw_output_format: Any, multi_output: bool, *, discovery: bool = False) -> dict[str, Any]:
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
    schema = {
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
    if discovery:
        schema["properties"]["discovery"] = discovery_schema()
        schema["required"].append("discovery")
    return schema


def validate_payload(payload: Any, schema: dict[str, Any], multi_output: bool) -> list[dict[str, Any]]:
    errors = sorted(Draft202012Validator(schema).iter_errors(payload), key=lambda e: list(e.path))
    if errors:
        first = errors[0]
        path = ".".join(str(p) for p in first.path) or "<root>"
        raise OutputValidationError(f"{path}: {first.message}")
    results = payload["results"]
    if payload["stub"] and results:
        raise OutputValidationError("stub=true must use an empty results array")
    if payload["stub"] and not payload["stub_explanation"].strip():
        raise OutputValidationError("stub=true requires a non-empty stub_explanation")
    if not payload["stub"] and not results:
        raise OutputValidationError("stub=false requires at least one result")
    if not multi_output and len(results) > 1:
        raise OutputValidationError("single-output step returned more than one result")
    if "discovery" in schema.get("properties", {}):
        try:
            validate_discovery(payload["discovery"])
        except ValueError as exc:
            raise OutputValidationError(str(exc)) from exc
    return results

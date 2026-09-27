import copy
import json
from typing import Any

from jsonschema import Draft202012Validator

EXTRACTOR_HELPER_FIELD = "_kritt_extractor_helper"

FIELD_TYPES = ("string", "number", "boolean", "array", "object")
DESCRIPTOR_KEYS = ("type", "items", "fields", "required", "enum")
MAX_DESCRIPTOR_DEPTH = 4
MAX_DESCRIPTOR_FIELDS = 64
RESERVED_OUTPUT_KEY_PREFIXES = ("_engine_",)
RESERVED_OUTPUT_KEYS = frozenset({"_chip_lifecycle"})

FIELD_TYPE_MAP = {
    "string": {"type": "string"},
    "number": {"type": "number"},
    "boolean": {"type": "boolean"},
    "array": {"type": "array", "items": {"type": "string"}},
    "object": {"type": "object", "additionalProperties": True},
}


class OutputValidationError(ValueError):
    pass


def is_reserved_output_key(key: str) -> bool:
    return key in RESERVED_OUTPUT_KEYS or any(key.startswith(prefix) for prefix in RESERVED_OUTPUT_KEY_PREFIXES)


def _is_descriptor(value: Any) -> bool:
    return isinstance(value, dict) and "type" in value


def _is_legacy_wrapper(key: str, value: Any) -> bool:
    return key in ("fields", "options") and isinstance(value, dict) and not _is_descriptor(value)


def normalize_field_definition(value: Any) -> str | dict[str, Any]:
    """Return a type name or a deep-copied descriptor; a type-only descriptor collapses to its name."""
    if isinstance(value, str):
        return value
    if _is_descriptor(value):
        if set(value.keys()) == {"type"} and value["type"] in FIELD_TYPES:
            return str(value["type"])
        descriptor: dict[str, Any] = {"type": value["type"]}
        for key, nested in value.items():
            if key == "type":
                continue
            if key == "items":
                descriptor["items"] = normalize_field_definition(nested)
            elif key == "fields" and isinstance(nested, dict):
                descriptor["fields"] = {str(name): normalize_field_definition(field) for name, field in nested.items()}
            else:
                descriptor[key] = copy.deepcopy(nested)
        return descriptor
    if isinstance(value, list):
        return "array"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, int | float):
        return "number"
    if isinstance(value, dict):
        return "object"
    return "string"


def normalize_output_format(raw: Any) -> dict[str, str | dict[str, Any]]:
    value = raw
    if isinstance(value, str):
        value = json.loads(value)

    out: dict[str, str | dict[str, Any]] = {}
    if isinstance(value, list):
        for item in value:
            if isinstance(item, dict) and item.get("key"):
                out[str(item["key"])] = normalize_field_definition(item.get("type") or "string")
    elif isinstance(value, dict):
        for key, field in value.items():
            if _is_legacy_wrapper(key, field):
                if key == "fields":
                    for nested_key, nested_field in field.items():
                        out[str(nested_key)] = normalize_field_definition(nested_field)
                continue
            out[str(key)] = normalize_field_definition(field)
    return out


def _count_definitions(definition: Any) -> int:
    """Count declared ``fields`` entries across the whole descriptor (the cap is on fields)."""
    if not isinstance(definition, dict):
        return 0
    total = 0
    if "items" in definition:
        total += _count_definitions(definition["items"])
    fields = definition.get("fields")
    if isinstance(fields, dict):
        total += len(fields) + sum(_count_definitions(field) for field in fields.values())
    return total


def validate_field_definition(path: str, value: Any) -> list[str]:
    """Validate one output-format field definition; each error is '<descriptor path>: <message>'."""
    errors: list[str] = []
    key = path.rsplit(".", 1)[-1]
    if is_reserved_output_key(key):
        errors.append(f'{path}: "{key}" is reserved for engine-owned output')
        return errors
    definition = normalize_field_definition(value) if isinstance(value, str | dict) else value
    if isinstance(definition, dict) and _count_definitions(definition) > MAX_DESCRIPTOR_FIELDS:
        errors.append(f"{path}: descriptor declares more than {MAX_DESCRIPTOR_FIELDS} fields in total")
        return errors
    _validate_definition(path, definition, 1, errors)
    return errors


def _validate_definition(path: str, definition: Any, depth: int, errors: list[str]) -> None:
    if isinstance(definition, str):
        if definition not in FIELD_TYPES:
            errors.append(f'{path}: unsupported type "{definition}"')
        return
    if not isinstance(definition, dict):
        errors.append(f"{path}: field definition must be a type name or a descriptor object")
        return
    if depth > MAX_DESCRIPTOR_DEPTH:
        errors.append(f"{path}: descriptor nesting exceeds the depth cap of {MAX_DESCRIPTOR_DEPTH}")
        return
    for unknown in definition:
        if unknown not in DESCRIPTOR_KEYS:
            errors.append(f'{path}.{unknown}: unknown descriptor key "{unknown}"')
    kind = definition.get("type")
    if kind not in FIELD_TYPES:
        errors.append(f'{path}.type: unsupported type "{kind}"')
        return
    extra_keys = [name for name in definition if name != "type"]
    if kind == "array":
        if extra_keys and "items" not in definition:
            errors.append(f"{path}.items: array descriptors must declare items")
        for forbidden in ("fields", "required", "enum"):
            if forbidden in definition:
                errors.append(f'{path}.{forbidden}: "{forbidden}" is only allowed under {_owner(forbidden)}')
        if "items" in definition:
            _validate_definition(f"{path}.items", definition["items"], depth + 1, errors)
        return
    if kind == "object":
        for forbidden in ("items", "enum"):
            if forbidden in definition:
                errors.append(f'{path}.{forbidden}: "{forbidden}" is only allowed under {_owner(forbidden)}')
        fields = definition.get("fields")
        if extra_keys and not (isinstance(fields, dict) and fields):
            errors.append(f"{path}.fields: object descriptors must declare a non-empty fields map")
            fields = {}
        elif not isinstance(fields, dict):
            fields = {}
        required = definition.get("required")
        if required is not None:
            if not isinstance(required, list) or any(not isinstance(name, str) for name in required):
                errors.append(f"{path}.required: required must be an array of field names")
            elif len(set(required)) != len(required):
                errors.append(f"{path}.required: required lists the same field more than once")
            else:
                for name in required:
                    if name not in fields:
                        errors.append(f'{path}.required: "{name}" is not a declared field')
        for name, field in fields.items():
            if is_reserved_output_key(str(name)):
                errors.append(f'{path}.fields.{name}: "{name}" is reserved for engine-owned output')
                continue
            _validate_definition(f"{path}.fields.{name}", field, depth + 1, errors)
        return
    for forbidden in ("items", "fields", "required"):
        if forbidden in definition:
            errors.append(f'{path}.{forbidden}: "{forbidden}" is only allowed under {_owner(forbidden)}')
    if "enum" in definition:
        if kind != "string":
            errors.append(f"{path}.enum: enum is only allowed under string")
        else:
            enum = definition["enum"]
            if (
                not isinstance(enum, list)
                or not enum
                or any(not isinstance(item, str) for item in enum)
                or len(set(enum)) != len(enum)
            ):
                errors.append(f"{path}.enum: enum must be a non-empty array of unique strings")


def _owner(descriptor_key: str) -> str:
    return {"items": "array", "fields": "object", "required": "object", "enum": "string"}[descriptor_key]


def field_definition_schema(definition: Any) -> dict[str, Any]:
    """JSON Schema for one field definition (type name or descriptor)."""
    definition = normalize_field_definition(definition)
    if isinstance(definition, str):
        return copy.deepcopy(FIELD_TYPE_MAP.get(definition, {"type": "string"}))
    kind = definition.get("type")
    if kind == "array":
        items = definition.get("items", "string")
        return {"type": "array", "items": field_definition_schema(items)}
    if kind == "object":
        fields = definition.get("fields")
        if not isinstance(fields, dict) or not fields:
            return copy.deepcopy(FIELD_TYPE_MAP["object"])
        required = definition.get("required")
        return {
            "type": "object",
            "properties": {name: field_definition_schema(field) for name, field in fields.items()},
            "required": list(required) if isinstance(required, list) else list(fields.keys()),
            "additionalProperties": False,
        }
    if kind == "string" and isinstance(definition.get("enum"), list) and definition["enum"]:
        return {"type": "string", "enum": list(definition["enum"])}
    return copy.deepcopy(FIELD_TYPE_MAP.get(str(kind), {"type": "string"}))


def output_schema(raw_output_format: Any, multi_output: bool) -> dict[str, Any]:
    fields = normalize_output_format(raw_output_format)
    properties = {key: field_definition_schema(definition) for key, definition in fields.items()}
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


def strip_reserved_keys(payload: dict[str, Any]) -> dict[str, Any]:
    """Drop engine-owned keys (``_engine_*`` and ``_chip_lifecycle``) from a payload and every result row."""
    stripped = {key: value for key, value in payload.items() if not is_reserved_output_key(str(key))}
    results = stripped.get("results")
    if isinstance(results, list):
        stripped["results"] = [
            {key: value for key, value in row.items() if not is_reserved_output_key(str(key))}
            if isinstance(row, dict)
            else row
            for row in results
        ]
    return stripped


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
    return results

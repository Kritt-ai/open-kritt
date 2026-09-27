import json
from pathlib import Path

import pytest

from open_kritt_engine.schema import (
    EXTRACTOR_HELPER_FIELD,
    FIELD_TYPES,
    RESERVED_OUTPUT_KEY_PREFIXES,
    RESERVED_OUTPUT_KEYS,
    OutputValidationError,
    field_definition_schema,
    is_reserved_output_key,
    normalize_output_format,
    output_schema,
    strip_reserved_keys,
    validate_field_definition,
    validate_payload,
)

FIXTURE = json.loads(
    (Path(__file__).parents[2] / "test-fixtures" / "output-format-descriptors.json").read_text(encoding="utf-8")
)


def _errors_for(output_format):
    normalized = normalize_output_format(output_format)
    errors = []
    for key, definition in normalized.items():
        errors.extend(validate_field_definition(f"outputFormat.{key}", definition))
    return errors


@pytest.mark.parametrize("case", FIXTURE["cases"], ids=[case["name"] for case in FIXTURE["cases"]])
def test_shared_descriptor_cases(case):
    errors = _errors_for(case["outputFormat"])
    if case["valid"]:
        assert errors == []
    else:
        assert errors, "expected a validation error"
        assert errors[0].startswith(case["errorPath"] + ": "), errors[0]
    if "normalizedEquals" in case:
        assert normalize_output_format(case["outputFormat"]) == case["normalizedEquals"]


@pytest.mark.parametrize("case", FIXTURE["payloadCases"], ids=[case["name"] for case in FIXTURE["payloadCases"]])
def test_shared_payload_cases(case):
    schema = output_schema(case["outputFormat"], multi_output=False)
    payload = {EXTRACTOR_HELPER_FIELD: True, "stub": False, "stub_explanation": "", "results": [case["result"]]}
    if case["valid"]:
        assert validate_payload(payload, schema, multi_output=False) == [case["result"]]
    else:
        with pytest.raises(OutputValidationError):
            validate_payload(payload, schema, multi_output=False)


def test_field_types_and_reserved_keys():
    assert FIELD_TYPES == ("string", "number", "boolean", "array", "object")
    assert RESERVED_OUTPUT_KEY_PREFIXES == ("_engine_",)
    assert RESERVED_OUTPUT_KEYS == frozenset({"_chip_lifecycle"})
    assert is_reserved_output_key("_engine_evidence")
    assert is_reserved_output_key("_chip_lifecycle")
    assert not is_reserved_output_key("_chip_confidence")
    assert not is_reserved_output_key("_reserved_report")


def test_normalize_output_format_accepts_json_string_and_key_type_lists():
    assert normalize_output_format('{"a": "string", "b": {"type": "number"}}') == {"a": "string", "b": "number"}
    assert normalize_output_format([{"key": "a", "type": "number"}, {"key": "b"}]) == {"a": "number", "b": "string"}
    assert normalize_output_format({"fields": {"a": "string"}, "options": {"multi": True}}) == {"a": "string"}


def test_normalize_output_format_preserves_and_deep_copies_descriptors():
    raw = {"chain": {"type": "array", "items": {"type": "object", "fields": {"id": "string"}}}}
    normalized = normalize_output_format(raw)
    assert normalized == raw
    normalized["chain"]["items"]["fields"]["extra"] = "string"
    assert "extra" not in raw["chain"]["items"]["fields"]


def test_nested_schema_uses_strict_objects_required_defaults_and_enums():
    schema = field_definition_schema(
        {
            "type": "array",
            "items": {
                "type": "object",
                "fields": {"id": "string", "status": {"type": "string", "enum": ["a", "b"]}, "n": "number"},
                "required": ["id"],
            },
        }
    )
    assert schema == {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "id": {"type": "string"},
                "status": {"type": "string", "enum": ["a", "b"]},
                "n": {"type": "number"},
            },
            "required": ["id"],
            "additionalProperties": False,
        },
    }
    assert field_definition_schema("array") == {"type": "array", "items": {"type": "string"}}
    assert field_definition_schema("object") == {"type": "object", "additionalProperties": True}
    assert field_definition_schema({"type": "object", "fields": {"a": "boolean"}})["required"] == ["a"]


def test_validate_field_definition_reports_descriptor_paths_and_caps():
    assert validate_field_definition("outputFormat.x", "integer") == ['outputFormat.x: unsupported type "integer"']
    too_wide = {"type": "object", "fields": {f"f{i}": "string" for i in range(65)}}
    errors = validate_field_definition("outputFormat.wide", too_wide)
    assert errors and errors[0].startswith("outputFormat.wide: ")
    assert "64" in errors[0]
    nested_reserved = {"type": "object", "fields": {"_engine_x": "string"}}
    assert validate_field_definition("outputFormat.y", nested_reserved)[0].startswith(
        "outputFormat.y.fields._engine_x: "
    )


def test_output_schema_rejects_reserved_model_keys_at_extraction():
    schema = output_schema({"verdict": "string"}, multi_output=False)
    payload = {
        EXTRACTOR_HELPER_FIELD: True,
        "stub": False,
        "stub_explanation": "",
        "results": [{"verdict": "confirmed", "_engine_lifecycle": {"lifecycle_status": "report_ready"}}],
    }
    with pytest.raises(OutputValidationError):
        validate_payload(payload, schema, multi_output=False)


def test_strip_reserved_keys_drops_engine_blocks_from_every_row_without_mutating_input():
    payload = {
        EXTRACTOR_HELPER_FIELD: True,
        "stub": False,
        "stub_explanation": "",
        "_engine_top": 1,
        "results": [
            {"verdict": "confirmed", "_engine_readiness": {"ready": True}, "_chip_lifecycle": "x", "_chip_ease": 3},
            {"verdict": "false_positive", "_engine_lifecycle": {}},
        ],
    }
    stripped = strip_reserved_keys(payload)
    assert stripped["results"] == [
        {"verdict": "confirmed", "_chip_ease": 3},
        {"verdict": "false_positive"},
    ]
    assert "_engine_top" not in stripped
    assert "_engine_readiness" in payload["results"][0]
    assert strip_reserved_keys({"_engine_x": 1, "a": 2}) == {"a": 2}

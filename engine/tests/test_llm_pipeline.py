import pytest

from open_kritt_engine.llm.parsing import UniversalResponsePipeline
from open_kritt_engine.llm.types import RawLLMResponse
from open_kritt_engine.schema import EXTRACTOR_HELPER_FIELD


def schema():
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            EXTRACTOR_HELPER_FIELD: {"type": "boolean", "const": True},
            "results": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string"},
                        "path": {"type": "array", "items": {"type": "string"}},
                    },
                    "required": ["name", "path"],
                    "additionalProperties": False,
                },
            },
        },
        "required": [EXTRACTOR_HELPER_FIELD, "results"],
        "additionalProperties": False,
    }


def raw(text, *, warnings=()):
    return RawLLMResponse(
        provider_id="test-provider",
        adapter_id="test-adapter",
        model="test-model",
        status="completed",
        raw_text=text,
        warnings=warnings,
    )


def parse(text):
    return UniversalResponsePipeline().run(raw(text), schema())


def valid_payload(name="finding"):
    return f'{{"{EXTRACTOR_HELPER_FIELD}":true,"results":[{{"name":"{name}","path":["a","b"]}}]}}'


def assert_valid(result, name="finding"):
    assert result.valid
    assert result.validated_object["results"][0]["name"] == name
    assert result.raw_response.raw_text
    assert result.normalized.text
    assert result.repaired_json
    assert {artifact.stage for artifact in result.stage_artifacts} >= {
        "normalizer",
        "extractor",
        "recovery",
        "validator",
        "confidence",
    }


def test_pipeline_accepts_perfect_json():
    result = parse(valid_payload())

    assert_valid(result)
    assert result.selected_candidate.source == "direct"
    assert result.confidence.signals["schema_valid"] is True


def test_pipeline_extracts_markdown_wrapped_json():
    result = parse(f"```json\n{valid_payload('markdown')}\n```")

    assert_valid(result, "markdown")
    assert result.selected_candidate.source in {"fenced", "balanced"}


def test_pipeline_extracts_json_after_reasoning_prefix():
    result = parse("I checked the repository first.\n" + valid_payload("prefix"))

    assert_valid(result, "prefix")


def test_pipeline_extracts_json_before_reasoning_suffix():
    result = parse(valid_payload("suffix") + "\nThis is why the result matters.")

    assert_valid(result, "suffix")


def test_pipeline_repairs_trailing_commas():
    text = f'{{"{EXTRACTOR_HELPER_FIELD}":true,"results":[{{"name":"comma","path":["a","b",],}},],}}'

    result = parse(text)

    assert_valid(result, "comma")
    assert result.confidence.signals["repair_count"] >= 1


def test_pipeline_repairs_unbalanced_brackets_when_not_inside_string():
    text = f'{{"{EXTRACTOR_HELPER_FIELD}":true,"results":[{{"name":"bracket","path":["a","b"]}}'

    result = parse(text)

    assert_valid(result, "bracket")
    assert result.confidence.signals["repair_count"] >= 1


def test_pipeline_repairs_invalid_string_escaping():
    text = f'{{"{EXTRACTOR_HELPER_FIELD}":true,"results":[{{"name":"bad\\qescape","path":["a"]}}]}}'

    result = parse(text)

    assert_valid(result, "bad\\qescape")


def test_pipeline_flags_truncated_inside_string_as_unrecoverable():
    text = f'{{"{EXTRACTOR_HELPER_FIELD}":true,"results":[{{"name":"truncated'

    result = parse(text)

    assert not result.valid
    assert any("truncated_inside_string_not_repaired" in artifact.warnings for artifact in result.stage_artifacts)


def test_pipeline_reports_empty_response():
    result = UniversalResponsePipeline().run(raw(""), schema())

    assert not result.valid
    assert result.candidates == ()
    assert any("empty_response" in artifact.warnings for artifact in result.stage_artifacts)
    assert any("no_json_candidate" in artifact.warnings for artifact in result.stage_artifacts)


def test_pipeline_chooses_valid_json_from_multiple_objects():
    invalid = '{"note":"ignore"}'
    result = parse(f"{invalid}\n{valid_payload('second')}")

    assert_valid(result, "second")
    assert len(result.candidates) >= 2


def test_pipeline_handles_nested_json():
    text = f'{{"{EXTRACTOR_HELPER_FIELD}":true,"results":[{{"name":"nested","path":["a", "{{nested}}"]}}]}}'

    result = parse(text)

    assert_valid(result, "nested")


def test_pipeline_rejects_duplicate_keys():
    text = f'{{"{EXTRACTOR_HELPER_FIELD}":true,"results":[],"results":[{{"name":"dup","path":["a"]}}]}}'

    result = parse(text)

    assert not result.valid
    assert any(issue.code == "duplicate_keys" for issue in result.validation_issues)


def test_pipeline_exposes_stage_inputs_outputs_and_timing():
    result = parse(valid_payload("observable"))

    for artifact in result.stage_artifacts:
        assert artifact.input is not None
        assert artifact.output is not None
        assert isinstance(artifact.elapsed_ms, float)


@pytest.mark.parametrize(
    "text",
    [
        f'{{"{EXTRACTOR_HELPER_FIELD}":true,"results":[{{"name":"array","path":["a",],}}]}}',
        "Explanation\n```json\n" + valid_payload("fenced") + "\n```\nDone",
        "<think>private reasoning</think>\n" + valid_payload("think"),
    ],
)
def test_pipeline_recovers_common_provider_output_shapes(text):
    result = parse(text)

    assert result.valid

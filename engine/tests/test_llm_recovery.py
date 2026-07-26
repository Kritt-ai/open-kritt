import random

from open_kritt_engine.llm.parsing import (
    RepairRequest,
    ShadowPipelineComparator,
    UniversalResponsePipeline,
)
from open_kritt_engine.llm.parsing.strategies import default_repair_strategies
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


def payload(name="item"):
    return f'{{"{EXTRACTOR_HELPER_FIELD}":true,"results":[{{"name":"{name}","path":["src","lib"]}}]}}'


def raw(text, *, warnings=()):
    return RawLLMResponse(
        provider_id="test-provider",
        adapter_id="test-adapter",
        model="test-model",
        status="completed",
        raw_text=text,
        warnings=warnings,
    )


def parse(text, *, warnings=()):
    return UniversalResponsePipeline().run(raw(text, warnings=warnings), schema())


def test_recovery_orchestrator_records_metrics():
    result = parse(f"```json\n{payload('metrics')},\n```")

    assert result.valid
    assert result.recovery_metrics.strategy_order
    assert "markdown_fence_removal" in result.recovery_metrics.strategy_order
    assert result.recovery_metrics.strategies_attempted
    assert result.recovery_metrics.total_repair_count >= 1
    assert result.recovery_metrics.deterministic is True
    assert result.recovery_metrics.llm_repair_used is False
    assert result.recovery_metrics.final_confidence == result.confidence.score


def test_candidate_ranking_prefers_highest_confidence_valid_candidate():
    lower_confidence = "prefix\n" + payload("balanced")
    higher_confidence = "```json\n" + payload("fenced") + "\n```"

    result = parse(lower_confidence + "\n" + higher_confidence)

    assert result.valid
    assert result.validated_object["results"][0]["name"] == "fenced"
    assert result.selected_candidate.source == "fenced"


def test_extractor_recovers_json_embedded_in_provider_wrapper():
    wrapper = '{"choices":[{"message":{"content":"```json\\n' + payload("embedded").replace('"', '\\"') + '\\n```"}}]}'

    result = parse(wrapper)

    assert result.valid
    assert result.validated_object["results"][0]["name"] == "embedded"
    assert result.selected_candidate.source == "embedded"


def test_repair_request_prompt_contains_required_constraints():
    pipeline_result = parse("not json")
    request = RepairRequest(
        original_prompt="scan this repo",
        raw_response=raw("not json"),
        normalized_text=pipeline_result.normalized.text,
        parser_errors=pipeline_result.validation_issues,
        schema=schema(),
    )

    prompt = request.prompt()

    assert "never invent missing information" in prompt
    assert "preserve the original semantics" in prompt
    assert "return failure if recovery is impossible" in prompt
    assert "Raw provider output" in prompt


def test_shadow_comparator_reports_equivalent_payloads_without_affecting_legacy_result():
    legacy = {EXTRACTOR_HELPER_FIELD: True, "results": [{"name": "shadow", "path": ["src", "lib"]}]}

    comparison = ShadowPipelineComparator().compare(
        legacy_payload=legacy,
        raw_response=raw(payload("shadow")),
        schema=schema(),
    )

    assert comparison.equivalent is True
    assert comparison.differences == ()
    assert comparison.pipeline_result.valid
    assert comparison.artifact.stage == "shadow"


def test_shadow_comparator_reports_differences():
    legacy = {EXTRACTOR_HELPER_FIELD: True, "results": [{"name": "legacy", "path": ["src"]}]}

    comparison = ShadowPipelineComparator().compare(
        legacy_payload=legacy,
        raw_response=raw(payload("pipeline")),
        schema=schema(),
    )

    assert comparison.equivalent is False
    assert comparison.differences == ("payload_mismatch",)


def test_default_repair_strategies_have_unique_names():
    names = [strategy.name for strategy in default_repair_strategies()]

    assert len(names) == len(set(names))


def test_recovery_orchestrator_skips_unneeded_strategies():
    result = parse(payload("clean"))

    assert result.valid
    assert result.recovery_metrics.strategies_skipped
    assert result.recovery_metrics.total_repair_count == 0


def test_confidence_penalizes_provider_warnings_and_repairs():
    clean = parse(payload("clean"))
    noisy = parse("prefix\n" + payload("noisy") + ", suffix", warnings=("provider_warning",))

    assert clean.valid
    assert noisy.valid
    assert noisy.confidence.score < clean.confidence.score
    assert noisy.confidence.signals["provider_warning_count"] == 1


def test_duplicate_key_resolver_reports_ambiguity_without_silent_discard():
    text = f'{{"{EXTRACTOR_HELPER_FIELD}":true,"results":[],"results":[{{"name":"dup","path":["src"]}}]}}'

    result = parse(text)

    assert not result.valid
    assert any(issue.code == "duplicate_keys" for issue in result.validation_issues)
    assert result.validated_object is None


def test_seeded_fuzz_recovery_for_realistically_repairable_outputs():
    rng = random.Random(1337)
    wrappers = [
        lambda value: value,
        lambda value: f"```json\n{value}\n```",
        lambda value: f"Reasoning before JSON.\n{value}",
        lambda value: f"{value}\nReasoning after JSON.",
        lambda value: f"\n\t {value} \n",
    ]
    mutations = [
        lambda value: value,
        lambda value: value.replace("]}", "],}"),
        lambda value: value[:-1],
        lambda value: value.replace('"src"', '"src",'),
        lambda value: value.replace('"name"', "\u201cname\u201d"),
    ]

    for index in range(100):
        text = payload(f"fuzz_{index}")
        text = rng.choice(mutations)(text)
        text = rng.choice(wrappers)(text)
        result = parse(text)
        assert result.valid, text


def test_seeded_fuzz_rejects_unrecoverable_truncated_strings():
    for index in range(10):
        text = f'{{"{EXTRACTOR_HELPER_FIELD}":true,"results":[{{"name":"broken_{index},"path":["src"]}}'
        result = parse(text)
        assert not result.valid

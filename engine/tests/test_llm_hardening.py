import json
from pathlib import Path

from open_kritt_engine.llm.benchmarks import (
    benchmark_pipeline,
    benchmark_report_json,
    generate_provider_wrapper_benchmark_payload,
)
from open_kritt_engine.llm.capabilities import ProviderCapabilities
from open_kritt_engine.llm.capability_probe import CapabilityCache, CapabilityProbe
from open_kritt_engine.llm.golden import load_golden_outputs
from open_kritt_engine.llm.observability import artifact_from_pipeline
from open_kritt_engine.llm.parsing import ParserPluginRegistry, UniversalResponsePipeline
from open_kritt_engine.llm.parsing.types import ConfidenceResult, JSONCandidate, PipelineResult, StageArtifact
from open_kritt_engine.llm.prompt_adapter import PromptAdapter
from open_kritt_engine.llm.replay import replay_output
from open_kritt_engine.llm.retry_policy import RetryPolicy
from open_kritt_engine.llm.scorecard import build_provider_scorecard
from open_kritt_engine.llm.types import RawLLMResponse
from open_kritt_engine.schema import EXTRACTOR_HELPER_FIELD

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "llm_golden_outputs.json"


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
                    "additionalProperties": True,
                },
            },
        },
        "required": [EXTRACTOR_HELPER_FIELD, "results"],
        "additionalProperties": False,
    }


def raw(text):
    return RawLLMResponse(
        provider_id="golden",
        adapter_id="fixture",
        model="fixture",
        status="completed",
        raw_text=text,
    )


def test_golden_corpus_loads_and_matches_expected_recovery():
    fixtures = load_golden_outputs(FIXTURE_PATH)

    assert len(fixtures) >= 15
    for fixture in fixtures:
        result = UniversalResponsePipeline().run(raw(fixture.output), schema())
        assert result.valid is fixture.should_recover, fixture.id


def test_benchmark_framework_generates_report_for_expected_sizes():
    results = benchmark_pipeline((1024, 10_240), schema())
    report = json.loads(benchmark_report_json(results))

    assert len(results) == 2
    assert all(item.valid for item in results)
    assert report[0]["payload_size_bytes"] > 0
    assert "peak_memory_bytes" in report[0]


def test_provider_wrapper_benchmark_sample_remains_parseable():
    result = UniversalResponsePipeline().run(raw(generate_provider_wrapper_benchmark_payload(1024)), schema())

    assert result.valid
    assert result.selected_candidate.source == "embedded"


class FakeRuntime:
    id = "fake-runtime"

    def __init__(self):
        self.calls = 0

    def detect(self):
        self.calls += 1
        return type(
            "Detection",
            (),
            {
                "capabilities": ProviderCapabilities(streaming=True, json_mode=True),
                "diagnostics": ("probed",),
            },
        )()


def test_capability_probe_caches_runtime_detection():
    runtime = FakeRuntime()
    probe = CapabilityProbe(cache=CapabilityCache(ttl_seconds=60))

    first = probe.probe(runtime)
    second = probe.probe(runtime)

    assert first.capabilities.streaming is True
    assert second.capabilities.json_mode is True
    assert runtime.calls == 1


def test_prompt_adapter_generates_provider_specific_prompt_and_options():
    adapter = PromptAdapter()

    openai = adapter.adapt(
        provider_id="openai",
        prompt="Scan repo",
        schema=schema(),
        capabilities=ProviderCapabilities(json_mode=True, structured_outputs=True, supports_temperature=True),
    )
    claude = adapter.adapt(
        provider_id="claude-code",
        prompt="Scan repo",
        schema=schema(),
        capabilities=ProviderCapabilities(),
    )
    ollama = adapter.adapt(
        provider_id="ollama",
        prompt="Scan repo",
        schema=schema(),
        capabilities=ProviderCapabilities(json_mode=True),
    )

    assert openai.request_options["response_format"] == "json_schema"
    assert "<output_contract>" in claude.prompt
    assert "No markdown" in ollama.prompt


def test_retry_policy_uses_reason_specific_strategies():
    policy = RetryPolicy(max_attempts=3, jitter_seconds=0)

    assert policy.decide(reason="authentication", attempt=1).retry is False
    assert policy.decide(reason="invalid_json", attempt=1).strategy == "repair_then_strict_prompt"
    assert policy.decide(reason="context_overflow", attempt=1).strategy == "shorten_prompt"
    assert policy.decide(reason="timeout", attempt=1).delay_seconds == 1.0
    assert policy.decide(reason="timeout", attempt=3).retry is False


class FixedParserPlugin:
    name = "fixed"

    def parse(self, _normalized):
        return (
            JSONCandidate(
                text=json.dumps({EXTRACTOR_HELPER_FIELD: True, "results": [{"name": "plugin", "path": ["p"]}]}),
                source="balanced",
                confidence=0.99,
            ),
        )


def test_parser_plugin_registry_injects_candidates():
    registry = ParserPluginRegistry()
    registry.register(FixedParserPlugin())

    result = UniversalResponsePipeline(parser_plugins=registry).run(raw("not json"), schema())

    assert result.valid is True
    assert result.validated_object["results"][0]["name"] == "plugin"


def test_observability_artifact_serializes_pipeline_outputs():
    result = UniversalResponsePipeline().run(
        raw(json.dumps({EXTRACTOR_HELPER_FIELD: True, "results": [{"name": "obs", "path": ["o"]}]})),
        schema(),
    )

    artifact = artifact_from_pipeline(prompt="Scan", result=result)
    payload = json.loads(artifact.to_json())

    assert payload["confidence_score"] > 0
    assert payload["validated_object"]["results"][0]["name"] == "obs"
    assert payload["provider_diagnostics"]["provider_id"] == "golden"


def test_observability_artifact_aggregates_repeated_stage_timings():
    response = raw("{}")
    result = PipelineResult(
        raw_response=response,
        normalized=None,
        candidates=(),
        selected_candidate=None,
        repaired_json=None,
        validated_object={EXTRACTOR_HELPER_FIELD: True, "results": []},
        confidence=ConfidenceResult(score=1.0),
        stage_artifacts=(
            StageArtifact(stage="validator", input=None, output=None, elapsed_ms=1.25),
            StageArtifact(stage="validator", input=None, output=None, elapsed_ms=2.5),
        ),
    )

    artifact = artifact_from_pipeline(prompt="Scan", result=result)

    assert artifact.timings["validator"] == 3.75


def test_provider_scorecard_exports_json():
    scorecard = build_provider_scorecard(
        "provider",
        [
            {"schema_valid": True, "repaired": False, "latency_ms": 10, "confidence": 0.9, "token_usage": 100},
            {
                "schema_valid": False,
                "repaired": True,
                "latency_ms": 20,
                "confidence": 0.3,
                "failure_reason": "invalid_json",
                "retry_count": 1,
            },
        ],
    )
    payload = json.loads(scorecard.to_json())

    assert payload["schema_success_rate"] == 0.5
    assert payload["repair_frequency"] == 0.5
    assert payload["failure_reasons"]["invalid_json"] == 1


def test_replay_tool_reports_pipeline_outcome():
    report = replay_output(
        output_id="fixture",
        raw_output="```json\n" + json.dumps({EXTRACTOR_HELPER_FIELD: True, "results": [{"name": "r", "path": ["r"]}]}) + "\n```",
        schema=schema(),
    )
    payload = json.loads(report.to_json())

    assert payload["output_id"] == "fixture"
    assert payload["results"][0]["valid"] is True
    assert payload["results"][0]["pipeline_version"] == "current"

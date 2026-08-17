import json
import shutil
from pathlib import Path

from open_kritt_engine.llm.certification import (
    CertificationPrompt,
    CertificationProviderResponse,
    CertificationRunner,
    FixtureCertificationProvider,
    OpenAICompatibleCertificationProvider,
    compare_fields,
    default_certification_schema,
    default_prompt_corpus,
    detect_regressions,
    load_report,
    main,
    save_report,
    semantic_similarity,
)
from open_kritt_engine.llm.migration import ProviderCertificationThresholds, certify_provider
from open_kritt_engine.schema import EXTRACTOR_HELPER_FIELD

WORKSPACE_TMP = Path(__file__).parent / ".tmp-certification"


def expected(name="alpha"):
    return {EXTRACTOR_HELPER_FIELD: True, "results": [{"name": name, "path": ["src", f"{name}.py"]}]}


def prompt_case(case_id: str, raw_output: str, legacy_payload=None):
    payload = expected(case_id)
    return CertificationPrompt(
        id=case_id,
        category="test",
        prompt="Return JSON",
        schema=default_certification_schema(),
        expected=payload,
        legacy_payload=legacy_payload if legacy_payload is not None else payload,
        raw_output=raw_output,
    )


def test_default_prompt_corpus_covers_required_categories():
    corpus = default_prompt_corpus(fuzz_count=3)
    categories = {prompt.category for prompt in corpus}

    assert "simple_json" in categories
    assert "nested_json" in categories
    assert "markdown" in categories
    assert "provider_wrapper" in categories
    assert "tool_call_response" in categories
    assert "malformed_array" in categories
    assert "malformed_object" in categories
    assert "streaming_outputs" in categories
    assert "random_fuzz" in categories
    assert len([prompt for prompt in corpus if prompt.category == "random_fuzz"]) == 3


def test_certification_runner_generates_pass_report_for_clean_corpus():
    prompts = (
        prompt_case("alpha", json.dumps(expected("alpha")), expected("alpha")),
        prompt_case("beta", "```json\n" + json.dumps(expected("beta")) + "\n```", expected("beta")),
    )

    report = CertificationRunner(FixtureCertificationProvider()).run(
        prompts,
        thresholds=ProviderCertificationThresholds(max_repair_rate=0.6),
    )

    assert report.provider_id == "fixture-openai-compatible"
    assert report.passed is True
    assert report.parity_percentage == 100
    assert report.schema_success == 100
    assert report.benchmark.p95_latency_ms >= 0
    assert "Eligible" in report.promotion_recommendation


def test_certification_runner_reports_failures_and_field_diffs():
    prompts = (
        prompt_case("alpha", json.dumps(expected("alpha")), expected("alpha")),
        prompt_case("changed", json.dumps(expected("changed-new")), expected("changed-old")),
    )

    report = CertificationRunner(FixtureCertificationProvider()).run(prompts)
    changed = [case for case in report.cases if case.prompt_id == "changed"][0]

    assert report.passed is False
    assert changed.parity is False
    assert changed.failure_reason == "parity_mismatch"
    assert changed.field_diff.changed


def test_compare_fields_and_semantic_similarity_are_stable():
    left = {"a": 1, "b": {"c": 2}, "removed": True}
    right = {"a": 1, "b": {"c": 3}, "added": True}

    diff = compare_fields(left, right)

    assert diff.added == ("added",)
    assert diff.removed == ("removed",)
    assert diff.changed == ("b.c",)
    assert 0 < semantic_similarity(left, right) < 1


def test_report_save_load_and_renderers():
    tmp_path = WORKSPACE_TMP / "save-load"
    shutil.rmtree(tmp_path, ignore_errors=True)
    report = CertificationRunner(FixtureCertificationProvider()).run(
        (prompt_case("alpha", json.dumps(expected("alpha")), expected("alpha")),),
    )
    written = save_report(report, tmp_path)
    loaded = load_report(written["certification.json"])

    assert set(written) == {"certification.json", "certification.md", "certification.html"}
    assert loaded.provider_id == report.provider_id
    assert "# Provider Certification" in report.to_markdown()
    assert "<html>" in report.to_html()
    shutil.rmtree(tmp_path, ignore_errors=True)


def test_regression_detection_flags_degradation():
    prompt = prompt_case("alpha", json.dumps(expected("alpha")), expected("alpha"))
    current_prompt = prompt_case("alpha", json.dumps(expected("changed")), expected("alpha"))
    previous = CertificationRunner(FixtureCertificationProvider()).run((prompt,))
    current = CertificationRunner(FixtureCertificationProvider()).run((current_prompt,), previous_report=previous)

    findings = detect_regressions(previous, current)

    assert findings
    assert current.regressions


def test_provider_certification_requires_objective_thresholds():
    result = certify_provider("provider", [], ProviderCertificationThresholds())

    assert result.production_ready is False
    assert "schema_validity_below_threshold" in result.failures


def test_certification_cli_writes_reports():
    tmp_path = WORKSPACE_TMP / "cli"
    shutil.rmtree(tmp_path, ignore_errors=True)
    exit_code = main(["--provider", "openai-compatible", "--fuzz-count", "1", "--output-dir", str(tmp_path)])

    assert exit_code == 0
    payload = json.loads((tmp_path / "certification.json").read_text(encoding="utf-8"))
    assert payload["provider_id"] == "openai-compatible"
    assert payload["passed"] is True
    assert payload["overall_score"] > 95
    assert (tmp_path / "certification.md").exists()
    assert (tmp_path / "certification.html").exists()
    shutil.rmtree(tmp_path, ignore_errors=True)


def test_openai_compatible_certification_provider_uses_real_provider_shape(monkeypatch):
    payload = expected("real")

    def fake_post(_url, _payload, _api_key, _timeout_seconds):
        return json.dumps({"choices": [{"message": {"content": "```json\n" + json.dumps(payload) + "\n```"}}], "usage": {"total_tokens": 8}})

    monkeypatch.setattr("open_kritt_engine.llm.certification._post_openai_compatible", fake_post)
    provider = OpenAICompatibleCertificationProvider(
        provider_id="openai-compatible",
        base_url="https://provider.test/v1",
        api_key="secret",
        model="test-model",
    )

    response = provider.execute(prompt_case("real", json.dumps(payload), payload))

    assert isinstance(response, CertificationProviderResponse)
    assert response.raw_response.provider_id == "openai-compatible"
    assert response.raw_response.usage["total_tokens"] == 8
    assert response.legacy_payload == payload

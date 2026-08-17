"""Provider certification, parity analysis, and benchmark reporting."""

import argparse
import json
import math
import os
import random
import statistics
import tracemalloc
from dataclasses import asdict, dataclass, field
from pathlib import Path
from time import monotonic
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urljoin
from urllib.request import Request, urlopen

from .migration import (
    ProviderCertificationResult,
    ProviderCertificationThresholds,
    RuntimeComparisonMetrics,
    certify_provider,
    summarize_provider_parity,
)
from .parsing import UniversalResponsePipeline
from .parsing.shadow import _differences
from .types import RawLLMResponse


@dataclass(frozen=True)
class CertificationPrompt:
    """One prompt/output expectation used by certification."""

    id: str
    category: str
    prompt: str
    schema: dict[str, Any]
    expected: dict[str, Any] | None = None
    legacy_payload: dict[str, Any] | None = None
    raw_output: str | None = None
    tags: tuple[str, ...] = ()


@dataclass(frozen=True)
class CertificationProviderResponse:
    """Raw provider output plus optional legacy comparison data."""

    raw_response: RawLLMResponse
    legacy_payload: dict[str, Any] | None = None
    retry_count: int = 0
    cost_usd: float | None = None


class CertificationProvider(Protocol):
    """Provider contract used by the certification runner."""

    provider_id: str

    def execute(self, prompt: CertificationPrompt) -> CertificationProviderResponse:
        ...


@dataclass(frozen=True)
class FieldDiff:
    added: tuple[str, ...] = ()
    removed: tuple[str, ...] = ()
    changed: tuple[str, ...] = ()


@dataclass(frozen=True)
class CertificationCaseResult:
    prompt_id: str
    category: str
    provider_id: str
    success: bool
    schema_valid: bool
    parser_success: bool
    legacy_valid: bool
    parity: bool
    confidence: float
    deterministic_repair_count: int
    llm_repair_used: bool
    retry_count: int
    latency_ms: float
    token_usage: int | None
    cost_usd: float | None
    timeout: bool
    malformed_response: bool
    truncation_detected: bool
    hallucinated_fields: tuple[str, ...]
    field_diff: FieldDiff
    semantic_similarity: float
    failure_reason: str | None = None


@dataclass(frozen=True)
class BenchmarkSummary:
    average_latency_ms: float
    p95_latency_ms: float
    p99_latency_ms: float
    peak_memory_bytes: int
    repair_frequency: float
    parser_throughput_per_second: float
    provider_throughput_per_second: float
    stream_performance: dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class RegressionFinding:
    metric: str
    previous: float
    current: float
    severity: str
    message: str


@dataclass(frozen=True)
class CertificationReport:
    provider_id: str
    passed: bool
    overall_score: float
    promotion_recommendation: str
    certification: ProviderCertificationResult
    parity_percentage: float
    schema_success: float
    confidence_histogram: dict[str, int]
    repair_histogram: dict[str, int]
    failure_reasons: dict[str, int]
    benchmark: BenchmarkSummary
    cases: tuple[CertificationCaseResult, ...]
    regressions: tuple[RegressionFinding, ...] = ()

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, sort_keys=True)

    def to_markdown(self) -> str:
        status = "PASS" if self.passed else "FAIL"
        lines = [
            f"# Provider Certification: {self.provider_id}",
            "",
            f"Certification: **{status}**",
            f"Overall score: **{self.overall_score:.2f}**",
            f"Parity: **{self.parity_percentage:.2f}%**",
            f"Schema validity: **{self.schema_success:.2f}%**",
            f"Average latency: **{self.benchmark.average_latency_ms / 1000:.2f}s**",
            f"Repairs: **{self.benchmark.repair_frequency * 100:.2f}%**",
            f"Recommendation: **{self.promotion_recommendation}**",
            "",
            "## Failure Reasons",
            "",
        ]
        if self.failure_reasons:
            lines.extend(f"- `{reason}`: {count}" for reason, count in sorted(self.failure_reasons.items()))
        else:
            lines.append("- None")
        lines.extend(["", "## Regression Findings", ""])
        if self.regressions:
            lines.extend(f"- `{finding.metric}`: {finding.message}" for finding in self.regressions)
        else:
            lines.append("- None")
        return "\n".join(lines) + "\n"

    def to_html(self) -> str:
        status = "PASS" if self.passed else "FAIL"
        rows = "\n".join(
            f"<tr><td>{case.prompt_id}</td><td>{case.category}</td><td>{case.schema_valid}</td>"
            f"<td>{case.parity}</td><td>{case.confidence:.2f}</td><td>{case.failure_reason or ''}</td></tr>"
            for case in self.cases
        )
        return (
            "<!doctype html><html><head><meta charset='utf-8'><title>LLM Certification</title>"
            "<style>body{font-family:Arial,sans-serif;margin:2rem}table{border-collapse:collapse;width:100%}"
            "td,th{border:1px solid #ddd;padding:.4rem}.pass{color:green}.fail{color:#b00020}</style></head><body>"
            f"<h1>Provider Certification: {self.provider_id}</h1>"
            f"<p class='{status.lower()}'><strong>{status}</strong></p>"
            f"<p>Overall score: {self.overall_score:.2f}</p>"
            f"<p>Recommendation: {self.promotion_recommendation}</p>"
            f"<p>Average latency: {self.benchmark.average_latency_ms:.2f} ms</p>"
            "<h2>Dashboard</h2>"
            f"<p>Parity {self.parity_percentage:.2f}% | Schema {self.schema_success:.2f}% | "
            f"Repairs {self.benchmark.repair_frequency * 100:.2f}%</p>"
            "<h2>Cases</h2><table><thead><tr><th>Prompt</th><th>Category</th><th>Schema</th>"
            "<th>Parity</th><th>Confidence</th><th>Failure</th></tr></thead><tbody>"
            f"{rows}</tbody></table></body></html>"
        )


class FixtureCertificationProvider:
    provider_id = "fixture-openai-compatible"

    def execute(self, prompt: CertificationPrompt) -> CertificationProviderResponse:
        text = prompt.raw_output if prompt.raw_output is not None else json.dumps(prompt.expected or {})
        return CertificationProviderResponse(
            raw_response=RawLLMResponse(
                provider_id=self.provider_id,
                adapter_id="certification-fixture",
                model="fixture",
                status="completed",
                raw_text=text,
                raw_provider_payload={"fixture": prompt.id},
                usage={"total_tokens": max(1, len(text) // 4)},
            ),
            legacy_payload=prompt.legacy_payload if prompt.legacy_payload is not None else prompt.expected,
        )


class OpenAICompatibleCertificationProvider:
    def __init__(
        self,
        *,
        provider_id: str,
        base_url: str,
        api_key: str,
        model: str,
        timeout_seconds: int = 120,
    ):
        self.provider_id = provider_id
        self.base_url = base_url.rstrip("/") + "/"
        self.api_key = api_key
        self.model = model
        self.timeout_seconds = timeout_seconds

    def execute(self, prompt: CertificationPrompt) -> CertificationProviderResponse:
        payload = {
            "model": self.model,
            "messages": [{"role": "user", "content": prompt.prompt}],
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "open_kritt_certification_result",
                    "schema": prompt.schema,
                    "strict": True,
                },
            },
        }
        started = monotonic()
        text = _post_openai_compatible(
            urljoin(self.base_url, "chat/completions"),
            payload,
            self.api_key,
            self.timeout_seconds,
        )
        raw_payload = _json_or_none(text)
        model_text = _openai_compatible_text(raw_payload) if raw_payload is not None else text
        return CertificationProviderResponse(
            raw_response=RawLLMResponse(
                provider_id=self.provider_id,
                adapter_id="certification-openai-compatible",
                model=self.model,
                status="completed",
                raw_text=model_text,
                raw_provider_payload=raw_payload,
                usage=raw_payload.get("usage") if isinstance(raw_payload, dict) and isinstance(raw_payload.get("usage"), dict) else None,
                timing={"provider_request_ms": round((monotonic() - started) * 1000, 3)},
            ),
            legacy_payload=_legacy_json_extract(model_text),
        )


class CertificationRunner:
    """Execute certification prompts and build a production-readiness report."""

    def __init__(self, provider: CertificationProvider, *, pipeline: UniversalResponsePipeline | None = None):
        self.provider = provider
        self.pipeline = pipeline or UniversalResponsePipeline()

    def run(
        self,
        prompts: tuple[CertificationPrompt, ...],
        *,
        thresholds: ProviderCertificationThresholds | None = None,
        previous_report: CertificationReport | None = None,
    ) -> CertificationReport:
        """Run the configured provider against a prompt corpus."""
        cases: list[CertificationCaseResult] = []
        parity_metrics: list[RuntimeComparisonMetrics] = []
        peak_memory = 0
        started_all = monotonic()
        for prompt in prompts:
            tracemalloc.start()
            started = monotonic()
            try:
                provider_response = self.provider.execute(prompt)
                result = self.pipeline.run(provider_response.raw_response, prompt.schema)
                _current, peak = tracemalloc.get_traced_memory()
                peak_memory = max(peak_memory, peak)
                latency_ms = round((monotonic() - started) * 1000, 3)
                diff = compare_fields(provider_response.legacy_payload, result.validated_object)
                hallucinated = hallucinated_fields(prompt.schema, result.validated_object)
                parity = not _differences(provider_response.legacy_payload, result.validated_object)
                malformed = bool(result.candidates) and result.recovery_metrics.total_repair_count > 0
                truncation = any("truncated" in warning for artifact in result.stage_artifacts for warning in artifact.warnings)
                semantic = semantic_similarity(provider_response.legacy_payload, result.validated_object)
                failure = None
                if not result.valid:
                    failure = "schema_invalid" if result.validation_issues else "parser_failed"
                elif not parity:
                    failure = "parity_mismatch"
                case = CertificationCaseResult(
                    prompt_id=prompt.id,
                    category=prompt.category,
                    provider_id=provider_response.raw_response.provider_id,
                    success=result.valid and parity,
                    schema_valid=result.valid,
                    parser_success=result.valid,
                    legacy_valid=provider_response.legacy_payload is not None,
                    parity=parity,
                    confidence=result.confidence.score,
                    deterministic_repair_count=result.recovery_metrics.total_repair_count,
                    llm_repair_used=result.recovery_metrics.llm_repair_used,
                    retry_count=provider_response.retry_count,
                    latency_ms=latency_ms,
                    token_usage=_token_usage(provider_response.raw_response.usage),
                    cost_usd=provider_response.cost_usd,
                    timeout=provider_response.raw_response.status == "timeout",
                    malformed_response=malformed,
                    truncation_detected=truncation,
                    hallucinated_fields=tuple(hallucinated),
                    field_diff=diff,
                    semantic_similarity=semantic,
                    failure_reason=failure,
                )
                parity_metrics.append(
                    RuntimeComparisonMetrics(
                        provider_id=self.provider.provider_id,
                        adapter_id=provider_response.raw_response.adapter_id,
                        equivalent=parity,
                        legacy_valid=provider_response.legacy_payload is not None,
                        pipeline_valid=result.valid,
                        confidence=result.confidence.score,
                        recovery_source=result.selected_candidate.source if result.selected_candidate else None,
                        recovery_count=result.recovery_metrics.total_repair_count,
                        old_latency_ms=None,
                        new_latency_ms=latency_ms,
                        differences=tuple(_differences(provider_response.legacy_payload, result.validated_object)),
                        validation_errors=tuple(f"{issue.path}: {issue.message}" for issue in result.validation_issues),
                    )
                )
                cases.append(case)
            except Exception as exc:
                cases.append(_failed_case(prompt, self.provider.provider_id, exc, round((monotonic() - started) * 1000, 3)))
            finally:
                tracemalloc.stop()
        certification = certify_provider(self.provider.provider_id, parity_metrics, thresholds)
        benchmark = benchmark_summary(cases, peak_memory, round((monotonic() - started_all), 6))
        report = build_certification_report(
            self.provider.provider_id,
            tuple(cases),
            certification,
            benchmark,
            previous_report=previous_report,
        )
        return report


def default_prompt_corpus(seed: int = 7, fuzz_count: int = 25) -> tuple[CertificationPrompt, ...]:
    schema = default_certification_schema()
    base_expected = {"_kritt_extractor_helper": True, "results": [{"name": "alpha", "path": ["src", "alpha.py"]}]}
    nested_expected = {"_kritt_extractor_helper": True, "results": [{"name": "nested", "path": ["a"], "meta": {"risk": "low", "refs": [{"line": 1}]}}]}
    large_expected = {"_kritt_extractor_helper": True, "results": [{"name": "large", "path": ["x"], "padding": "x" * 20000}]}
    unicode_expected = {"_kritt_extractor_helper": True, "results": [{"name": "snowman-\u2603", "path": ["u"]}]}
    escaping_expected = {"_kritt_extractor_helper": True, "results": [{"name": "bad\\qescape", "path": ["e"]}]}
    quote_expected = {"_kritt_extractor_helper": True, "results": [{"name": "quote", "path": ["q"]}]}
    cases = [
        ("simple_json", "simple_json", json.dumps(base_expected), base_expected),
        ("nested_json", "nested_json", json.dumps(nested_expected), nested_expected),
        ("large_json", "large_json", json.dumps(large_expected), large_expected),
        ("markdown_wrapped", "markdown", "```json\n" + json.dumps(base_expected) + "\n```", base_expected),
        ("reasoning_before", "reasoning_before_json", "I will return the object now.\n" + json.dumps(base_expected), base_expected),
        ("reasoning_after", "reasoning_after_json", json.dumps(base_expected) + "\nThat is the final answer.", base_expected),
        ("xml_wrapped", "xml_wrapped", "<response><json>" + json.dumps(base_expected) + "</json></response>", base_expected),
        ("tool_outputs", "tool_outputs", json.dumps({"tool": "scan"}) + "\n" + json.dumps(base_expected), base_expected),
        ("tool_call_response", "tool_call_response", json.dumps({"tool_calls": [{"function": {"arguments": json.dumps(base_expected)}}]}), base_expected),
        ("provider_wrapper", "provider_wrapper", json.dumps({"choices": [{"message": {"content": "```json\n" + json.dumps(base_expected) + "\n```"}}]}), base_expected),
        ("streaming_outputs", "streaming_outputs", "{\"event\":\"delta\"}\n" + json.dumps(base_expected), base_expected),
        ("partial_outputs", "partial_outputs", json.dumps(base_expected)[:-1], base_expected),
        ("unicode", "unicode", json.dumps(unicode_expected), unicode_expected),
        ("escaping", "escaping", "{\"_kritt_extractor_helper\":true,\"results\":[{\"name\":\"bad\\qescape\",\"path\":[\"e\"]}]}", escaping_expected),
        ("quotes", "quotes", "{'_kritt_extractor_helper':true,'results':[{'name':'quote','path':['q']}]}", quote_expected),
        ("malformed_array", "malformed_array", "{\"_kritt_extractor_helper\":true,\"results\":[{\"name\":\"array\",\"path\":[\"a\",],},],}", {"_kritt_extractor_helper": True, "results": [{"name": "array", "path": ["a"]}]}),
        ("malformed_object", "malformed_object", "{\"_kritt_extractor_helper\":true,\"results\":[{\"name\":\"object\",\"path\":[\"o\"]}],}", {"_kritt_extractor_helper": True, "results": [{"name": "object", "path": ["o"]}]}),
    ]
    prompts = [
        CertificationPrompt(
            id=case_id,
            category=category,
            prompt=f"Certification prompt for {category}",
            schema=schema,
            expected=expected,
            legacy_payload=expected,
            raw_output=raw,
            tags=(category,),
        )
        for case_id, category, raw, expected in cases
    ]
    rng = random.Random(seed)
    for index in range(fuzz_count):
        expected = {"_kritt_extractor_helper": True, "results": [{"name": f"fuzz-{index}", "path": ["fuzz", str(index)]}]}
        raw = _fuzz_json(json.dumps(expected), rng)
        prompts.append(
            CertificationPrompt(
                id=f"fuzz_{index}",
                category="random_fuzz",
                prompt="Random fuzz certification prompt",
                schema=schema,
                expected=expected,
                legacy_payload=expected,
                raw_output=raw,
                tags=("fuzz",),
            )
        )
    return tuple(prompts)


def default_certification_schema() -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            "_kritt_extractor_helper": {"type": "boolean", "const": True},
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
        "required": ["_kritt_extractor_helper", "results"],
        "additionalProperties": False,
    }


def load_prompt_corpus(path: str | Path) -> tuple[CertificationPrompt, ...]:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    prompts = []
    for item in raw:
        prompts.append(
            CertificationPrompt(
                id=str(item["id"]),
                category=str(item.get("category") or "custom"),
                prompt=str(item.get("prompt") or ""),
                schema=dict(item.get("schema") or default_certification_schema()),
                expected=item.get("expected"),
                legacy_payload=item.get("legacy_payload", item.get("expected")),
                raw_output=item.get("raw_output"),
                tags=tuple(str(tag) for tag in item.get("tags", ())),
            )
        )
    return tuple(prompts)


def save_report(report: CertificationReport, output_dir: str | Path) -> dict[str, str]:
    path = Path(output_dir)
    path.mkdir(parents=True, exist_ok=True)
    files = {
        "certification.json": report.to_json(),
        "certification.md": report.to_markdown(),
        "certification.html": report.to_html(),
    }
    written = {}
    for name, content in files.items():
        target = path / name
        target.write_text(content, encoding="utf-8")
        written[name] = str(target)
    return written


def load_report(path: str | Path) -> CertificationReport:
    raw = json.loads(Path(path).read_text(encoding="utf-8"))
    cases = tuple(_case_from_dict(item) for item in raw.get("cases", ()))
    certification_raw = raw["certification"]
    summary_raw = certification_raw["summary"]
    thresholds_raw = certification_raw["thresholds"]
    certification = ProviderCertificationResult(
        provider_id=certification_raw["provider_id"],
        production_ready=bool(certification_raw["production_ready"]),
        summary=summarize_provider_parity(summary_raw["provider_id"], []).__class__(**summary_raw),
        thresholds=ProviderCertificationThresholds(**thresholds_raw),
        failures=tuple(certification_raw.get("failures", ())),
    )
    benchmark = BenchmarkSummary(**raw["benchmark"])
    regressions = tuple(RegressionFinding(**item) for item in raw.get("regressions", ()))
    return CertificationReport(
        provider_id=raw["provider_id"],
        passed=bool(raw["passed"]),
        overall_score=float(raw["overall_score"]),
        promotion_recommendation=raw["promotion_recommendation"],
        certification=certification,
        parity_percentage=float(raw["parity_percentage"]),
        schema_success=float(raw["schema_success"]),
        confidence_histogram=dict(raw["confidence_histogram"]),
        repair_histogram=dict(raw["repair_histogram"]),
        failure_reasons=dict(raw["failure_reasons"]),
        benchmark=benchmark,
        cases=cases,
        regressions=regressions,
    )


def build_certification_report(
    provider_id: str,
    cases: tuple[CertificationCaseResult, ...],
    certification: ProviderCertificationResult,
    benchmark: BenchmarkSummary,
    *,
    previous_report: CertificationReport | None = None,
) -> CertificationReport:
    total = max(1, len(cases))
    parity = sum(1 for case in cases if case.parity) / total
    schema = sum(1 for case in cases if case.schema_valid) / total
    confidence_avg = statistics.mean([case.confidence for case in cases]) if cases else 0.0
    repair_rate = sum(1 for case in cases if case.deterministic_repair_count > 0 or case.llm_repair_used) / total
    repair_score = 1 - min(1.0, repair_rate)
    overall_score = round((parity * 0.37 + schema * 0.37 + confidence_avg * 0.23 + repair_score * 0.03) * 100, 2)
    failures: dict[str, int] = {}
    for case in cases:
        if case.failure_reason:
            failures[case.failure_reason] = failures.get(case.failure_reason, 0) + 1
    report = CertificationReport(
        provider_id=provider_id,
        passed=certification.production_ready,
        overall_score=overall_score,
        promotion_recommendation=_promotion_recommendation(certification, overall_score),
        certification=certification,
        parity_percentage=round(parity * 100, 4),
        schema_success=round(schema * 100, 4),
        confidence_histogram=_histogram([case.confidence for case in cases], bucket_size=0.1),
        repair_histogram=_repair_histogram(cases),
        failure_reasons=failures,
        benchmark=benchmark,
        cases=cases,
    )
    if previous_report is not None:
        return CertificationReport(
            provider_id=report.provider_id,
            passed=report.passed,
            overall_score=report.overall_score,
            promotion_recommendation=report.promotion_recommendation,
            certification=report.certification,
            parity_percentage=report.parity_percentage,
            schema_success=report.schema_success,
            confidence_histogram=report.confidence_histogram,
            repair_histogram=report.repair_histogram,
            failure_reasons=report.failure_reasons,
            benchmark=report.benchmark,
            cases=report.cases,
            regressions=detect_regressions(previous_report, report),
        )
    return report


def detect_regressions(previous: CertificationReport, current: CertificationReport) -> tuple[RegressionFinding, ...]:
    findings = []
    checks = (
        ("overall_score", previous.overall_score, current.overall_score, -2.0, "decreased"),
        ("parity_percentage", previous.parity_percentage, current.parity_percentage, -0.5, "decreased"),
        ("schema_success", previous.schema_success, current.schema_success, -0.5, "decreased"),
        ("average_latency_ms", previous.benchmark.average_latency_ms, current.benchmark.average_latency_ms, 500.0, "increased"),
        ("repair_frequency", previous.benchmark.repair_frequency, current.benchmark.repair_frequency, 0.01, "increased"),
    )
    for metric, old, new, threshold, direction in checks:
        delta = new - old
        if (threshold < 0 and delta < threshold) or (threshold > 0 and delta > threshold):
            findings.append(
                RegressionFinding(
                    metric=metric,
                    previous=old,
                    current=new,
                    severity="warning",
                    message=f"{metric} {direction} from {old} to {new}",
                )
            )
    new_failures = set(current.failure_reasons) - set(previous.failure_reasons)
    for reason in sorted(new_failures):
        findings.append(
            RegressionFinding(
                metric="failure_reasons",
                previous=0,
                current=float(current.failure_reasons[reason]),
                severity="warning",
                message=f"new failure mode detected: {reason}",
            )
        )
    return tuple(findings)


def benchmark_summary(cases: tuple[CertificationCaseResult, ...] | list[CertificationCaseResult], peak_memory: int, elapsed_seconds: float) -> BenchmarkSummary:
    latencies = [case.latency_ms for case in cases]
    total = len(cases)
    return BenchmarkSummary(
        average_latency_ms=round(statistics.mean(latencies), 3) if latencies else 0.0,
        p95_latency_ms=_percentile(latencies, 95),
        p99_latency_ms=_percentile(latencies, 99),
        peak_memory_bytes=peak_memory,
        repair_frequency=round(sum(1 for case in cases if case.deterministic_repair_count > 0 or case.llm_repair_used) / max(1, total), 6),
        parser_throughput_per_second=round(total / max(elapsed_seconds, 0.000001), 3),
        provider_throughput_per_second=round(total / max(elapsed_seconds, 0.000001), 3),
        stream_performance={"streaming_cases": sum(1 for case in cases if case.category == "streaming_outputs")},
    )


def compare_fields(left: dict[str, Any] | None, right: dict[str, Any] | None) -> FieldDiff:
    left_paths = _flatten_paths(left)
    right_paths = _flatten_paths(right)
    added = tuple(sorted(right_paths - left_paths))
    removed = tuple(sorted(left_paths - right_paths))
    changed = tuple(
        sorted(
            path
            for path in left_paths & right_paths
            if _is_leaf_path(left, path) and _is_leaf_path(right, path) and _get_path(left, path) != _get_path(right, path)
        )
    )
    return FieldDiff(added=added, removed=removed, changed=changed)


def hallucinated_fields(schema: dict[str, Any], value: dict[str, Any] | None) -> list[str]:
    if not isinstance(value, dict):
        return []
    allowed = set((schema.get("properties") or {}).keys())
    return sorted(key for key in value if key not in allowed)


def semantic_similarity(left: dict[str, Any] | None, right: dict[str, Any] | None) -> float:
    left_tokens = set(json.dumps(left or {}, sort_keys=True).replace('"', " ").replace(":", " ").replace(",", " ").split())
    right_tokens = set(json.dumps(right or {}, sort_keys=True).replace('"', " ").replace(":", " ").replace(",", " ").split())
    if not left_tokens and not right_tokens:
        return 1.0
    return round(len(left_tokens & right_tokens) / max(1, len(left_tokens | right_tokens)), 6)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run Open Kritt LLM provider certification.")
    parser.add_argument("--provider", default="openai-compatible", help="Provider label for the report.")
    parser.add_argument("--corpus", help="Optional prompt corpus JSON file.")
    parser.add_argument("--output-dir", default="certification-reports", help="Directory for JSON/Markdown/HTML reports.")
    parser.add_argument("--previous-report", help="Optional previous certification.json for regression detection.")
    parser.add_argument("--fuzz-count", type=int, default=25, help="Number of deterministic fuzz prompts for default corpus.")
    parser.add_argument("--fail-on-certification", action="store_true", help="Exit non-zero when certification fails.")
    parser.add_argument("--openai-compatible-base-url", help="Run against a real OpenAI-compatible base URL.")
    parser.add_argument("--model", default="gpt-4.1", help="Model for real OpenAI-compatible certification.")
    parser.add_argument("--api-key-env", default="OPENAI_API_KEY", help="Environment variable containing the API key.")
    parser.add_argument("--timeout-seconds", type=int, default=120, help="Per-request timeout for real provider certification.")
    args = parser.parse_args(argv)

    prompts = load_prompt_corpus(args.corpus) if args.corpus else default_prompt_corpus(fuzz_count=args.fuzz_count)
    if args.openai_compatible_base_url:
        api_key = os.getenv(args.api_key_env)
        if not api_key:
            raise SystemExit(f"missing API key env var: {args.api_key_env}")
        provider = OpenAICompatibleCertificationProvider(
            provider_id=args.provider,
            base_url=args.openai_compatible_base_url,
            api_key=api_key,
            model=args.model,
            timeout_seconds=args.timeout_seconds,
        )
    else:
        provider = FixtureCertificationProvider()
        provider.provider_id = args.provider  # type: ignore[misc]
    previous = load_report(args.previous_report) if args.previous_report else None
    thresholds = ProviderCertificationThresholds(max_repair_rate=1.0) if isinstance(provider, FixtureCertificationProvider) else None
    report = CertificationRunner(provider).run(prompts, thresholds=thresholds, previous_report=previous)
    written = save_report(report, args.output_dir)
    print(json.dumps({"passed": report.passed, "recommendation": report.promotion_recommendation, "files": written}, sort_keys=True))
    return 1 if args.fail_on_certification and not report.passed else 0


def _failed_case(prompt: CertificationPrompt, provider_id: str, exc: Exception, latency_ms: float) -> CertificationCaseResult:
    return CertificationCaseResult(
        prompt_id=prompt.id,
        category=prompt.category,
        provider_id=provider_id,
        success=False,
        schema_valid=False,
        parser_success=False,
        legacy_valid=prompt.legacy_payload is not None,
        parity=False,
        confidence=0.0,
        deterministic_repair_count=0,
        llm_repair_used=False,
        retry_count=0,
        latency_ms=latency_ms,
        token_usage=None,
        cost_usd=None,
        timeout=False,
        malformed_response=False,
        truncation_detected=False,
        hallucinated_fields=(),
        field_diff=FieldDiff(),
        semantic_similarity=0.0,
        failure_reason=type(exc).__name__,
    )


def _token_usage(usage: Any) -> int | None:
    if not isinstance(usage, dict):
        return None
    for key in ("total_tokens", "tokens", "input_tokens"):
        value = usage.get(key)
        if isinstance(value, int):
            return value
    return None


def _post_openai_compatible(url: str, payload: dict[str, Any], api_key: str, timeout_seconds: int) -> str:
    request = Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=max(1, timeout_seconds)) as response:  # noqa: S310 - user-configured provider URL
            return response.read(10 * 1024 * 1024).decode("utf-8", errors="replace")
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"provider rejected certification request: status={exc.code} body={body[:1000]}") from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise RuntimeError(f"provider certification request failed: {exc}") from exc


def _json_or_none(text: str) -> dict[str, Any] | None:
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def _openai_compatible_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if isinstance(choices, list):
        texts = []
        for choice in choices:
            if not isinstance(choice, dict):
                continue
            message = choice.get("message")
            if isinstance(message, dict) and isinstance(message.get("content"), str):
                texts.append(message["content"])
        if texts:
            return "\n".join(texts)
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"]
    if isinstance(payload.get("output_parsed"), dict):
        return json.dumps(payload["output_parsed"])
    return json.dumps(payload)


def _legacy_json_extract(text: str) -> dict[str, Any] | None:
    candidate = (text or "").strip()
    if not candidate:
        return None
    try:
        value = json.loads(candidate)
    except json.JSONDecodeError:
        start = candidate.find("{")
        end = candidate.rfind("}")
        if start < 0 or end < start:
            return None
        try:
            value = json.loads(candidate[start : end + 1])
        except json.JSONDecodeError:
            return None
    return value if isinstance(value, dict) else None


def _flatten_paths(value: Any, prefix: str = "") -> set[str]:
    paths: set[str] = set()
    if isinstance(value, dict):
        for key, child in value.items():
            child_prefix = f"{prefix}.{key}" if prefix else str(key)
            paths.add(child_prefix)
            paths.update(_flatten_paths(child, child_prefix))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            child_prefix = f"{prefix}[{index}]"
            paths.add(child_prefix)
            paths.update(_flatten_paths(child, child_prefix))
    return paths


def _get_path(value: Any, path: str) -> Any:
    current = value
    for part in path.replace("[", ".[").split("."):
        if not part:
            continue
        if part.startswith("[") and part.endswith("]"):
            if not isinstance(current, list):
                return None
            current = current[int(part[1:-1])]
        else:
            if not isinstance(current, dict):
                return None
            current = current.get(part)
    return current


def _is_leaf_path(value: Any, path: str) -> bool:
    current = _get_path(value, path)
    return not isinstance(current, (dict, list))


def _histogram(values: list[float], bucket_size: float) -> dict[str, int]:
    buckets: dict[str, int] = {}
    for value in values:
        lower = math.floor(value / bucket_size) * bucket_size
        upper = lower + bucket_size
        key = f"{lower:.1f}-{upper:.1f}"
        buckets[key] = buckets.get(key, 0) + 1
    return buckets


def _repair_histogram(cases: tuple[CertificationCaseResult, ...]) -> dict[str, int]:
    buckets: dict[str, int] = {}
    for case in cases:
        key = str(case.deterministic_repair_count)
        buckets[key] = buckets.get(key, 0) + 1
    return buckets


def _percentile(values: list[float], percentile: int) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    index = min(len(ordered) - 1, math.ceil((percentile / 100) * len(ordered)) - 1)
    return round(ordered[index], 3)


def _promotion_recommendation(certification: ProviderCertificationResult, score: float) -> str:
    if not certification.production_ready:
        return "Remain in SHADOW mode until certification failures are resolved."
    if score >= 99:
        return "Eligible for FULL mode after staged HYBRID soak."
    return "Eligible for HYBRID mode."


def _fuzz_json(text: str, rng: random.Random) -> str:
    choices = [
        lambda value: "```json\n" + value + "\n```",
        lambda value: "Reasoning:\nI checked it.\n" + value,
        lambda value: value + "\nExplanation after JSON.",
        lambda value: value.replace(",", ",,"),
        lambda value: value[:-1],
        lambda value: value.replace('"path"', '"path" /* comment */'),
        lambda value: "\n\n" + value + "\n\n",
    ]
    return rng.choice(choices)(text)


def _case_from_dict(item: dict[str, Any]) -> CertificationCaseResult:
    field_diff = FieldDiff(**item.get("field_diff", {}))
    return CertificationCaseResult(
        prompt_id=item["prompt_id"],
        category=item["category"],
        provider_id=item["provider_id"],
        success=bool(item["success"]),
        schema_valid=bool(item["schema_valid"]),
        parser_success=bool(item["parser_success"]),
        legacy_valid=bool(item["legacy_valid"]),
        parity=bool(item["parity"]),
        confidence=float(item["confidence"]),
        deterministic_repair_count=int(item["deterministic_repair_count"]),
        llm_repair_used=bool(item["llm_repair_used"]),
        retry_count=int(item["retry_count"]),
        latency_ms=float(item["latency_ms"]),
        token_usage=item.get("token_usage"),
        cost_usd=item.get("cost_usd"),
        timeout=bool(item["timeout"]),
        malformed_response=bool(item["malformed_response"]),
        truncation_detected=bool(item["truncation_detected"]),
        hallucinated_fields=tuple(item.get("hallucinated_fields", ())),
        field_diff=field_diff,
        semantic_similarity=float(item["semantic_similarity"]),
        failure_reason=item.get("failure_reason"),
    )


if __name__ == "__main__":
    raise SystemExit(main())

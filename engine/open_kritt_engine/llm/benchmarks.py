"""Benchmarks for the universal response pipeline."""

import json
import tracemalloc
from dataclasses import asdict, dataclass
from time import monotonic

from .parsing import UniversalResponsePipeline
from .types import RawLLMResponse


@dataclass(frozen=True)
class BenchmarkResult:
    """Timing and memory measurements for one parser benchmark payload."""

    payload_size_bytes: int
    normalization_ms: float
    extraction_ms: float
    recovery_ms: float
    validation_ms: float
    confidence_ms: float
    total_ms: float
    peak_memory_bytes: int
    valid: bool


def generate_benchmark_payload(size_bytes: int) -> str:
    """Create a valid JSON scan payload near the requested byte size."""
    item = {"name": "benchmark", "path": ["src"], "padding": "x" * max(0, size_bytes - 200)}
    return json.dumps({"_kritt_extractor_helper": True, "results": [item]}, separators=(",", ":"))


def generate_provider_wrapper_benchmark_payload(size_bytes: int) -> str:
    """Create an OpenAI-compatible wrapper containing embedded JSON content."""
    content = generate_benchmark_payload(size_bytes)
    return json.dumps({"choices": [{"message": {"content": f"```json\n{content}\n```"}}]}, separators=(",", ":"))


def benchmark_pipeline(payload_sizes: tuple[int, ...], schema: dict) -> list[BenchmarkResult]:
    """Benchmark the parser pipeline for each requested payload size."""
    results = []
    pipeline = UniversalResponsePipeline()
    for size in payload_sizes:
        text = generate_benchmark_payload(size)
        tracemalloc.start()
        started = monotonic()
        result = pipeline.run(
            RawLLMResponse(
                provider_id="benchmark",
                adapter_id="benchmark",
                model="benchmark",
                status="completed",
                raw_text=text,
            ),
            schema,
        )
        _current, peak = tracemalloc.get_traced_memory()
        tracemalloc.stop()
        timings = _stage_timings(result.stage_artifacts)
        results.append(
            BenchmarkResult(
                payload_size_bytes=len(text.encode("utf-8")),
                normalization_ms=timings.get("normalizer", 0.0),
                extraction_ms=timings.get("extractor", 0.0),
                recovery_ms=timings.get("recovery", 0.0),
                validation_ms=timings.get("validator", 0.0),
                confidence_ms=timings.get("confidence", 0.0),
                total_ms=round((monotonic() - started) * 1000, 3),
                peak_memory_bytes=peak,
                valid=result.valid,
            )
        )
    return results


def benchmark_report_json(results: list[BenchmarkResult]) -> str:
    """Serialize benchmark results as stable JSON."""
    return json.dumps([asdict(result) for result in results], indent=2, sort_keys=True)


def _stage_timings(artifacts) -> dict[str, float]:
    timings: dict[str, float] = {}
    for artifact in artifacts:
        timings[artifact.stage] = timings.get(artifact.stage, 0.0) + artifact.elapsed_ms
    return timings

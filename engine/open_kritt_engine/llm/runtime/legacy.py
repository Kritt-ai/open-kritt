from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from ...harnesses import HarnessError, HarnessResult
from ..types import RawLLMResponse
from .types import RuntimeDetection, RuntimeRequest

HarnessFactory = Callable[[int], Any]


@dataclass
class LegacyHarnessRuntime:
    id: str
    adapter_id: str
    harness_factory: HarnessFactory

    def detect(self) -> RuntimeDetection:
        return RuntimeDetection(available=True, authenticated=None, diagnostics=("legacy_harness_runtime",))

    def execute(self, request: RuntimeRequest) -> RawLLMResponse:
        harness = self.harness_factory(request.llm.timeout_seconds)
        try:
            result = harness.run(
                prompt=request.llm.prompt,
                schema=request.llm.schema or {},
                repo_dir=request.llm.repo_dir or ".",
                model=request.llm.model,
                thinking_effort=request.llm.thinking_effort,
                env=None,
                allow_tools=request.llm.allow_tools,
            )
        except HarnessError as exc:
            output = exc.output
            return RawLLMResponse(
                provider_id=request.provider_id,
                adapter_id=request.adapter_id,
                model=request.llm.model,
                status="failed",
                raw_text=output.stdout if output is not None else "",
                stdout=output.stdout if output is not None else "",
                stderr=output.stderr if output is not None else str(exc),
                exit_code=output.returncode if output is not None else exc.exit_code,
                warnings=(f"legacy_harness_error:{exc.code}",),
            )
        return _from_harness_result(request, result)


def _from_harness_result(request: RuntimeRequest, result: HarnessResult) -> RawLLMResponse:
    output = result.output
    return RawLLMResponse(
        provider_id=request.provider_id,
        adapter_id=request.adapter_id,
        model=request.llm.model,
        status="completed",
        raw_text=output.stdout if output is not None else "",
        stdout=output.stdout if output is not None else "",
        stderr=output.stderr if output is not None else "",
        exit_code=output.returncode if output is not None else 0,
        usage=result.usage,
        raw_provider_payload=result.payload if isinstance(result.payload, dict) else None,
        capabilities_used={"runtime": "legacy_harness"},
    )


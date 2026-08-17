from open_kritt_engine.harnesses import HarnessError, HarnessOutput, HarnessResult
from open_kritt_engine.llm import LLMRequest, ProviderContext, RawLLMResponse, default_provider_registry
from open_kritt_engine.llm.capabilities import ProviderCapabilities
from open_kritt_engine.llm.providers.legacy import LegacyHarnessProvider
from open_kritt_engine.llm.registry import ProviderRegistry


class FakeHarness:
    def __init__(self, result=None, error=None):
        self.result = result
        self.error = error
        self.calls = []

    def run(self, **kwargs):
        self.calls.append(kwargs)
        if self.error is not None:
            raise self.error
        return self.result


def request():
    return LLMRequest(
        prompt="Return JSON.",
        schema={"type": "object"},
        model="test-model",
        mode="generation",
        repo_dir="/tmp/open-kritt-test",
        allow_tools=False,
        thinking_effort="medium",
        timeout_seconds=12,
    )


def test_default_provider_registry_exposes_legacy_providers():
    registry = default_provider_registry()

    assert registry.ids() == ("claude-code", "codex", "cursor", "openai-compatible")
    assert registry.get("codex").supports_tools() is True
    assert registry.get("openai-compatible").supports_tools() is False
    assert registry.get("claude-code").capabilities().cli_execution is True


def test_registry_rejects_duplicate_provider_ids():
    registry = ProviderRegistry()
    provider = default_provider_registry().get("codex")
    registry.register(provider)

    try:
        registry.register(provider)
    except ValueError as exc:
        assert "already registered" in str(exc)
    else:
        raise AssertionError("duplicate provider registration should fail")


def test_legacy_provider_adapts_successful_harness_result():
    output = HarnessOutput(stdout='{"ok":true}', stderr="warning", returncode=0)
    result = HarnessResult(payload={"ok": True}, usage={"total_tokens": 3}, output=output)
    harness = FakeHarness(result=result)
    provider = LegacyHarnessProvider(
        id="fake",
        label="Fake",
        harness_name="fake-harness",
        harness_factory=lambda _timeout: harness,
        capability_defaults=ProviderCapabilities(json_mode=True),
    )

    response = provider.generate(ProviderContext(env={"A": "B"}), request())

    assert isinstance(response, RawLLMResponse)
    assert response.provider_id == "fake"
    assert response.adapter_id == "legacy:fake-harness"
    assert response.status == "completed"
    assert response.raw_text == '{"ok":true}'
    assert response.raw_provider_payload == {"ok": True}
    assert response.usage == {"total_tokens": 3}
    assert harness.calls[0]["env"] == {"A": "B"}
    assert harness.calls[0]["allow_tools"] is False


def test_legacy_provider_adapts_harness_error_without_raising():
    output = HarnessOutput(stdout="partial", stderr="rate limited", returncode=429)
    error = HarnessError("limited", code="rate_limited", output=output)
    harness = FakeHarness(error=error)
    provider = LegacyHarnessProvider(
        id="fake",
        label="Fake",
        harness_name="fake-harness",
        harness_factory=lambda _timeout: harness,
        capability_defaults=ProviderCapabilities(),
    )

    response = provider.generate(ProviderContext(), request())

    assert response.status == "rate_limited"
    assert response.raw_text == "partial"
    assert response.stderr == "rate limited"
    assert response.exit_code == 429
    assert response.warnings == ("legacy_harness_error:rate_limited",)


"""Parser tolerance and OpenAI-compatible harness tests.

Covers loose JSON recovery (markdown fences, explanatory text, multiple code
blocks), strict-mode preservation for existing providers, request payload
passthrough, reasoning-effort forwarding, and failure diagnostics.
"""

import io
import json

import pytest

from open_kritt_engine import harnesses
from open_kritt_engine.generation import (
    GenerationValidationError,
    generation_response_schema,
    validate_generation_payload,
)
from open_kritt_engine.harnesses import HarnessError, OpenAICompatibleHarness
from open_kritt_engine.schema import EXTRACTOR_HELPER_FIELD


def workflow_artifact():
    return {
        "name": "generated-security-review",
        "description": "Find concrete vulnerabilities in externally reachable production flows.",
        "levels": [
            {
                "depth": 0,
                "multiOutput": True,
                "consumesAll": False,
                "outputFields": [
                    {"key": "explanation", "type": "string"},
                    {"key": "file_path", "type": "string"},
                    {"key": "line", "type": "number"},
                    {"key": "malicious_input_example", "type": "string"},
                    {"key": "summary", "type": "string"},
                    {"key": "trigger_flow", "type": "array"},
                    {"key": "vulnerability_type", "type": "string"},
                    {"key": "malicious_actor", "type": "string"},
                ],
                "steps": [{"name": "Investigate attack surface", "content": "Analyze {{repo_full}}."}],
            }
        ],
    }


def envelope(artifact=None):
    return {EXTRACTOR_HELPER_FIELD: True, "results": [artifact if artifact is not None else workflow_artifact()]}


def provider_env(tmp_path):
    credentials = tmp_path / "providers.json"
    credentials.write_text(
        json.dumps(
            {
                "version": 2,
                "credentials": {},
                "customProviders": [
                    {
                        "id": "cline-pass",
                        "label": "Cline Pass",
                        "baseUrl": "https://api.cline.bot/api/v1",
                        "apiKey": "secret-key",
                        "model": "cline-pass/deepseek-v4-flash",
                    }
                ],
                "disabledEnvironmentProviders": [],
            }
        ),
        encoding="utf-8",
    )
    return {"OPEN_KRITT_PROVIDER_CREDENTIALS_PATH": str(credentials), "OPENAI_API_KEY": "secret-key"}


class FakeResponse:
    def __init__(self, body: bytes):
        self.body = body

    def read(self, _limit=None):
        return self.body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False


def http_error(code: int = 404, body: bytes = b'{"error":"not found"}'):
    return harnesses.HTTPError("https://api.cline.bot/api/v1", code, "error", {}, io.BytesIO(body))


def chat_response(content: str, **extra):
    payload = {
        "choices": [{"message": {"role": "assistant", "content": content}}],
        "usage": {"total_tokens": 7},
    }
    payload.update(extra)
    return FakeResponse(json.dumps(payload).encode("utf-8"))


def run_harness(monkeypatch, tmp_path, urlopen_fake, *, thinking_effort="default"):
    harness = OpenAICompatibleHarness(timeout_seconds=10, model_provider="cline-pass")
    monkeypatch.setattr(harnesses, "urlopen", urlopen_fake)
    return harness.run(
        prompt="Build a focused security review draft.",
        schema=generation_response_schema("workflow"),
        repo_dir=str(tmp_path),
        model="cline-pass/deepseek-v4-flash",
        thinking_effort=thinking_effort,
        env=provider_env(tmp_path),
        allow_tools=False,
    )


class TestParseJsonText:
    def test_plain_json_requires_loose_mode_and_recovers_artifact(self):
        text = json.dumps(workflow_artifact())
        with pytest.raises(harnesses.HarnessError):
            harnesses._parse_json_text(text)
        parsed = harnesses._parse_json_text(text, allow_loose=True)
        assert parsed == {EXTRACTOR_HELPER_FIELD: True, **workflow_artifact()}

    def test_fenced_markdown_json_is_recovered(self):
        text = "Sure! Here's the workflow:\n\n```json\n" + json.dumps(workflow_artifact(), indent=2) + "\n```\n"
        parsed = harnesses._parse_json_text(text, allow_loose=True)
        assert parsed["name"] == "generated-security-review"
        assert parsed["levels"][0]["depth"] == 0

    def test_explanatory_text_before_and_after_json_is_recovered(self):
        text = "Workflow draft:\n\n" + json.dumps(workflow_artifact()) + "\n\nAdditional notes here."
        parsed = harnesses._parse_json_text(text, allow_loose=True)
        assert parsed["name"] == "generated-security-review"

    def test_multiple_code_blocks_picks_largest_valid_object(self):
        artifact = workflow_artifact()
        text = (
            "```json\n{\"name\": \"small-example\"}\n```\n"
            "```json\n{not valid json\n```\n"
            "```json\n"
            + json.dumps(artifact)
            + "\n```\n"
        )
        parsed = harnesses._parse_json_text(text, allow_loose=True)
        assert parsed["name"] == artifact["name"]
        assert "levels" in parsed

    @pytest.mark.parametrize("allow_loose", [False, True])
    def test_malformed_json_raises_even_in_loose_mode(self, allow_loose):
        with pytest.raises((harnesses.HarnessError, json.JSONDecodeError)):
            harnesses._parse_json_text("this is not json {oops", allow_loose=allow_loose)

    def test_strict_parser_keeps_accepting_wrapped_envelopes(self):
        text = "Here you go:\n\n" + json.dumps(envelope())
        parsed = harnesses._parse_json_text(text)
        assert parsed["results"][0]["name"] == "generated-security-review"

    def test_strict_parser_keeps_rejecting_plain_objects(self):
        with pytest.raises(harnesses.HarnessError):
            harnesses._parse_json_text(json.dumps(workflow_artifact()))


class TestExtractJson:
    def test_loose_mode_handles_standard_chat_completion_shape(self):
        response = {"choices": [{"message": {"content": json.dumps(workflow_artifact())}}]}
        with pytest.raises(harnesses.HarnessError):
            harnesses._extract_json(response)
        parsed = harnesses._extract_json(response, allow_loose=True)
        assert parsed["name"] == "generated-security-review"

    def test_loose_mode_handles_responses_output_shape(self):
        response = {"output": [{"content": [{"type": "output_text", "text": json.dumps(workflow_artifact())}]}]}
        parsed = harnesses._extract_json(response, allow_loose=True)
        assert parsed["name"] == "generated-security-review"


class TestSchemaValidationStaysStrict:
    def test_loose_recovered_raw_artifact_is_rejected_by_generation_schema(self):
        parsed = harnesses._parse_json_text(json.dumps(workflow_artifact()), allow_loose=True)
        with pytest.raises(GenerationValidationError):
            validate_generation_payload("workflow", parsed)

    def test_loose_recovered_envelope_with_bad_field_is_rejected(self):
        bad = envelope({"name": "missing-fields"})
        parsed = harnesses._parse_json_text(json.dumps(bad), allow_loose=True)
        with pytest.raises(GenerationValidationError):
            validate_generation_payload("workflow", parsed)


class TestOpenAICompatibleHarness:
    def test_recovers_wrapped_text_from_plain_chat_completions(self, monkeypatch, tmp_path):
        content = "Sure! Here's the workflow:\n\n" + json.dumps(envelope()) + "\n"

        def urlopen_fake(request, timeout):
            body = json.loads(request.data.decode("utf-8"))
            url = request.full_url
            if url.endswith("/responses"):
                raise http_error(404)
            if url.endswith("/chat/completions") and "response_format" in body:
                raise http_error(400)
            assert url.endswith("/chat/completions")
            assert "response_format" not in body
            assert body["model"] == "cline-pass/deepseek-v4-flash"
            assert body["max_tokens"] == 8000
            return chat_response(content)

        result = run_harness(monkeypatch, tmp_path, urlopen_fake)
        assert result.payload["results"][0]["name"] == "generated-security-review"
        assert result.usage["endpoint"] == "chat.completions.plain"

    def test_recovers_fenced_json_from_plain_chat_completions(self, monkeypatch, tmp_path):
        content = "Here is the draft:\n\n```json\n" + json.dumps(envelope()) + "\n```\n"

        def urlopen_fake(request, timeout):
            url = request.full_url
            if url.endswith("/responses"):
                raise http_error(404)
            if url.endswith("/chat/completions") and "response_format" in json.loads(request.data.decode("utf-8")):
                raise http_error(400)
            return chat_response(content)

        result = run_harness(monkeypatch, tmp_path, urlopen_fake)
        assert result.payload["results"][0]["name"] == "generated-security-review"

    def test_structured_outputs_still_used_when_supported(self, monkeypatch, tmp_path):
        content = json.dumps(envelope())

        def urlopen_fake(request, timeout):
            url = request.full_url
            if url.endswith("/responses"):
                raise http_error(404)
            body = json.loads(request.data.decode("utf-8"))
            if url.endswith("/chat/completions") and "response_format" in body:
                assert body["response_format"]["type"] == "json_schema"
                assert body["response_format"]["json_schema"]["strict"] is False
                return chat_response(content)
            raise AssertionError("plain fallback should not be reached when structured outputs work")

        result = run_harness(monkeypatch, tmp_path, urlopen_fake)
        assert result.usage["endpoint"] == "chat.completions"

    def test_reasoning_effort_is_forwarded_before_plain_fallback(self, monkeypatch, tmp_path):
        seen = []

        def urlopen_fake(request, timeout):
            body = json.loads(request.data.decode("utf-8"))
            seen.append(body)
            url = request.full_url
            if url.endswith("/responses"):
                raise http_error(404)
            if url.endswith("/chat/completions") and "response_format" in body and "reasoning_effort" not in body:
                raise http_error(400)
            if url.endswith("/chat/completions") and "reasoning_effort" in body:
                assert body["reasoning_effort"] == "medium"
                assert body["response_format"]["type"] == "json_schema"
                assert body["max_tokens"] == 8000
                return chat_response(json.dumps(envelope()))
            raise AssertionError("plain fallback should not be reached when reasoning works")

        result = run_harness(monkeypatch, tmp_path, urlopen_fake, thinking_effort="medium")
        assert result.usage["endpoint"] == "chat.completions.reasoning"
        assert seen[-1]["reasoning_effort"] == "medium"

    def test_non_openai_thinking_efforts_are_not_sent(self, monkeypatch, tmp_path):
        seen = []

        def urlopen_fake(request, timeout):
            body = json.loads(request.data.decode("utf-8"))
            seen.append(body)
            url = request.full_url
            if url.endswith("/responses"):
                raise http_error(404)
            return chat_response("no json here")

        with pytest.raises(HarnessError):
            run_harness(monkeypatch, tmp_path, urlopen_fake, thinking_effort="xhigh")
        assert all("reasoning_effort" not in body for body in seen)

    def test_request_payloads_preserve_supported_fields(self, monkeypatch, tmp_path):
        captured = []

        def urlopen_fake(request, timeout):
            body = json.loads(request.data.decode("utf-8"))
            captured.append((request.full_url, body))
            return chat_response("no json here")

        with pytest.raises(HarnessError):
            run_harness(monkeypatch, tmp_path, urlopen_fake)

        urls = [url for url, _body in captured]
        assert any(url.endswith("/responses") for url in urls)
        assert any(url.endswith("/chat/completions") for url in urls)
        structured = [body for url, body in captured if url.endswith("/chat/completions") and "response_format" in body]
        plain = [body for url, body in captured if url.endswith("/chat/completions") and "response_format" not in body]
        assert structured and plain
        assert all(body["model"] == "cline-pass/deepseek-v4-flash" for body in structured + plain)
        assert all(body["messages"] == [{"role": "user", "content": "Build a focused security review draft."}] for body in structured + plain)
        assert all(body["response_format"]["type"] == "json_schema" for body in structured)
        # Standard attempts keep the original budget; only the final large-budget
        # retry increases max_tokens.
        assert all(body["max_tokens"] == 8000 for body in plain + structured[:-1])
        assert structured[-1]["max_tokens"] == 32000

    def test_large_budget_retry_completes_truncated_draft(self, monkeypatch, tmp_path):
        complete = json.dumps(envelope())
        truncated = complete[: len(complete) // 3]

        def urlopen_fake(request, timeout):
            body = json.loads(request.data.decode("utf-8"))
            url = request.full_url
            if url.endswith("/responses"):
                raise http_error(404)
            if url.endswith("/chat/completions") and "response_format" in body:
                if body["max_tokens"] == 8000:
                    # Gateway-style wrapped response; reasoning ate the whole
                    # budget and the draft was cut off.
                    return FakeResponse(
                        json.dumps(
                            {
                                "data": {
                                    "choices": [
                                        {
                                            "finish_reason": "length",
                                            "message": {"role": "assistant", "content": truncated},
                                        }
                                    ]
                                },
                                "success": True,
                            }
                        ).encode("utf-8")
                    )
                assert body["max_tokens"] == 32000
                return chat_response(complete)
            return chat_response(truncated)

        result = run_harness(monkeypatch, tmp_path, urlopen_fake)
        assert result.payload["results"][0]["name"] == "generated-security-review"
        assert result.usage["endpoint"] == "chat.completions.large"

    def test_data_wrapped_chat_response_is_recovered(self, monkeypatch, tmp_path):
        def urlopen_fake(request, timeout):
            url = request.full_url
            if url.endswith("/responses"):
                raise http_error(404)
            return FakeResponse(
                json.dumps(
                    {
                        "data": {
                            "choices": [
                                {
                                    "finish_reason": "stop",
                                    "message": {"role": "assistant", "content": json.dumps(envelope())},
                                }
                            ]
                        },
                        "success": True,
                    }
                ).encode("utf-8")
            )

        result = run_harness(monkeypatch, tmp_path, urlopen_fake)
        assert result.payload["results"][0]["name"] == "generated-security-review"
        assert result.usage["endpoint"] == "chat.completions"

    def test_truncated_response_is_noted_in_parse_diagnostics(self, monkeypatch, tmp_path):
        def urlopen_fake(request, timeout):
            url = request.full_url
            if url.endswith("/responses"):
                raise http_error(404)
            return FakeResponse(
                json.dumps(
                    {
                        "data": {
                            "choices": [
                                {
                                    "finish_reason": "length",
                                    "message": {"role": "assistant", "content": "{\"name\": \"cut"},
                                }
                            ]
                        },
                        "success": True,
                    }
                ).encode("utf-8")
            )

        with pytest.raises(HarnessError) as exc_info:
            run_harness(monkeypatch, tmp_path, urlopen_fake)

        files = exc_info.value.output.files
        assert "chat.completions.large-parse-error.txt" in files
        assert "finish_reason=length" in files["chat.completions.large-parse-error.txt"]

    def test_parse_failure_saves_diagnostics_and_raises_invalid_output(self, monkeypatch, tmp_path):
        def urlopen_fake(request, timeout):
            url = request.full_url
            if url.endswith("/responses"):
                raise http_error(404)
            return chat_response("Sorry, no JSON here.")

        with pytest.raises(HarnessError) as exc_info:
            run_harness(monkeypatch, tmp_path, urlopen_fake)

        assert exc_info.value.code == "invalid_output"
        files = exc_info.value.output.files
        names = set(files)
        assert "chat.completions.plain-request.json" in names
        assert "chat.completions.plain-raw-response.txt" in names
        assert "chat.completions.plain-parse-error.txt" in names

    def test_parse_failure_saves_extracted_candidates_when_present(self, monkeypatch, tmp_path):
        def urlopen_fake(request, timeout):
            url = request.full_url
            if url.endswith("/responses"):
                raise http_error(404)
            return chat_response("Here is a fragment: {\"name\": \"unclosed\" and then more text")

        with pytest.raises(HarnessError) as exc_info:
            run_harness(monkeypatch, tmp_path, urlopen_fake)

        files = exc_info.value.output.files
        candidates_name = "chat.completions.plain-extracted-candidates.json"
        assert candidates_name in files
        assert "Here is a fragment" in files[candidates_name]


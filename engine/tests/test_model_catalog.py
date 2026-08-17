import io
import json
import os
import stat
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest

from open_kritt_engine import model_catalog
from open_kritt_engine.model_catalog import (
    ModelCatalogRefresher,
    codex_is_configured,
    fetch_anthropic_models,
    fetch_codex_models,
    fetch_openrouter_models,
    normalize_catalog_models,
)


class FakeConnection:
    def __init__(self):
        self.commits = 0

    def commit(self):
        self.commits += 1


class FakeDatabase:
    def __init__(self):
        self.catalogs = []
        self.errors = []
        self.connections = []

    @contextmanager
    def connect(self):
        conn = FakeConnection()
        self.connections.append(conn)
        yield conn

    def upsert_model_catalog(self, _conn, **kwargs):
        self.catalogs.append(kwargs)

    def record_model_catalog_error(self, _conn, **kwargs):
        self.errors.append(kwargs)


def _write_fake_codex(executable):
    executable.write_text(
        f"""#!{sys.executable}
import json
import os
import sys
from pathlib import Path

codex_home = os.environ.get("CODEX_HOME")
if capture_path := os.environ.get("CODEX_HOME_CAPTURE"):
    Path(capture_path).write_text(codex_home or "<unset>", encoding="utf-8")
if os.environ.get("WRITE_CODEX_STATE") == "1":
    Path(codex_home, "state_5.sqlite").write_text("temporary", encoding="utf-8")
if os.environ.get("MUTATE_CODEX_AUTH") == "1":
    auth_path = Path(codex_home, "auth.json")
    refreshed_auth = auth_path.with_name(".auth.json.refreshed")
    refreshed_auth.write_text('{{"tokens": {{"access_token": "refreshed"}}}}', encoding="utf-8")
    refreshed_auth.chmod(0o644)
    os.replace(refreshed_auth, auth_path)

for raw in sys.stdin:
    request = json.loads(raw)
    if request.get("id") == 1:
        print(json.dumps({{"id": 1, "result": {{"userAgent": "test"}}}}), flush=True)
    elif request.get("method") == "model/list":
        print(json.dumps({{"method": "remoteControl/status/changed", "params": {{}}}}), flush=True)
        print(json.dumps({{
            "id": request["id"],
            "result": {{
                "data": [
                    {{
                        "id": "internal-id",
                        "model": "gpt-5-codex",
                        "displayName": "GPT-5 Codex",
                        "isDefault": True,
                        "supportedReasoningEfforts": [{{"reasoningEffort": "medium"}}],
                    }}
                ],
                "nextCursor": None,
            }},
        }}), flush=True)
""",
        encoding="utf-8",
    )
    executable.chmod(executable.stat().st_mode | stat.S_IXUSR)


def test_normalize_catalog_models_prefers_cli_model_and_sanitizes_metadata():
    models, default_model = normalize_catalog_models(
        [
            {
                "id": "internal-id",
                "model": "gpt-5-codex",
                "displayName": "GPT-5 Codex",
                "supportedReasoningEfforts": [
                    {"reasoningEffort": "low"},
                    {"reasoningEffort": "medium"},
                    {"reasoningEffort": "max"},
                    {"reasoningEffort": "ultra"},
                    {"reasoningEffort": "unsupported"},
                    {"reasoningEffort": "low"},
                ],
            },
            {"slug": "claude-sonnet-4", "display_name": "Claude Sonnet 4", "is_default": True},
            {"model": "gpt-5-codex", "displayName": "duplicate"},
            {"model": "\ninvalid"},
        ]
    )

    assert models == [
        {
            "id": "gpt-5-codex",
            "label": "GPT-5 Codex",
            "thinkingEfforts": ["low", "medium", "max", "ultra"],
            "isDefault": False,
        },
        {
            "id": "claude-sonnet-4",
            "label": "Claude Sonnet 4",
            "thinkingEfforts": [],
            "isDefault": True,
        },
    ]
    assert default_model == "claude-sonnet-4"


def test_normalize_catalog_models_adds_cyber_note_to_gpt_models_newer_than_5_4():
    models, default_model = normalize_catalog_models(
        [
            {"model": "gpt-5.4", "displayName": "GPT-5.4", "isDefault": True},
            {"model": "gpt-5.5", "displayName": "GPT-5.5"},
            {"model": "gpt-5.6-codex", "displayName": "GPT-5.6 Codex"},
            {"model": "gpt-6", "displayName": "GPT-6"},
        ]
    )

    assert default_model == "gpt-5.4"
    assert models[0]["label"] == "GPT-5.4"
    assert "note" not in models[0]
    for model in models[1:]:
        assert model["note"] == "This model may have cybersecurity usage restrictions."
        assert model["noteUrl"] == "https://chatgpt.com/cyber"


def test_codex_configuration_accepts_openai_key_or_persisted_login(tmp_path):
    assert codex_is_configured({"OPENAI_API_KEY": "sk-test"})
    assert not codex_is_configured({"CODEX_HOME": str(tmp_path)})

    (tmp_path / "auth.json").write_text('{"tokens": {"access_token": "test"}}', encoding="utf-8")
    assert codex_is_configured({"CODEX_HOME": str(tmp_path)})


def test_runtime_codex_home_overrides_container_default(tmp_path):
    configured = tmp_path / "configured"
    configured.mkdir()
    (configured / "auth.json").write_text('{"tokens": {"access_token": "test"}}', encoding="utf-8")

    assert codex_is_configured(
        {
            "CODEX_HOME": str(tmp_path / "container-default"),
            "ENGINE_CODEX_HOME": f"{configured},{tmp_path / 'secondary'}",
        }
    )


def test_fetch_codex_models_uses_app_server_model_values(tmp_path, monkeypatch):
    executable = tmp_path / "codex"
    _write_fake_codex(executable)
    source_home = tmp_path / "source-home"
    source_home.mkdir()
    (source_home / "auth.json").write_text('{"tokens":{"access_token":"test"}}', encoding="utf-8")
    capture_path = tmp_path / "codex-home.txt"
    env = {
        "CODEX_API_KEY": "test-key",
        "ENGINE_CODEX_HOME": str(source_home),
        "CODEX_HOME_CAPTURE": str(capture_path),
        "WRITE_CODEX_STATE": "1",
        "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
    }

    models, default_model = fetch_codex_models(env, 2)

    assert models == [
        {
            "id": "gpt-5-codex",
            "label": "GPT-5 Codex",
            "thinkingEfforts": ["medium"],
            "isDefault": True,
        }
    ]
    assert default_model == "gpt-5-codex"
    isolated_home = Path(capture_path.read_text(encoding="utf-8"))
    assert isolated_home != source_home
    assert not isolated_home.exists()
    assert not (source_home / "state_5.sqlite").exists()


def test_fetch_codex_models_persists_refresh_and_restores_private_mode(tmp_path):
    executable = tmp_path / "codex"
    _write_fake_codex(executable)
    source_home = tmp_path / "persisted-codex"
    source_home.mkdir()
    source_auth = source_home / "auth.json"
    source_auth.write_text('{"tokens": {"access_token": "original"}}', encoding="utf-8")
    source_auth.chmod(0o600)
    capture_path = tmp_path / "codex-home.txt"
    env = {
        "CODEX_HOME": str(source_home),
        "CODEX_HOME_CAPTURE": str(capture_path),
        "MUTATE_CODEX_AUTH": "1",
        "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}",
    }

    models, default_model = fetch_codex_models(env, 2)

    isolated_home = Path(capture_path.read_text(encoding="utf-8"))
    assert isolated_home != source_home
    assert not isolated_home.exists()
    assert source_auth.read_text(encoding="utf-8") == '{"tokens": {"access_token": "refreshed"}}'
    assert stat.S_IMODE(source_auth.stat().st_mode) == 0o600
    assert [model["id"] for model in models] == ["gpt-5-codex"]
    assert default_model == "gpt-5-codex"


def test_fetch_anthropic_models_uses_the_account_model_list(monkeypatch):
    requests = []

    class FakeResponse(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            self.close()

    def fake_urlopen(request, timeout):
        requests.append((request, timeout))
        return FakeResponse(
            json.dumps(
                {
                    "data": [
                        {"id": "claude-fable-5", "display_name": "Claude Fable 5"},
                        {"id": "claude-opus-4-6", "display_name": "Claude Opus 4.6"},
                        {"id": "claude-haiku-4", "display_name": "Claude Haiku 4"},
                    ],
                    "has_more": False,
                }
            ).encode("utf-8")
        )

    monkeypatch.setattr(model_catalog, "urlopen", fake_urlopen)
    models, default_model = fetch_anthropic_models("anthropic-test-key", 2)

    assert [model["id"] for model in models] == ["claude-fable-5", "claude-opus-4-6", "claude-haiku-4"]
    assert models[0]["label"] == "Claude Fable 5"
    assert models[0]["note"] == "Cyber requests may route to Opus 4.8."
    assert models[0]["thinkingEfforts"] == ["low", "medium", "high", "xhigh", "max"]
    assert models[1]["thinkingEfforts"] == ["low", "medium", "high", "max"]
    assert models[2]["thinkingEfforts"] == ["default"]
    assert default_model == "claude-fable-5"
    request, timeout = requests[0]
    assert request.full_url == "https://api.anthropic.com/v1/models?limit=100"
    assert request.get_header("X-api-key") == "anthropic-test-key"
    assert timeout > 0


def _openrouter_model(model_id, *, name=None, output_modalities=None, reasoning=None):
    return {
        "id": model_id,
        "name": name or model_id,
        "architecture": {"output_modalities": output_modalities or ["text"]},
        **({"reasoning": reasoning} if reasoning is not None else {}),
    }


def test_fetch_openrouter_models_uses_account_catalog_and_keeps_all_text_models(monkeypatch):
    requests = []

    def fake_urlopen(request, timeout):
        requests.append((request, timeout))
        entries = [
            _openrouter_model("vendor/general-chat", name="General Chat"),
            _openrouter_model("openai/gpt-model", name="OpenAI through OpenRouter"),
            _openrouter_model("z-ai/glm-5.2", name=" Z.ai GLM 5.2 "),
            _openrouter_model("anthropic/claude-model", name="Claude through OpenRouter"),
            _openrouter_model("vendor/image-only", output_modalities=["image"]),
            _openrouter_model(
                "vendor/reasoning-model",
                reasoning={"supported_efforts": ["high", "minimal", "medium", "low"]},
            ),
        ]
        return io.BytesIO(json.dumps({"data": entries}).encode("utf-8"))

    monkeypatch.setattr(model_catalog, "urlopen", fake_urlopen)
    models, default_model = fetch_openrouter_models("openrouter-test-key", 2)

    assert [model["id"] for model in models] == [
        "vendor/general-chat",
        "openai/gpt-model",
        "z-ai/glm-5.2",
        "anthropic/claude-model",
        "vendor/reasoning-model",
    ]
    assert models[2]["label"] == "Z.ai GLM 5.2"
    assert models[2]["isDefault"] is True
    assert models[4]["thinkingEfforts"] == ["low", "medium", "high"]
    assert default_model == "z-ai/glm-5.2"
    request, timeout = requests[0]
    assert request.full_url == "https://openrouter.ai/api/v1/models/user"
    assert request.get_header("Authorization") == "Bearer openrouter-test-key"
    assert timeout == 2


def test_fetch_openrouter_models_uses_provider_default_or_all_gateway_efforts(monkeypatch):
    entries = [
        _openrouter_model(
            "vendor/default-reasoning-model",
            name="Default Reasoning Model",
            reasoning={"mandatory": True},
        ),
        _openrouter_model(
            "vendor/gateway-effort-model",
            name="Gateway Effort Model",
            reasoning={"supported_efforts": None},
        ),
    ]
    monkeypatch.setattr(
        model_catalog,
        "urlopen",
        lambda *_args, **_kwargs: io.BytesIO(json.dumps({"data": entries}).encode("utf-8")),
    )

    models, _default_model = fetch_openrouter_models("openrouter-test-key", 2)

    assert models[0]["thinkingEfforts"] == ["default"]
    assert models[1]["thinkingEfforts"] == ["low", "medium", "high", "xhigh", "max"]


def test_fetch_openrouter_models_caps_the_sanitized_catalog(monkeypatch):
    entries = [
        _openrouter_model(f"vendor/model-{index}", name=f"Model {index}")
        for index in range(model_catalog.MAX_CATALOG_MODELS + 25)
    ]
    entries.append(_openrouter_model("z-ai/glm-5.2", name="Preferred Default"))
    monkeypatch.setattr(
        model_catalog,
        "urlopen",
        lambda *_args, **_kwargs: io.BytesIO(json.dumps({"data": entries}).encode("utf-8")),
    )
    models, default_model = fetch_openrouter_models("openrouter-test-key", 2)

    assert len(models) == model_catalog.MAX_CATALOG_MODELS
    assert models[0]["id"] == "vendor/model-0"
    assert models[-1]["id"] == "z-ai/glm-5.2"
    assert default_model == "z-ai/glm-5.2"


def test_fetch_openrouter_models_rejects_oversized_or_invalid_responses(monkeypatch):
    monkeypatch.setattr(model_catalog, "MAX_HTTP_CATALOG_BYTES", 32)
    monkeypatch.setattr(
        model_catalog,
        "urlopen",
        lambda *_args, **_kwargs: io.BytesIO(b'{"data":[{"id":"vendor/model","padding":"too large"}]}'),
    )
    with pytest.raises(model_catalog.ModelCatalogError, match="response was too large"):
        fetch_openrouter_models("openrouter-test-key", 2)

    monkeypatch.setattr(model_catalog, "MAX_HTTP_CATALOG_BYTES", 1024)
    monkeypatch.setattr(model_catalog, "urlopen", lambda *_args, **_kwargs: io.BytesIO(b"not-json"))
    with pytest.raises(model_catalog.ModelCatalogError, match="Could not read the OpenRouter model catalog"):
        fetch_openrouter_models("openrouter-test-key", 2)


def test_refresher_persists_only_configured_provider_catalogs():
    db = FakeDatabase()
    codex_models = [{"id": "gpt-5-codex", "label": "GPT-5 Codex", "thinkingEfforts": [], "isDefault": True}]
    claude_models = [{"id": "claude-sonnet-4", "label": "Claude Sonnet 4", "thinkingEfforts": [], "isDefault": True}]
    openrouter_models = [
        {"id": "vendor/code-model", "label": "Code Model", "thinkingEfforts": ["medium"], "isDefault": True}
    ]
    refresher = ModelCatalogRefresher(
        db,
        env={
            "CODEX_API_KEY": "codex-key",
            "ANTHROPIC_API_KEY": "anthropic-key",
            "OPENROUTER_API_KEY": "openrouter-key",
        },
        fetch_codex=lambda: (codex_models, "gpt-5-codex"),
        fetch_anthropic=lambda: (claude_models, "claude-sonnet-4"),
        fetch_openrouter=lambda: (openrouter_models, "vendor/code-model"),
    )

    assert refresher.refresh() == {"codex": True, "claude": True, "openrouter": True}
    assert db.catalogs == [
        {"provider": "codex", "models": codex_models, "default_model": "gpt-5-codex"},
        {"provider": "claude", "models": claude_models, "default_model": "claude-sonnet-4"},
        {"provider": "openrouter", "models": openrouter_models, "default_model": "vendor/code-model"},
    ]
    assert db.errors == []
    assert [conn.commits for conn in db.connections] == [1, 1, 1]


def test_refresher_preserves_existing_catalog_on_provider_failure():
    db = FakeDatabase()
    refresher = ModelCatalogRefresher(
        db,
        env={"CODEX_API_KEY": "codex-key"},
        fetch_codex=lambda: (_ for _ in ()).throw(RuntimeError("do not persist upstream details")),
    )

    assert refresher.refresh() == {"codex": False}
    assert db.catalogs == []
    assert db.errors == [
        {"provider": "codex", "error": "Unable to refresh the provider model catalog."},
    ]
    assert [conn.commits for conn in db.connections] == [1]


def test_refresher_never_persists_openrouter_failure_details():
    db = FakeDatabase()
    secret = "openrouter-secret"
    refresher = ModelCatalogRefresher(
        db,
        env={"OPENROUTER_API_KEY": secret},
        fetch_openrouter=lambda: (_ for _ in ()).throw(RuntimeError(f"upstream rejected {secret}")),
    )

    assert refresher.refresh() == {"openrouter": False}
    assert db.catalogs == []
    assert db.errors == [
        {"provider": "openrouter", "error": "Unable to refresh the provider model catalog."},
    ]
    assert secret not in json.dumps(db.errors)

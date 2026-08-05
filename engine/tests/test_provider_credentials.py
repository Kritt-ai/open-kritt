import json

from open_kritt_engine.provider_credentials import (
    CUSTOM_PROVIDER_API_KEY_ENV,
    CUSTOM_PROVIDER_BASE_URL_ENV,
    CUSTOM_PROVIDER_HEADERS_ENV,
    bootstrap_managed_provider_credentials,
    custom_provider_settings,
    job_environment,
    provider_environment,
    read_managed_provider_credentials,
)


def test_environment_key_bootstraps_managed_store_once(tmp_path):
    credential_path = tmp_path / "providers.json"

    credentials, disabled = bootstrap_managed_provider_credentials(
        {"OPENROUTER_API_KEY": "initial-key"}, str(credential_path)
    )
    assert credentials == {"openrouter": "initial-key"}
    assert disabled == set()
    assert json.loads(credential_path.read_text(encoding="utf-8"))["credentials"] == {"openrouter": "initial-key"}

    credentials, disabled = bootstrap_managed_provider_credentials(
        {"OPENROUTER_API_KEY": "changed-env-key"}, str(credential_path)
    )
    assert credentials == {"openrouter": "initial-key"}
    assert disabled == set()


def test_disabled_environment_key_is_not_bootstrapped_again(tmp_path):
    credential_path = tmp_path / "providers.json"
    credential_path.write_text(
        json.dumps(
            {
                "version": 1,
                "credentials": {},
                "disabledEnvironmentProviders": ["openrouter"],
            }
        ),
        encoding="utf-8",
    )

    env = provider_environment(
        {
            "OPEN_KRITT_PROVIDER_CREDENTIALS_PATH": str(credential_path),
            "OPENROUTER_API_KEY": "stale-env-key",
        }
    )

    assert "OPENROUTER_API_KEY" not in env
    assert read_managed_provider_credentials(str(credential_path)) == {}


def test_provider_environment_reads_managed_credentials(tmp_path):
    credential_path = tmp_path / "providers.json"
    credential_path.write_text(
        json.dumps(
            {
                "version": 1,
                "credentials": {
                    "codex": "codex-managed",
                    "claude": "claude-managed",
                    "openrouter": "openrouter-managed",
                    "unknown": "ignored",
                },
            }
        ),
        encoding="utf-8",
    )

    env = provider_environment(
        {
            "OPEN_KRITT_PROVIDER_CREDENTIALS_PATH": str(credential_path),
            "CODEX_API_KEY": "old-codex",
            "UNRELATED": "keep",
        }
    )

    assert env["CODEX_API_KEY"] == "old-codex"
    assert "ANTHROPIC_API_KEY" not in env
    assert env["OPENROUTER_API_KEY"] == "openrouter-managed"
    assert env["UNRELATED"] == "keep"
    assert "unknown" not in env


def test_provider_environment_falls_back_to_openai_key(tmp_path):
    env = provider_environment(
        {
            "OPEN_KRITT_PROVIDER_CREDENTIALS_PATH": str(tmp_path / "missing.json"),
            "OPENAI_API_KEY": "openai-key",
        }
    )
    assert env["CODEX_API_KEY"] == "openai-key"


def test_oversized_or_invalid_managed_credential_files_are_ignored(tmp_path):
    invalid = tmp_path / "invalid.json"
    invalid.write_text("not-json", encoding="utf-8")
    assert read_managed_provider_credentials(str(invalid)) == {}

    oversized = tmp_path / "oversized.json"
    oversized.write_bytes(b"x" * (1024 * 1024 + 1))
    assert read_managed_provider_credentials(str(oversized)) == {}


def test_job_environment_only_includes_selected_provider_and_harness_credentials(tmp_path):
    source = {
        "OPEN_KRITT_PROVIDER_CREDENTIALS_PATH": str(tmp_path / "missing.json"),
        "PATH": "/bin",
        "DATABASE_URL": "database-secret",
        "GITHUB_TOKEN": "github-secret",
        "OPENAI_API_KEY": "openai-secret",
        "ANTHROPIC_API_KEY": "anthropic-secret",
        "OPENROUTER_API_KEY": "openrouter-secret",
        "CURSOR_API_KEY": "cursor-secret",
    }

    codex = job_environment("codex", "codex", source)
    openrouter_claude = job_environment("openrouter", "claude-code", source)
    openrouter_cursor = job_environment("openrouter", "cursor", source)

    assert codex == {"PATH": "/bin", "OPENAI_API_KEY": "openai-secret", "CODEX_API_KEY": "openai-secret"}
    assert openrouter_claude == {"PATH": "/bin", "OPENROUTER_API_KEY": "openrouter-secret"}
    assert openrouter_cursor == {
        "PATH": "/bin",
        "OPENROUTER_API_KEY": "openrouter-secret",
        "CURSOR_API_KEY": "cursor-secret",
    }
    for env in (codex, openrouter_claude, openrouter_cursor):
        assert "DATABASE_URL" not in env
        assert "GITHUB_TOKEN" not in env


def test_custom_provider_settings_are_loaded_from_managed_store(tmp_path):
    credential_path = tmp_path / "providers.json"
    credential_path.write_text(
        json.dumps(
            {
                "version": 2,
                "customProviders": [
                    {
                        "id": "my-gateway",
                        "label": "My Gateway",
                        "baseUrl": "https://gateway.example/v1/",
                        "apiKey": "gateway-secret",
                        "model": "gateway-model",
                        "extraHeaders": {"X-Gateway": "yes"},
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    source = {"OPEN_KRITT_PROVIDER_CREDENTIALS_PATH": str(credential_path), "OPENAI_API_KEY": "ambient-secret"}

    assert custom_provider_settings("my-gateway", source)["base_url"] == "https://gateway.example/v1/"
    env = job_environment("my-gateway", "openai-compatible", source)

    assert env[CUSTOM_PROVIDER_API_KEY_ENV] == "gateway-secret"
    assert env[CUSTOM_PROVIDER_BASE_URL_ENV] == "https://gateway.example/v1/"
    assert json.loads(env[CUSTOM_PROVIDER_HEADERS_ENV]) == {"X-Gateway": "yes"}

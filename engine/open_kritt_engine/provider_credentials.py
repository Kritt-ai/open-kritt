import json
import os
import threading
import uuid
from collections.abc import Mapping
from pathlib import Path

DEFAULT_PROVIDER_CREDENTIALS_PATH = "/credentials/providers.json"
PROVIDER_ENV_KEYS = {
    "openrouter": "OPENROUTER_API_KEY",
}
CUSTOM_PROVIDER_API_KEY_ENV = "OPENAI_API_KEY"
CUSTOM_PROVIDER_BASE_URL_ENV = "OPEN_KRITT_CUSTOM_PROVIDER_BASE_URL"
CUSTOM_PROVIDER_NAME_ENV = "OPEN_KRITT_CUSTOM_PROVIDER_NAME"
CUSTOM_PROVIDER_ORG_ENV = "OPEN_KRITT_CUSTOM_PROVIDER_ORGANIZATION"
CUSTOM_PROVIDER_HEADERS_ENV = "OPEN_KRITT_CUSTOM_PROVIDER_EXTRA_HEADERS"
MAX_CREDENTIAL_FILE_BYTES = 1024 * 1024
_CREDENTIAL_WRITE_LOCK = threading.Lock()
JOB_COMMON_ENV_KEYS = frozenset(
    {
        "PATH",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "REQUESTS_CA_BUNDLE",
        "CURL_CA_BUNDLE",
        "NODE_EXTRA_CA_CERTS",
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "NO_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "no_proxy",
    }
)
JOB_PROVIDER_ENV_KEYS = {
    "codex": frozenset({"CODEX_API_KEY", "OPENAI_API_KEY", "OPEN_KRITT_CODEX_BIN", "CODEX_BIN", "CODEX_CLI_PATH"}),
    "claude": frozenset(
        {
            "ANTHROPIC_API_KEY",
            "ANTHROPIC_AUTH_TOKEN",
            "ANTHROPIC_BASE_URL",
            "OPEN_KRITT_CLAUDE_BIN",
            "CLAUDE_BIN",
            "CLAUDE_CLI_PATH",
        }
    ),
    "openrouter": frozenset({"OPENROUTER_API_KEY"}),
}
JOB_HARNESS_ENV_KEYS = {
    "cursor": frozenset({"CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_AGENT_BIN"}),
    "openai-compatible": frozenset(),
}


def _credential_path(path: str | None = None) -> Path:
    return Path(path or os.getenv("OPEN_KRITT_PROVIDER_CREDENTIALS_PATH", DEFAULT_PROVIDER_CREDENTIALS_PATH))


def _normalize_custom_provider(value: object) -> dict[str, object] | None:
    if not isinstance(value, Mapping):
        return None
    provider_id = str(value.get("id") or "").strip().lower()
    label = str(value.get("label") or value.get("name") or "").strip()
    base_url = str(value.get("baseUrl") or value.get("base_url") or "").strip()
    api_key = str(value.get("apiKey") or value.get("api_key") or "").strip()
    model = str(value.get("model") or "").strip()
    organization = str(value.get("organization") or "").strip()
    raw_headers = value.get("extraHeaders") or value.get("extra_headers")
    headers = {
        str(name).strip(): str(header_value).strip()
        for name, header_value in raw_headers.items()
        if isinstance(raw_headers, Mapping) and str(name).strip() and str(header_value).strip()
    } if isinstance(raw_headers, Mapping) else {}
    if not (provider_id and label and base_url and api_key and model):
        return None
    return {
        "id": provider_id,
        "label": label,
        "base_url": base_url,
        "api_key": api_key,
        "model": model,
        "organization": organization,
        "extra_headers": headers,
    }


def read_managed_provider_state(path: str | None = None) -> tuple[dict[str, str], set[str], dict[str, dict[str, object]]]:
    credential_path = _credential_path(path)
    try:
        if credential_path.stat().st_size > MAX_CREDENTIAL_FILE_BYTES:
            return {}, set(), {}
        payload = json.loads(credential_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}, set(), {}
    values = payload.get("credentials") if isinstance(payload, Mapping) else None
    credentials = (
        {
            provider: value.strip()
            for provider, value in values.items()
            if provider in PROVIDER_ENV_KEYS and isinstance(value, str) and value.strip()
        }
        if isinstance(values, Mapping)
        else {}
    )
    raw_disabled = payload.get("disabledEnvironmentProviders") if isinstance(payload, Mapping) else None
    disabled = (
        {provider for provider in raw_disabled if isinstance(provider, str) and provider in PROVIDER_ENV_KEYS}
        if isinstance(raw_disabled, list)
        else set()
    )
    custom = {}
    raw_custom = payload.get("customProviders") if isinstance(payload, Mapping) else None
    if isinstance(raw_custom, list):
        for entry in raw_custom:
            provider = _normalize_custom_provider(entry)
            if provider is not None:
                custom[str(provider["id"])] = provider
    return credentials, disabled, custom


def read_managed_provider_credentials(path: str | None = None) -> dict[str, str]:
    credentials, _disabled, _custom = read_managed_provider_state(path)
    return credentials


def read_custom_provider(path: str | None, provider: str | None) -> dict[str, object] | None:
    if not provider:
        return None
    _credentials, _disabled, custom = read_managed_provider_state(path)
    return custom.get(str(provider).strip().lower())


def bootstrap_managed_provider_credentials(
    source: Mapping[str, str], path: str
) -> tuple[dict[str, str], set[str]]:
    with _CREDENTIAL_WRITE_LOCK:
        credentials, disabled, custom = read_managed_provider_state(path)
        changed = False
        for provider, env_key in PROVIDER_ENV_KEYS.items():
            value = source.get(env_key)
            if provider not in disabled and provider not in credentials and isinstance(value, str) and value.strip():
                credentials[provider] = value.strip()
                changed = True
        if not changed:
            return credentials, disabled

        credential_path = Path(path)
        temporary = credential_path.with_name(f".{credential_path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
        try:
            credential_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            temporary.write_text(
                json.dumps(
                    {
                        "version": 2,
                        "credentials": credentials,
                        "customProviders": list(custom.values()),
                        "disabledEnvironmentProviders": sorted(disabled),
                    },
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            os.chmod(temporary, 0o600)
            os.replace(temporary, credential_path)
        except OSError:
            try:
                temporary.unlink(missing_ok=True)
            except OSError:
                pass
        return credentials, disabled


def provider_environment(source: Mapping[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if source is None else source)
    credentials_path = env.get("OPEN_KRITT_PROVIDER_CREDENTIALS_PATH") or DEFAULT_PROVIDER_CREDENTIALS_PATH
    credentials, disabled = bootstrap_managed_provider_credentials(env, credentials_path)
    for provider in disabled:
        env.pop(PROVIDER_ENV_KEYS[provider], None)
    for provider, value in credentials.items():
        env[PROVIDER_ENV_KEYS[provider]] = value
    if not env.get("CODEX_API_KEY") and env.get("OPENAI_API_KEY"):
        env["CODEX_API_KEY"] = env["OPENAI_API_KEY"]
    return env


def _truthy_env_flag(value: object) -> bool | None:
    if value is None:
        return None
    text = str(value).strip().lower()
    if not text:
        return None
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return None


def _codex_auth_configured(env: Mapping[str, str]) -> bool:
    for key in ("ENGINE_CODEX_HOME", "CODEX_HOME", "OPEN_KRITT_CODEX_INITIAL_HOME"):
        raw = str(env.get(key) or "").strip()
        if not raw:
            continue
        home = raw.split(",", 1)[0].split(":", 1)[0].strip()
        if not home:
            continue
        auth_path = Path(home) / "auth.json"
        try:
            payload = json.loads(auth_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if isinstance(payload, dict) and payload:
            return True
    return False


def codex_runtime_enabled(source: Mapping[str, str] | None = None) -> bool:
    env = dict(os.environ if source is None else source)
    explicit = _truthy_env_flag(env.get("OPEN_KRITT_ENABLE_CODEX"))
    if explicit is not None:
        return explicit
    if _truthy_env_flag(env.get("OPEN_KRITT_CODEX_LOGIN_CONFIGURED")):
        return True
    if _truthy_env_flag(env.get("CODEX_LOGIN_CONFIGURED")):
        return True
    if str(env.get("CODEX_API_KEY") or "").strip():
        return True
    if str(env.get("OPENAI_API_KEY") or "").strip():
        return True
    if _truthy_env_flag(env.get("OPEN_KRITT_CODEX_API_KEY_CONFIGURED")):
        return True
    if _truthy_env_flag(env.get("OPEN_KRITT_OPENAI_API_KEY_CONFIGURED")):
        return True
    return _codex_auth_configured(env)


def is_custom_provider(provider: str | None, source: Mapping[str, str] | None = None) -> bool:
    env = dict(os.environ if source is None else source)
    credentials_path = env.get("OPEN_KRITT_PROVIDER_CREDENTIALS_PATH") or DEFAULT_PROVIDER_CREDENTIALS_PATH
    return read_custom_provider(credentials_path, provider) is not None


def custom_provider_settings(provider: str | None, source: Mapping[str, str] | None = None) -> dict[str, object] | None:
    env = dict(os.environ if source is None else source)
    credentials_path = env.get("OPEN_KRITT_PROVIDER_CREDENTIALS_PATH") or DEFAULT_PROVIDER_CREDENTIALS_PATH
    return read_custom_provider(credentials_path, provider)


def job_environment(
    provider: str,
    harness: str,
    source: Mapping[str, str] | None = None,
) -> dict[str, str]:
    """Build the minimal environment inherited by an untrusted scan harness."""

    source_env = provider_environment(source)
    allowed = (
        JOB_COMMON_ENV_KEYS
        | JOB_PROVIDER_ENV_KEYS.get(provider, frozenset())
        | JOB_HARNESS_ENV_KEYS.get(harness, frozenset())
    )
    custom_provider = custom_provider_settings(provider, source_env)
    if custom_provider is not None:
        allowed |= frozenset(
            {
                CUSTOM_PROVIDER_API_KEY_ENV,
                CUSTOM_PROVIDER_BASE_URL_ENV,
                CUSTOM_PROVIDER_NAME_ENV,
                CUSTOM_PROVIDER_ORG_ENV,
                CUSTOM_PROVIDER_HEADERS_ENV,
            }
        )
        source_env[CUSTOM_PROVIDER_API_KEY_ENV] = str(custom_provider["api_key"])
        source_env[CUSTOM_PROVIDER_BASE_URL_ENV] = str(custom_provider["base_url"])
        source_env[CUSTOM_PROVIDER_NAME_ENV] = str(custom_provider["label"])
        if custom_provider.get("organization"):
            source_env[CUSTOM_PROVIDER_ORG_ENV] = str(custom_provider["organization"])
        headers = custom_provider.get("extra_headers") or {}
        if headers:
            source_env[CUSTOM_PROVIDER_HEADERS_ENV] = json.dumps(headers, sort_keys=True)

    env = {key: value for key in allowed if isinstance((value := source_env.get(key)), str) and value}
    if provider == "codex" and not env.get("CODEX_API_KEY") and env.get("OPENAI_API_KEY"):
        env["CODEX_API_KEY"] = env["OPENAI_API_KEY"]
    if custom_provider is not None and not env.get("OPENAI_API_KEY"):
        env["OPENAI_API_KEY"] = str(custom_provider["api_key"])
    return env

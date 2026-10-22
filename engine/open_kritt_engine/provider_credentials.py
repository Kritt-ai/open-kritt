import json
import os
import threading
import uuid
from collections.abc import Mapping
from pathlib import Path

from .account_activity import filter_account_environment, read_account_activity

DEFAULT_PROVIDER_CREDENTIALS_PATH = "/credentials/providers.json"
PROVIDER_ENV_KEYS = {
    "openrouter": "OPENROUTER_API_KEY",
    "xai": "XAI_API_KEY",
    "deepseek": "DEEPSEEK_API_KEY",
    "opencode": "CODEX_API_KEY",
}
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
        # OpenCode adapter: lets the codex shim pick the model it delegates to.
        "OPENCODE_KRITT_MODEL",
        "OPENCODE_KRITT_TIMEOUT",
    }
)
JOB_PROVIDER_ENV_KEYS = {
    "codex": frozenset({"CODEX_API_KEY", "OPENAI_API_KEY"}),
    "claude": frozenset({"ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"}),
    "openrouter": frozenset({"OPENROUTER_API_KEY"}),
    "xai": frozenset({"XAI_API_KEY"}),
    "deepseek": frozenset({"DEEPSEEK_API_KEY"}),
    # The opencode harness authenticates via CODEX_API_KEY (the opencode-go
    # subscription key) and OPENCODE_KRITT_MODEL pins the real model id.
    #
    # 2026-07-21 — the per-attempt budget must be in this allowlist, or it never
    # reaches the runner: the harness builds the docker command with `--env KEY`
    # (name only), so the value is taken from the JOB env, and the wrapper inside
    # the container expands ${OPENCODE_KRITT_ATTEMPT_TIMEOUT:-900}. With the key
    # missing here, the 900 s default was baked in and no value in .env could
    # change it — a 3k-file repo's first step was killed at 15 minutes every time.
    "opencode": frozenset(
        {
            "CODEX_API_KEY",
            "OPENAI_API_KEY",
            "OPENCODE_KRITT_MODEL",
            "OPENCODE_KRITT_TIMEOUT",
            "OPENCODE_KRITT_ATTEMPT_TIMEOUT",
            "OPENCODE_KRITT_RETRIES",
        }
    ),
}
JOB_HARNESS_ENV_KEYS = {
    "cursor": frozenset({"CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_AGENT_BIN"}),
    "grok-build": frozenset({"GROK_BIN", "GROK_HOME"}),
}


def read_managed_provider_state(path: str | None = None) -> tuple[dict[str, str], set[str]]:
    credential_path = Path(path or os.getenv("OPEN_KRITT_PROVIDER_CREDENTIALS_PATH", DEFAULT_PROVIDER_CREDENTIALS_PATH))
    try:
        if credential_path.stat().st_size > MAX_CREDENTIAL_FILE_BYTES:
            return {}, set()
        payload = json.loads(credential_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}, set()
    values = payload.get("credentials") if isinstance(payload, dict) else None
    if not isinstance(values, dict):
        return {}, set()
    credentials = {
        provider: value.strip()
        for provider, value in values.items()
        if provider in PROVIDER_ENV_KEYS and isinstance(value, str) and value.strip()
    }
    raw_disabled = payload.get("disabledEnvironmentProviders")
    disabled = (
        {provider for provider in raw_disabled if isinstance(provider, str) and provider in PROVIDER_ENV_KEYS}
        if isinstance(raw_disabled, list)
        else set()
    )
    return credentials, disabled


def read_managed_provider_credentials(path: str | None = None) -> dict[str, str]:
    credentials, _disabled = read_managed_provider_state(path)
    return credentials


def bootstrap_managed_provider_credentials(source: Mapping[str, str], path: str) -> tuple[dict[str, str], set[str]]:
    with _CREDENTIAL_WRITE_LOCK:
        credentials, disabled = read_managed_provider_state(path)
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
                        "version": 1,
                        "credentials": credentials,
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
    return filter_account_environment(env, read_account_activity(env))


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
    env = {key: value for key in allowed if isinstance((value := source_env.get(key)), str) and value}
    if provider == "codex" and not env.get("CODEX_API_KEY") and env.get("OPENAI_API_KEY"):
        env["CODEX_API_KEY"] = env["OPENAI_API_KEY"]
    return env

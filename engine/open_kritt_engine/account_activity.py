"""Persisted account eligibility, independent of credential health and quota caches."""

import json
import os
from pathlib import Path

API_ACCOUNT_KEYS = {
    "codex": ("CODEX_API_KEY", "OPENAI_API_KEY"),
    "claude": ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"),
    "openrouter": ("OPENROUTER_API_KEY",),
    "xai": ("XAI_API_KEY",),
    "deepseek": ("DEEPSEEK_API_KEY",),
}


class AccountInactiveError(RuntimeError):
    pass


def read_account_activity(source=None):
    env = os.environ if source is None else source
    path = Path(env.get("OPEN_KRITT_PROVIDER_CREDENTIALS_PATH") or "/credentials/providers.json").with_name(
        "account-activity.json"
    )
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if (
            not isinstance(payload, dict)
            or payload.get("version") != 1
            or not isinstance(payload.get("accounts"), list)
        ):
            raise ValueError
        entries = payload["accounts"]
        if any(
            not isinstance(entry, dict)
            or not isinstance(entry.get("provider"), str)
            or not isinstance(entry.get("path"), str)
            or not isinstance(entry.get("active"), bool)
            for entry in entries
        ):
            raise ValueError
        return entries
    except FileNotFoundError:
        return []
    except (OSError, ValueError) as exc:
        raise AccountInactiveError(
            "Account preferences could not be read. Restore account-activity.json before assigning accounts."
        ) from exc


def account_is_active(provider, path, entries):
    return next((entry["active"] for entry in entries if entry["provider"] == provider and entry["path"] == path), True)


def filter_account_environment(env, entries):
    result = dict(env)
    for provider, keys in API_ACCOUNT_KEYS.items():
        if not account_is_active(provider, keys[0], entries):
            for key in keys:
                result.pop(key, None)
    return result


def assert_account_assignment(provider, home=None, env=None):
    # This fresh atomic-file read is the assignment boundary. A toggle committed
    # after this read affects subsequent assignments, not this admitted call.
    entries = read_account_activity()
    keys = API_ACCOUNT_KEYS.get(provider, ())
    has_login = home and any(
        (Path(home) / filename).is_file() for filename in ("auth.json", ".credentials.json", "credentials.json")
    )
    uses_key = keys and (any((env or {}).get(key) for key in keys) or not has_login)
    paths = ([home] if home else []) + ([keys[0]] if uses_key else [])
    for path in paths:
        if not account_is_active(provider, path, entries):
            raise AccountInactiveError("The selected account is inactive. Activate it in Accounts and retry.")

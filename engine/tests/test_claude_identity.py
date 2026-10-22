"""Credential attribution must not borrow identity from a replaced account."""

import json
import os
import subprocess
from pathlib import Path

from open_kritt_engine.workspace import _claude_account_info


def test_explicit_unknown_identity_blocks_stale_fallback(tmp_path):
    (tmp_path / ".open-kritt-account.json").write_text(
        json.dumps({"provider": "claude", "identityKnown": False}), encoding="utf-8"
    )
    (tmp_path / ".claude.json").write_text(json.dumps({"email": "old@example.test"}), encoding="utf-8")

    assert _claude_account_info(str(tmp_path)) == {"id": str(tmp_path), "email": None}


def test_legacy_home_still_uses_available_profile(tmp_path):
    (tmp_path / ".claude.json").write_text(json.dumps({"email": "existing@example.test"}), encoding="utf-8")

    assert _claude_account_info(str(tmp_path)) == {
        "id": "existing@example.test",
        "email": "existing@example.test",
    }


def test_unreadable_managed_identity_does_not_fall_back_to_old_email(tmp_path):
    (tmp_path / ".open-kritt-account.json").write_text("{", encoding="utf-8")
    (tmp_path / ".claude.json").write_text(json.dumps({"email": "old@example.test"}), encoding="utf-8")

    assert _claude_account_info(str(tmp_path)) == {"id": str(tmp_path), "email": None}


def test_partial_new_profile_does_not_reuse_previous_email(tmp_path):
    source = tmp_path / "source"
    target = tmp_path / "target"
    source.mkdir()
    target.mkdir()
    (source / ".credentials.json").write_text(
        json.dumps(
            {
                "claudeAiOauth": {
                    "accessToken": "synthetic-new",
                    "refreshToken": "synthetic-refresh",
                    "expiresAt": 9999999999999,
                }
            }
        ),
        encoding="utf-8",
    )
    (source / ".claude.json").write_text(json.dumps({"name": "Fresh Name"}), encoding="utf-8")
    (target / ".open-kritt-account.json").write_text(json.dumps({"email": "previous@example.test"}), encoding="utf-8")
    (target / ".claude.json").write_text(json.dumps({"email": "old-fallback@example.test"}), encoding="utf-8")
    module = (Path(__file__).parents[2] / "backend/src/lib/claudeCredentials.js").as_uri()
    subprocess.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "const m = await import(process.argv[1]); await m.promoteClaudeCredential(process.argv[2], process.argv[3]);",
            module,
            str(source),
            str(target),
        ],
        env={**os.environ, "BROWSER": "/usr/bin/true", "PHONE_HARNESS_TELEMETRY": "0"},
        check=True,
        timeout=10,
    )

    assert _claude_account_info(str(target)) == {"id": str(target), "email": None}

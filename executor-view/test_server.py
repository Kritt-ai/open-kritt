import json
import tempfile
import time
import unittest
from email.message import Message
from pathlib import Path
from unittest.mock import patch

import server


def claude_usage(primary=44, secondary=5):
    return {
        "checkedAt": "2026-07-14T15:00:00+00:00",
        "observedAt": "2026-07-14T15:00:00+00:00",
        "statusCode": 200,
        "primary": {
            "usedPercent": primary,
            "remainingPercent": max(0, 100 - primary),
            "windowMinutes": 300,
            "resetsAt": "2026-07-14T18:39:59+00:00",
        },
        "secondary": {
            "usedPercent": secondary,
            "remainingPercent": max(0, 100 - secondary),
            "windowMinutes": 10080,
            "resetsAt": "2026-07-16T19:59:59+00:00",
        },
    }


def codex_usage(primary=2, secondary=None):
    return {
        "checkedAt": "2026-07-15T10:00:00+00:00",
        "observedAt": "2026-07-15T10:00:00+00:00",
        "statusCode": 200,
        "email": "researcher@example.test",
        "planType": "pro",
        "rateLimitReachedType": None,
        "allowed": True,
        "manualResetCredits": {
            "availableCount": 3,
            "applicableAvailableCount": 0,
        },
        "primary": {
            "usedPercent": primary,
            "remainingPercent": max(0, 100 - primary),
            "windowMinutes": 10080,
            "resetsAt": "2026-07-21T10:00:00+00:00",
        },
        "secondary": secondary,
    }


def write_claude_credentials(home, access_token="unit-test-access-token"):
    (home / ".credentials.json").write_text(
        json.dumps(
            {
                "claudeAiOauth": {
                    "accessToken": access_token,
                    "refreshToken": "unit-test-refresh-token",
                    "subscriptionType": "max",
                    "rateLimitTier": "default_claude_max_20x",
                }
            }
        ),
        encoding="utf-8",
    )


class ExecutorViewSummaryTests(unittest.TestCase):
    def test_executor_html_has_no_accounts_tab(self):
        self.assertNotIn('id="tab-accounts"', server.HTML)
        self.assertNotIn("renderAccounts", server.HTML)
        self.assertIn('id="queue"', server.HTML)

    def test_public_bind_requires_auth_even_for_a_loopback_host_header(self):
        self.assertTrue(server.bind_address_is_loopback("localhost"))
        self.assertTrue(server.bind_address_is_loopback("127.0.0.1"))
        self.assertTrue(server.bind_address_is_loopback("::1"))
        self.assertFalse(server.bind_address_is_loopback("0.0.0.0"))
        self.assertFalse(server.bind_address_is_loopback("::"))

        with patch.object(server, "REQUIRE_AUTH", True):
            self.assertTrue(
                server.request_token_required(peer_loopback=True, host_loopback=True)
            )
        with patch.object(server, "REQUIRE_AUTH", False):
            self.assertFalse(
                server.request_token_required(peer_loopback=True, host_loopback=True)
            )
            self.assertFalse(
                server.request_token_required(peer_loopback=False, host_loopback=True)
            )
            self.assertTrue(
                server.request_token_required(peer_loopback=False, host_loopback=False)
            )

        self.assertTrue(server.request_peer_is_loopback(("127.0.0.1", 1234)))
        self.assertTrue(server.request_peer_is_loopback(("::1", 1234)))
        self.assertFalse(server.request_peer_is_loopback(("172.20.0.4", 1234)))

    def test_request_host_access_allows_loopback_and_rejects_rebinding_hosts(self):
        def headers(host):
            result = Message()
            result["Host"] = host
            return result

        self.assertEqual(
            server.request_host_access(headers("localhost:8090")), (True, True)
        )
        self.assertEqual(
            server.request_host_access(headers("127.0.0.1:8090")), (True, True)
        )
        self.assertEqual(
            server.request_host_access(headers("[::1]:8090")), (True, True)
        )
        self.assertEqual(
            server.request_host_access(headers("localhost.attacker.test")),
            (False, False),
        )
        self.assertEqual(
            server.request_host_access(headers("rebind.attacker.test")), (False, False)
        )
        self.assertEqual(
            server.request_host_access(headers("localhost/path")), (False, False)
        )

        with patch.object(server, "ALLOWED_HOSTS", {"qa.example.test"}):
            self.assertEqual(
                server.request_host_access(headers("qa.example.test:8090")),
                (True, False),
            )

    def test_non_loopback_access_accepts_only_bearer_or_session_token(self):
        def headers(**values):
            result = Message()
            for key, value in values.items():
                result[key.replace("_", "-")] = value
            return result

        with (
            patch.object(server, "ACCESS_TOKEN", "unit-test-access"),
            patch.object(server, "SESSION_TOKEN", "unit-test-session"),
        ):
            self.assertFalse(server.request_token_allowed(headers()))
            self.assertFalse(
                server.request_token_allowed(headers(Authorization="Bearer wrong"))
            )
            self.assertTrue(
                server.request_token_allowed(
                    headers(Authorization="Bearer unit-test-access")
                )
            )
            self.assertTrue(
                server.request_token_allowed(
                    headers(Cookie="executor_view_session=unit-test-session")
                )
            )

    def test_internal_token_is_distinct_and_only_recognized_by_internal_check(self):
        def headers(**values):
            result = Message()
            for key, value in values.items():
                result[key.replace("_", "-")] = value
            return result

        with (
            patch.object(server, "ACCESS_TOKEN", "browser-token"),
            patch.object(server, "INTERNAL_ACCESS_TOKEN", "backend-token"),
        ):
            internal = headers(Authorization="Bearer backend-token")
            self.assertTrue(server.request_internal_token_allowed(internal))
            self.assertFalse(server.request_token_allowed(internal))
            self.assertFalse(
                server.request_internal_token_allowed(
                    headers(Authorization="Bearer browser-token")
                )
            )
        self.assertTrue(server.internal_request_path_allowed("GET", "/api/state"))
        self.assertTrue(
            server.internal_request_path_allowed("GET", "/api/accounts/codex")
        )
        self.assertTrue(
            server.internal_request_path_allowed("GET", "/api/accounts/claude")
        )
        self.assertFalse(
            server.internal_request_path_allowed("GET", "/api/accounts/unknown")
        )
        self.assertTrue(
            server.internal_request_path_allowed(
                "POST", "/api/accounts/codex/primary/reset"
            )
        )
        self.assertFalse(
            server.internal_request_path_allowed(
                "POST", "/api/accounts/codex/primary/anything-else"
            )
        )

    def test_access_token_is_redacted_from_request_logs(self):
        with patch.object(server, "ACCESS_TOKEN", "unit-test-access"):
            redacted = server.redact_log_value(
                '"GET /?token=unit-test-access&next=%2F HTTP/1.1" 303 -'
            )

        self.assertNotIn("unit-test-access", redacted)
        self.assertIn("token=[REDACTED]", redacted)

    def test_mutation_request_requires_json_and_rejects_cross_origin_browsers(self):
        def headers(**values):
            result = Message()
            for key, value in values.items():
                result[key.replace("_", "-")] = value
            return result

        self.assertTrue(
            server.mutation_request_allowed(headers(Content_Type="application/json"))
        )
        self.assertTrue(
            server.mutation_request_allowed(
                headers(
                    Content_Type="application/json; charset=utf-8",
                    Host="localhost:8090",
                    Origin="http://localhost:8090",
                    Sec_Fetch_Site="same-origin",
                )
            )
        )
        self.assertFalse(
            server.mutation_request_allowed(headers(Content_Type="text/plain"))
        )
        self.assertFalse(
            server.mutation_request_allowed(
                headers(
                    Content_Type="application/json",
                    Host="localhost:8090",
                    Origin="https://attacker.example",
                    Sec_Fetch_Site="cross-site",
                )
            )
        )
        self.assertFalse(
            server.mutation_request_allowed(
                headers(
                    Content_Type="application/json",
                    Host="localhost:8090",
                    Origin="https://attacker.example",
                )
            )
        )

    def test_configured_missing_auth_codex_home_is_still_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / ".codex"
            home.mkdir()
            with patch.object(server, "current_codex_home_raw", return_value=str(home)):
                self.assertEqual(server.configured_codex_homes(), [home])

    def test_only_direct_managed_codex_homes_are_removable(self):
        managed_root = Path("/managed-accounts")
        with patch.object(server, "CODEX_ACCOUNTS_ROOT", managed_root):
            self.assertEqual(
                server.removable_codex_account_id(
                    managed_root / "reviewer-1" / ".codex"
                ),
                "reviewer-1",
            )
            self.assertEqual(
                server.removable_codex_account_id(Path("/root/.codex")),
                "primary",
            )
            self.assertIsNone(
                server.removable_codex_account_id(
                    managed_root / "nested" / "reviewer" / ".codex"
                )
            )
            self.assertIsNone(
                server.removable_codex_account_id(
                    managed_root / "invalid name" / ".codex"
                )
            )

    def test_empty_runtime_codex_home_does_not_fall_back_to_startup_accounts(self):
        with (
            patch.object(
                server,
                "read_runtime_config",
                return_value={"ENGINE_CODEX_HOME": ""},
            ),
            patch.object(server, "CODEX_HOME_RAW", "/startup/.codex"),
        ):
            self.assertEqual(server.current_codex_home_raw(), "")
            self.assertEqual(server.configured_codex_homes(), [])

    def test_scan_summary_reports_total_and_visible_window(self):
        summary = server.summarize_scan_counts(
            [
                {"status": "completed", "count": 50},
                {"status": "running", "count": 3},
                {"status": "prewarming_cache", "count": 1},
                {"status": "failed", "count": 4},
            ],
            displayed=50,
        )

        self.assertEqual(summary["scans"], 58)
        self.assertEqual(summary["displayedScans"], 50)
        self.assertEqual(summary["running"], 4)
        self.assertTrue(summary["truncated"])

    def test_empty_post_work_does_not_look_complete(self):
        summary = server.summarize_post_processing(
            [], [], [], expected_post_script_count=0
        )

        self.assertEqual(summary["attempts"], 0)
        self.assertEqual(summary["progressPct"], 0)

    def test_shallow_account_refresh_keeps_effective_codex_accounts(self):
        codex = {
            "active": 1,
            "total": 1,
            "limited": 0,
            "stale": 0,
            "observedJobAccounts": 1,
            "accounts": [{"email": "researcher@example.test", "active": True}],
            "configuredRaw": "/effective/.codex",
        }
        claude = {
            "active": 0,
            "total": 0,
            "accounts": [],
            "configuredRaw": "/root/.claude",
        }
        openrouter = {
            "active": 0,
            "total": 0,
            "limited": 0,
            "accounts": [],
            "configuredRaw": None,
        }
        server.ACCOUNT_OVERVIEW_CACHE = {"expires_at": 0.0, "data": None}

        with (
            patch.object(server, "DEEP_ACCOUNT_REFRESH", False),
            patch.object(
                server, "fetch_codex_accounts", return_value=codex
            ) as fetch_codex,
            patch.object(server, "fetch_claude_accounts", return_value=claude),
            patch.object(
                server, "fetch_openrouter_accounts", return_value=openrouter
            ) as fetch_openrouter,
        ):
            overview = server.fetch_accounts(force=True)

        fetch_codex.assert_called_once_with(force=True)
        fetch_openrouter.assert_called_once_with(force=True)
        self.assertEqual(overview["codex"]["total"], 1)
        self.assertEqual(overview["active"], 1)

    def test_account_provider_refresh_loads_only_the_requested_provider(self):
        claude = {
            "active": 1,
            "total": 1,
            "limited": 0,
            "stale": 0,
            "accounts": [{"email": "researcher@example.test", "active": True}],
            "configuredRaw": "/root/.claude",
        }

        with patch.object(
            server, "fetch_claude_accounts", return_value=claude
        ) as fetch_claude:
            provider = server.fetch_account_provider("claude", force=True)

        fetch_claude.assert_called_once_with(force=True)
        self.assertEqual(provider["kind"], "claude")
        self.assertEqual(provider["total"], 1)
        self.assertEqual(provider["accounts"], claude["accounts"])

    def test_effective_codex_homes_does_not_restore_historical_job_home(self):
        configured = Path("/configured/.codex")
        job = Path("/data/jobs/metadata-58/home/.codex")

        with (
            patch.object(server, "configured_codex_homes", return_value=[configured]),
            patch.object(server, "job_codex_homes", return_value=[(58, job)]),
            patch.object(server, "load_codex_auth", return_value={"exists": True}),
            patch.object(
                server,
                "codex_account_identity",
                side_effect=lambda _auth, home: str(home),
            ),
        ):
            homes, observed = server.effective_codex_homes()

        self.assertEqual(homes, [configured])
        self.assertEqual(observed, 1)

    def test_codex_usage_is_fetched_without_a_prior_session(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return json.dumps(
                    {
                        "email": "researcher@example.test",
                        "plan_type": "pro",
                        "rate_limit_reached_type": None,
                        "rate_limit": {
                            "allowed": True,
                            "primary_window": {
                                "used_percent": 2,
                                "limit_window_seconds": 604800,
                                "reset_at": 1784637600,
                            },
                            "secondary_window": None,
                        },
                        "rate_limit_reset_credits": {
                            "available_count": 3,
                            "applicable_available_count": 1,
                            "secret": "must-not-leak",
                        },
                    }
                ).encode()

        with patch.object(
            server.urlrequest, "urlopen", return_value=Response()
        ) as urlopen:
            usage = server.fetch_codex_usage(
                "unit-test-access-token", "unit-test-account-id"
            )

        request = urlopen.call_args.args[0]
        self.assertEqual(
            request.get_header("Authorization"), "Bearer unit-test-access-token"
        )
        self.assertEqual(
            request.get_header("Chatgpt-account-id"), "unit-test-account-id"
        )
        self.assertEqual(usage["primary"]["usedPercent"], 2)
        self.assertEqual(usage["primary"]["windowMinutes"], 10080)
        self.assertEqual(usage["planType"], "pro")
        self.assertEqual(
            usage["manualResetCredits"],
            {"availableCount": 3, "applicableAvailableCount": 1},
        )
        self.assertNotIn(
            "unit-test-access-token", json.dumps(usage, default=server.encode)
        )

    def test_forced_codex_usage_refresh_bypasses_a_fresh_cache_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / ".codex"
            home.mkdir()
            (home / "auth.json").write_text(
                json.dumps(
                    {
                        "tokens": {
                            "access_token": "unit-test-access-token",
                            "account_id": "unit-test-account-id",
                        }
                    }
                ),
                encoding="utf-8",
            )
            cache_key = server.secret_fingerprint(
                "unit-test-access-token\nunit-test-account-id"
            )
            cache = {
                cache_key: {
                    "data": codex_usage(primary=0),
                    "expires_at": time.monotonic() + 60,
                }
            }
            refreshed = codex_usage(primary=0.2)
            with (
                patch.object(server, "CODEX_USAGE_CACHE", cache),
                patch.object(
                    server, "fetch_codex_usage", return_value=refreshed
                ) as fetch_usage,
            ):
                result = server.codex_usage_for_account(home, force=True)

        fetch_usage.assert_called_once_with(
            "unit-test-access-token", "unit-test-account-id"
        )
        self.assertEqual(result["primary"]["usedPercent"], 0.2)

    def test_codex_usage_retains_latest_401_status_with_cached_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / ".codex"
            home.mkdir()
            (home / "auth.json").write_text(
                json.dumps(
                    {
                        "tokens": {
                            "access_token": "unit-test-access-token",
                            "account_id": "unit-test-account-id",
                        }
                    }
                ),
                encoding="utf-8",
            )
            cache_key = server.secret_fingerprint(
                "unit-test-access-token\nunit-test-account-id"
            )
            cache = {
                cache_key: {
                    "data": codex_usage(primary=100),
                    "expires_at": time.monotonic() + 60,
                }
            }
            with (
                patch.object(server, "CODEX_USAGE_CACHE", cache),
                patch.object(
                    server,
                    "fetch_codex_usage",
                    return_value={
                        "checkedAt": "2026-07-20T08:00:00+00:00",
                        "statusCode": 401,
                        "error": "Codex usage returned HTTP 401",
                    },
                ),
            ):
                result = server.codex_usage_for_account(home, force=True)

        self.assertEqual(result["refreshStatusCode"], 401)
        self.assertEqual(result["primary"]["usedPercent"], 100)

    def test_codex_401_requires_sign_in_and_hides_cached_usage(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "account" / ".codex"
            home.mkdir(parents=True)
            (home / "auth.json").write_text(
                json.dumps(
                    {
                        "tokens": {
                            "access_token": "unit-test-access-token",
                            "account_id": "unit-test-account-id",
                        }
                    }
                ),
                encoding="utf-8",
            )
            invalid_usage = codex_usage(primary=100)
            invalid_usage.update(
                {
                    "stale": True,
                    "refreshStatusCode": 401,
                    "error": "Codex usage returned HTTP 401",
                }
            )
            with (
                patch.object(server, "latest_rate_limits", return_value={}),
                patch.object(
                    server,
                    "codex_usage_for_account",
                    return_value=invalid_usage,
                ),
            ):
                account = server.codex_account(home, {}, force=True)

        self.assertFalse(account["active"])
        self.assertEqual(account["statusKind"], "expired")
        self.assertEqual(account["status"], "sign in again")
        self.assertIsNone(account["rateLimits"])
        self.assertEqual(
            account["details"],
            [
                {"label": "Provider", "value": "Codex", "mono": False},
                {
                    "label": "Authentication",
                    "value": "Token rejected; sign in to Codex again.",
                    "mono": False,
                },
            ],
        )

    def test_codex_account_prefers_live_usage_over_missing_session_events(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / "account" / ".codex"
            home.mkdir(parents=True)
            (home / "auth.json").write_text(
                json.dumps(
                    {
                        "tokens": {
                            "access_token": "unit-test-access-token",
                            "account_id": "unit-test-account-id",
                        }
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch.object(server, "latest_rate_limits", return_value={}),
                patch.object(
                    server,
                    "codex_usage_for_account",
                    return_value=codex_usage(),
                ) as usage_for_account,
            ):
                account = server.codex_account(home, {}, force=True)

        usage_for_account.assert_called_once_with(home, force=True)
        self.assertEqual(account["label"], "researcher@example.test")
        self.assertEqual(account["plan"], "pro")
        self.assertEqual(account["statusKind"], "available")
        self.assertEqual(account["rateLimits"]["primary"]["usedPercent"], 2)
        self.assertEqual(account["rateLimits"]["source"], "Codex account usage API")
        self.assertEqual(
            account["rateLimits"]["manualResetCredits"],
            {"availableCount": 3, "applicableAvailableCount": 0},
        )
        self.assertNotIn(
            "unit-test-access-token", json.dumps(account, default=server.encode)
        )

    def test_codex_reset_does_not_call_consume_endpoint_without_eligible_window(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / ".codex"
            home.mkdir()
            (home / "auth.json").write_text(
                json.dumps(
                    {
                        "tokens": {
                            "access_token": "unit-test-access-token",
                            "account_id": "unit-test-account-id",
                        }
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch.object(server, "CODEX_PRIMARY_HOME", home),
                patch.object(server, "configured_codex_homes", return_value=[home]),
                patch.object(
                    server,
                    "codex_usage_for_account",
                    return_value=codex_usage(),
                ),
                patch.object(server.urlrequest, "urlopen") as urlopen,
            ):
                result, error, status = server.consume_codex_reset_credit("primary")

        self.assertIsNone(result)
        self.assertEqual(error, "No current usage window is eligible for a reset")
        self.assertEqual(status, 409)
        urlopen.assert_not_called()

    def test_claude_profile_metadata_does_not_count_as_a_login(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / ".claude"
            home.mkdir()
            (home / ".claude.json").write_text(
                '{"oauthAccount":{"emailAddress":"researcher@example.test"}}',
                encoding="utf-8",
            )
            with (
                patch.object(server, "CLAUDE_HOME_RAW", str(home)),
                patch.object(server, "configured_secret", return_value=""),
            ):
                account = server.fetch_claude_accounts()

            self.assertEqual(account["active"], 0)
            self.assertEqual(account["accounts"][0]["id"], "default")
            self.assertFalse(account["accounts"][0]["canRemove"])
            self.assertEqual(
                account["accounts"][0]["status"], "profile found; login required"
            )

            (home / ".credentials.json").write_text(
                '{"claudeAiOauth":{"accessToken":"test"}}',
                encoding="utf-8",
            )
            with (
                patch.object(server, "CLAUDE_HOME_RAW", str(home)),
                patch.object(server, "configured_secret", return_value=""),
            ):
                account = server.fetch_claude_accounts()

            self.assertEqual(account["active"], 1)
            self.assertEqual(account["accounts"][0]["status"], "logged in")
            self.assertTrue(account["accounts"][0]["canRemove"])

    def test_claude_usage_is_normalized_without_exposing_oauth_tokens(self):
        class Response:
            status = 200

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self, _limit):
                return json.dumps(
                    {
                        "five_hour": {
                            "utilization": 44,
                            "resets_at": "2026-07-14T18:39:59+00:00",
                        },
                        "seven_day": {
                            "utilization": 5,
                            "resets_at": "2026-07-16T19:59:59+00:00",
                        },
                    }
                ).encode()

        with patch.object(
            server.urlrequest, "urlopen", return_value=Response()
        ) as urlopen:
            usage = server.fetch_claude_usage("unit-test-access-token")

        request = urlopen.call_args.args[0]
        self.assertEqual(
            request.get_header("Authorization"), "Bearer unit-test-access-token"
        )
        self.assertEqual(request.get_header("Anthropic-beta"), "oauth-2025-04-20")
        self.assertEqual(usage["primary"]["usedPercent"], 44)
        self.assertEqual(usage["secondary"]["usedPercent"], 5)
        self.assertNotIn(
            "unit-test-access-token", json.dumps(usage, default=server.encode)
        )

    def test_claude_account_reports_plan_and_rate_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / ".claude"
            home.mkdir()
            write_claude_credentials(home)
            server.CLAUDE_USAGE_CACHE = {
                "expires_at": 0.0,
                "credential": None,
                "data": None,
            }
            with (
                patch.object(server, "CLAUDE_HOME_RAW", str(home)),
                patch.object(server, "configured_secret", return_value=""),
                patch.object(server, "fetch_claude_usage", return_value=claude_usage()),
            ):
                result = server.fetch_claude_accounts(force=True)

        account = result["accounts"][0]
        self.assertEqual(account["plan"], "max")
        self.assertEqual(account["rateLimits"]["primary"]["usedPercent"], 44)
        self.assertEqual(account["rateLimits"]["secondary"]["usedPercent"], 5)
        self.assertEqual(account["statusKind"], "available")
        self.assertEqual(result["stale"], 0)

    def test_claude_account_reports_rate_limit_reached(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / ".claude"
            home.mkdir()
            write_claude_credentials(home)
            server.CLAUDE_USAGE_CACHE = {
                "expires_at": 0.0,
                "credential": None,
                "data": None,
            }
            with (
                patch.object(server, "CLAUDE_HOME_RAW", str(home)),
                patch.object(server, "configured_secret", return_value=""),
                patch.object(
                    server, "fetch_claude_usage", return_value=claude_usage(primary=100)
                ),
            ):
                result = server.fetch_claude_accounts(force=True)

        self.assertEqual(result["limited"], 1)
        self.assertEqual(result["accounts"][0]["statusKind"], "limited")

    def test_claude_rejected_login_requires_sign_in_without_usage_limits(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / ".claude"
            home.mkdir()
            write_claude_credentials(home)
            server.CLAUDE_USAGE_CACHE = {
                "expires_at": 0.0,
                "credential": None,
                "data": None,
            }
            with (
                patch.object(server, "CLAUDE_HOME_RAW", str(home)),
                patch.object(server, "configured_secret", return_value=""),
                patch.object(
                    server,
                    "fetch_claude_usage",
                    return_value={
                        "checkedAt": "2026-07-14T15:00:00+00:00",
                        "statusCode": 401,
                        "error": "Claude usage returned HTTP 401",
                    },
                ) as fetch_usage,
            ):
                result = server.fetch_claude_accounts(force=True)
                cached_result = server.fetch_claude_accounts(force=True)

        fetch_usage.assert_called_once_with("unit-test-access-token")
        self.assertEqual(cached_result["stale"], 0)
        self.assertEqual(result["stale"], 0)
        account = result["accounts"][0]
        self.assertFalse(account["active"])
        self.assertIsNone(account["rateLimits"])
        self.assertEqual(account["status"], "sign-in required")
        self.assertEqual(account["statusKind"], "expired")
        self.assertEqual(
            account["authError"],
            "Claude rejected the saved login (HTTP 401). "
            "Sign in to Claude again to renew this account.",
        )

    def test_expired_claude_oauth_requires_sign_in_even_without_usage_probe(self):
        oauth = {"expiresAt": 1_700_000_000_000}

        self.assertEqual(
            server.claude_auth_error(oauth, None),
            "Claude's saved OAuth login has expired. "
            "Sign in to Claude again to renew this account.",
        )

    def test_claude_usage_failure_keeps_last_successful_limits_as_stale(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / ".claude"
            home.mkdir()
            write_claude_credentials(home)
            server.CLAUDE_USAGE_CACHE = {
                "expires_at": 0.0,
                "credential": None,
                "data": None,
            }
            with (
                patch.object(server, "CLAUDE_HOME_RAW", str(home)),
                patch.object(server, "configured_secret", return_value=""),
                patch.object(
                    server,
                    "fetch_claude_usage",
                    side_effect=[
                        claude_usage(),
                        {
                            "checkedAt": "2026-07-14T15:01:00+00:00",
                            "error": "Claude usage check failed (TimeoutError)",
                        },
                    ],
                ),
            ):
                server.fetch_claude_accounts(force=True)
                server.CLAUDE_USAGE_CACHE["expires_at"] = 0.0
                result = server.fetch_claude_accounts(force=True)

        account = result["accounts"][0]
        self.assertEqual(result["stale"], 1)
        self.assertEqual(account["statusKind"], "stale")
        self.assertEqual(account["rateLimits"]["primary"]["usedPercent"], 44)

    def test_openrouter_account_reports_sanitized_credit_and_key_metadata(self):
        payload = {
            "label": "unit-test-key-label",
            "limit": 500,
            "limit_remaining": 55.41,
            "limit_reset": None,
            "usage": 444.59,
            "usage_daily": 0.53,
            "usage_weekly": 1.25,
            "usage_monthly": 397.88,
            "byok_usage": 0,
            "include_byok_in_limit": False,
            "is_free_tier": False,
            "is_provisioning_key": False,
            "is_management_key": False,
            "expires_at": None,
            "rate_limit": {"note": "deprecated and safe to ignore"},
            "creator_user_id": "must-not-leak",
        }
        server.OPENROUTER_KEY_CACHE = {
            "expires_at": 0.0,
            "credential": None,
            "data": None,
        }
        with (
            patch.dict(
                server.os.environ,
                {"EXECUTOR_VIEW_OPENROUTER_REMOTE_CHECK": "1"},
            ),
            patch.object(
                server,
                "configured_secret",
                side_effect=lambda name: (
                    "unit-test-api-key" if name == "OPENROUTER_API_KEY" else None
                ),
            ),
            patch.object(
                server,
                "fetch_openrouter_key_info",
                return_value={
                    "checkedAt": "2026-07-14T16:00:00+00:00",
                    "statusCode": 200,
                    "data": payload,
                },
            ) as fetch_key_info,
        ):
            result = server.fetch_openrouter_accounts(force=True)
            cached_result = server.fetch_openrouter_accounts(force=True)

        account = result["accounts"][0]
        fetch_key_info.assert_called_once_with("unit-test-api-key")
        self.assertEqual(cached_result["accounts"][0]["credit"], account["credit"])
        self.assertEqual(account["status"], "verified")
        self.assertAlmostEqual(account["credit"]["usedPercent"], 88.918)
        self.assertEqual(account["credit"]["dailyUsage"], 0.53)
        serialized = json.dumps(result, default=server.encode)
        self.assertNotIn("unit-test-api-key", serialized)
        self.assertNotIn("must-not-leak", serialized)
        self.assertNotIn("deprecated", serialized)

    def test_managed_openrouter_key_overrides_environment_and_disable_is_sticky(self):
        with tempfile.TemporaryDirectory() as directory:
            credential_path = Path(directory) / "providers.json"
            credential_path.write_text(
                json.dumps(
                    {
                        "version": 1,
                        "credentials": {"openrouter": "managed-key"},
                    }
                ),
                encoding="utf-8",
            )
            with (
                patch.object(server, "PROVIDER_CREDENTIALS_PATH", credential_path),
                patch.dict(server.os.environ, {"OPENROUTER_API_KEY": "initial-key"}),
            ):
                self.assertEqual(
                    server.configured_secret("OPENROUTER_API_KEY"), "managed-key"
                )

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
            with (
                patch.object(server, "PROVIDER_CREDENTIALS_PATH", credential_path),
                patch.dict(server.os.environ, {"OPENROUTER_API_KEY": "initial-key"}),
            ):
                self.assertIsNone(server.configured_secret("OPENROUTER_API_KEY"))


if __name__ == "__main__":
    unittest.main()

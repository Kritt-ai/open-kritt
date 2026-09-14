"""Synthetic account inventory checks; no credential probes or database access."""

import unittest
from pathlib import Path
from unittest.mock import patch

import server


class AccountActivityInventoryTests(unittest.TestCase):
    def test_claude_key_is_distinct_from_login_and_never_marks_login_authenticated(
        self,
    ):
        login = {"path": "/sample/login", "active": False, "statusKind": "expired"}
        with (
            patch.object(server, "configured_secret", return_value="synthetic-key"),
            patch.object(
                server, "configured_claude_homes", return_value=[Path("/sample/login")]
            ),
            patch.object(
                server, "current_claude_home_raw", return_value="/sample/login"
            ),
            patch.object(server, "claude_account", return_value=login) as probe,
        ):
            inventory = server.fetch_claude_accounts()
        probe.assert_called_once_with(Path("/sample/login"), force=False)
        self.assertEqual(inventory["accounts"][0], login)
        self.assertEqual(inventory["accounts"][1]["path"], "ANTHROPIC_API_KEY")
        self.assertEqual(inventory["active"], 1)
        self.assertNotIn("synthetic-key", str(inventory))

    def test_key_only_inventory_does_not_invent_a_login(self):
        with (
            patch.object(server, "configured_secret", return_value="synthetic-key"),
            patch.object(server, "configured_claude_homes", return_value=[]),
            patch.object(server, "current_claude_home_raw", return_value=""),
            patch.object(server, "claude_account") as probe,
        ):
            inventory = server.fetch_claude_accounts()
        probe.assert_not_called()
        self.assertEqual(inventory["total"], 1)
        self.assertEqual(inventory["accounts"][0]["path"], "ANTHROPIC_API_KEY")

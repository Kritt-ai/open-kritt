"""Keep the engine's global Codex CLI current without interrupting scans."""

from __future__ import annotations

import logging
import re
import subprocess
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass

LOGGER = logging.getLogger("open_kritt_engine")
CODEX_PACKAGE = "@openai/codex@latest"


class CodexCliGate:
    """Prevent a global npm upgrade from racing a Codex subprocess."""

    def __init__(self):
        self._condition = threading.Condition()
        self._active_uses = 0
        self._updating = False

    @contextmanager
    def use(self) -> Iterator[None]:
        with self._condition:
            while self._updating:
                self._condition.wait()
            self._active_uses += 1
        try:
            yield
        finally:
            with self._condition:
                self._active_uses -= 1
                self._condition.notify_all()

    def try_begin_update(self) -> bool:
        """Acquire the exclusive side only when Codex is currently idle."""
        with self._condition:
            if self._updating or self._active_uses:
                return False
            self._updating = True
            return True

    def end_update(self) -> None:
        with self._condition:
            self._updating = False
            self._condition.notify_all()


@dataclass(frozen=True)
class CodexUpdateResult:
    attempted: bool
    succeeded: bool
    updated: bool
    before_version: str | None
    after_version: str | None


class CodexUpdater:
    """Install the latest Codex npm package and retain the prior CLI on failure."""

    def __init__(
        self,
        *,
        timeout_seconds: float = 120.0,
        gate: CodexCliGate | None = None,
        run_command=subprocess.run,
    ):
        self.timeout_seconds = max(1.0, float(timeout_seconds))
        self.gate = gate or CodexCliGate()
        self._run_command = run_command

    def update(self) -> CodexUpdateResult:
        if not self.gate.try_begin_update():
            return CodexUpdateResult(
                attempted=False,
                succeeded=False,
                updated=False,
                before_version=None,
                after_version=None,
            )

        before_version = None
        try:
            before_version = self._version()
            try:
                completed = self._run_command(
                    ["npm", "install", "--global", "--no-audit", "--no-fund", CODEX_PACKAGE],
                    capture_output=True,
                    check=False,
                    text=True,
                    timeout=self.timeout_seconds,
                )
            except subprocess.TimeoutExpired:
                LOGGER.warning("Codex CLI update timed out after %s seconds", int(self.timeout_seconds))
                return CodexUpdateResult(True, False, False, before_version, None)
            except OSError:
                LOGGER.warning("could not start the Codex CLI update")
                return CodexUpdateResult(True, False, False, before_version, None)

            if completed.returncode != 0:
                LOGGER.warning("Codex CLI update failed (npm exited with status %s)", completed.returncode)
                return CodexUpdateResult(True, False, False, before_version, None)

            after_version = self._version()
            if not after_version:
                LOGGER.warning("Codex CLI update completed but the installed CLI could not start")
                return CodexUpdateResult(True, False, False, before_version, None)

            updated = before_version != after_version
            if updated:
                LOGGER.info("updated Codex CLI from %s to %s", before_version or "unknown", after_version)
            else:
                LOGGER.info("Codex CLI is already up to date (%s)", after_version)
            return CodexUpdateResult(True, True, updated, before_version, after_version)
        finally:
            self.gate.end_update()

    def _version(self) -> str | None:
        try:
            completed = self._run_command(
                ["codex", "--version"],
                capture_output=True,
                check=False,
                text=True,
                timeout=min(self.timeout_seconds, 15.0),
            )
        except (OSError, subprocess.TimeoutExpired):
            return None
        if completed.returncode != 0:
            return None
        match = re.search(r"\b(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b", completed.stdout or "")
        return match.group(1) if match else None

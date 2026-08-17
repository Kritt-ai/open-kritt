import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from queue import Empty, Queue
from threading import Thread
from time import monotonic, sleep
from typing import Protocol

from .errors import TimeoutError, TransportError
from .streaming import CancellationToken, StreamEvent
from .types import ProgressCallback


@dataclass(frozen=True)
class ProcessResult:
    stdout: str
    stderr: str
    returncode: int
    elapsed_ms: float


class ProcessRunner(Protocol):
    def which(self, names: tuple[str, ...], path: str | None = None) -> str | None:
        ...

    def run(
        self,
        command: list[str],
        *,
        input_text: str,
        cwd: str | None,
        timeout_seconds: int,
        env: dict[str, str] | None,
    ) -> ProcessResult:
        ...

    def run_stream(
        self,
        command: list[str],
        *,
        input_text: str,
        cwd: str | None,
        timeout_seconds: int,
        env: dict[str, str] | None,
        callback: ProgressCallback,
        cancellation_token: CancellationToken | None,
    ) -> ProcessResult:
        ...


class SubprocessRunner:
    def which(self, names: tuple[str, ...], path: str | None = None) -> str | None:
        for key in _executable_env_keys(names):
            configured = os.environ.get(key)
            if configured and Path(configured).is_file():
                return str(Path(configured))
        search_path = path if path is not None else os.environ.get("PATH")
        candidate_dirs = _candidate_dirs(search_path)
        for name in names:
            found = shutil.which(name, path=os.pathsep.join(candidate_dirs))
            if found:
                return found
            for candidate in _executable_candidates(name, candidate_dirs):
                if candidate.is_file():
                    return str(candidate)
        return None

    def run(
        self,
        command: list[str],
        *,
        input_text: str,
        cwd: str | None,
        timeout_seconds: int,
        env: dict[str, str] | None,
    ) -> ProcessResult:
        started = monotonic()
        try:
            proc = subprocess.run(
                command,
                input=input_text,
                cwd=cwd,
                env=env,
                text=True,
                capture_output=True,
                timeout=max(1, timeout_seconds),
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(stdout=exc.stdout, stderr=exc.stderr) from exc
        except OSError as exc:
            raise TransportError(str(exc)) from exc
        return ProcessResult(
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
            returncode=proc.returncode,
            elapsed_ms=round((monotonic() - started) * 1000, 3),
        )

    def run_stream(
        self,
        command: list[str],
        *,
        input_text: str,
        cwd: str | None,
        timeout_seconds: int,
        env: dict[str, str] | None,
        callback: ProgressCallback,
        cancellation_token: CancellationToken | None,
    ) -> ProcessResult:
        if cancellation_token is not None and cancellation_token.cancelled():
            callback(StreamEvent(kind="cancelled"))
            return ProcessResult(stdout="", stderr="", returncode=130, elapsed_ms=0.0)
        started = monotonic()
        events: Queue[StreamEvent] = Queue()
        stdout_chunks: list[str] = []
        stderr_chunks: list[str] = []
        try:
            proc = subprocess.Popen(
                command,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=cwd,
                env=env,
                text=True,
                bufsize=1,
            )
        except OSError as exc:
            raise TransportError(str(exc)) from exc

        writer = Thread(target=_write_stdin, args=(proc, input_text), daemon=True)
        stdout_reader = Thread(target=_read_stream, args=(proc.stdout, "stdout", stdout_chunks, events), daemon=True)
        stderr_reader = Thread(target=_read_stream, args=(proc.stderr, "stderr", stderr_chunks, events), daemon=True)
        writer.start()
        stdout_reader.start()
        stderr_reader.start()

        timeout = max(1, timeout_seconds)
        cancelled = False
        try:
            while proc.poll() is None:
                _drain_events(events, callback)
                if cancellation_token is not None and cancellation_token.cancelled():
                    cancelled = True
                    _terminate_process(proc)
                    break
                if monotonic() - started > timeout:
                    _terminate_process(proc)
                    _join_threads(writer, stdout_reader, stderr_reader)
                    raise TimeoutError(stdout="".join(stdout_chunks), stderr="".join(stderr_chunks))
                sleep(0.05)

            _join_threads(writer, stdout_reader, stderr_reader)
            _drain_events(events, callback)
            elapsed_ms = round((monotonic() - started) * 1000, 3)
            if cancelled:
                callback(StreamEvent(kind="cancelled"))
                return ProcessResult(
                    stdout="".join(stdout_chunks),
                    stderr="".join(stderr_chunks),
                    returncode=proc.returncode if proc.returncode is not None else 130,
                    elapsed_ms=elapsed_ms,
                )
            returncode = proc.returncode if proc.returncode is not None else 0
            callback(StreamEvent(kind="completed", data={"returncode": returncode}))
            return ProcessResult(
                stdout="".join(stdout_chunks),
                stderr="".join(stderr_chunks),
                returncode=returncode,
                elapsed_ms=elapsed_ms,
            )
        except BaseException:
            _terminate_process(proc)
            _join_threads(writer, stdout_reader, stderr_reader)
            raise


def _write_stdin(proc: subprocess.Popen, input_text: str) -> None:
    if proc.stdin is None:
        return
    try:
        proc.stdin.write(input_text)
        proc.stdin.close()
    except OSError:
        return


def _read_stream(pipe, kind: str, chunks: list[str], events: Queue[StreamEvent]) -> None:
    if pipe is None:
        return
    try:
        for chunk in iter(pipe.readline, ""):
            if not chunk:
                break
            chunks.append(chunk)
            events.put(StreamEvent(kind=kind, text=chunk))
    finally:
        pipe.close()


def _drain_events(events: Queue[StreamEvent], callback: ProgressCallback) -> None:
    while True:
        try:
            callback(events.get_nowait())
        except Empty:
            return


def _join_threads(*threads: Thread) -> None:
    for thread in threads:
        thread.join(timeout=1)


def _terminate_process(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            return


def _candidate_dirs(path: str | None) -> list[str]:
    home = Path(os.environ.get("HOME") or os.environ.get("USERPROFILE") or str(Path.home()))
    dirs = [entry for entry in (path or "").split(os.pathsep) if entry]
    dirs.extend(_npm_global_bins())
    dirs.extend([str(home / ".local" / "bin"), str(home / "bin")])
    if os.name == "nt":
        appdata = os.environ.get("APPDATA") or str(home / "AppData" / "Roaming")
        localappdata = os.environ.get("LOCALAPPDATA") or str(home / "AppData" / "Local")
        dirs.extend(
            [
                str(Path(appdata) / "npm"),
                str(Path(localappdata) / "Programs"),
                str(Path(localappdata) / "Programs" / "OpenAI" / "Codex" / "bin"),
                str(Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "nodejs"),
                str(Path(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")) / "nodejs"),
                str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"),
            ]
        )
    else:
        dirs.extend(["/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin", "/snap/bin"])
        if Path("/mnt/c/Users").exists():
            user = home.name
            dirs.extend(
                [
                    f"/mnt/c/Users/{user}/AppData/Roaming/npm",
                    f"/mnt/c/Users/{user}/AppData/Local/Programs/OpenAI/Codex/bin",
                    "/mnt/c/Program Files/nodejs",
                    "/mnt/c/Program Files (x86)/nodejs",
                ]
            )
    result: list[str] = []
    for item in dirs:
        text = str(Path(item).expanduser())
        if text and text not in result:
            result.append(text)
    return result


def _npm_global_bins() -> list[str]:
    npm = "npm.cmd" if os.name == "nt" else "npm"
    result: list[str] = []
    for args in ((npm, "bin", "-g"), (npm, "prefix", "-g")):
        try:
            proc = subprocess.run(args, text=True, capture_output=True, timeout=3, check=False)
        except (OSError, subprocess.TimeoutExpired):
            continue
        value = proc.stdout.strip()
        if not value:
            continue
        if args[1] == "prefix" and os.name != "nt":
            value = str(Path(value) / "bin")
        result.append(value)
    return result


def _executable_candidates(name: str, dirs: list[str]) -> list[Path]:
    path = Path(name)
    if path.is_absolute() or path.parent != Path("."):
        return [path]
    extensions = ["", ".cmd", ".exe", ".bat", ".ps1"] if os.name == "nt" and not path.suffix else [""]
    return [Path(directory) / f"{name}{extension}" for directory in dirs for extension in extensions]


def _executable_env_keys(names: tuple[str, ...]) -> tuple[str, ...]:
    lowered = {name.lower() for name in names}
    keys: list[str] = []
    if "codex" in lowered:
        keys.extend(["OPEN_KRITT_CODEX_BIN", "CODEX_BIN", "CODEX_CLI_PATH"])
    if "claude" in lowered:
        keys.extend(["OPEN_KRITT_CLAUDE_BIN", "CLAUDE_BIN", "CLAUDE_CLI_PATH"])
    return tuple(keys)

import fcntl
import logging
import os
import re
import shutil
import stat
import subprocess
import tempfile
import threading
from contextlib import contextmanager
from pathlib import Path

REPO_FULL_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
COMMIT_SHA_RE = re.compile(r"^[0-9a-fA-F]{7,64}$")
_THREAD_LOCKS: dict[str, threading.Lock] = {}
_THREAD_LOCKS_GUARD = threading.Lock()
LOGGER = logging.getLogger("open_kritt_engine.repository")
LOCAL_SNAPSHOT_REVISION = "LOCAL_SNAPSHOT"
GIT_ENV_KEYS = frozenset(
    {
        "PATH",
        "HOME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "GIT_SSL_CAINFO",
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


class RepoError(RuntimeError):
    pass


def normalize_repo_full(repo_full: str) -> str:
    raw = (repo_full or "").strip()
    if REPO_FULL_RE.match(raw):
        return raw.removesuffix(".git")
    match = re.match(r"^https://github\.com/([^/]+)/([^/#?]+?)(?:\.git)?/?(?:[#?].*)?$", raw)
    if match:
        return f"{match.group(1)}/{match.group(2)}"
    return raw


def safe_repo_dir(base_dir: str, repo_full: str) -> str:
    normalized = normalize_repo_full(repo_full)
    if not REPO_FULL_RE.match(normalized):
        raise RepoError(f"repo_full must be GitHub owner/repo, got {repo_full!r}")
    owner, repo = normalized.split("/", 1)
    return str(Path(base_dir) / f"{owner}__{repo}")


def _run(cmd, cwd=None, env=None):
    actual_cmd = _authenticated_git_command(cmd, env)
    proc = subprocess.run(actual_cmd, cwd=cwd, env=env, text=True, capture_output=True, check=False)
    if proc.returncode != 0:
        msg = _redact_git_secrets((proc.stderr or proc.stdout or "").strip(), env)
        command = _redact_git_secrets(" ".join(actual_cmd), env)
        raise RepoError(f"{command} failed: {msg[-2000:]}")
    return proc.stdout.strip()


def _authenticated_git_command(cmd: list[str], env: dict[str, str] | None) -> list[str]:
    if not cmd or Path(cmd[0]).name != "git" or not (env or {}).get("GITHUB_TOKEN"):
        return cmd
    askpass = (env or {}).get("GIT_ASKPASS")
    config = ["-c", "credential.helper="]
    if askpass:
        config.extend(["-c", f"core.askPass={askpass}"])
    return [cmd[0], *config, *cmd[1:]]


def _redact_git_secrets(value: str, env: dict[str, str] | None = None) -> str:
    redacted = re.sub(r"(?i)(https?://[^\s/:@]+:)[^\s@]+(@)", r"\1[REDACTED]\2", value)
    token = (env or {}).get("GITHUB_TOKEN")
    if token:
        redacted = redacted.replace(token, "[REDACTED]")
    return redacted


@contextmanager
def _github_auth_environment(github_token: str | None):
    if not github_token:
        yield None
        return
    with tempfile.TemporaryDirectory(prefix="open-kritt-git-auth-") as directory:
        auth_root = Path(directory)
        askpass = auth_root / "askpass.sh"
        xdg_config = auth_root / "xdg-config"
        xdg_config.mkdir(mode=0o700)
        askpass.write_text(
            "#!/bin/sh\n"
            'case "$1" in\n'
            "  *Username*) printf '%s\\n' 'x-access-token' ;;\n"
            "  *) printf '%s\\n' \"$GITHUB_TOKEN\" ;;\n"
            "esac\n",
            encoding="utf-8",
        )
        askpass.chmod(0o700)
        env = {
            **{key: value for key in GIT_ENV_KEYS if (value := os.environ.get(key))},
            "HOME": str(auth_root),
            "XDG_CONFIG_HOME": str(xdg_config),
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_ASKPASS": str(askpass),
            "GIT_ASKPASS_REQUIRE": "force",
            "GIT_TERMINAL_PROMPT": "0",
            "GITHUB_TOKEN": github_token,
        }
        yield env


def _thread_lock(lock_path: Path) -> threading.Lock:
    key = str(lock_path)
    with _THREAD_LOCKS_GUARD:
        lock = _THREAD_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _THREAD_LOCKS[key] = lock
        return lock


def github_clone_url(repo_full: str, github_token: str | None = None) -> str:
    repo_full = normalize_repo_full(repo_full)
    return f"https://github.com/{repo_full}.git"


def resolve_remote_head(repo_full: str, github_token: str | None = None) -> str:
    """Resolve a repository's current HEAD without persisting credentials."""

    normalized = normalize_repo_full(repo_full)
    if not REPO_FULL_RE.fullmatch(normalized):
        raise RepoError(f"repo_full must be GitHub owner/repo, got {repo_full!r}")
    url = github_clone_url(normalized)
    with _github_auth_environment(github_token) as git_env:
        output = _run(["git", "ls-remote", "--exit-code", url, "HEAD"], env=git_env)
    line = next((part for part in output.splitlines() if part.strip()), "")
    commit = line.split(maxsplit=1)[0] if line else ""
    if not re.fullmatch(r"[0-9a-fA-F]{40,64}", commit):
        raise RepoError(f"could not resolve HEAD for {normalized}")
    return commit.lower()


def checkout_repo(repo_full: str, commit_sha: str, base_dir: str, github_token: str | None = None) -> tuple[str, str]:
    os.makedirs(base_dir, exist_ok=True)
    repo_dir = safe_repo_dir(base_dir, repo_full)
    lock_dir = Path(base_dir) / ".locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_path = lock_dir / f"{Path(repo_dir).name}.lock"

    with _thread_lock(lock_path):
        with open(lock_path, "w") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            url = github_clone_url(repo_full)
            target = commit_sha or "HEAD"
            had_checkout = os.path.isdir(os.path.join(repo_dir, ".git"))
            exact_commit = bool(COMMIT_SHA_RE.fullmatch(target))

            with _github_auth_environment(github_token) as git_env:
                if had_checkout:
                    _run(["git", "remote", "set-url", "origin", url], cwd=repo_dir)
                elif not exact_commit:
                    _run(["git", "clone", "--no-tags", url, repo_dir], env=git_env)
                else:
                    Path(repo_dir).mkdir(parents=True, exist_ok=True)
                    _run(["git", "-c", "init.defaultBranch=main", "init", "--quiet"], cwd=repo_dir)
                    _run(["git", "remote", "add", "origin", url], cwd=repo_dir)

                if target == "HEAD":
                    if had_checkout:
                        _run(["git", "fetch", "--prune", "--no-tags", "origin"], cwd=repo_dir, env=git_env)
                    _run(["git", "checkout", "origin/HEAD"], cwd=repo_dir)
                elif exact_commit:
                    if not _has_commit(repo_dir, target):
                        try:
                            _run(
                                ["git", "fetch", "--depth=1", "--no-tags", "origin", target],
                                cwd=repo_dir,
                                env=git_env,
                            )
                        except RepoError as exc:
                            LOGGER.info("shallow fetch for %s failed; falling back to a full fetch: %s", target, exc)
                            _fetch_full_history(repo_dir, env=git_env)
                    _run(["git", "checkout", "--detach", target], cwd=repo_dir)
                else:
                    if had_checkout:
                        _run(["git", "fetch", "--prune", "--no-tags", "origin"], cwd=repo_dir, env=git_env)
                    _run(["git", "checkout", target], cwd=repo_dir)
                checked_out = _run(["git", "rev-parse", "HEAD"], cwd=repo_dir)
                return repo_dir, checked_out


def _has_commit(repo_dir: str, target: str) -> bool:
    proc = subprocess.run(
        ["git", "cat-file", "-e", f"{target}^{{commit}}"],
        cwd=repo_dir,
        text=True,
        capture_output=True,
        check=False,
    )
    return proc.returncode == 0


def _fetch_full_history(repo_dir: str, env: dict[str, str] | None = None) -> None:
    cmd = ["git", "fetch"]
    if os.path.isfile(os.path.join(repo_dir, ".git", "shallow")):
        cmd.append("--unshallow")
    cmd.extend(["--prune", "--no-tags", "origin"])
    _run(cmd, cwd=repo_dir, env=env)


def copy_checkout(src_dir: str, dest_dir: str, *, shared: bool = False, hardlink: bool = False) -> tuple[str, str]:
    if not os.path.isdir(os.path.join(src_dir, ".git")):
        raise RepoError(f"source checkout is not a git repository: {src_dir}")
    if os.path.exists(dest_dir):
        shutil.rmtree(dest_dir, ignore_errors=True)
    Path(dest_dir).parent.mkdir(parents=True, exist_ok=True)
    if hardlink:
        try:
            _run(["cp", "-al", src_dir, dest_dir])
            checked_out = _run(["git", "rev-parse", "HEAD"], cwd=dest_dir)
            return dest_dir, checked_out
        except RepoError as exc:
            LOGGER.info("hardlink checkout copy failed; falling back to git clone: %s", exc)
            if os.path.exists(dest_dir):
                shutil.rmtree(dest_dir, ignore_errors=True)
    cmd = ["git", "clone", "--quiet"]
    if shared:
        cmd.append("--shared")
    else:
        cmd.append("--no-hardlinks")
    cmd.extend([src_dir, dest_dir])
    _run(cmd)
    checked_out = _run(["git", "rev-parse", "HEAD"], cwd=dest_dir)
    return dest_dir, checked_out


def copy_checkout_locked(
    src_dir: str, dest_dir: str, *, shared: bool = False, hardlink: bool = False
) -> tuple[str, str]:
    src = Path(src_dir)
    lock_dir = src.parent / ".locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_path = lock_dir / f"{src.name}.lock"
    with _thread_lock(lock_path):
        with open(lock_path, "w") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            return copy_checkout(src_dir, dest_dir, shared=shared, hardlink=hardlink)


def snapshot_local_repo(
    repo_name: str,
    base_dir: str,
    local_repos_path: str | None = None,
) -> tuple[str, str]:
    try:
        source_root = Path(local_repos_path or os.getenv("LOCAL_REPOS_PATH") or "/local_repos").resolve(strict=True)
    except (OSError, RuntimeError) as exc:
        raise RepoError("LOCAL_REPOS_PATH is not an accessible directory") from exc
    name = str(repo_name or "").strip()
    if not name or Path(name).is_absolute() or Path(name).name != name or name in {".", ".."}:
        raise RepoError("local repository must be one folder directly under LOCAL_REPOS_PATH")

    os.makedirs(base_dir, exist_ok=True)
    repo_dir = Path(base_dir) / _safe_path_part(name)
    lock_dir = Path(base_dir) / ".locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_path = lock_dir / f"{repo_dir.name}.lock"

    with _thread_lock(lock_path):
        with open(lock_path, "w") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            source_fd = _open_local_repository(source_root, name)
            try:
                _copy_local_tree_from_fd(source_fd, repo_dir, source_root / name)
                return str(repo_dir), LOCAL_SNAPSHOT_REVISION
            finally:
                os.close(source_fd)


def copy_local_snapshot(src_dir: str, dest_dir: str) -> tuple[str, str]:
    source = Path(src_dir)
    destination = Path(dest_dir)
    destination.parent.mkdir(parents=True, exist_ok=True)
    source_fd = _open_pinned_directory(source, f"local snapshot source {src_dir}")
    try:
        _copy_local_tree_from_fd(source_fd, destination, source)
    finally:
        os.close(source_fd)
    return str(destination), LOCAL_SNAPSHOT_REVISION


def _open_local_repository(source_root: Path, name: str) -> int:
    root_fd = _open_pinned_directory(source_root, f"local repository root {source_root}")
    try:
        try:
            source_stat = os.stat(name, dir_fd=root_fd, follow_symlinks=False)
        except OSError as exc:
            raise RepoError(f"local repository {name!r} was not found under {source_root}") from exc
        if stat.S_ISLNK(source_stat.st_mode):
            raise RepoError(f"local repository {name!r} must not be a symbolic link")
        if not stat.S_ISDIR(source_stat.st_mode):
            raise RepoError(f"local repository {name!r} must be one folder directly under {source_root}")
        return _open_pinned_entry(
            root_fd,
            name,
            source_stat,
            directory=True,
            label=f"local repository {name!r}",
        )
    finally:
        os.close(root_fd)


def _open_pinned_directory(path: Path, label: str) -> int:
    try:
        path_stat = path.lstat()
    except OSError as exc:
        raise RepoError(f"{label} is not an accessible directory") from exc
    if stat.S_ISLNK(path_stat.st_mode) or not stat.S_ISDIR(path_stat.st_mode):
        raise RepoError(f"{label} is not a directory")
    flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise RepoError(f"{label} is not an accessible directory") from exc
    opened_stat = os.fstat(descriptor)
    if not _same_entry(path_stat, opened_stat) or not stat.S_ISDIR(opened_stat.st_mode):
        os.close(descriptor)
        raise RepoError(f"{label} changed while it was being opened")
    return descriptor


def _open_pinned_entry(
    parent_fd: int,
    name: str,
    expected_stat: os.stat_result,
    *,
    directory: bool,
    label: str,
) -> int:
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    if directory:
        flags |= getattr(os, "O_DIRECTORY", 0)
    try:
        descriptor = os.open(name, flags, dir_fd=parent_fd)
    except OSError as exc:
        raise RepoError(f"{label} changed or became inaccessible while it was being snapshotted") from exc
    opened_stat = os.fstat(descriptor)
    expected_type = stat.S_ISDIR if directory else stat.S_ISREG
    if not _same_entry(expected_stat, opened_stat) or not expected_type(opened_stat.st_mode):
        os.close(descriptor)
        raise RepoError(f"{label} changed while it was being snapshotted")
    return descriptor


def _copy_local_tree_from_fd(source_fd: int, destination: Path, source_label: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    staging = Path(
        tempfile.mkdtemp(
            prefix=f".{destination.name}.snapshot-",
            dir=destination.parent,
        )
    )
    source_stat = os.fstat(source_fd)
    try:
        _copy_local_directory(source_fd, staging, source_label)
        if _directory_changed(source_stat, os.fstat(source_fd)):
            raise RepoError(f"local repository {source_label} changed while it was being snapshotted")
        _validate_local_tree(staging)
        _make_snapshot_readable(staging)
        if destination.exists() or destination.is_symlink():
            _remove_path(destination)
        os.replace(staging, destination)
    except Exception:
        _remove_path(staging)
        raise


def _copy_local_directory(source_fd: int, destination: Path, source_label: Path) -> None:
    try:
        names = sorted(os.listdir(source_fd))
    except OSError as exc:
        raise RepoError(f"could not read local repository directory {source_label}") from exc

    for name in names:
        if name == ".git":
            continue
        source_path = source_label / name
        destination_path = destination / name
        try:
            entry_stat = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        except OSError as exc:
            raise RepoError(f"could not inspect local repository entry {source_path}") from exc

        if stat.S_ISLNK(entry_stat.st_mode):
            _copy_local_symlink(source_fd, name, entry_stat, destination_path, source_path)
        elif stat.S_ISDIR(entry_stat.st_mode):
            child_fd = _open_pinned_entry(
                source_fd,
                name,
                entry_stat,
                directory=True,
                label=f"local repository directory {source_path}",
            )
            destination_path.mkdir(mode=0o755)
            try:
                _copy_local_directory(child_fd, destination_path, source_path)
                if _directory_changed(entry_stat, os.fstat(child_fd)):
                    raise RepoError(f"local repository directory {source_path} changed while it was being snapshotted")
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(entry_stat.st_mode):
            _copy_local_file(source_fd, name, entry_stat, destination_path, source_path)
        else:
            raise RepoError(f"local repository contains an unsupported special file: {source_path}")


def _copy_local_symlink(
    source_fd: int,
    name: str,
    entry_stat: os.stat_result,
    destination: Path,
    source_label: Path,
) -> None:
    try:
        target = os.readlink(name, dir_fd=source_fd)
        current_stat = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
    except OSError as exc:
        raise RepoError(f"could not read local repository symbolic link {source_label}") from exc
    if not _same_entry(entry_stat, current_stat):
        raise RepoError(f"local repository symbolic link {source_label} changed while it was being snapshotted")
    if os.path.isabs(target):
        raise RepoError(f"local repository contains an absolute symbolic link: {source_label}")
    destination.symlink_to(target)


def _copy_local_file(
    source_fd: int,
    name: str,
    entry_stat: os.stat_result,
    destination: Path,
    source_label: Path,
) -> None:
    file_fd = _open_pinned_entry(
        source_fd,
        name,
        entry_stat,
        directory=False,
        label=f"local repository file {source_label}",
    )
    destination_fd = -1
    try:
        destination_fd = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0),
            0o600,
        )
        while True:
            chunk = os.read(file_fd, 1024 * 1024)
            if not chunk:
                break
            view = memoryview(chunk)
            while view:
                written = os.write(destination_fd, view)
                view = view[written:]
        current_stat = os.fstat(file_fd)
        if _file_changed(entry_stat, current_stat):
            raise RepoError(f"local repository file {source_label} changed while it was being snapshotted")
        os.fchmod(destination_fd, 0o755 if entry_stat.st_mode & 0o111 else 0o644)
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    finally:
        os.close(file_fd)
        if destination_fd >= 0:
            os.close(destination_fd)


def _same_entry(first: os.stat_result, second: os.stat_result) -> bool:
    return (
        first.st_dev,
        first.st_ino,
        stat.S_IFMT(first.st_mode),
    ) == (
        second.st_dev,
        second.st_ino,
        stat.S_IFMT(second.st_mode),
    )


def _file_changed(first: os.stat_result, second: os.stat_result) -> bool:
    return not _same_entry(first, second) or (
        first.st_size,
        first.st_mtime_ns,
        first.st_ctime_ns,
    ) != (
        second.st_size,
        second.st_mtime_ns,
        second.st_ctime_ns,
    )


def _directory_changed(first: os.stat_result, second: os.stat_result) -> bool:
    return not _same_entry(first, second) or (
        first.st_mtime_ns,
        first.st_ctime_ns,
    ) != (
        second.st_mtime_ns,
        second.st_ctime_ns,
    )


def _validate_local_tree(source: Path) -> None:
    source_resolved = source.resolve()

    def fail_walk(error: OSError) -> None:
        raise RepoError(f"could not read local repository entry {error.filename or source_resolved}") from error

    for root, dir_names, file_names in os.walk(source_resolved, followlinks=False, onerror=fail_walk):
        dir_names[:] = [name for name in dir_names if name != ".git"]
        for name in [*dir_names, *(name for name in file_names if name != ".git")]:
            path = Path(root) / name
            try:
                mode = path.lstat().st_mode
            except OSError as exc:
                raise RepoError(f"could not inspect local repository entry {path}") from exc
            if stat.S_ISLNK(mode):
                target = os.readlink(path)
                if os.path.isabs(target):
                    raise RepoError(f"local repository contains an absolute symbolic link: {path}")
                try:
                    (path.parent / target).resolve(strict=False).relative_to(source_resolved)
                except (OSError, RuntimeError, ValueError) as exc:
                    raise RepoError(f"local repository contains a symbolic link outside its root: {path}") from exc
                continue
            if not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise RepoError(f"local repository contains an unsupported special file: {path}")


def _make_snapshot_readable(root: Path) -> None:
    for current_root, dir_names, file_names in os.walk(root, followlinks=False):
        current = Path(current_root)
        current.chmod(0o755)
        for name in dir_names:
            path = current / name
            if not path.is_symlink():
                path.chmod(0o755)
        for name in file_names:
            path = current / name
            if path.is_symlink():
                continue
            source_mode = path.stat().st_mode
            path.chmod(0o755 if source_mode & 0o111 else 0o644)


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.exists():
        shutil.rmtree(path, ignore_errors=True)


def _safe_path_part(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value or "")).strip("._-")
    return safe or "repo"

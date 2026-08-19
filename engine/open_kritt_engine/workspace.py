import base64
import copy
import fcntl
import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .claude_auth import CLAUDE_OAUTH_EXPIRY_ENV, prepare_claude_job_credentials
from .provider_credentials import job_environment
from .repository import (
    LOCAL_SNAPSHOT_REVISION,
    checkout_repo,
    copy_checkout,
    copy_local_snapshot,
    normalize_repo_full,
    resolve_remote_head,
    snapshot_local_repo,
)
from .runtime_config import runtime_int, runtime_value
from .workspace_snapshots import (
    WorkspaceSnapshotError,
    ensure_workspace_snapshot_image,
)

_PROVIDER_HOME_LOCK = threading.Lock()
_PROVIDER_HOME_CURSORS: dict[str, int] = {}
_PROVIDER_HOME_KEYS: dict[str, tuple[str, ...]] = {}
_RATE_LIMITED_PROVIDER_HOMES: dict[str, set[str]] = {}
_RATE_LIMITED_PROVIDER_HOME_MARKED_AT: dict[tuple[str, str], float] = {}
_PROVIDER_ACCOUNT_HEALTH_CACHE: dict[tuple[str, str], tuple[float, dict[str, "_ProviderAccountHealth"]]] = {}
_PROVIDER_ACCOUNT_HEALTH_LOCK = threading.Lock()
_PROVIDER_ACCOUNT_GATES: dict[tuple[str, str], "_ProviderAccountGate"] = {}
_PROVIDER_ACCOUNT_GATES_LOCK = threading.Lock()
CACHE_READY_FILENAME = ".open-kritt-ready.json"
CACHE_MARKER_VERSION = 3
RESERVED_WORKSPACE_ENTRIES = {"WORKSPACE.json", "WORKSPACE.md"}
LOGGER = logging.getLogger("open_kritt_engine.workspace")
SCAN_RUNNER_WORKDIR = "/workspace"
SELECTED_AGENT_SKILLS_SLUG = "open-kritt-selected-skills"
OPENROUTER_CODEX_BASE_URL = "https://openrouter.ai/api/v1"
JOB_UID_BASE = 100_000
JOB_UID_SPAN = 2_000_000_000
_SHARED_WORKSPACE_LOCKS: dict[str, threading.Lock] = {}
_SHARED_WORKSPACE_LOCKS_GUARD = threading.Lock()
IMAGE_WORKSPACE_MODES = {"image", "snapshot", "snapshot_image"}


@dataclass(frozen=True)
class JobWorkspace:
    root_dir: str
    repo_base_dir: str
    env: dict[str, str]
    codex_source_home: str | None = None
    codex_account_id: str | None = None
    codex_account_email: str | None = None
    # Provider-neutral identity is written through the database's legacy
    # codex_account_* attribution columns until that schema is generalized.
    provider_account_provider: str | None = None
    provider_account_home: str | None = None
    provider_account_id: str | None = None
    provider_account_email: str | None = None


@dataclass(frozen=True)
class DependencyWorkspace:
    workspace: JobWorkspace
    repo_dir: str
    checked_out_commit: str
    manifest: dict[str, Any]
    layout: str
    manifest_json: str
    setup_timings_ms: dict[str, int] | None = None
    source_repo_dir: str | None = None
    runner_image: str | None = None


@dataclass(frozen=True)
class PreparedWorkspaceTree:
    repo_dir: str
    checked_out_commit: str
    manifest: dict[str, Any]
    layout: str
    manifest_json: str


class _ProviderAccountGate:
    def __init__(self):
        self.condition = threading.Condition()
        self.active = 0


@dataclass(frozen=True)
class _ProviderAccountHealth:
    available: bool
    observed_at: float | None


def image_workspace_enabled(*, data_dir: str | None = None) -> bool:
    mode = runtime_value(
        "ENGINE_POST_PROCESS_WORKSPACE_MODE",
        "copy",
        data_dir=data_dir,
    )
    return str(mode or "copy").strip().lower() in IMAGE_WORKSPACE_MODES


def prepare_job_workspace(
    data_dir: str,
    metadata_id: int,
    agent_skills: list[dict[str, Any]] | None = None,
    harness_name: str | None = None,
    model_provider: str | None = None,
) -> JobWorkspace:
    root = Path(data_dir) / "jobs" / f"metadata-{metadata_id}"
    home = root / "home"
    repo_base = root / "repos"
    for path in (
        home,
        repo_base,
        home / ".config",
        home / ".cache",
        home / ".local" / "share",
        home / ".npm",
    ):
        path.mkdir(parents=True, exist_ok=True)

    selected_harness = harness_name or "codex"
    selected_provider = model_provider or "openrouter"
    codex_home = home / ".codex"
    claude_home = home / ".claude"
    claude_oauth_expires_at_ms = None
    needs_codex_home = selected_harness == "codex"
    needs_claude_home = selected_harness == "claude-code"
    codex_source = (
        provider_home_for_job("codex", metadata_id, data_dir=data_dir)
        if needs_codex_home and selected_provider == "codex"
        else None
    )
    claude_source = (
        provider_home_for_job("claude", metadata_id, data_dir=data_dir)
        if needs_claude_home and selected_provider == "claude"
        else None
    )
    provider_account = (
        _codex_account_info(codex_source)
        if codex_source
        else _claude_account_info(claude_source)
        if claude_source
        else {}
    )
    if needs_codex_home and codex_source:
        _copy_credential_files(Path(codex_source), codex_home, ("auth.json",))
    elif needs_codex_home:
        _prepare_openrouter_codex_home(codex_home)
    if needs_claude_home and selected_provider == "claude":
        claude_oauth_expires_at_ms = prepare_claude_job_credentials(
            Path(claude_source or os.getenv("CLAUDE_HOME", "/root/.claude")),
            claude_home,
            harness_timeout_seconds=_harness_timeout_seconds(data_dir),
        )
        _prepare_claude_config(claude_home)
    elif needs_claude_home:
        # OpenRouter uses an API key and must not inherit Anthropic OAuth,
        # project settings, hooks, or MCP servers from the operator's profile.
        _prepare_claude_config(claude_home)
    if needs_codex_home:
        _install_agent_skills(codex_home, agent_skills or [])
    if needs_claude_home:
        _install_agent_skills(claude_home, agent_skills or [])
    job_uid, job_gid = _job_identity(metadata_id)
    env = job_environment(selected_provider, selected_harness)
    env.update(
        {
            "HOME": str(home),
            "CODEX_HOME": str(codex_home),
            "CLAUDE_HOME": str(claude_home),
            "CLAUDE_CONFIG_DIR": str(claude_home),
            "XDG_CONFIG_HOME": str(home / ".config"),
            "XDG_CACHE_HOME": str(home / ".cache"),
            "XDG_DATA_HOME": str(home / ".local" / "share"),
            "NPM_CONFIG_CACHE": str(home / ".npm"),
            "PIP_CACHE_DIR": str(home / ".cache" / "pip"),
            "OPEN_KRITT_JOB_UID": str(job_uid),
            "OPEN_KRITT_JOB_GID": str(job_gid),
        }
    )
    if claude_oauth_expires_at_ms is not None:
        env[CLAUDE_OAUTH_EXPIRY_ENV] = str(claude_oauth_expires_at_ms)
    _secure_job_tree(root, job_uid, job_gid)
    return JobWorkspace(
        root_dir=str(root),
        repo_base_dir=str(repo_base),
        env=env,
        codex_source_home=codex_source,
        codex_account_id=provider_account.get("id") if codex_source else None,
        codex_account_email=provider_account.get("email") if codex_source else None,
        provider_account_provider=selected_provider if selected_provider in {"codex", "claude"} else None,
        provider_account_home=codex_source or claude_source,
        provider_account_id=provider_account.get("id"),
        provider_account_email=provider_account.get("email"),
    )


def _job_identity(metadata_id: int) -> tuple[int, int]:
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        return os.getuid(), os.getgid()
    job_id = abs(int(metadata_id)) % JOB_UID_SPAN
    identity = JOB_UID_BASE + job_id
    return identity, identity


def _harness_timeout_seconds(data_dir: str) -> int:
    raw = runtime_value("ENGINE_HARNESS_TIMEOUT_SECONDS", "7200", data_dir=data_dir)
    try:
        return max(60, min(int(str(raw)), 86400))
    except (TypeError, ValueError):
        return 7200


def _secure_job_tree(root: Path, uid: int, gid: int):
    """Make a job private and assign a distinct host-side filesystem identity."""

    if not root.exists():
        return
    try:
        root.chmod(0o700)
    except OSError:
        pass
    if not hasattr(os, "geteuid") or os.geteuid() != 0:
        return
    paths = [root]
    for current_root, dirs, files in os.walk(root, followlinks=False):
        paths.extend(Path(current_root) / name for name in [*dirs, *files])
    for path in paths:
        try:
            os.chown(path, uid, gid, follow_symlinks=False)
        except (NotImplementedError, PermissionError, OSError):
            continue


def _prepare_openrouter_codex_home(codex_home: Path):
    """Create the minimum Codex config needed for an OpenRouter scan."""

    codex_home.mkdir(parents=True, exist_ok=True)
    config = codex_home / "config.toml"
    _atomic_write_text(
        config,
        "\n".join(
            [
                "[model_providers.openrouter]",
                'name = "OpenRouter"',
                f'base_url = "{OPENROUTER_CODEX_BASE_URL}"',
                'env_key = "OPENROUTER_API_KEY"',
                'wire_api = "responses"',
                "",
            ]
        ),
    )
    config.chmod(0o600)


def _prepare_claude_config(claude_home: Path):
    claude_home.mkdir(parents=True, exist_ok=True)
    config = claude_home / ".claude.json"
    if config.exists():
        _prepare_claude_home_root_config(config)
        return
    backups = sorted(
        (claude_home / "backups").glob(".claude.json.backup.*"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for backup in backups:
        try:
            shutil.copy2(backup, config)
            _prepare_claude_home_root_config(config)
            return
        except OSError:
            continue
    config.write_text("{}\n", encoding="utf-8")
    _prepare_claude_home_root_config(config)


def _prepare_claude_home_root_config(config: Path):
    home_config = config.parent.parent / ".claude.json"
    if home_config.exists():
        return
    try:
        shutil.copy2(config, home_config)
    except OSError:
        pass


def _prepare_claude_writable_workspace(repo_dir: Path):
    user = os.getenv("CLAUDE_RUN_AS_USER") or "nobody"
    group = os.getenv("CLAUDE_RUN_AS_GROUP") or "nogroup"
    try:
        shutil.chown(repo_dir, user=user, group=group)
    except (LookupError, PermissionError, OSError):
        return
    for root, dirs, files in os.walk(repo_dir):
        for name in [*dirs, *files]:
            try:
                shutil.chown(Path(root) / name, user=user, group=group)
            except (LookupError, PermissionError, OSError):
                return


def cleanup_job_workspace(data_dir: str, metadata_id: int):
    root = Path(data_dir) / "jobs" / f"metadata-{metadata_id}"
    shutil.rmtree(root, ignore_errors=True)


def cleanup_workspace(workspace: JobWorkspace):
    shutil.rmtree(workspace.root_dir, ignore_errors=True)


def prepare_dependency_workspace(
    *,
    data_dir: str,
    checkout_cache_dir: str | None = None,
    metadata_id: int,
    scan: dict[str, Any],
    github_token: str | None = None,
    agent_skills: list[dict[str, Any]] | None = None,
    harness_name: str | None = None,
    model_provider: str | None = None,
    use_snapshot_image: bool = False,
) -> DependencyWorkspace:
    scan = resolve_scan_checkout_revisions(scan, github_token=github_token, data_dir=data_dir)
    total_started = time.perf_counter()
    timings: dict[str, int] = {}
    home_started = time.perf_counter()
    workspace = prepare_job_workspace(
        data_dir,
        metadata_id,
        agent_skills=agent_skills,
        harness_name=harness_name,
        model_provider=model_provider,
    )
    timings["job_home_ms"] = _elapsed_ms(home_started)
    if use_snapshot_image:
        try:
            prepared = _prepare_dependency_snapshot_workspace(
                workspace=workspace,
                cache_dir=_checkout_cache_dir(checkout_cache_dir),
                scan=scan,
                github_token=github_token,
                timings=timings,
            )
            timings["total_ms"] = _elapsed_ms(total_started)
            LOGGER.info(
                "prepared image workspace for metadata %s scan %s in %sms using %s: %s",
                metadata_id,
                scan.get("id"),
                timings["total_ms"],
                prepared.runner_image,
                timings,
            )
            return DependencyWorkspace(
                workspace=prepared.workspace,
                repo_dir=prepared.repo_dir,
                checked_out_commit=prepared.checked_out_commit,
                manifest=prepared.manifest,
                layout=prepared.layout,
                manifest_json=prepared.manifest_json,
                setup_timings_ms=timings,
                source_repo_dir=prepared.source_repo_dir,
                runner_image=prepared.runner_image,
            )
        except WorkspaceSnapshotError as exc:
            LOGGER.warning(
                "workspace snapshot unavailable for metadata %s scan %s; falling back to a physical copy: %s",
                metadata_id,
                scan.get("id"),
                exc,
            )
    # Every harness gets a writable per-job copy. The nested runner is disposable,
    # so agents can compile targets and create proof-of-concept artifacts freely.
    cache_dir = _checkout_cache_dir(checkout_cache_dir)
    prepared_tree = _prepare_dependency_workspace_tree(
        target_dir=Path(workspace.root_dir) / "workspace",
        cache_dir=cache_dir,
        scan=scan,
        github_token=github_token,
        hardlink_worktree=False,
        timings=timings,
    )
    prepared_tree = _with_display_workspace_paths(prepared_tree, SCAN_RUNNER_WORKDIR, write_files=True)

    job_uid = int(workspace.env["OPEN_KRITT_JOB_UID"])
    job_gid = int(workspace.env["OPEN_KRITT_JOB_GID"])
    _secure_job_tree(Path(workspace.root_dir), job_uid, job_gid)

    timings["total_ms"] = _elapsed_ms(total_started)
    LOGGER.info(
        "prepared %s workspace for metadata %s scan %s in %sms: %s",
        "job",
        metadata_id,
        scan.get("id"),
        timings["total_ms"],
        timings,
    )
    return DependencyWorkspace(
        workspace=workspace,
        repo_dir=prepared_tree.repo_dir,
        checked_out_commit=prepared_tree.checked_out_commit,
        manifest=prepared_tree.manifest,
        layout=prepared_tree.layout,
        manifest_json=prepared_tree.manifest_json,
        setup_timings_ms=timings,
    )


def _prepare_dependency_snapshot_workspace(
    *,
    workspace: JobWorkspace,
    cache_dir: Path,
    scan: dict[str, Any],
    github_token: str | None,
    timings: dict[str, int] | None = None,
) -> DependencyWorkspace:
    primary_kind = scan.get("repo_kind") or "remote"
    requested_commit = _requested_revision(primary_kind, scan.get("commit_sha"))
    cache_started = time.perf_counter()
    primary_cache_checkout, checked_out_commit = _checkout_scan_repo_to_cache(
        cache_dir=cache_dir,
        kind=primary_kind,
        repo_full=scan["repo_full"],
        commit_sha=requested_commit,
        github_token=github_token,
        scan_id=scan.get("id"),
    )
    _add_timing(timings, "checkout_cache_ms", _elapsed_ms(cache_started))

    sources = [(primary_cache_checkout, SCAN_RUNNER_WORKDIR)]
    dependencies = []
    used_aliases: set[str] = set(RESERVED_WORKSPACE_ENTRIES)
    for dep in _scan_dependencies(scan):
        kind = dep.get("kind") or "remote"
        repo_full = dep.get("repo_full") or dep.get("repoFull") or ""
        commit_sha = _requested_revision(kind, dep.get("commit_sha") or dep.get("commitSha"))
        if not repo_full:
            continue
        alias = _dependency_alias(SCAN_RUNNER_WORKDIR, repo_full, used_aliases)
        used_aliases.add(alias)
        cache_started = time.perf_counter()
        dep_cache_checkout, dep_commit = _checkout_scan_repo_to_cache(
            cache_dir=cache_dir,
            kind=kind,
            repo_full=repo_full,
            commit_sha=commit_sha,
            github_token=github_token,
            scan_id=scan.get("id"),
        )
        _add_timing(timings, "checkout_cache_ms", _elapsed_ms(cache_started))
        dependency_path = f"{SCAN_RUNNER_WORKDIR}/{alias}"
        sources.append((dep_cache_checkout, dependency_path))
        dependencies.append(
            {
                "kind": kind,
                "repo": repo_full,
                "requested_commit": commit_sha,
                "commit": dep_commit,
                "alias": alias,
                "path": dependency_path,
                "relative_path": alias,
            }
        )

    manifest = {
        "primary": {
            "kind": primary_kind,
            "repo": scan["repo_full"],
            "requested_commit": requested_commit,
            "commit": checked_out_commit,
            "path": SCAN_RUNNER_WORKDIR,
        },
        "dependencies": dependencies,
    }
    manifest_json = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True)
    layout = workspace_layout(SCAN_RUNNER_WORKDIR, manifest)
    repo_dir = Path(workspace.root_dir) / "workspace"
    repo_dir.mkdir(parents=True, exist_ok=True)
    _write_workspace_files(str(repo_dir), manifest, layout, manifest_json)

    image_started = time.perf_counter()
    runner_image = ensure_workspace_snapshot_image(
        base_image=os.getenv("ENGINE_SCAN_RUNNER_IMAGE", "open-kritt-engine:local"),
        checkout_key=scan_checkout_cache_key(scan),
        manifest_json=manifest_json,
        workspace_files_dir=str(repo_dir),
        sources=sources,
        scan_id=scan.get("id"),
    )
    _add_timing(timings, "snapshot_image_ms", _elapsed_ms(image_started))
    job_uid = int(workspace.env["OPEN_KRITT_JOB_UID"])
    job_gid = int(workspace.env["OPEN_KRITT_JOB_GID"])
    _secure_job_tree(Path(workspace.root_dir), job_uid, job_gid)
    return DependencyWorkspace(
        workspace=workspace,
        repo_dir=str(repo_dir),
        checked_out_commit=checked_out_commit,
        manifest=manifest,
        layout=layout,
        manifest_json=manifest_json,
        source_repo_dir=primary_cache_checkout,
        runner_image=runner_image,
    )


def _prepare_dependency_workspace_tree(
    *,
    target_dir: Path,
    cache_dir: Path,
    scan: dict[str, Any],
    github_token: str | None,
    hardlink_worktree: bool,
    timings: dict[str, int] | None = None,
) -> PreparedWorkspaceTree:
    primary_kind = scan.get("repo_kind") or "remote"
    requested_commit = _requested_revision(primary_kind, scan.get("commit_sha"))
    cache_started = time.perf_counter()
    primary_cache_checkout, checked_out_commit = _checkout_scan_repo_to_cache(
        cache_dir=cache_dir,
        kind=primary_kind,
        repo_full=scan["repo_full"],
        commit_sha=requested_commit,
        github_token=github_token,
        scan_id=scan.get("id"),
    )
    _add_timing(timings, "checkout_cache_ms", _elapsed_ms(cache_started))

    copy_started = time.perf_counter()
    if primary_kind == "local":
        repo_dir, checked_out_commit = copy_local_snapshot(primary_cache_checkout, str(target_dir))
    else:
        repo_dir, checked_out_commit = copy_checkout(
            primary_cache_checkout,
            str(target_dir),
            shared=True,
            hardlink=hardlink_worktree,
        )
    _add_timing(timings, "workspace_copy_ms", _elapsed_ms(copy_started))

    dependency_entries = []
    used_aliases: set[str] = set(RESERVED_WORKSPACE_ENTRIES)
    for dep in _scan_dependencies(scan):
        kind = dep.get("kind") or "remote"
        repo_full = dep.get("repo_full") or dep.get("repoFull") or ""
        commit_sha = _requested_revision(kind, dep.get("commit_sha") or dep.get("commitSha"))
        if not repo_full:
            continue
        alias = _dependency_alias(repo_dir, repo_full, used_aliases)
        used_aliases.add(alias)
        cache_started = time.perf_counter()
        dep_cache_checkout, dep_commit = _checkout_scan_repo_to_cache(
            cache_dir=cache_dir,
            kind=kind,
            repo_full=repo_full,
            commit_sha=commit_sha,
            github_token=github_token,
            scan_id=scan.get("id"),
        )
        _add_timing(timings, "checkout_cache_ms", _elapsed_ms(cache_started))
        dep_path = Path(repo_dir) / alias
        copy_started = time.perf_counter()
        if kind == "local":
            _, dep_commit = copy_local_snapshot(dep_cache_checkout, str(dep_path))
        else:
            _, dep_commit = copy_checkout(
                dep_cache_checkout,
                str(dep_path),
                shared=True,
                hardlink=hardlink_worktree,
            )
        _add_timing(timings, "workspace_copy_ms", _elapsed_ms(copy_started))
        dependency_entries.append(
            {
                "kind": kind,
                "repo": repo_full,
                "requested_commit": commit_sha,
                "commit": dep_commit,
                "alias": alias,
                "path": str(dep_path),
                "relative_path": alias,
            }
        )

    manifest = {
        "primary": {
            "kind": primary_kind,
            "repo": scan["repo_full"],
            "requested_commit": requested_commit,
            "commit": checked_out_commit,
            "path": repo_dir,
        },
        "dependencies": dependency_entries,
    }
    manifest_started = time.perf_counter()
    manifest_json = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True)
    layout = workspace_layout(repo_dir, manifest)
    _write_workspace_files(repo_dir, manifest, layout, manifest_json)
    _add_timing(timings, "manifest_ms", _elapsed_ms(manifest_started))
    return PreparedWorkspaceTree(
        repo_dir=repo_dir,
        checked_out_commit=checked_out_commit,
        manifest=manifest,
        layout=layout,
        manifest_json=manifest_json,
    )


def prewarm_scan_checkout_cache(
    *,
    checkout_cache_dir: str | None = None,
    scan: dict[str, Any],
    github_token: str | None = None,
    data_dir: str | None = None,
) -> dict[str, Any]:
    scan = resolve_scan_checkout_revisions(scan, github_token=github_token, data_dir=data_dir)
    cache_dir = _checkout_cache_dir(checkout_cache_dir)
    primary_kind = scan.get("repo_kind") or "remote"
    requested_commit = _requested_revision(primary_kind, scan.get("commit_sha"))
    primary_path, primary_commit = _checkout_scan_repo_to_cache(
        cache_dir=cache_dir,
        kind=primary_kind,
        repo_full=scan["repo_full"],
        commit_sha=requested_commit,
        github_token=github_token,
        scan_id=scan.get("id"),
    )
    dependencies = []
    for dep in _scan_dependencies(scan):
        repo_full = dep.get("repo_full") or dep.get("repoFull") or ""
        if not repo_full:
            continue
        kind = dep.get("kind") or "remote"
        commit_sha = _requested_revision(kind, dep.get("commit_sha") or dep.get("commitSha"))
        dep_path, dep_commit = _checkout_scan_repo_to_cache(
            cache_dir=cache_dir,
            kind=kind,
            repo_full=repo_full,
            commit_sha=commit_sha,
            github_token=github_token,
            scan_id=scan.get("id"),
        )
        dependencies.append(
            {
                "kind": kind,
                "repo": repo_full,
                "requested_commit": commit_sha,
                "commit": dep_commit,
                "cache_path": dep_path,
            }
        )
    return {
        "cache_dir": str(cache_dir),
        "primary": {
            "kind": primary_kind,
            "repo": scan["repo_full"],
            "requested_commit": requested_commit,
            "commit": primary_commit,
            "cache_path": primary_path,
        },
        "dependencies": dependencies,
    }


def primary_checkout_cache_path(
    *,
    checkout_cache_dir: str | None,
    scan: dict[str, Any],
    github_token: str | None = None,
    data_dir: str | None = None,
) -> str | None:
    """Return the ready primary checkout shared by per-job workspaces."""

    scan = resolve_scan_checkout_revisions(scan, github_token=github_token, data_dir=data_dir)
    kind = scan.get("repo_kind") or "remote"
    requested_commit = _requested_revision(kind, scan.get("commit_sha"))
    cache_base = _checkout_cache_base(
        _checkout_cache_dir(checkout_cache_dir),
        scan["repo_full"],
        requested_commit,
        kind=kind,
        scan_id=scan.get("id"),
    )
    ready = _read_ready_cache_checkout(cache_base)
    return ready[0] if ready is not None else None


def restore_persistent_scan_checkout_cache(
    *,
    checkout_cache_dir: str | None = None,
    checkout_cache_persist_dir: str | None = None,
    scan: dict[str, Any],
    github_token: str | None = None,
    data_dir: str | None = None,
) -> list[str]:
    if not checkout_cache_persist_dir:
        return []
    scan = resolve_scan_checkout_revisions(scan, github_token=github_token, data_dir=data_dir)
    persist_root = Path(checkout_cache_persist_dir)
    if persist_root.exists():
        try:
            persist_root.chmod(0o700)
        except OSError:
            pass
    cache_dir = _checkout_cache_dir(checkout_cache_dir)
    persisted_cache_dir = _persistent_scan_checkout_cache_dir(checkout_cache_persist_dir, scan)
    if not persisted_cache_dir.is_dir():
        return []
    restored = []
    cache_dir.mkdir(parents=True, exist_ok=True)
    for cache_base in _scan_cache_bases(cache_dir, scan):
        source = persisted_cache_dir / cache_base.name
        if not source.is_dir() or _read_ready_cache_checkout(cache_base) is not None:
            continue
        if cache_base.exists():
            shutil.rmtree(cache_base)
        _copy_cache_tree(source, cache_base)
        if _read_ready_cache_checkout(cache_base) is not None:
            restored.append(cache_base.name)
        else:
            shutil.rmtree(cache_base, ignore_errors=True)
    return restored


def save_persistent_scan_checkout_cache(
    *,
    checkout_cache_dir: str | None = None,
    checkout_cache_persist_dir: str | None = None,
    scan: dict[str, Any],
    github_token: str | None = None,
    data_dir: str | None = None,
) -> list[str]:
    if not checkout_cache_persist_dir:
        return []
    scan = resolve_scan_checkout_revisions(scan, github_token=github_token, data_dir=data_dir)
    persist_root = Path(checkout_cache_persist_dir)
    persist_root.mkdir(parents=True, exist_ok=True)
    try:
        persist_root.chmod(0o700)
    except OSError:
        pass
    cache_dir = _checkout_cache_dir(checkout_cache_dir)
    persisted_cache_dir = _persistent_scan_checkout_cache_dir(checkout_cache_persist_dir, scan)
    persisted_cache_dir.mkdir(parents=True, exist_ok=True)
    saved = []
    for cache_base in _scan_cache_bases(cache_dir, scan):
        ready = _read_ready_cache_checkout(cache_base)
        if ready is None:
            continue
        _, commit = ready
        target = persisted_cache_dir / cache_base.name
        target_ready = _read_ready_cache_checkout(target)
        if target_ready is not None and target_ready[1] == commit:
            saved.append(cache_base.name)
            continue
        if target.exists():
            shutil.rmtree(target)
        _copy_cache_tree(cache_base, target)
        if _read_ready_cache_checkout(target) is not None:
            saved.append(cache_base.name)
        else:
            shutil.rmtree(target, ignore_errors=True)
    manifest = {
        "scan_id": scan.get("id"),
        "cache_key": scan_checkout_cache_key(scan),
        "entries": saved,
    }
    (persisted_cache_dir.parent / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + "\n", encoding="utf-8"
    )
    return saved


def scan_checkout_cache_key(scan: dict[str, Any]) -> str:
    primary_kind = scan.get("repo_kind") or "remote"
    value = {
        "repo_kind": primary_kind,
        "repo_full": scan.get("repo_full"),
        "commit_sha": _requested_revision(primary_kind, scan.get("commit_sha")),
        "scan_id": scan.get("id") if primary_kind == "local" else None,
        "dependencies": _scan_dependencies(scan),
    }
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def scan_checkout_cache_entry_names(scan: dict[str, Any]) -> set[str]:
    """Return the shared checkout-cache entries required by a resolved scan."""

    return {path.name for path in _scan_cache_bases(Path("."), scan)}


def scan_checkout_cache_entry_prefixes(scan: dict[str, Any]) -> set[str]:
    """Return revision-independent entry prefixes needed by an active scan.

    Scan rows may still say HEAD after the engine has pinned a concrete revision
    in its on-disk manifest, so active cleanup protects every revision of the
    referenced repositories until that scan becomes inactive.
    """

    prefixes = set()
    for name in scan_checkout_cache_entry_names(scan):
        base, separator, _revision = name.rpartition("@")
        prefixes.add(f"{base}{separator}" if separator else name)
    return prefixes


def _has_remote_head(scan: dict[str, Any]) -> bool:
    primary_kind = scan.get("repo_kind") or "remote"
    if primary_kind != "local" and _requested_revision(primary_kind, scan.get("commit_sha")).upper() == "HEAD":
        return True
    return any(
        (dep.get("kind") or "remote") != "local"
        and _requested_revision(
            dep.get("kind") or "remote",
            dep.get("commit_sha") or dep.get("commitSha"),
        ).upper()
        == "HEAD"
        for dep in _scan_dependencies(scan)
    )


def _resolved_revisions_are_concrete(scan: dict[str, Any]) -> bool:
    return not _has_remote_head(scan)


def _apply_resolved_revisions(
    scan: dict[str, Any],
    *,
    primary_commit: str | None,
    dependency_commits: list[str | None],
) -> dict[str, Any]:
    resolved = copy.deepcopy(scan)
    if primary_commit:
        resolved["commit_sha"] = primary_commit
    dependencies = []
    for index, dependency in enumerate(_scan_dependencies(resolved)):
        dep = copy.deepcopy(dependency)
        commit = dependency_commits[index] if index < len(dependency_commits) else None
        if commit:
            if "commitSha" in dep and "commit_sha" not in dep:
                dep["commitSha"] = commit
            else:
                dep["commit_sha"] = commit
        dependencies.append(dep)
    if dependencies or resolved.get("dependencies_detail") is not None:
        resolved["dependencies_detail"] = dependencies
    if resolved.get("dependenciesDetail") is not None:
        resolved["dependenciesDetail"] = dependencies
    return resolved


def resolve_scan_checkout_revisions(
    scan: dict[str, Any],
    *,
    github_token: str | None = None,
    data_dir: str | None = None,
) -> dict[str, Any]:
    """Pin every remote HEAD once per scan before consulting any cache."""

    if not _has_remote_head(scan):
        return scan
    original_key = scan_checkout_cache_key(scan)
    scan_id = scan.get("id")
    root = Path(data_dir or os.getenv("ENGINE_DATA_DIR", "/data")) / "scan-revisions"
    root.mkdir(parents=True, exist_ok=True)
    try:
        root.chmod(0o700)
    except OSError:
        pass
    digest_input = json.dumps(
        {"scan_id": scan_id, "checkout": original_key},
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(digest_input.encode("utf-8")).hexdigest()[:24]
    manifest = root / f"scan-{_safe_alias(str(scan_id)) if scan_id is not None else 'unscoped'}-{digest}.json"
    lock_path = root / ".locks" / f"{manifest.name}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)

    with _shared_workspace_thread_lock(lock_path):
        with open(lock_path, "w") as lock_file:
            fcntl.flock(lock_file, fcntl.LOCK_EX)
            if scan_id is not None and manifest.is_file():
                payload = {}
                try:
                    payload = json.loads(manifest.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    payload = {}
                dependency_commits = payload.get("dependency_commits")
                if payload.get("original_key") == original_key and isinstance(dependency_commits, list):
                    resolved = _apply_resolved_revisions(
                        scan,
                        primary_commit=payload.get("primary_commit"),
                        dependency_commits=dependency_commits,
                    )
                    if _resolved_revisions_are_concrete(resolved):
                        return resolved

            primary_kind = scan.get("repo_kind") or "remote"
            primary_commit = scan.get("commit_sha")
            if primary_kind != "local" and _requested_revision(primary_kind, primary_commit).upper() == "HEAD":
                primary_commit = resolve_remote_head(scan["repo_full"], github_token)

            dependency_commits = []
            for dependency in _scan_dependencies(scan):
                kind = dependency.get("kind") or "remote"
                repo_full = dependency.get("repo_full") or dependency.get("repoFull") or ""
                revision = dependency.get("commit_sha") or dependency.get("commitSha")
                if kind != "local" and _requested_revision(kind, revision).upper() == "HEAD":
                    revision = resolve_remote_head(repo_full, github_token)
                dependency_commits.append(revision)
            resolved = _apply_resolved_revisions(
                scan,
                primary_commit=primary_commit,
                dependency_commits=dependency_commits,
            )

            if scan_id is not None:
                _atomic_write_text(
                    manifest,
                    json.dumps(
                        {
                            "original_key": original_key,
                            "primary_commit": primary_commit,
                            "dependency_commits": dependency_commits,
                        },
                        ensure_ascii=False,
                        sort_keys=True,
                    )
                    + "\n",
                )
                manifest.chmod(0o600)
            return resolved


def _elapsed_ms(started: float) -> int:
    return int((time.perf_counter() - started) * 1000)


def _with_display_workspace_paths(
    prepared: PreparedWorkspaceTree,
    display_root: str,
    *,
    write_files: bool = False,
) -> PreparedWorkspaceTree:
    manifest = copy.deepcopy(prepared.manifest)
    primary = manifest.get("primary") if isinstance(manifest, dict) else None
    if isinstance(primary, dict):
        primary["path"] = display_root
    dependencies = manifest.get("dependencies") if isinstance(manifest, dict) else []
    if isinstance(dependencies, list):
        for dep in dependencies:
            if not isinstance(dep, dict):
                continue
            relative_path = dep.get("relative_path") or dep.get("alias")
            if relative_path:
                dep["path"] = str(Path(display_root) / str(relative_path))
    manifest_json = json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True)
    layout = workspace_layout(display_root, manifest)
    if write_files:
        _write_workspace_files(prepared.repo_dir, manifest, layout, manifest_json)
    return PreparedWorkspaceTree(
        repo_dir=prepared.repo_dir,
        checked_out_commit=prepared.checked_out_commit,
        manifest=manifest,
        layout=layout,
        manifest_json=manifest_json,
    )


def _add_timing(timings: dict[str, int] | None, key: str, value: int):
    if timings is None:
        return
    timings[key] = int(timings.get(key, 0)) + int(value)


def _shared_workspace_thread_lock(lock_path: Path) -> threading.Lock:
    key = str(lock_path)
    with _SHARED_WORKSPACE_LOCKS_GUARD:
        lock = _SHARED_WORKSPACE_LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _SHARED_WORKSPACE_LOCKS[key] = lock
        return lock


def workspace_context(prepared: DependencyWorkspace) -> dict[str, Any]:
    manifest = getattr(prepared, "manifest", None)
    primary = manifest.get("primary") if isinstance(manifest, dict) else {}
    workspace_root = primary.get("path") if isinstance(primary, dict) else None
    return {
        "workspace_root": workspace_root or prepared.repo_dir,
        "workspace_layout": prepared.layout,
        "workspace_manifest_json": prepared.manifest_json,
    }


def workspace_layout(repo_dir: str, manifest: dict[str, Any]) -> str:
    primary = manifest.get("primary") if isinstance(manifest, dict) else {}
    dependencies = manifest.get("dependencies") if isinstance(manifest, dict) else []
    lines = [
        f"Current working directory / primary repository root: {repo_dir}",
        "Workspace manifest: WORKSPACE.json",
        "Dependency repositories are checked out as top-level directories inside the same workspace root.",
        "When reporting file_path for dependency code, prefix it with the dependency alias directory.",
        (
            "Primary repository: "
            f"{primary.get('repo') or '<unknown-repo>'} @ {primary.get('commit') or primary.get('requested_commit') or '<unknown-commit>'}"
        ),
    ]
    if dependencies:
        lines.append("Dependency checkouts:")
        for dep in dependencies:
            lines.append(
                f"- {dep.get('alias')}/ => {dep.get('repo') or '<unknown-repo>'} "
                f"@ {dep.get('commit') or dep.get('requested_commit') or '<unknown-commit>'} "
                f"(workspace path: {dep.get('relative_path') or dep.get('alias')})"
            )
    else:
        lines.append("No dependency checkouts are listed in WORKSPACE.json.")
    return "\n".join(lines)


def workspace_prompt_context(layout: str, manifest_json: str) -> str:
    return f"Workspace context:\n{layout}\n\nWORKSPACE.json:\n{manifest_json}"


def _scan_dependencies(scan: dict[str, Any]) -> list[dict[str, Any]]:
    detail = scan.get("dependencies_detail")
    if detail is None:
        detail = scan.get("dependenciesDetail")
    if isinstance(detail, list):
        return [dep for dep in detail if isinstance(dep, dict)]
    return [{"kind": "remote", "repo_full": repo, "commit_sha": "HEAD"} for repo in (scan.get("dependencies") or [])]


def _checkout_cache_dir(checkout_cache_dir: str | None = None) -> Path:
    default_dir = Path(os.getenv("ENGINE_DATA_DIR", "/data")) / "checkout-cache"
    path = Path(checkout_cache_dir or os.getenv("ENGINE_CHECKOUT_CACHE_DIR", str(default_dir)))
    path.mkdir(parents=True, exist_ok=True)
    try:
        path.chmod(0o700)
    except OSError:
        pass
    return path


def _copy_cache_tree(source: Path, target: Path):
    target.parent.mkdir(parents=True, exist_ok=True)
    staging_root = Path(tempfile.mkdtemp(dir=target.parent, prefix=f".{target.name}.cache-copy-"))
    staging = staging_root / "tree"
    ignore = shutil.ignore_patterns(".locks")
    try:
        try:
            if source.stat().st_dev == target.parent.stat().st_dev:
                proc = subprocess.run(
                    ["cp", "-al", str(source), str(staging)],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                if proc.returncode != 0:
                    LOGGER.info(
                        "hardlink cache copy failed; falling back to copytree: %s",
                        (proc.stderr or proc.stdout or "").strip()[-500:],
                    )
                    shutil.rmtree(staging, ignore_errors=True)
        except OSError as exc:
            LOGGER.info("hardlink cache copy unavailable; falling back to copytree: %s", exc)
            shutil.rmtree(staging, ignore_errors=True)

        if not staging.is_dir():
            shutil.copytree(source, staging, symlinks=True, ignore=ignore)
        shutil.rmtree(staging / ".locks", ignore_errors=True)
        if _read_ready_cache_checkout(staging) is None:
            LOGGER.warning("refusing to publish incomplete checkout cache copy from %s", source)
            return
        if target.is_symlink() or target.is_file():
            target.unlink(missing_ok=True)
        elif target.exists():
            shutil.rmtree(target, ignore_errors=True)
        os.replace(staging, target)
    finally:
        shutil.rmtree(staging_root, ignore_errors=True)


def _persistent_scan_checkout_cache_dir(checkout_cache_persist_dir: str, scan: dict[str, Any]) -> Path:
    scan_id = scan.get("id")
    if scan_id is not None:
        scan_dir = f"scan-{_safe_alias(str(scan_id))}"
    else:
        digest = hashlib.sha256(scan_checkout_cache_key(scan).encode("utf-8")).hexdigest()[:16]
        scan_dir = f"scan-{digest}"
    return Path(checkout_cache_persist_dir) / scan_dir / "cache"


def _scan_cache_bases(cache_dir: Path, scan: dict[str, Any]) -> list[Path]:
    primary_kind = scan.get("repo_kind") or "remote"
    bases = [
        _checkout_cache_base(
            cache_dir,
            scan["repo_full"],
            _requested_revision(primary_kind, scan.get("commit_sha")),
            kind=primary_kind,
            scan_id=scan.get("id"),
        )
    ]
    for dep in _scan_dependencies(scan):
        repo_full = dep.get("repo_full") or dep.get("repoFull") or ""
        if not repo_full:
            continue
        bases.append(
            _checkout_cache_base(
                cache_dir,
                repo_full,
                _requested_revision(
                    dep.get("kind") or "remote",
                    dep.get("commit_sha") or dep.get("commitSha"),
                ),
                kind=dep.get("kind") or "remote",
                scan_id=scan.get("id"),
            )
        )
    seen = set()
    unique = []
    for base in bases:
        key = str(base)
        if key not in seen:
            seen.add(key)
            unique.append(base)
    return unique


def _checkout_scan_repo_to_cache(
    *,
    cache_dir: Path,
    kind: str,
    repo_full: str,
    commit_sha: str,
    github_token: str | None,
    scan_id: Any | None,
) -> tuple[str, str]:
    cache_base = _checkout_cache_base(cache_dir, repo_full, commit_sha, kind=kind, scan_id=scan_id)
    ready = _read_ready_cache_checkout(cache_base)
    if ready is not None:
        return ready

    if cache_base.exists():
        shutil.rmtree(cache_base)

    if kind == "local":
        repo_dir, checked_out = snapshot_local_repo(repo_full, str(cache_base), os.getenv("LOCAL_REPOS_PATH"))
    else:
        repo_dir, checked_out = checkout_repo(repo_full, commit_sha, str(cache_base), github_token)
    _write_ready_cache_checkout(cache_base, repo_dir, checked_out, kind=kind)
    return repo_dir, checked_out


def _read_ready_cache_checkout(cache_base: Path) -> tuple[str, str] | None:
    marker = cache_base / CACHE_READY_FILENAME
    if marker.is_file():
        try:
            data = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            data = {}
        marker_version = data.get("version")
        if marker_version != CACHE_MARKER_VERSION:
            # Older caches may share hardlinked worktree files with jobs. They
            # must be rebuilt, not inferred and silently promoted.
            return None
        repo_dir = data.get("repo_dir")
        commit = data.get("commit")
        kind = data.get("kind") or "remote"
        if isinstance(repo_dir, str) and repo_dir:
            candidate = Path(repo_dir)
            repo_path = cache_base / candidate if not candidate.is_absolute() else None
        else:
            repo_path = Path(repo_dir) if isinstance(repo_dir, str) else None
        if repo_path is not None and isinstance(commit, str) and commit and _path_is_inside(repo_path, cache_base):
            if kind == "local":
                if commit == LOCAL_SNAPSHOT_REVISION and repo_path.is_dir() and not repo_path.is_symlink():
                    return str(repo_path), commit
            elif _git_head_commit(repo_path) == commit:
                return str(repo_path), commit
        return None
    inferred = _infer_cache_checkout(cache_base)
    if inferred is not None:
        repo_dir, commit = inferred
        _write_ready_cache_checkout(cache_base, repo_dir, commit)
        return inferred
    return None


def _infer_cache_checkout(cache_base: Path) -> tuple[str, str] | None:
    if not cache_base.is_dir():
        return None
    try:
        candidates = [path for path in cache_base.iterdir() if path.is_dir() and path.name != ".locks"]
    except OSError:
        return None
    for repo_path in candidates:
        if not _valid_git_checkout(repo_path):
            continue
        commit = _git_head_commit(repo_path)
        if commit:
            return str(repo_path), commit
    return None


def _valid_git_checkout(repo_path: Path) -> bool:
    return _git_head_commit(repo_path) is not None


def _git_head_commit(repo_path: Path) -> str | None:
    git_path = repo_path / ".git"
    if not (git_path.is_dir() or git_path.is_file()):
        return None
    try:
        proc = subprocess.run(
            ["git", "-C", str(repo_path), "rev-parse", "--verify", "HEAD^{commit}"],
            text=True,
            capture_output=True,
            check=False,
            timeout=30,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if proc.returncode != 0:
        return None
    commit = proc.stdout.strip()
    return commit or None


def _path_is_inside(path: Path, parent: Path) -> bool:
    try:
        resolved_path = path.resolve()
        resolved_parent = parent.resolve()
        resolved_path.relative_to(resolved_parent)
    except (OSError, RuntimeError, ValueError):
        return False
    return resolved_path != resolved_parent


def _write_ready_cache_checkout(cache_base: Path, repo_dir: str, commit: str, *, kind: str = "remote"):
    cache_base.mkdir(parents=True, exist_ok=True)
    try:
        relative_repo_dir = Path(repo_dir).resolve().relative_to(cache_base.resolve())
    except (OSError, RuntimeError, ValueError) as exc:
        raise ValueError("cache checkout must be inside its cache directory") from exc
    marker = cache_base / CACHE_READY_FILENAME
    _atomic_write_text(
        marker,
        json.dumps(
            {
                "version": CACHE_MARKER_VERSION,
                "kind": kind,
                "repo_dir": str(relative_repo_dir),
                "commit": commit,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
        + "\n",
    )


def _checkout_cache_base(
    cache_dir: Path,
    repo_full: str,
    commit_sha: str,
    *,
    kind: str = "remote",
    scan_id: Any | None = None,
) -> Path:
    if kind == "local":
        repo_part = _safe_alias(str(repo_full or "local"))[:80]
        repo_digest = hashlib.sha256(str(repo_full or "").encode("utf-8")).hexdigest()[:10]
        scan_part = _safe_alias(str(scan_id)) if scan_id is not None else "unscoped"
        return cache_dir / f"local__scan-{scan_part}__{repo_part}-{repo_digest}@{LOCAL_SNAPSHOT_REVISION}"
    normalized = normalize_repo_full(repo_full).rstrip("/").removesuffix(".git")
    repo_part = _safe_alias(normalized.replace("/", "__"))
    commit_part = _safe_alias(commit_sha or "HEAD")
    return cache_dir / f"{repo_part}@{commit_part}"


def _requested_revision(kind: str, commit_sha: Any | None) -> str:
    if kind == "local":
        return LOCAL_SNAPSHOT_REVISION
    return str(commit_sha or "HEAD")


def _dependency_alias(repo_dir: str, repo_full: str, used_aliases: set[str]) -> str:
    normalized = normalize_repo_full(repo_full)
    repo_name = normalized.rstrip("/").removesuffix(".git").split("/")[-1]
    fallback = normalized.replace("/", "__")
    for candidate in (_safe_alias(repo_name), _safe_alias(fallback)):
        if _alias_available(repo_dir, candidate, used_aliases):
            return candidate
    base = _safe_alias(fallback)
    index = 2
    while True:
        candidate = f"{base}__{index}"
        if _alias_available(repo_dir, candidate, used_aliases):
            return candidate
        index += 1


def _alias_available(repo_dir: str, alias: str, used_aliases: set[str]) -> bool:
    candidate = Path(repo_dir) / alias
    return (
        bool(alias)
        and alias not in RESERVED_WORKSPACE_ENTRIES
        and alias not in used_aliases
        and not candidate.exists()
        and not candidate.is_symlink()
    )


def _safe_alias(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(value or "")).strip("._-")
    return safe or "dependency"


def _write_workspace_files(repo_dir: str, manifest: dict[str, Any], layout: str, manifest_json: str):
    root = Path(repo_dir)
    _atomic_write_text(root / "WORKSPACE.json", manifest_json + "\n")
    note = [
        "# Dependency Workspace",
        "",
        layout,
        "",
        "Path guidance:",
        "- Reference primary repo files relative to the workspace root.",
        "- Reference dependency files with their dependency directory prefix, e.g. `agave/...`.",
    ]
    _atomic_write_text(root / "WORKSPACE.md", "\n".join(note) + "\n")


def _atomic_write_text(path: Path, content: str) -> None:
    descriptor, temporary_name = tempfile.mkstemp(
        dir=path.parent,
        prefix=f".{path.name}.",
        suffix=".tmp",
        text=True,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as temporary_file:
            descriptor = -1
            temporary_file.write(content)
            temporary_file.flush()
            os.fchmod(temporary_file.fileno(), 0o644)
            os.fsync(temporary_file.fileno())
        os.replace(temporary, path)
    finally:
        if descriptor >= 0:
            os.close(descriptor)
        temporary.unlink(missing_ok=True)


def provider_home_for_job(provider: str, metadata_id: int, *, data_dir: str | None = None) -> str:
    """Select a healthy account for a provider, falling back only when all are limited."""

    del metadata_id
    homes = _configured_provider_homes(provider, data_dir=data_dir)
    if not homes:
        return "/root/.codex" if provider == "codex" else "/root/.claude"
    live_health = _provider_account_health(provider)
    key = tuple(homes)
    with _PROVIDER_HOME_LOCK:
        if _PROVIDER_HOME_KEYS.get(provider) != key:
            _PROVIDER_HOME_KEYS[provider] = key
            _PROVIDER_HOME_CURSORS[provider] = 0
            _RATE_LIMITED_PROVIDER_HOMES.setdefault(provider, set()).intersection_update(homes)
            for marked_key in tuple(_RATE_LIMITED_PROVIDER_HOME_MARKED_AT):
                if marked_key[0] == provider and marked_key[1] not in homes:
                    _RATE_LIMITED_PROVIDER_HOME_MARKED_AT.pop(marked_key, None)
        limited = _RATE_LIMITED_PROVIDER_HOMES.setdefault(provider, set())
        _reconcile_provider_account_limits(provider, limited, live_health)
        selectable = [
            home for home in homes if home not in limited and _provider_account_is_available(live_health.get(home))
        ] or homes
        cursor = _PROVIDER_HOME_CURSORS.get(provider, 0)
        home = selectable[cursor % len(selectable)]
        _PROVIDER_HOME_CURSORS[provider] = cursor + 1
        return home


def _codex_home_for_job(metadata_id: int, *, data_dir: str | None = None) -> str:
    return provider_home_for_job("codex", metadata_id, data_dir=data_dir)


def codex_home_for_job(metadata_id: int, *, data_dir: str | None = None) -> str:
    """Select one currently configured Codex login for a new unit of work."""

    return _codex_home_for_job(metadata_id, data_dir=data_dir)


def mark_provider_account_rate_limited(provider: str | None, home: str | None) -> None:
    if provider not in {"codex", "claude"} or not home:
        return
    with _PROVIDER_HOME_LOCK:
        _RATE_LIMITED_PROVIDER_HOMES.setdefault(provider, set()).add(home)
        _RATE_LIMITED_PROVIDER_HOME_MARKED_AT[(provider, home)] = time.time()


def mark_provider_account_available(provider: str | None, home: str | None) -> None:
    if provider not in {"codex", "claude"} or not home:
        return
    with _PROVIDER_HOME_LOCK:
        _RATE_LIMITED_PROVIDER_HOMES.setdefault(provider, set()).discard(home)
        _RATE_LIMITED_PROVIDER_HOME_MARKED_AT.pop((provider, home), None)


def _provider_account_is_available(health: _ProviderAccountHealth | None) -> bool:
    return health is None or health.available


def _reconcile_provider_account_limits(
    provider: str,
    limited: set[str],
    live_health: dict[str, _ProviderAccountHealth],
) -> None:
    """Release local quarantine after a newer authoritative healthy observation."""

    for home in tuple(limited):
        health = live_health.get(home)
        marked_at = _RATE_LIMITED_PROVIDER_HOME_MARKED_AT.get((provider, home))
        if (
            health
            and health.available
            and health.observed_at is not None
            and marked_at is not None
            and health.observed_at > marked_at
        ):
            limited.discard(home)
            _RATE_LIMITED_PROVIDER_HOME_MARKED_AT.pop((provider, home), None)


def _provider_account_worker_limit(data_dir: str | None = None) -> int:
    return runtime_int(
        "ENGINE_WORKERS_PER_ACCOUNT",
        15,
        data_dir=data_dir,
        minimum=1,
        maximum=128,
    )


@contextmanager
def provider_account_lease(provider: str | None, home: str | None, *, data_dir: str | None = None):
    """Limit concurrent root model calls assigned to one native provider account."""

    if provider not in {"codex", "claude"} or not home:
        yield
        return
    key = (provider, home)
    with _PROVIDER_ACCOUNT_GATES_LOCK:
        gate = _PROVIDER_ACCOUNT_GATES.setdefault(key, _ProviderAccountGate())
    with gate.condition:
        while gate.active >= _provider_account_worker_limit(data_dir):
            gate.condition.wait(timeout=1.0)
        gate.active += 1
    try:
        yield
    finally:
        with gate.condition:
            gate.active -= 1
            gate.condition.notify_all()


def provider_accounts_all_rate_limited(provider: str | None, *, data_dir: str | None = None) -> bool:
    if provider not in {"codex", "claude"}:
        return True
    homes = _configured_provider_homes(provider, data_dir=data_dir)
    if not homes:
        return True
    live_health = _provider_account_health(provider)
    with _PROVIDER_HOME_LOCK:
        limited = _RATE_LIMITED_PROVIDER_HOMES.setdefault(provider, set())
        _reconcile_provider_account_limits(provider, limited, live_health)
        return all(home in limited or not _provider_account_is_available(live_health.get(home)) for home in homes)


def _provider_account_health(provider: str) -> dict[str, _ProviderAccountHealth]:
    """Return authoritative account availability from the local account service."""

    if provider not in {"codex", "claude"}:
        return {}
    base_url = os.getenv("EXECUTOR_VIEW_URL", "").strip().rstrip("/")
    token_path = os.getenv("EXECUTOR_VIEW_INTERNAL_TOKEN_FILE", "").strip()
    if not base_url or not token_path:
        return {}
    try:
        token = Path(token_path).read_text(encoding="utf-8").strip()
    except OSError:
        return {}
    if not token or len(token) > 4096:
        return {}

    cache_seconds = 15.0
    cache_key = (provider, base_url)
    now = time.monotonic()
    with _PROVIDER_ACCOUNT_HEALTH_LOCK:
        cached = _PROVIDER_ACCOUNT_HEALTH_CACHE.get(cache_key)
        if cached and now < cached[0]:
            return dict(cached[1])
        request = urllib.request.Request(
            f"{base_url}/api/accounts/{provider}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=20.0) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, urllib.error.URLError):
            _PROVIDER_ACCOUNT_HEALTH_CACHE[cache_key] = (now + cache_seconds, {})
            return {}

        health: dict[str, _ProviderAccountHealth] = {}
        generated_at = payload.get("generatedAt") if isinstance(payload, dict) else None
        for account in payload.get("accounts", []) if isinstance(payload, dict) else []:
            if not isinstance(account, dict):
                continue
            home = str(account.get("path") or "").strip()
            if not home:
                continue
            status = str(account.get("statusKind") or "").strip().lower()
            rate_limits = account.get("rateLimits")
            observed_at = rate_limits.get("observedAt") if isinstance(rate_limits, dict) else generated_at
            health[home] = _ProviderAccountHealth(
                available=bool(account.get("active")) and status not in {"limited", "expired", "missing"},
                observed_at=_provider_health_timestamp(observed_at),
            )
        _PROVIDER_ACCOUNT_HEALTH_CACHE[cache_key] = (time.monotonic() + cache_seconds, health)
        return dict(health)


def _provider_health_timestamp(value: Any) -> float | None:
    if isinstance(value, int | float):
        return float(value)
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _configured_provider_homes(provider: str, *, data_dir: str | None = None) -> list[str]:
    if provider == "codex":
        return _configured_codex_homes(data_dir=data_dir)
    if provider == "claude":
        return _configured_claude_homes(data_dir=data_dir)
    return []


def _configured_codex_homes(data_dir: str | None = None) -> list[str]:
    raw = runtime_value("ENGINE_CODEX_HOME", os.getenv("CODEX_HOME") or "/root/.codex", data_dir=data_dir)
    seen: set[str] = set()
    homes: list[str] = []
    for raw_path in _split_home_list(raw or ""):
        source = Path(raw_path).expanduser()
        if source.exists() and not (source / "auth.json").exists() and not (source / ".codex").exists():
            candidates = sorted(path for path in source.glob("*/.codex") if path.is_dir())
        else:
            candidates = [Path(_resolve_codex_home(raw_path))]
        for candidate in candidates:
            home = str(candidate)
            if home and home not in seen:
                seen.add(home)
                homes.append(home)
    return homes


def _configured_claude_homes(data_dir: str | None = None) -> list[str]:
    raw = runtime_value("ENGINE_CLAUDE_HOME", os.getenv("CLAUDE_HOME") or "/root/.claude", data_dir=data_dir)
    seen: set[str] = set()
    homes: list[str] = []
    for raw_path in _split_home_list(raw or ""):
        home = str(Path(raw_path).expanduser())
        if home and home not in seen:
            seen.add(home)
            homes.append(home)
    return homes


def _split_home_list(raw: str) -> list[str]:
    raw = (raw or "").strip()
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return [str(part).strip() for part in parsed if str(part).strip()]
    except json.JSONDecodeError:
        pass
    separator = "," if "," in raw else os.pathsep
    return [part.strip().strip('"').strip("'") for part in raw.split(separator) if part.strip()]


def _resolve_codex_home(path: str) -> str:
    source = Path(path).expanduser()
    nested = source / ".codex"
    if nested.exists():
        return str(nested)
    return str(source)


def _codex_account_info(home: str) -> dict[str, str | None]:
    auth_path = Path(home) / "auth.json"
    try:
        auth = json.loads(auth_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"id": str(home), "email": None}
    tokens = auth.get("tokens") if isinstance(auth.get("tokens"), dict) else {}
    payload = _decode_jwt_payload(tokens.get("id_token"))
    auth_info = (
        payload.get("https://api.openai.com/auth")
        if isinstance(payload.get("https://api.openai.com/auth"), dict)
        else {}
    )
    email = payload.get("email")
    return {
        "id": auth_info.get("chatgpt_account_id") or payload.get("sub") or email or str(home),
        "email": email,
    }


def _first_account_profile_value(value: Any, keys: set[str]) -> str | None:
    if not isinstance(value, dict | list):
        return None
    values = value.values() if isinstance(value, dict) else value
    if isinstance(value, dict):
        for key, candidate in value.items():
            normalized_key = "".join(character for character in key.lower() if character.isalnum())
            if normalized_key in keys and isinstance(candidate, str | int):
                text = str(candidate).strip()
                if text:
                    return text
    for candidate in values:
        found = _first_account_profile_value(candidate, keys)
        if found:
            return found
    return None


def _claude_account_info(home: str) -> dict[str, str | None]:
    source = Path(home)
    candidates = [
        source / ".open-kritt-account.json",
        source / ".claude.json",
        source / "claude.json",
    ]
    if source.name == ".claude":
        candidates.append(source.parent / ".claude.json")
    payloads: list[Any] = []
    for path in candidates:
        try:
            if path.stat().st_size > 1024 * 1024:
                continue
            payloads.append(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError):
            continue
    email = _first_account_profile_value(
        payloads,
        {"email", "emailaddress", "useremail", "accountemail"},
    )
    account_id = _first_account_profile_value(
        payloads,
        {"accountid", "accountuuid", "userid", "useruuid"},
    )
    return {
        "id": account_id or email or str(home),
        "email": email,
    }


def _decode_jwt_payload(token: str | None) -> dict[str, Any]:
    if not token or token.count(".") < 2:
        return {}
    try:
        part = token.split(".")[1]
        part += "=" * (-len(part) % 4)
        payload = json.loads(base64.urlsafe_b64decode(part.encode("utf-8")).decode("utf-8"))
        return payload if isinstance(payload, dict) else {}
    except Exception:
        return {}


def _copy_credential_files(source: Path, target: Path, names: tuple[str, ...]):
    """Copy only provider login material into an otherwise clean job home."""

    target.mkdir(parents=True, exist_ok=True)
    for name in names:
        source_file = source / name
        if not source_file.is_file() or source_file.is_symlink():
            continue
        target_file = target / name
        shutil.copyfile(source_file, target_file)
        target_file.chmod(0o600)


def _install_agent_skills(codex_home: Path, agent_skills: list[dict[str, Any]]):
    if not agent_skills:
        return
    skills_dir = codex_home / "skills"
    skills_dir.mkdir(parents=True, exist_ok=True)
    for skill in agent_skills:
        slug = _skill_slug(skill)
        target = skills_dir / slug
        target.mkdir(parents=True, exist_ok=True)
        (target / "SKILL.md").write_text(_skill_markdown(skill, slug), encoding="utf-8")
    bundle = skills_dir / SELECTED_AGENT_SKILLS_SLUG
    bundle.mkdir(parents=True, exist_ok=True)
    (bundle / "SKILL.md").write_text(_selected_agent_skills_markdown(agent_skills), encoding="utf-8")


def _skill_slug(skill: dict[str, Any]) -> str:
    value = skill.get("slug") or skill.get("name") or skill.get("id") or "agent-skill"
    slug = re.sub(r"[^a-z0-9_.-]+", "-", str(value).strip().lower()).strip("-._")
    return slug[:80] or "agent-skill"


def _yaml_string(value: Any) -> str:
    return json.dumps("" if value is None else str(value), ensure_ascii=False)


def _skill_markdown(skill: dict[str, Any], slug: str) -> str:
    description = skill.get("description") or f"Open-kritt scan skill: {skill.get('name') or slug}"
    lines = [
        "---",
        f"name: {_yaml_string(slug)}",
        f"description: {_yaml_string(description)}",
    ]
    metadata = {
        "open_kritt_skill_id": skill.get("id"),
        "source_url": skill.get("source_url"),
        "license_spdx": skill.get("license_spdx"),
        "attribution": skill.get("attribution"),
    }
    if any(value for value in metadata.values()):
        lines.append("metadata:")
        for key, value in metadata.items():
            if value:
                lines.append(f"  {key}: {_yaml_string(value)}")
    lines.extend(
        [
            "---",
            "",
            f"# {skill.get('name') or slug}",
            "",
        ]
    )
    if skill.get("description"):
        lines.extend([str(skill["description"]).strip(), ""])
    content = str(skill.get("content") or "").strip()
    if content:
        lines.extend([content, ""])
    return "\n".join(lines)


def _selected_agent_skills_markdown(agent_skills: list[dict[str, Any]]) -> str:
    lines = [
        "---",
        f"name: {_yaml_string(SELECTED_AGENT_SKILLS_SLUG)}",
        'description: "Apply all Open-Kritt agent skills selected for this scan. Use when the scan prompt invokes the selected native scan skills."',
        "---",
        "",
        "# Open-Kritt selected scan skills",
        "",
        "Apply the selected skills below when they are relevant to the current scan task. They complement the workflow prompt and do not replace the required output schema.",
        "",
    ]
    for skill in agent_skills:
        slug = _skill_slug(skill)
        metadata = []
        if skill.get("source_url"):
            metadata.append(f"- source: {skill['source_url']}")
        if skill.get("license_spdx"):
            metadata.append(f"- license: {skill['license_spdx']}")
        if skill.get("attribution"):
            metadata.append(f"- attribution: {skill['attribution']}")
        lines.extend(
            [
                f"## {skill.get('name') or slug}",
                "",
                f"- slug: {slug}",
            ]
        )
        lines.extend(metadata)
        if skill.get("description"):
            lines.extend(["", str(skill["description"]).strip()])
        content = str(skill.get("content") or "").strip()
        if content:
            lines.extend(["", "Instructions:", "", content])
        lines.append("")
    return "\n".join(lines)

import json
import subprocess
from pathlib import Path

from open_kritt_engine import prompting as prompting_module
from open_kritt_engine.prompting import (
    patched_since_history_context,
    patched_since_prompt,
    patched_since_workspace_history_context,
    render_prompt,
)


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args],
        cwd=repo,
        text=True,
        capture_output=True,
        check=True,
    ).stdout.strip()


def _commit(repo: Path, message: str) -> str:
    _git(repo, "add", ".")
    _git(
        repo,
        "-c",
        "user.name=Open Kritt Test",
        "-c",
        "user.email=open-kritt@example.invalid",
        "commit",
        "-m",
        message,
    )
    return _git(repo, "rev-parse", "HEAD")


def _scan(commit: str) -> dict:
    return {
        "id": 58,
        "repo_full": "stacks-network/stacks-core",
        "repo_kind": "remote",
        "commit_sha": commit,
    }


def _shallow_checkout(remote: Path, checkout: Path, commit: str) -> None:
    checkout.mkdir()
    _git(checkout, "init", "--initial-branch=main")
    _git(checkout, "remote", "add", "origin", str(remote))
    _git(checkout, "fetch", "--depth=1", "--no-tags", "origin", commit)
    _git(checkout, "checkout", "--detach", commit)


def test_patched_since_fetches_newer_remote_history_without_moving_pinned_worktree(tmp_path):
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    _git(upstream, "init", "--initial-branch=main")
    validation = upstream / "validation.rs"
    validation.write_text("signers_by_pk.get(&signature.signer);\n", encoding="utf-8")
    vulnerable_commit = _commit(upstream, "accept duplicate signer signatures")

    remote = tmp_path / "remote.git"
    subprocess.run(["git", "clone", "--bare", str(upstream), str(remote)], check=True, capture_output=True)
    checkout = tmp_path / "checkout"
    _shallow_checkout(remote, checkout, vulnerable_commit)

    validation.write_text("signers_by_pk.remove(&signature.signer);\n", encoding="utf-8")
    fixed_commit = _commit(upstream, "reject duplicate signer signatures")
    _git(upstream, "remote", "add", "origin", str(remote))
    _git(upstream, "push", "origin", "main")

    context = json.loads(patched_since_history_context(str(checkout), _scan(vulnerable_commit)))

    assert _git(checkout, "rev-parse", "HEAD") == vulnerable_commit
    assert context["status"] == "available"
    assert context["target_commit"] == vulnerable_commit
    assert context["worktree_remains_pinned"] is True
    assert (checkout / ".git" / "shallow").is_file()
    assert any(item["commit"] == fixed_commit for item in context["newer_descendants"])
    assert _git(checkout, "show", f"{fixed_commit}:validation.rs") == "signers_by_pk.remove(&signature.signer);"


def test_patched_since_fetches_remote_history_once_and_attaches_it_to_each_workspace(monkeypatch, tmp_path):
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    _git(upstream, "init", "--initial-branch=main")
    validation = upstream / "validation.rs"
    validation.write_text("signers_by_pk.get(&signature.signer);\n", encoding="utf-8")
    vulnerable_commit = _commit(upstream, "accept duplicate signer signatures")

    remote = tmp_path / "remote.git"
    subprocess.run(["git", "clone", "--bare", str(upstream), str(remote)], check=True, capture_output=True)
    history_cache = tmp_path / "history-cache"
    workspace_one = tmp_path / "workspace-one"
    workspace_two = tmp_path / "workspace-two"
    _shallow_checkout(remote, history_cache, vulnerable_commit)
    _shallow_checkout(remote, workspace_one, vulnerable_commit)
    _shallow_checkout(remote, workspace_two, vulnerable_commit)

    validation.write_text("signers_by_pk.remove(&signature.signer);\n", encoding="utf-8")
    fixed_commit = _commit(upstream, "reject duplicate signer signatures")
    _git(upstream, "remote", "add", "origin", str(remote))
    _git(upstream, "push", "origin", "main")

    fetches = []
    original_fetch = prompting_module._git_fetch_status

    def counted_fetch(repo_dir, refspec, *, timeout):
        fetches.append((repo_dir, refspec))
        return original_fetch(repo_dir, refspec, timeout=timeout)

    monkeypatch.setattr(prompting_module, "_git_fetch_status", counted_fetch)

    first = json.loads(
        patched_since_history_context(
            str(workspace_one),
            _scan(vulnerable_commit),
            history_repo_dir=str(history_cache),
        )
    )
    second = json.loads(
        patched_since_history_context(
            str(workspace_two),
            _scan(vulnerable_commit),
            history_repo_dir=str(history_cache),
        )
    )

    assert len(fetches) == 1
    assert fetches[0][1] == "+HEAD:refs/remotes/open-kritt-patched-since/default"
    assert first["newer_descendants"] == second["newer_descendants"]
    assert first["worktree_remains_pinned"] is True
    assert second["worktree_remains_pinned"] is True
    assert any(item["commit"] == fixed_commit for item in second["newer_descendants"])
    assert _git(workspace_one, "rev-parse", "HEAD") == vulnerable_commit
    assert _git(workspace_two, "rev-parse", "HEAD") == vulnerable_commit
    assert _git(workspace_one, "show", f"{fixed_commit}:validation.rs") == "signers_by_pk.remove(&signature.signer);"
    assert _git(workspace_two, "show", f"{fixed_commit}:validation.rs") == "signers_by_pk.remove(&signature.signer);"


def test_patched_since_prompt_requires_newer_comparison_and_exact_fix_commit():
    prompt = render_prompt(
        patched_since_prompt("Check duplicate signer validation for {{summary}}."),
        {
            "summary": "duplicate signatures count toward quorum",
            "patched_since_history": json.dumps(
                {
                    "status": "available",
                    "target_commit": "4a7dfc2",
                    "newer_descendants": [{"commit": "bd9ee631", "refs": ["refs/remotes/origin/main"]}],
                }
            ),
        },
    )

    assert "worktree intentionally remains checked out" in prompt
    assert "Do not use\n`git rev-parse HEAD`" in prompt
    assert "exact fixing commit" in prompt
    assert "found_at_commit" in prompt
    assert "_chip_patched" in prompt
    assert "needs_manual_review" in prompt
    assert "4a7dfc2" in prompt
    assert "bd9ee631" in prompt
    assert "{{patched_since_history}}" not in prompt


def test_patched_since_treats_current_default_as_a_completed_comparison(tmp_path):
    upstream = tmp_path / "upstream"
    upstream.mkdir()
    _git(upstream, "init", "--initial-branch=main")
    (upstream / "validation.rs").write_text("still vulnerable\n", encoding="utf-8")
    target = _commit(upstream, "target")

    remote = tmp_path / "remote.git"
    subprocess.run(["git", "clone", "--bare", str(upstream), str(remote)], check=True, capture_output=True)
    checkout = tmp_path / "checkout"
    _shallow_checkout(remote, checkout, target)

    context = json.loads(patched_since_history_context(str(checkout), _scan(target)))

    assert context["status"] == "current_default"
    assert context["default_branch"]["commit"] == target
    assert context["default_branch"]["is_target"] is True
    assert context["newer_descendants"] == []
    assert context["worktree_remains_pinned"] is True


def test_patched_since_compares_dependency_path_with_dependency_default_branch(tmp_path):
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _git(workspace, "init", "--initial-branch=main")
    (workspace / "primary.rs").write_text("primary\n", encoding="utf-8")
    primary_commit = _commit(workspace, "primary")

    dependency_upstream = tmp_path / "dependency-upstream"
    dependency_upstream.mkdir()
    _git(dependency_upstream, "init", "--initial-branch=main")
    signer_dir = dependency_upstream / "signer" / "src"
    signer_dir.mkdir(parents=True)
    signer_file = signer_dir / "contracts.rs"
    signer_file.write_text("accept_unvalidated_contract();\n", encoding="utf-8")
    vulnerable_commit = _commit(dependency_upstream, "accept unvalidated contract")

    dependency_remote = tmp_path / "dependency.git"
    subprocess.run(
        ["git", "clone", "--bare", str(dependency_upstream), str(dependency_remote)],
        check=True,
        capture_output=True,
    )
    dependency_checkout = workspace / "sbtc"
    _shallow_checkout(dependency_remote, dependency_checkout, vulnerable_commit)

    signer_file.write_text("validate_contract_before_accepting();\n", encoding="utf-8")
    fixed_commit = _commit(dependency_upstream, "validate contract before accepting")
    _git(dependency_upstream, "remote", "add", "origin", str(dependency_remote))
    _git(dependency_upstream, "push", "origin", "main")

    manifest = {
        "primary": {
            "kind": "remote",
            "repo": "stacks-network/stacks-core",
            "commit": primary_commit,
        },
        "dependencies": [
            {
                "kind": "remote",
                "repo": "stacks-sbtc/sbtc",
                "commit": vulnerable_commit,
                "alias": "sbtc",
                "relative_path": "sbtc",
            }
        ],
    }
    context = json.loads(
        patched_since_workspace_history_context(
            str(workspace),
            manifest,
            _scan(primary_commit),
            "sbtc/signer/src/contracts.rs",
        )
    )

    assert context["status"] == "available"
    assert context["repository"]["repo"] == "stacks-sbtc/sbtc"
    assert context["repository"]["role"] == "dependency"
    assert context["finding_path"]["repo_relative"] == "signer/src/contracts.rs"
    assert context["target_commit"] == vulnerable_commit
    assert context["default_branch"]["commit"] == fixed_commit
    assert context["comparison_performed"] is True
    assert "validate_contract_before_accepting" in context["path_comparison"]["diff"]
    assert any(fixed_commit in row for row in context["path_comparison"]["commits_touching_path"])
    assert not (workspace / ".git" / "refs" / "remotes" / "open-kritt-patched-since").exists()


def test_patched_since_without_newer_refs_requires_manual_review_context(tmp_path):
    checkout = tmp_path / "checkout"
    checkout.mkdir()
    _git(checkout, "init", "--initial-branch=main")
    (checkout / "validation.rs").write_text("still vulnerable\n", encoding="utf-8")
    target = _commit(checkout, "target")

    context = json.loads(patched_since_history_context(str(checkout), _scan(target), fetch_timeout=1))

    assert context["status"] == "unavailable"
    assert context["target_commit"] == target
    assert context["newer_descendants"] == []
    assert all(item["status"] == "unavailable" for item in context["fetch_results"])
    assert "requires manual review" in context["reason"]

import json
import shutil
import subprocess
import threading
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from open_kritt_engine import harnesses
from open_kritt_engine import post_processing as post_processing_module
from open_kritt_engine import worker as worker_module
from open_kritt_engine import workspace as workspace_module
from open_kritt_engine.claude_auth import ClaudeCredentialRateLimited
from open_kritt_engine.db import Database, configured_agent_skill_ids
from open_kritt_engine.harnesses import (
    ClaudeHarness,
    CodexHarness,
    CursorHarness,
    HarnessError,
    HarnessOutput,
    HarnessResult,
)
from open_kritt_engine.models import (
    Job,
    ModelSelection,
    State,
    Step,
    StepResultRow,
    Workflow,
    model_selection_for_depth,
    post_processing_model_selection,
    post_processing_thinking_effort,
)
from open_kritt_engine.post_processing import (
    PostProcessor,
    PostProcessRateLimited,
    build_dedupe_prompt,
    build_ranker_prompt,
    configured_post_script_ids,
    dedupe_batch,
    dedupe_mapping_from_clusters,
    dedupe_schema,
    post_script_context,
    rank_updates_from_payload,
    ranker_batch,
    ranker_schema,
    validate_dedupe_payload,
)
from open_kritt_engine.prompting import (
    agent_skills_prompt,
    harness_prompt,
    native_agent_skills_prompt,
    render_prompt,
    repeat_append_prompt,
    scan_context,
)
from open_kritt_engine.queue import build_pending_jobs, configured_step_ids, repeat_runs
from open_kritt_engine.repository import github_clone_url, normalize_repo_full, safe_repo_dir
from open_kritt_engine.runtime_config import ensure_runtime_config_file
from open_kritt_engine.schema import EXTRACTOR_HELPER_FIELD, OutputValidationError, output_schema, validate_payload
from open_kritt_engine.worker import Worker
from open_kritt_engine.workspace import (
    _configured_claude_homes,
    _configured_codex_homes,
    _dependency_alias,
    cleanup_job_workspace,
    mark_provider_account_available,
    mark_provider_account_rate_limited,
    prepare_dependency_workspace,
    prepare_job_workspace,
    prewarm_scan_checkout_cache,
    provider_account_lease,
    provider_accounts_all_rate_limited,
    provider_home_for_job,
    restore_persistent_scan_checkout_cache,
    save_persistent_scan_checkout_cache,
    workspace_context,
    workspace_prompt_context,
)

REAL_SCAN_DOCKER_COMMAND = harnesses._scan_docker_command


def marked(payload):
    return {EXTRACTOR_HELPER_FIELD: True, **payload}


@pytest.fixture(autouse=True)
def isolate_unit_tests_from_external_runners(monkeypatch):
    monkeypatch.setattr(harnesses, "_scan_docker_command", lambda cmd, _repo_dir, _env, **_kwargs: cmd)
    monkeypatch.setattr(workspace_module, "resolve_scan_checkout_revisions", lambda scan, **_kwargs: scan)
    monkeypatch.setattr(worker_module, "resolve_scan_checkout_revisions", lambda scan, **_kwargs: scan)


def step(step_id, depth, *, is_last=False, multi=False, output_format=None, bound_source_step_id=None):
    return Step(
        id=step_id,
        content="Check {{repo_full}} {{thing}}",
        output_format=output_format or '{"thing":"string"}',
        name=f"s{step_id}",
        depth=depth,
        multi_output=multi,
        is_last_step=is_last,
        output_table="workflows.vulnerabilities" if is_last else "workflows.step_results",
        order=step_id,
        bound_source_step_id=bound_source_step_id,
    )


def scan(configuration=None):
    return {
        "id": 7,
        "workflow_id": 3,
        "repo_full": "owner/repo",
        "repo_kind": "remote",
        "commit_sha": "HEAD",
        "repo_scope": "full repository",
        "dependencies": [],
        "dependencies_detail": [],
        "configuration": configuration or {},
        "model": "test-model",
        "harness": "codex",
    }


def test_model_selection_resolves_depth_override_and_keeps_default_for_post_processing():
    configured = {
        **scan(),
        "model_provider": "codex",
        "thinking_effort": "high",
        "model_overrides": {
            "1": {
                "model": "claude-sonnet",
                "model_provider": "claude",
                "harness": "claude-code",
                "thinking_effort": "medium",
            }
        },
    }

    assert model_selection_for_depth(configured, 1).model == "claude-sonnet"
    assert model_selection_for_depth(configured, 1).model_provider == "claude"
    assert model_selection_for_depth(configured, 0).model == "test-model"
    assert model_selection_for_depth(configured).model == "test-model"


def test_post_processing_thinking_effort_is_independent_from_workflow_effort():
    configured = {
        **scan({"post_processing_thinking_effort": "medium"}),
        "thinking_effort": "high",
    }

    assert model_selection_for_depth(configured).thinking_effort == "high"
    assert post_processing_thinking_effort(configured) == "medium"
    assert post_processing_thinking_effort({**configured, "configuration": {}}) == "high"


def test_post_processing_can_use_a_complete_independent_model_selection():
    configured = {
        **scan(
            {
                "post_processing_model": "gpt-5-codex",
                "post_processing_model_provider": "codex",
                "post_processing_harness": "codex",
                "post_processing_thinking_effort": "xhigh",
            }
        ),
        "model": "claude-sonnet",
        "model_provider": "claude",
        "harness": "claude-code",
        "thinking_effort": "high",
    }

    assert post_processing_model_selection(configured) == ModelSelection(
        model="gpt-5-codex",
        model_provider="codex",
        harness="codex",
        thinking_effort="xhigh",
    )


def fake_cache_git_head(path):
    repo_txt = Path(path) / "repo.txt"
    if not repo_txt.exists():
        return None
    return f"commit-{repo_txt.read_text(encoding='utf-8').split('/')[-1]}"


def vuln(row_id, *, canonical=None, canonical_id=None, rank_value=None, bounty_rank=None, summary=None):
    return {
        "id": row_id,
        "scan_id": 7,
        "rank": rank_value or row_id,
        "json_answer": {
            "summary": summary or f"finding {row_id}",
            "vulnerability_type": "DoS",
            "file_path": "src/lib.rs",
            "line": row_id,
            "exploitable": True,
            "trigger_flow": ["entry", "sink"],
            "explanation": f"explanation {row_id}",
        },
        "dedupe_is_canonical": canonical,
        "dedupe_canonical_id": canonical_id,
        "dedupe_cluster_id": f"7:{canonical_id}" if canonical_id else None,
        "dedupe_reason": "same root" if canonical is not None else None,
        "bounty_rank": bounty_rank,
        "bounty_rank_impact_level": "high" if bounty_rank else None,
        "bounty_rank_minimum_reward": 1 if bounty_rank else None,
        "bounty_rank_maximum_reward": 2 if bounty_rank else None,
        "bounty_rank_reasoning": "anchor" if bounty_rank else None,
        "rank_root_bug": "anchor bug" if bounty_rank else None,
    }


def test_output_schema_is_strict_and_multi_output_checked():
    schema = output_schema('{"name":"string","score":"number","path":"array"}', multi_output=False)

    assert schema["properties"][EXTRACTOR_HELPER_FIELD] == {"type": "boolean", "const": True}
    assert EXTRACTOR_HELPER_FIELD in schema["required"]
    assert schema["properties"]["stub"] == {"type": "boolean"}
    assert schema["properties"]["stub_explanation"] == {"type": "string"}
    assert schema["properties"]["results"]["maxItems"] == 1
    assert schema["properties"]["results"]["items"]["properties"]["path"]["items"] == {"type": "string"}

    rows = validate_payload(
        marked({"stub": False, "stub_explanation": "", "results": [{"name": "a", "score": 1, "path": ["x"]}]}),
        schema,
        multi_output=False,
    )
    assert rows == [{"name": "a", "score": 1, "path": ["x"]}]

    assert (
        validate_payload(
            marked({"stub": True, "stub_explanation": "No matching code path.", "results": []}),
            schema,
            multi_output=False,
        )
        == []
    )

    with pytest.raises(OutputValidationError):
        validate_payload(marked({"stub": True, "stub_explanation": "", "results": []}), schema, multi_output=False)

    with pytest.raises(OutputValidationError):
        validate_payload(marked({"stub": False, "stub_explanation": "", "results": []}), schema, multi_output=False)

    with pytest.raises(OutputValidationError):
        validate_payload(
            marked(
                {
                    "stub": True,
                    "stub_explanation": "No matching code path.",
                    "results": [{"name": "a", "score": 1, "path": []}],
                }
            ),
            schema,
            multi_output=False,
        )

    with pytest.raises(OutputValidationError):
        validate_payload(
            marked(
                {
                    "stub": False,
                    "stub_explanation": "",
                    "results": [{"name": "a", "score": 1, "path": [], "extra": True}],
                }
            ),
            schema,
            multi_output=False,
        )

    with pytest.raises(OutputValidationError):
        validate_payload(
            marked(
                {
                    "stub": False,
                    "stub_explanation": "",
                    "results": [{"name": "a", "score": 1, "path": []}, {"name": "b", "score": 2, "path": []}],
                }
            ),
            schema,
            multi_output=False,
        )


def test_multi_output_schema_uses_top_level_stub_and_results_array():
    schema = output_schema('{"name":"string"}', multi_output=True)
    assert "maxItems" not in schema["properties"]["results"]
    rows = validate_payload(
        marked({"stub": False, "stub_explanation": "", "results": [{"name": "a"}, {"name": "b"}]}),
        schema,
        multi_output=True,
    )
    assert rows == [{"name": "a"}, {"name": "b"}]


def test_post_processing_schemas_use_typed_extractor_marker():
    for schema in (dedupe_schema(), ranker_schema()):
        assert schema["properties"][EXTRACTOR_HELPER_FIELD] == {"type": "boolean", "const": True}


def test_anchored_dedupe_batches_carry_canonicals_and_next_50():
    rows = [vuln(1, canonical=True, canonical_id=1)] + [vuln(i) for i in range(2, 58)]

    anchors, targets = dedupe_batch(rows)

    assert [row["id"] for row in anchors] == [1]
    assert [row["id"] for row in targets] == list(range(2, 52))
    prompt = build_dedupe_prompt(scan(), anchors, targets)
    assert "Canonical anchors JSON" in prompt
    assert "Target findings JSON" in prompt


def test_dedupe_validation_requires_every_target_once_and_maps_anchors():
    anchors = [vuln(1, canonical=True, canonical_id=1)]
    targets = [vuln(2), vuln(3), vuln(4)]
    payload = marked(
        {
            "clusters": [
                {"ids": [1, 2], "reason": "same root as anchor"},
                {"ids": [3, 4], "reason": "same new root"},
            ]
        }
    )

    clusters = validate_dedupe_payload(payload, anchors=anchors, targets=targets)
    mapping = dedupe_mapping_from_clusters(clusters, scan_id=7, anchors=anchors, targets=targets)

    assert mapping[2] == (1, False, "7:1", "same root as anchor")
    assert mapping[3] == (3, True, "7:3", "same new root")
    assert mapping[4] == (3, False, "7:3", "same new root")

    with pytest.raises(OutputValidationError):
        validate_dedupe_payload(
            marked({"clusters": [{"ids": [1, 2], "reason": "missing 3 and 4"}]}), anchors=anchors, targets=targets
        )


def test_ranker_append_compacts_anchors_and_targets_to_global_ranks():
    anchors = [
        vuln(10, canonical=True, canonical_id=10, bounty_rank=1),
        vuln(20, canonical=True, canonical_id=20, bounty_rank=2),
    ]
    targets = [vuln(30, canonical=True, canonical_id=30), vuln(40, canonical=True, canonical_id=40)]
    payload = marked(
        {
            "rankings": [
                {
                    "id": 30,
                    "rank": 1.5,
                    "impact_level": "high",
                    "minimum_reward": 10,
                    "maximum_reward": 20,
                    "reasoning": "between anchors",
                    "root_bug": "middle bug",
                },
                {
                    "id": 40,
                    "rank": 3,
                    "impact_level": "medium",
                    "minimum_reward": 1,
                    "maximum_reward": 2,
                    "reasoning": "after anchors",
                    "root_bug": "last bug",
                },
            ],
            "summary": "ordered by impact",
            "missing_from_prompt": "",
        }
    )

    updates = rank_updates_from_payload(
        payload,
        anchors=anchors,
        targets=targets,
        rank_run_id=99,
        model="gpt-5.4-mini",
        prompt_filled="prompt",
    )

    ranks = {item["id"]: item["bounty_rank"] for item in updates}
    assert ranks == {10: 1, 30: 2, 20: 3, 40: 4}
    assert next(item for item in updates if item["id"] == 20)["bounty_rank_total_issues"] == 4
    target_update = next(item for item in updates if item["id"] == 30)
    assert target_update["bounty_rank_response"]["summary"] == "ordered by impact"
    assert target_update["bounty_rank_run_id"] == 99


def test_ranker_batch_uses_only_canonicals_and_next_50_unranked():
    rows = [vuln(1, canonical=False, canonical_id=2)]
    rows += [vuln(2, canonical=True, canonical_id=2, bounty_rank=1)]
    rows += [vuln(i, canonical=True, canonical_id=i) for i in range(3, 60)]

    anchors, targets = ranker_batch(rows)

    assert [row["id"] for row in anchors] == [2]
    assert [row["id"] for row in targets] == list(range(3, 53))


def test_ranker_prompt_applies_the_scan_severity_ranker_before_protocol_constraints():
    configured_rules = """# Program ranking policy

1. Unauthenticated loss of funds is Critical and ranks first.
2. Findings requiring validator collusion are no higher than Medium."""
    configured_scan = {**scan(), "severity_ranker": configured_rules}

    prompt = build_ranker_prompt(configured_scan, [], [vuln(3, canonical=True, canonical_id=3)])

    assert configured_rules in prompt
    assert "Treat the configured severity ranking rules below as authoritative" in prompt
    assert prompt.index(configured_rules) < prompt.index("Required ranking protocol:")
    assert "Return every target id exactly once" in prompt
    assert "Return only minified JSON matching the provided schema" in prompt


def test_ranker_prompt_keeps_a_safe_fallback_for_legacy_scans_without_rules():
    prompt = build_ranker_prompt(scan(), [], [vuln(3, canonical=True, canonical_id=3)])

    assert "No additional scan-specific ranking rules were configured." in prompt
    assert "Target findings JSON" in prompt


def test_ranker_batch_sends_the_configured_severity_rules_to_the_harness():
    configured_rules = "Rank public consensus-halting bugs above authenticated denial of service."
    current = {
        **scan(),
        "status": "post_processing",
        "model_provider": "codex",
        "thinking_effort": "medium",
        "severity_ranker": configured_rules,
    }

    class FakeRankerDb:
        def __init__(self):
            self.updates = []

        @contextmanager
        def connect(self):
            yield FakeConn()

        def count_running_post_process(self, _conn, _scan_id, _kind):
            return 0

        def load_scan(self, _conn, _scan_id):
            return current

        def load_vulnerabilities(self, _conn, _scan_id):
            return [vuln(3, canonical=True, canonical_id=3)]

        def next_post_process_batch_index(self, _conn, _scan_id, _kind):
            return 0

        def claim_post_process_metadata(self, _conn, **_kwargs):
            return 9

        def update_post_process_metadata(self, _conn, metadata_id, **kwargs):
            self.updates.append({"metadata_id": metadata_id, **kwargs})

    captured = {}
    database = FakeRankerDb()
    processor = PostProcessor(SimpleNamespace(data_dir="/tmp", github_token=None), database)

    def capture_prompt(**kwargs):
        captured.update(kwargs)
        raise PostProcessRateLimited("stop after prompt capture", retry_after_seconds=1.0)

    processor._run_harness_with_retries = capture_prompt

    with pytest.raises(PostProcessRateLimited):
        processor._run_next_ranker_batch(current, object())

    assert configured_rules in captured["prompt"]
    assert captured["kind"] == "ranker"
    assert database.updates[-1]["status"] == "interrupted"


def test_post_script_context_contains_only_scan_and_finding_fields():
    row = vuln(5, canonical=True, canonical_id=5, bounty_rank=2)
    ctx = post_script_context(scan(), row)

    assert ctx == {**scan_context(scan()), **row["json_answer"]}


def test_configured_post_script_ids_preserve_primary_then_configuration_order():
    row = scan({"post_script_ids": [3, "4", {"id": 5}, 3, "bad"]})
    row["post_script_id"] = 2

    assert configured_post_script_ids(row) == [2, 3, 4, 5]


def test_configured_agent_skill_ids_preserve_column_then_configuration_order():
    row = scan({"agent_skill_ids": [4, {"id": 5}, "bad", 4]})
    row["agent_skill_ids"] = [2, "3", 2]

    assert configured_agent_skill_ids(row) == [2, 3, 4, 5]


def test_prompt_rendering_uses_json_for_structured_values():
    rendered = render_prompt(
        "Repo {{repo_full}} deps {{dependencies}} missing {{nope}}",
        {
            "repo_full": "owner/repo",
            "dependencies": ["a", "b"],
        },
    )

    assert rendered == 'Repo owner/repo deps ["a", "b"] missing null'


def test_prompt_rendering_resolves_extra_subkeys():
    rendered = render_prompt(
        "Region {{extra.region}} full {{extra}} missing {{extra.nope}}",
        {"extra": {"region": "us-east", "network": "mainnet"}},
    )

    assert rendered == 'Region us-east full {"network": "mainnet", "region": "us-east"} missing null'


def test_scan_context_includes_extra_values():
    ctx = scan_context({**scan(), "extra": {"region": "us-east"}})

    assert ctx["extra"]["region"] == "us-east"


def test_scan_context_labels_local_repository_as_snapshot():
    ctx = scan_context({**scan(), "repo_kind": "local", "commit_sha": "HEAD"})

    assert ctx["commit_sha"] == "LOCAL_SNAPSHOT"


def test_repeat_append_prompt_requires_only_new_results_after_the_first_run():
    assert repeat_append_prompt(1, [{"repeat_run": 1, "result": {"thing": "existing"}}]) == ""

    prompt = repeat_append_prompt(2, [{"repeat_run": 1, "result": {"thing": "existing"}}])

    assert "This is repeat run 2" in prompt
    assert '"thing": "existing"' in prompt
    assert "return only genuinely new application records" in prompt
    assert "appended" in prompt and "earlier set automatically" in prompt


def test_agent_skills_prompt_includes_skill_metadata_and_content():
    prompt = agent_skills_prompt(
        [
            {
                "slug": "audit-skill",
                "name": "Audit skill",
                "description": "Find concrete bugs.",
                "content": "Trace attacker input to sinks.",
                "source_url": "https://example.com/skill",
                "license_spdx": "MIT",
                "attribution": "Example",
            }
        ]
    )

    assert "Selected agent skills" in prompt
    assert "## Audit skill" in prompt
    assert "source: https://example.com/skill" in prompt
    assert "Trace attacker input to sinks." in prompt


def test_native_agent_skills_prompt_invokes_installed_bundle():
    skills = [{"slug": "audit-skill"}]

    assert native_agent_skills_prompt(skills, "claude-code") == "/open-kritt-selected-skills"
    codex_prompt = native_agent_skills_prompt(skills, "codex")
    assert codex_prompt.startswith("$open-kritt-selected-skills")
    assert "Trace attacker input" not in codex_prompt


def test_dependency_alias_falls_back_when_repo_name_collides(tmp_path):
    repo_dir = tmp_path / "workspace"
    repo_dir.mkdir()
    (repo_dir / "agave").mkdir()

    assert _dependency_alias(str(repo_dir), "anza-xyz/agave", set()) == "anza-xyz__agave"

    (repo_dir / "anza-xyz__agave").mkdir()
    assert _dependency_alias(str(repo_dir), "anza-xyz/agave", {"agave"}) == "anza-xyz__agave__2"


def test_prepare_dependency_workspace_writes_manifest_and_layout(monkeypatch, tmp_path):
    def fake_checkout_repo(repo_full, commit_sha, base_dir, github_token=None):
        path = Path(base_dir) / repo_full.replace("/", "__")
        path.mkdir(parents=True, exist_ok=True)
        (path / ".git").mkdir(exist_ok=True)
        (path / "repo.txt").write_text(repo_full, encoding="utf-8")
        return str(path), f"commit-{repo_full.split('/')[-1]}"

    def fake_copy_checkout(src_dir, dest_dir, *, shared=False, hardlink=False):
        assert shared is True
        assert hardlink is False
        src = Path(src_dir)
        dest = Path(dest_dir)
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest)
        return str(dest), f"commit-{(dest / 'repo.txt').read_text(encoding='utf-8').split('/')[-1]}"

    monkeypatch.setattr(workspace_module, "checkout_repo", fake_checkout_repo)
    monkeypatch.setattr(workspace_module, "copy_checkout", fake_copy_checkout)
    monkeypatch.setattr(workspace_module, "_git_head_commit", fake_cache_git_head)

    prepared = prepare_dependency_workspace(
        data_dir=str(tmp_path / "data"),
        checkout_cache_dir=str(tmp_path / "cache"),
        metadata_id=42,
        scan={
            **scan(),
            "dependencies_detail": [{"kind": "remote", "repo_full": "anza-xyz/agave", "commit_sha": "abc123"}],
        },
        agent_skills=[
            {
                "id": 9,
                "slug": "audit-skill",
                "name": "Audit Skill",
                "description": "Find concrete bugs.",
                "content": "Trace attacker input to sinks.",
                "source_url": "https://example.com/skill",
                "license_spdx": "MIT",
                "attribution": "Example",
            }
        ],
    )

    manifest_path = Path(prepared.repo_dir) / "WORKSPACE.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["primary"]["repo"] == "owner/repo"
    assert manifest["dependencies"][0]["alias"] == "agave"
    assert (Path(prepared.repo_dir) / "agave" / ".git").is_dir()
    assert "Dependency repositories are checked out as top-level directories" in prepared.layout
    assert "WORKSPACE.json:" in workspace_prompt_context(prepared.layout, prepared.manifest_json)
    skill_file = Path(prepared.workspace.env["CODEX_HOME"]) / "skills" / "audit-skill" / "SKILL.md"
    assert skill_file.exists()
    skill_text = skill_file.read_text(encoding="utf-8")
    assert 'name: "audit-skill"' in skill_text
    assert "Trace attacker input to sinks." in skill_text
    bundle_file = Path(prepared.workspace.env["CODEX_HOME"]) / "skills" / "open-kritt-selected-skills" / "SKILL.md"
    assert bundle_file.exists()
    bundle_text = bundle_file.read_text(encoding="utf-8")
    assert 'name: "open-kritt-selected-skills"' in bundle_text
    assert "Trace attacker input to sinks." in bundle_text


def test_prepare_dependency_workspace_uses_cached_snapshot_image_without_copying_worktree(monkeypatch, tmp_path):
    def fake_checkout_repo(repo_full, commit_sha, base_dir, github_token=None):
        path = Path(base_dir) / repo_full.replace("/", "__")
        path.mkdir(parents=True, exist_ok=True)
        (path / ".git").mkdir(exist_ok=True)
        (path / "repo.txt").write_text(repo_full, encoding="utf-8")
        return str(path), f"commit-{repo_full.split('/')[-1]}"

    captured = {}

    def fake_snapshot_image(**kwargs):
        captured.update(kwargs)
        return "open-kritt-workspace-snapshot:test"

    monkeypatch.setattr(workspace_module, "checkout_repo", fake_checkout_repo)
    monkeypatch.setattr(workspace_module, "_git_head_commit", fake_cache_git_head)
    monkeypatch.setattr(workspace_module, "ensure_workspace_snapshot_image", fake_snapshot_image)
    monkeypatch.setattr(
        workspace_module,
        "copy_checkout",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("snapshot mode must not copy worktrees")),
    )

    prepared = prepare_dependency_workspace(
        data_dir=str(tmp_path / "data"),
        checkout_cache_dir=str(tmp_path / "cache"),
        metadata_id=47,
        scan={
            **scan(),
            "commit_sha": "abc123",
            "dependencies_detail": [{"kind": "remote", "repo_full": "anza-xyz/agave", "commit_sha": "def456"}],
        },
        use_snapshot_image=True,
    )

    assert prepared.runner_image == "open-kritt-workspace-snapshot:test"
    assert prepared.source_repo_dir == captured["sources"][0][0]
    assert captured["sources"][0][1] == "/workspace"
    assert captured["sources"][1][1] == "/workspace/agave"
    assert Path(prepared.repo_dir).is_dir()
    assert {path.name for path in Path(prepared.repo_dir).iterdir()} == {"WORKSPACE.json", "WORKSPACE.md"}
    assert json.loads(prepared.manifest_json)["primary"]["path"] == "/workspace"


def test_prewarm_scan_checkout_cache_only_populates_cache(monkeypatch, tmp_path):
    calls = []

    def fake_checkout_repo(repo_full, commit_sha, base_dir, github_token=None):
        path = Path(base_dir) / repo_full.replace("/", "__")
        path.mkdir(parents=True, exist_ok=True)
        (path / ".git").mkdir(exist_ok=True)
        calls.append((repo_full, commit_sha, base_dir))
        return str(path), f"commit-{repo_full.split('/')[-1]}"

    def fail_copy_checkout(*_args, **_kwargs):
        raise AssertionError("prewarm must not create per-job workspace copies")

    monkeypatch.setattr(workspace_module, "checkout_repo", fake_checkout_repo)
    monkeypatch.setattr(workspace_module, "copy_checkout", fail_copy_checkout)
    monkeypatch.setattr(workspace_module, "_git_head_commit", fake_cache_git_head)

    manifest = prewarm_scan_checkout_cache(
        checkout_cache_dir=str(tmp_path / "cache"),
        scan={
            **scan(),
            "dependencies_detail": [{"kind": "remote", "repo_full": "anza-xyz/agave", "commit_sha": "abc123"}],
        },
    )

    assert [call[0] for call in calls] == ["owner/repo", "anza-xyz/agave"]
    assert all(str(tmp_path / "cache") in call[2] for call in calls)
    assert manifest["primary"]["commit"] == "commit-repo"
    assert manifest["dependencies"][0]["commit"] == "commit-agave"


def test_ready_checkout_cache_skips_fetch_and_uses_shared_clone(monkeypatch, tmp_path):
    def fake_checkout_repo(repo_full, commit_sha, base_dir, github_token=None):
        path = Path(base_dir) / repo_full.replace("/", "__")
        path.mkdir(parents=True, exist_ok=True)
        (path / ".git").mkdir(exist_ok=True)
        (path / "repo.txt").write_text(repo_full, encoding="utf-8")
        return str(path), f"commit-{repo_full.split('/')[-1]}"

    monkeypatch.setattr(workspace_module, "checkout_repo", fake_checkout_repo)
    monkeypatch.setattr(workspace_module, "_git_head_commit", fake_cache_git_head)
    prewarm_scan_checkout_cache(
        checkout_cache_dir=str(tmp_path / "cache"),
        scan={
            **scan(),
            "dependencies_detail": [{"kind": "remote", "repo_full": "anza-xyz/agave", "commit_sha": "abc123"}],
        },
    )

    def fail_checkout_repo(*_args, **_kwargs):
        raise AssertionError("ready cache entries must not be fetched again per job")

    clone_calls = []

    def fake_copy_checkout(src_dir, dest_dir, *, shared=False, hardlink=False):
        clone_calls.append((src_dir, dest_dir, shared, hardlink))
        src = Path(src_dir)
        dest = Path(dest_dir)
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest)
        return str(dest), f"commit-{(dest / 'repo.txt').read_text(encoding='utf-8').split('/')[-1]}"

    monkeypatch.setattr(workspace_module, "checkout_repo", fail_checkout_repo)
    monkeypatch.setattr(workspace_module, "copy_checkout", fake_copy_checkout)

    prepared = prepare_dependency_workspace(
        data_dir=str(tmp_path / "data"),
        checkout_cache_dir=str(tmp_path / "cache"),
        metadata_id=43,
        scan={
            **scan(),
            "dependencies_detail": [{"kind": "remote", "repo_full": "anza-xyz/agave", "commit_sha": "abc123"}],
        },
    )

    assert prepared.manifest["primary"]["commit"] == "commit-repo"
    assert prepared.manifest["dependencies"][0]["commit"] == "commit-agave"
    assert [call[2] for call in clone_calls] == [True, True]
    assert [call[3] for call in clone_calls] == [False, False]


def test_claude_workspace_skips_codex_home_and_uses_writable_job_checkout(monkeypatch, tmp_path):
    codex_home = tmp_path / "source-codex"
    codex_home.mkdir()
    (codex_home / "auth.json").write_text("{}", encoding="utf-8")
    (codex_home / "config.toml").write_text(
        '[mcp_servers.private]\ncommand = "print-secret"\nenv = { TOKEN = "mcp-secret" }\n',
        encoding="utf-8",
    )
    monkeypatch.setenv("ENGINE_CODEX_HOME", str(codex_home))

    def fake_checkout_repo(repo_full, commit_sha, base_dir, github_token=None):
        path = Path(base_dir) / repo_full.replace("/", "__")
        path.mkdir(parents=True, exist_ok=True)
        (path / ".git").mkdir(exist_ok=True)
        (path / "repo.txt").write_text(repo_full, encoding="utf-8")
        return str(path), f"commit-{repo_full.split('/')[-1]}"

    clone_calls = []

    def fake_copy_checkout(src_dir, dest_dir, *, shared=False, hardlink=False):
        clone_calls.append((src_dir, dest_dir, shared, hardlink))
        src = Path(src_dir)
        dest = Path(dest_dir)
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest)
        return str(dest), f"commit-{(dest / 'repo.txt').read_text(encoding='utf-8').split('/')[-1]}"

    monkeypatch.setattr(workspace_module, "checkout_repo", fake_checkout_repo)
    monkeypatch.setattr(workspace_module, "copy_checkout", fake_copy_checkout)
    monkeypatch.setattr(workspace_module, "_git_head_commit", fake_cache_git_head)

    prepared = prepare_dependency_workspace(
        data_dir=str(tmp_path / "data"),
        checkout_cache_dir=str(tmp_path / "cache"),
        metadata_id=44,
        scan={
            **scan(),
            "harness": "claude-code",
            "dependencies_detail": [{"kind": "remote", "repo_full": "anza-xyz/agave", "commit_sha": "abc123"}],
        },
        agent_skills=[{"slug": "audit-skill", "content": "Skill content"}],
        harness_name="claude-code",
    )

    assert not Path(prepared.workspace.env["CODEX_HOME"]).exists()
    claude_skill_file = Path(prepared.workspace.env["CLAUDE_HOME"]) / "skills" / "audit-skill" / "SKILL.md"
    assert claude_skill_file.exists()
    assert "Skill content" in claude_skill_file.read_text(encoding="utf-8")
    claude_bundle_file = (
        Path(prepared.workspace.env["CLAUDE_HOME"]) / "skills" / "open-kritt-selected-skills" / "SKILL.md"
    )
    assert claude_bundle_file.exists()
    assert "Skill content" in claude_bundle_file.read_text(encoding="utf-8")
    assert prepared.workspace.codex_source_home is None
    assert [call[2] for call in clone_calls] == [True, True]
    assert [call[3] for call in clone_calls] == [False, False]
    assert "OPEN_KRITT_WORKSPACE_READONLY" not in prepared.workspace.env
    assert Path(prepared.repo_dir) == Path(prepared.workspace.root_dir) / "workspace"


def test_claude_workspaces_are_writable_per_job_copies(monkeypatch, tmp_path):
    checkout_calls = []

    def fake_checkout_repo(repo_full, commit_sha, base_dir, github_token=None):
        checkout_calls.append((repo_full, commit_sha, base_dir))
        path = Path(base_dir) / repo_full.replace("/", "__")
        path.mkdir(parents=True, exist_ok=True)
        (path / ".git").mkdir(exist_ok=True)
        (path / "repo.txt").write_text(repo_full, encoding="utf-8")
        return str(path), f"commit-{repo_full.split('/')[-1]}"

    clone_calls = []

    def fake_copy_checkout(src_dir, dest_dir, *, shared=False, hardlink=False):
        clone_calls.append((src_dir, dest_dir, shared, hardlink))
        src = Path(src_dir)
        dest = Path(dest_dir)
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest)
        return str(dest), f"commit-{(dest / 'repo.txt').read_text(encoding='utf-8').split('/')[-1]}"

    monkeypatch.setattr(workspace_module, "checkout_repo", fake_checkout_repo)
    monkeypatch.setattr(workspace_module, "copy_checkout", fake_copy_checkout)
    monkeypatch.setattr(workspace_module, "_git_head_commit", fake_cache_git_head)

    prepared = prepare_dependency_workspace(
        data_dir=str(tmp_path / "data"),
        checkout_cache_dir=str(tmp_path / "cache"),
        metadata_id=45,
        scan={
            **scan(),
            "harness": "claude-code",
            "dependencies_detail": [{"kind": "remote", "repo_full": "anza-xyz/agave", "commit_sha": "abc123"}],
        },
        harness_name="claude-code",
    )

    assert [call[2] for call in clone_calls] == [True, True]
    assert [call[3] for call in clone_calls] == [False, False]
    assert (Path(prepared.workspace.root_dir) / "workspace").is_dir()
    assert "OPEN_KRITT_WORKSPACE_READONLY" not in prepared.workspace.env
    manifest = json.loads(prepared.manifest_json)
    assert manifest["primary"]["path"] == "/workspace"
    assert manifest["dependencies"][0]["path"] == "/workspace/agave"
    assert workspace_context(prepared)["workspace_root"] == "/workspace"
    assert "Current working directory / primary repository root: /workspace" in prepared.layout
    assert prepared.repo_dir not in prepared.manifest_json
    assert prepared.repo_dir not in (Path(prepared.repo_dir) / "WORKSPACE.json").read_text(encoding="utf-8")

    clone_calls.clear()
    checkout_calls.clear()
    prepared_again = prepare_dependency_workspace(
        data_dir=str(tmp_path / "data"),
        checkout_cache_dir=str(tmp_path / "cache"),
        metadata_id=46,
        scan={
            **scan(),
            "harness": "claude-code",
            "dependencies_detail": [{"kind": "remote", "repo_full": "anza-xyz/agave", "commit_sha": "abc123"}],
        },
        harness_name="claude-code",
    )

    assert prepared_again.repo_dir != prepared.repo_dir
    assert [call[3] for call in clone_calls] == [False, False]
    assert checkout_calls == []
    assert json.loads(prepared_again.manifest_json)["primary"]["path"] == "/workspace"
    assert prepared_again.repo_dir not in (Path(prepared_again.repo_dir) / "WORKSPACE.json").read_text(encoding="utf-8")


def test_persistent_scan_checkout_cache_restores_ready_entries(monkeypatch, tmp_path):
    def fake_checkout_repo(repo_full, commit_sha, base_dir, github_token=None):
        path = Path(base_dir) / repo_full.replace("/", "__")
        path.mkdir(parents=True, exist_ok=True)
        (path / ".git").mkdir(exist_ok=True)
        (path / "repo.txt").write_text(repo_full, encoding="utf-8")
        return str(path), f"commit-{repo_full.split('/')[-1]}"

    monkeypatch.setattr(workspace_module, "checkout_repo", fake_checkout_repo)
    monkeypatch.setattr(workspace_module, "_git_head_commit", fake_cache_git_head)
    test_scan = {
        **scan(),
        "dependencies_detail": [{"kind": "remote", "repo_full": "anza-xyz/agave", "commit_sha": "abc123"}],
    }
    prewarm_scan_checkout_cache(checkout_cache_dir=str(tmp_path / "cache"), scan=test_scan)

    saved = save_persistent_scan_checkout_cache(
        checkout_cache_dir=str(tmp_path / "cache"),
        checkout_cache_persist_dir=str(tmp_path / "persist"),
        scan=test_scan,
    )
    assert sorted(saved) == ["anza-xyz__agave@abc123", "owner__repo@HEAD"]

    sentinel = tmp_path / "persist" / "scan-7" / "cache" / "owner__repo@HEAD" / "sentinel.txt"
    sentinel.write_text("keep unchanged cache", encoding="utf-8")
    saved_again = save_persistent_scan_checkout_cache(
        checkout_cache_dir=str(tmp_path / "cache"),
        checkout_cache_persist_dir=str(tmp_path / "persist"),
        scan=test_scan,
    )
    assert sorted(saved_again) == ["anza-xyz__agave@abc123", "owner__repo@HEAD"]
    assert sentinel.read_text(encoding="utf-8") == "keep unchanged cache"

    shutil.rmtree(tmp_path / "cache")
    restored = restore_persistent_scan_checkout_cache(
        checkout_cache_dir=str(tmp_path / "cache"),
        checkout_cache_persist_dir=str(tmp_path / "persist"),
        scan=test_scan,
    )
    assert sorted(restored) == ["anza-xyz__agave@abc123", "owner__repo@HEAD"]
    restored_marker = json.loads(
        (tmp_path / "cache" / "owner__repo@HEAD" / ".open-kritt-ready.json").read_text(encoding="utf-8")
    )
    assert restored_marker["version"] == workspace_module.CACHE_MARKER_VERSION
    assert restored_marker["repo_dir"] == "owner__repo"

    def fail_checkout_repo(*_args, **_kwargs):
        raise AssertionError("restored ready cache entries must not be fetched again")

    monkeypatch.setattr(workspace_module, "checkout_repo", fail_checkout_repo)
    manifest = prewarm_scan_checkout_cache(checkout_cache_dir=str(tmp_path / "cache"), scan=test_scan)
    assert manifest["primary"]["commit"] == "commit-repo"
    assert manifest["dependencies"][0]["commit"] == "commit-agave"


def test_prewarm_checkout_cache_removes_stale_entry_before_fetch(monkeypatch, tmp_path):
    stale_base = tmp_path / "cache" / "owner__repo@HEAD"
    stale_repo = stale_base / "owner__repo"
    stale_repo.mkdir(parents=True)
    (stale_repo / "partial.txt").write_text("not a git checkout", encoding="utf-8")

    def fake_checkout_repo(repo_full, commit_sha, base_dir, github_token=None):
        base_path = Path(base_dir)
        assert not base_path.exists()
        path = base_path / repo_full.replace("/", "__")
        path.mkdir(parents=True)
        (path / ".git").mkdir()
        (path / "repo.txt").write_text(repo_full, encoding="utf-8")
        return str(path), "commit-repo"

    monkeypatch.setattr(workspace_module, "checkout_repo", fake_checkout_repo)
    monkeypatch.setattr(workspace_module, "_git_head_commit", fake_cache_git_head)

    manifest = prewarm_scan_checkout_cache(checkout_cache_dir=str(tmp_path / "cache"), scan=scan())

    assert manifest["primary"]["commit"] == "commit-repo"
    assert not (stale_repo / "partial.txt").exists()


def test_persistent_scan_checkout_cache_discards_invalid_restore(tmp_path):
    persisted_repo = tmp_path / "persist" / "scan-7" / "cache" / "owner__repo@HEAD" / "owner__repo"
    persisted_repo.mkdir(parents=True)
    (persisted_repo / "partial.txt").write_text("not a git checkout", encoding="utf-8")

    restored = restore_persistent_scan_checkout_cache(
        checkout_cache_dir=str(tmp_path / "cache"),
        checkout_cache_persist_dir=str(tmp_path / "persist"),
        scan=scan(),
    )

    assert restored == []
    assert not (tmp_path / "cache" / "owner__repo@HEAD").exists()


def test_harness_prompt_explains_stub_contract():
    prompt = harness_prompt(
        "Find things", multi_output=True, schema=output_schema('{"thing":"string"}', multi_output=True)
    )
    assert "`stub` set to true" in prompt
    assert "`stub_explanation`" in prompt
    assert "`results` set to an empty array" in prompt
    assert "valid successful" in prompt
    assert "does not establish an actual bug" in prompt
    assert "`stub: false` with an empty `results` array" in prompt
    assert "fails the attempt" in prompt
    assert "multi-output step" in prompt
    assert "The exact JSON Schema" in prompt
    assert EXTRACTOR_HELPER_FIELD in prompt
    assert '"thing"' in prompt


def test_codex_harness_uses_dangerous_permissions_and_web_search(monkeypatch):
    captured = {}

    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        captured["cmd"] = cmd
        output_path = Path(cmd[cmd.index("-o") + 1])
        output_path.write_text(
            json.dumps(marked({"stub": True, "stub_explanation": "No matching records.", "results": []})),
            encoding="utf-8",
        )
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)

    result = CodexHarness(timeout_seconds=5).run(
        prompt="prompt",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir="/tmp",
        model="gpt-test",
        thinking_effort="low",
    )

    assert result.payload == marked({"stub": True, "stub_explanation": "No matching records.", "results": []})
    assert captured["cmd"][:3] == ["codex", "--search", "exec"]
    assert "--dangerously-bypass-approvals-and-sandbox" in captured["cmd"]
    assert "agents.max_concurrent_threads_per_session=5" in captured["cmd"]
    assert "--ephemeral" not in captured["cmd"]
    assert "--sandbox" not in captured["cmd"]


def test_codex_harness_extracts_fenced_json_from_text_result(monkeypatch):
    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        output_path = Path(cmd[cmd.index("-o") + 1])
        output_path.write_text(
            json.dumps(
                {
                    "result": (
                        "I checked the target and found no applicable issue.\n\n"
                        "```json\n"
                        '{"stub":true,"stub_explanation":"No matching records.","results":[]}\n'
                        "```"
                    )
                }
            ),
            encoding="utf-8",
        )
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)

    result = CodexHarness(timeout_seconds=5).run(
        prompt="prompt",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir="/tmp",
        model="gpt-test",
    )

    assert result.payload == marked({"stub": True, "stub_explanation": "No matching records.", "results": []})


def test_codex_harness_prefers_marked_json_from_text_result(monkeypatch):
    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        output_path = Path(cmd[cmd.index("-o") + 1])
        output_path.write_text(
            json.dumps(
                {
                    "result": (
                        'Unrelated schema example: {"stub": false, "stub_explanation": "", "results": [{"thing": "wrong"}]}.\n\n'
                        "```json\n"
                        '{"_kritt_extractor_helper":true,"stub":true,"stub_explanation":"No matching records.","results":[]}\n'
                        "```"
                    )
                }
            ),
            encoding="utf-8",
        )
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)

    result = CodexHarness(timeout_seconds=5).run(
        prompt="prompt",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir="/tmp",
        model="gpt-test",
    )

    assert result.payload == marked({"stub": True, "stub_explanation": "No matching records.", "results": []})


def test_codex_harness_falls_back_to_jsonl_answer(monkeypatch):
    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        output_path = Path(cmd[cmd.index("-o") + 1])
        output_path.write_text(json.dumps({"result": ""}), encoding="utf-8")
        stdout = "\n".join(
            [
                json.dumps({"type": "thread.started", "thread_id": "thread-1"}),
                json.dumps(
                    {
                        "type": "event_msg",
                        "payload": {
                            "type": "task_complete",
                            "last_agent_message": (
                                "Finished.\n\n"
                                "```json\n"
                                '{"_kritt_extractor_helper":true,"stub":true,"stub_explanation":"No matching records.","results":[]}\n'
                                "```"
                            ),
                        },
                    }
                ),
            ]
        )
        return SimpleNamespace(stdout=stdout, stderr="", returncode=0)

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)

    result = CodexHarness(timeout_seconds=5).run(
        prompt="prompt",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir="/tmp",
        model="gpt-test",
    )

    assert result.payload == marked({"stub": True, "stub_explanation": "No matching records.", "results": []})
    assert result.codex_session_id == "thread-1"


def test_codex_harness_falls_back_to_latest_session_file(monkeypatch, tmp_path):
    codex_home = tmp_path / "home" / ".codex"
    session_dir = codex_home / "sessions" / "2026" / "06" / "29"
    session_dir.mkdir(parents=True)

    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        output_path = Path(cmd[cmd.index("-o") + 1])
        output_path.write_text("", encoding="utf-8")
        session_path = session_dir / "rollout.jsonl"
        session_path.write_text(
            "\n".join(
                [
                    json.dumps({"type": "session_meta", "payload": {"id": "session-1"}}),
                    json.dumps(
                        {
                            "type": "event_msg",
                            "payload": {
                                "type": "token_count",
                                "info": {
                                    "total_token_usage": {"input_tokens": 1, "output_tokens": 2, "total_tokens": 3},
                                    "model_context_window": 100,
                                },
                            },
                        }
                    ),
                    json.dumps(
                        {
                            "type": "event_msg",
                            "payload": {
                                "type": "task_complete",
                                "last_agent_message": (
                                    "Done.\n\n"
                                    "```json\n"
                                    '{"_kritt_extractor_helper":true,"stub":true,"stub_explanation":"No matching records.","results":[]}\n'
                                    "```"
                                ),
                            },
                        }
                    ),
                ]
            ),
            encoding="utf-8",
        )
        return SimpleNamespace(stdout="", stderr="", returncode=0)

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)

    result = CodexHarness(timeout_seconds=5).run(
        prompt="prompt",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir="/tmp",
        model="gpt-test",
        env={"CODEX_HOME": str(codex_home)},
    )

    assert result.payload == marked({"stub": True, "stub_explanation": "No matching records.", "results": []})
    assert result.codex_session_id == "session-1"
    assert result.usage["total_tokens"] == 3


def test_codex_harness_resumes_corrupted_session_for_json(monkeypatch, tmp_path):
    codex_home = tmp_path / "home" / ".codex"
    session_dir = codex_home / "sessions" / "2026" / "06" / "29"
    session_dir.mkdir(parents=True)
    calls = []
    prompts = []

    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        calls.append(cmd)
        prompts.append(prompt)
        output_path = Path(cmd[cmd.index("-o") + 1])
        if cmd[:3] == ["codex", "--search", "exec"]:
            output_path.write_text("", encoding="utf-8")
            session_path = session_dir / "corrupted.jsonl"
            session_path.write_text(
                "\n".join(
                    [
                        json.dumps({"type": "session_meta", "payload": {"id": "session-bad"}}),
                        json.dumps(
                            {
                                "type": "event_msg",
                                "payload": {
                                    "type": "task_complete",
                                    "last_agent_message": "token salad </think> no json here",
                                },
                            }
                        ),
                    ]
                ),
                encoding="utf-8",
            )
            return SimpleNamespace(stdout="", stderr="", returncode=0)
        if cmd[:3] == ["codex", "exec", "resume"]:
            output_path.write_text(
                json.dumps(marked({"stub": True, "stub_explanation": "No matching records.", "results": []})),
                encoding="utf-8",
            )
            stdout = "\n".join(
                [
                    json.dumps({"type": "session_meta", "payload": {"id": "session-bad"}}),
                    json.dumps(
                        {
                            "type": "event_msg",
                            "payload": {
                                "type": "token_count",
                                "info": {
                                    "total_token_usage": {"input_tokens": 3, "output_tokens": 4, "total_tokens": 7}
                                },
                            },
                        }
                    ),
                ]
            )
            return SimpleNamespace(stdout=stdout, stderr="", returncode=0)
        raise AssertionError(f"unexpected command: {cmd}")

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)

    result = CodexHarness(timeout_seconds=5, model_provider="openrouter").run(
        prompt="prompt",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir="/tmp",
        model="glm-5.2",
        thinking_effort="medium",
        env={"CODEX_HOME": str(codex_home)},
    )

    assert result.payload == marked({"stub": True, "stub_explanation": "No matching records.", "results": []})
    assert result.codex_session_id == "session-bad"
    assert result.usage["total_tokens"] == 7
    assert calls[1][:3] == ["codex", "exec", "resume"]
    assert calls[1][-2:] == ["session-bad", "-"]
    assert "agents.max_concurrent_threads_per_session=5" in calls[1]
    assert 'model_provider="openrouter"' in calls[1]
    assert 'model_reasoning_effort="medium"' in calls[1]
    assert EXTRACTOR_HELPER_FIELD in prompts[1]
    assert "The exact JSON Schema" in prompts[1]
    assert "does not establish an actual bug" in prompts[1]
    assert "`stub: false` with an empty `results`" in prompts[1]
    assert "Do not include markdown fences" in prompts[1]


def test_claude_harness_uses_dangerous_permissions_and_default_tools(monkeypatch, tmp_path):
    captured = {}

    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        captured["cmd"] = cmd
        captured["timeout"] = timeout
        return SimpleNamespace(
            stdout=json.dumps(
                {
                    "result": {
                        "structured_output": marked(
                            {"stub": True, "stub_explanation": "No matching records.", "results": []}
                        )
                    },
                    "usage": {"input_tokens": 1},
                }
            ),
            stderr="",
            returncode=0,
        )

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)
    monkeypatch.setattr(harnesses, "claude_oauth_timeout_seconds", lambda *_args: 3)

    source_schema = output_schema('{"thing":"string"}', multi_output=False)
    result = ClaudeHarness(timeout_seconds=5).run(
        prompt="prompt",
        schema=source_schema,
        repo_dir="/tmp",
        model="claude-test",
        thinking_effort="low",
        env={
            "HOME": str(tmp_path / "home"),
            "CLAUDE_HOME": str(tmp_path / "home" / ".claude"),
            "CLAUDE_CONFIG_DIR": str(tmp_path / "home" / ".claude"),
            "OPEN_KRITT_CLAUDE_OAUTH_EXPIRES_AT_MS": "9999999999999",
        },
    )

    assert result.payload == marked({"stub": True, "stub_explanation": "No matching records.", "results": []})
    assert captured["timeout"] == 3
    assert "--dangerously-skip-permissions" in captured["cmd"]
    if captured["cmd"][:3] == ["runuser", "-u", "nobody"]:
        assert captured["cmd"][3:5] == ["--preserve-environment", "--"]
        assert not any(part.startswith("HOME=") for part in captured["cmd"])
        assert "claude" in captured["cmd"]
    assert captured["cmd"][captured["cmd"].index("--tools") + 1] == "default"
    assert "--append-system-prompt" in captured["cmd"]
    assert "--no-session-persistence" in captured["cmd"]
    assert "--permission-mode" not in captured["cmd"]
    claude_schema = json.loads(captured["cmd"][captured["cmd"].index("--json-schema") + 1])
    assert source_schema["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    assert "$schema" not in claude_schema
    assert claude_schema["properties"][EXTRACTOR_HELPER_FIELD] == {"type": "boolean", "const": True}


def test_claude_harness_can_route_glm_through_openrouter(monkeypatch, tmp_path):
    captured = {}

    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        captured["cmd"] = cmd
        captured["env"] = env
        payload = marked({"stub": True, "stub_explanation": "No matching records.", "results": []})
        return SimpleNamespace(
            stdout="\n".join(
                [
                    json.dumps(
                        {
                            "type": "assistant",
                            "message": {"content": [{"type": "text", "text": json.dumps(payload)}]},
                        }
                    ),
                    json.dumps(
                        {
                            "type": "result",
                            "result": json.dumps(payload),
                            "usage": {"input_tokens": 1},
                            "total_cost_usd": 0.01,
                            "modelUsage": {"z-ai/glm-5.2": {"inputTokens": 1}},
                        }
                    ),
                ]
            ),
            stderr="",
            returncode=0,
        )

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)

    result = ClaudeHarness(timeout_seconds=5).run(
        prompt="prompt",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir="/tmp",
        model="glm-5.2",
        thinking_effort="medium",
        env={
            "HOME": str(tmp_path / "home"),
            "CLAUDE_HOME": str(tmp_path / "home" / ".claude"),
            "CLAUDE_CONFIG_DIR": str(tmp_path / "home" / ".claude"),
            "OPENROUTER_API_KEY": "or-key",
            "CODEX_MODEL_PROVIDER": "openrouter",
        },
    )

    assert result.payload == marked({"stub": True, "stub_explanation": "No matching records.", "results": []})
    assert captured["cmd"][captured["cmd"].index("--model") + 1] == "z-ai/glm-5.2"
    assert captured["env"]["ANTHROPIC_BASE_URL"] == "https://openrouter.ai/api"
    assert captured["env"]["ANTHROPIC_AUTH_TOKEN"] == "or-key"
    assert captured["env"]["ANTHROPIC_API_KEY"] == ""
    # The subprocess environment is authoritative in both containers and local
    # development; credentials must never be serialized into process arguments.
    if captured["cmd"][:3] == ["runuser", "-u", "nobody"]:
        assert captured["cmd"][3:5] == ["--preserve-environment", "--"]
        assert not any("or-key" in part for part in captured["cmd"])
    assert captured["cmd"][captured["cmd"].index("--output-format") + 1] == "stream-json"
    assert "--include-partial-messages" in captured["cmd"]
    assert "--verbose" in captured["cmd"]
    assert "--disallowedTools" not in captured["cmd"]
    assert "--append-system-prompt" in captured["cmd"]
    assert "--json-schema" not in captured["cmd"]
    assert harnesses.claude_model_provider("glm-5.2", captured["env"]) == "openrouter"


def test_claude_openrouter_parse_error_carries_raw_output(monkeypatch, tmp_path):
    raw_stdout = "\n".join(
        [
            json.dumps({"type": "system", "message": "started"}),
            json.dumps({"type": "result", "usage": {"input_tokens": 1}}),
        ]
    )

    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        return SimpleNamespace(stdout=raw_stdout, stderr="raw stderr", returncode=0)

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)

    with pytest.raises(HarnessError) as raised:
        ClaudeHarness(timeout_seconds=5).run(
            prompt="prompt",
            schema=output_schema('{"thing":"string"}', multi_output=False),
            repo_dir="/tmp",
            model="glm-5.2",
            env={
                "HOME": str(tmp_path / "home"),
                "CLAUDE_HOME": str(tmp_path / "home" / ".claude"),
                "CLAUDE_CONFIG_DIR": str(tmp_path / "home" / ".claude"),
                "OPENROUTER_API_KEY": "or-key",
                "CODEX_MODEL_PROVIDER": "openrouter",
            },
        )

    assert raised.value.code == "invalid_output"
    assert raised.value.output.stdout == raw_stdout
    assert raised.value.output.stderr == "raw stderr"
    assert raised.value.output.returncode == 0


def test_claude_openrouter_stream_rate_limit_is_preserved(monkeypatch, tmp_path):
    raw_stdout = json.dumps({"type": "error", "error": {"message": "requires more credits"}})
    monkeypatch.setattr(
        harnesses,
        "_run_process",
        lambda *_args, **_kwargs: SimpleNamespace(stdout=raw_stdout, stderr="", returncode=0),
    )

    with pytest.raises(HarnessError) as raised:
        ClaudeHarness(timeout_seconds=5, model_provider="openrouter").run(
            prompt="prompt",
            schema=output_schema('{"thing":"string"}', multi_output=False),
            repo_dir="/tmp",
            model="glm-5.2",
            env={
                "HOME": str(tmp_path / "home"),
                "OPENROUTER_API_KEY": "or-key",
            },
        )

    assert raised.value.code == "rate_limited"
    assert raised.value.retryable is True
    assert raised.value.output.stdout == raw_stdout


def test_native_claude_json_rate_limit_is_preserved(monkeypatch, tmp_path):
    raw_stdout = json.dumps({"is_error": True, "result": "rate limit exceeded", "status": 429})
    monkeypatch.setattr(
        harnesses,
        "_run_process",
        lambda *_args, **_kwargs: SimpleNamespace(stdout=raw_stdout, stderr="", returncode=0),
    )
    monkeypatch.setattr(harnesses, "claude_oauth_timeout_seconds", lambda *_args: 5)

    with pytest.raises(HarnessError) as raised:
        ClaudeHarness(timeout_seconds=5, model_provider="claude").run(
            prompt="prompt",
            schema=output_schema('{"thing":"string"}', multi_output=False),
            repo_dir="/tmp",
            model="claude-sonnet-4-5",
            env={"HOME": str(tmp_path / "home")},
        )

    assert raised.value.code == "rate_limited"
    assert raised.value.retryable is True
    assert raised.value.output.stdout == raw_stdout


def test_cursor_harness_routes_grok_openrouter_headless(monkeypatch, tmp_path):
    captured = {}
    payload = marked({"stub": True, "stub_explanation": "No matching records.", "results": []})

    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        captured["cmd"] = cmd
        captured["prompt"] = prompt
        captured["cwd"] = cwd
        captured["env"] = env
        return SimpleNamespace(
            stdout=json.dumps({"result": json.dumps(payload), "usage": {"input_tokens": 1}}),
            stderr="",
            returncode=0,
        )

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)

    result = CursorHarness(timeout_seconds=5, model_provider="openrouter").run(
        prompt="prompt",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir=str(tmp_path),
        model="grok-4.5",
        thinking_effort="xhigh",
        env={"HOME": str(tmp_path / "home"), "CURSOR_AGENT_BIN": "cursor-agent"},
    )

    assert result.payload == payload
    assert captured["prompt"] == "prompt"
    assert captured["cwd"] == str(tmp_path)
    assert captured["cmd"][:4] == ["cursor-agent", "-p", "--output-format", "json"]
    assert captured["cmd"][captured["cmd"].index("--model") + 1] == "grok-4.5-xhigh"
    assert "--force" in captured["cmd"]
    assert "--trust" in captured["cmd"]
    assert captured["cmd"][captured["cmd"].index("--workspace") + 1] == str(tmp_path)
    assert result.usage["model_provider"] == "openrouter"
    assert result.usage["openrouter_model"] == "grok-4.5-xhigh"
    assert result.usage["thinking_effort"] == "xhigh"


def test_cursor_harness_aliases():
    assert harnesses.normalize_harness_name("cursor-cli") == "cursor"
    assert harnesses.normalize_harness_name("cursor-agent") == "cursor"


def test_tool_harness_docker_runner_is_root_writable_and_internet_enabled(monkeypatch, tmp_path):
    data_dir = tmp_path / "engine-data"
    host_data_dir = tmp_path / "host-engine-data"
    repo_dir = data_dir / "jobs" / "metadata-777" / "workspace"
    home_dir = data_dir / "jobs" / "metadata-777" / "home"
    repo_dir.mkdir(parents=True)
    home_dir.mkdir(parents=True)
    captured = {}

    monkeypatch.setenv("ENGINE_DATA_DIR", str(data_dir))
    monkeypatch.setenv("ENGINE_DOCKER_DATA_DIR_HOST", str(host_data_dir))
    monkeypatch.setenv("ENGINE_SCAN_RUNNER_IMAGE", "runner-image")
    monkeypatch.setattr(harnesses, "_scan_docker_command", REAL_SCAN_DOCKER_COMMAND)
    original_which = shutil.which
    monkeypatch.setattr(harnesses.shutil, "which", lambda name: "docker" if name == "docker" else original_which(name))

    def fake_run_process(cmd, prompt, cwd, timeout, env=None):
        captured["cmd"] = cmd
        captured["cwd"] = cwd
        captured["env"] = env
        return SimpleNamespace(
            stdout=json.dumps(
                {
                    "result": {
                        "structured_output": marked(
                            {"stub": True, "stub_explanation": "No matching records.", "results": []}
                        )
                    },
                    "usage": {"input_tokens": 1},
                }
            ),
            stderr="",
            returncode=0,
        )

    monkeypatch.setattr(harnesses, "_run_process", fake_run_process)

    result = ClaudeHarness(
        timeout_seconds=5,
        runner_memory_mb=1536,
        runner_memory_reservation_mb=768,
    ).run(
        prompt="prompt",
        schema=output_schema('{"thing":"string"}', multi_output=False),
        repo_dir=str(repo_dir),
        model="claude-test",
        env={
            "HOME": str(home_dir),
            "CLAUDE_HOME": str(home_dir / ".claude"),
            "CLAUDE_CONFIG_DIR": str(home_dir / ".claude"),
            "OPEN_KRITT_JOB_UID": "100777",
            "OPEN_KRITT_JOB_GID": "100777",
        },
    )

    assert result.payload == marked({"stub": True, "stub_explanation": "No matching records.", "results": []})
    assert captured["cmd"][:3] == ["docker", "run", "--rm"]
    mounts = [captured["cmd"][index + 1] for index, value in enumerate(captured["cmd"]) if value == "--mount"]
    assert f"type=bind,src={host_data_dir / 'jobs' / 'metadata-777' / 'workspace'},dst=/workspace" in mounts
    assert f"type=bind,src={host_data_dir / 'jobs' / 'metadata-777' / 'home'},dst=/home/runner" in mounts
    assert not any("src=/data" in mount or "dst=/data" in mount for mount in mounts)
    assert "--volumes-from" not in captured["cmd"]
    assert "--user" in captured["cmd"]
    assert captured["cmd"][captured["cmd"].index("--user") + 1] == "0:0"
    assert "--cap-drop" not in captured["cmd"]
    assert "--security-opt" not in captured["cmd"]
    assert "--read-only" not in captured["cmd"]
    network = captured["cmd"][captured["cmd"].index("--network") + 1]
    assert network.startswith(harnesses.SCAN_SANDBOX_NETWORK_PREFIX)
    assert "runner-image" in captured["cmd"]
    assert captured["cmd"][captured["cmd"].index("--workdir") + 1] == "/workspace"
    assert captured["cmd"][captured["cmd"].index("--memory") + 1] == "1536m"
    assert captured["cmd"][captured["cmd"].index("--memory-swap") + 1] == "1536m"
    assert captured["cmd"][captured["cmd"].index("--memory-reservation") + 1] == "768m"
    assert "--env" in captured["cmd"]
    assert "HOME=/home/runner" in captured["cmd"]
    assert "CODEX_HOME=/home/runner/.codex" in captured["cmd"]
    assert "GIT_OPTIONAL_LOCKS=0" in captured["cmd"]
    assert "IS_SANDBOX=1" in captured["cmd"]
    assert not any("PROXY=" in part for part in captured["cmd"])
    assert captured["cwd"] == str(repo_dir)


def test_harness_process_errors_do_not_echo_command_or_provider_output(monkeypatch):
    def timeout(*_args, **_kwargs):
        raise subprocess.TimeoutExpired(["provider", "secret-value"], 1, output="secret-value")

    monkeypatch.setattr(harnesses.subprocess, "run", timeout)

    with pytest.raises(harnesses.HarnessError, match="timed out") as exc_info:
        harnesses._run_process(["provider", "secret-value"], "prompt", "/tmp", 1, env={})

    assert "secret-value" not in str(exc_info.value)


@pytest.mark.parametrize(
    ("provider_output", "expected_code", "retryable"),
    [
        ('{"error":{"code":"invalid_json_schema"}}', "invalid_output_schema", False),
        ('{"error":{"type":"authentication_error"},"status":401}', "auth_failed", False),
        ('{"error":{"code":"model_not_found"}}', "model_unavailable", False),
        (
            '{"type":"error","message":"Selected model is at capacity. Please try a different model."}',
            "model_capacity",
            True,
        ),
        (
            '{"type":"error","message":"This content was flagged for possible cybersecurity risk."}',
            "cyber_safety_blocked",
            False,
        ),
        ('{"type":"error","message":"unrecognized provider rejection"}', "provider_rejected", True),
        ('{"error":{"type":"rate_limit_error"},"status":429}', "rate_limited", True),
        ('{"error":{"type":"rate_limit_error"},"status":403}', "rate_limited", True),
        (
            '{"api_error_status":429,"result":"Server is temporarily limiting requests (not your usage limit)"}',
            "provider_throttled",
            True,
        ),
        (
            '{"limit_id":"premium"}\nAgent errored: You\'ve hit your usage limit. Upgrade to Pro.',
            "subagent_limited",
            True,
        ),
        ('{"error":"usage_limit"}', "account_quota_limited", True),
        ('{"error":"you have hit your limit"}', "account_quota_limited", True),
        ('{"api_error_status":403,"result":"Key limit exceeded (total limit)"}', "account_quota_limited", True),
        ('{"error":"quota has been exceeded","status":403}', "quota_exceeded", False),
        ('{"error":"permission to use this model","status":403}', "model_access_denied", False),
        ('{"error":{"code":"insufficient_quota"}}', "quota_exceeded", False),
        ('{"api_error_status":400,"result":"Credit balance is too low"}', "quota_exceeded", False),
        (
            "Error: --json-schema is not a valid JSON Schema: no schema with key or ref "
            '"https://json-schema.org/draft/2020-12/schema"',
            "invalid_output_schema",
            False,
        ),
        ('{"status":503,"error":"upstream unavailable"}', "provider_unavailable", True),
    ],
)
def test_harness_process_errors_are_classified_without_echoing_output(
    monkeypatch, provider_output, expected_code, retryable
):
    secret_output = f"{provider_output} secret-provider-detail"
    monkeypatch.setattr(
        harnesses.subprocess,
        "run",
        lambda *_args, **_kwargs: type(
            "Process",
            (),
            {"stdout": secret_output, "stderr": "", "returncode": 1},
        )(),
    )

    with pytest.raises(harnesses.HarnessError) as exc_info:
        harnesses._run_process(["codex", "exec"], "prompt", "/tmp", 1, env={})

    assert exc_info.value.code == expected_code
    assert exc_info.value.retryable is retryable
    assert exc_info.value.exit_code == 1
    assert exc_info.value.harness == "codex"
    assert "secret-provider-detail" not in str(exc_info.value)
    assert "secret-provider-detail" not in exc_info.value.public_message


def test_unstructured_process_failure_uses_model_process_error(monkeypatch):
    monkeypatch.setattr(
        harnesses.subprocess,
        "run",
        lambda *_args, **_kwargs: type(
            "Process",
            (),
            {"stdout": "unstructured secret-provider-detail", "stderr": "", "returncode": 1},
        )(),
    )

    with pytest.raises(harnesses.HarnessError) as exc_info:
        harnesses._run_process(["codex", "exec"], "prompt", "/tmp", 1, env={})

    assert exc_info.value.code == "model_process_error"
    assert "harness" not in exc_info.value.public_message.lower()
    assert "secret-provider-detail" not in exc_info.value.public_message


def test_harness_dns_failure_has_safe_specific_public_message(monkeypatch):
    monkeypatch.setattr(
        harnesses.subprocess,
        "run",
        lambda *_args, **_kwargs: type(
            "Process",
            (),
            {
                "stdout": "failed to lookup address information secret-provider-detail",
                "stderr": "",
                "returncode": 1,
            },
        )(),
    )

    with pytest.raises(harnesses.HarnessError) as exc_info:
        harnesses._run_process(["codex", "exec"], "prompt", "/tmp", 1, env={})

    assert exc_info.value.code == "network_error"
    assert "DNS lookup failed" in exc_info.value.public_message
    assert "secret-provider-detail" not in exc_info.value.public_message


@pytest.mark.parametrize(
    "provider_output",
    [
        '{"error":{"code":"insufficient_quota"}}',
        '{"error":"key limit exceeded"}',
        '{"error":"requires more credits"}',
        '{"error":"insufficient credits"}',
    ],
)
def test_openrouter_credit_limits_are_classified_as_rate_limited(monkeypatch, provider_output):
    monkeypatch.setattr(
        harnesses.subprocess,
        "run",
        lambda *_args, **_kwargs: type(
            "Process",
            (),
            {"stdout": provider_output, "stderr": "", "returncode": 1},
        )(),
    )

    with pytest.raises(harnesses.HarnessError) as exc_info:
        harnesses._run_process(
            ["codex", "exec", "-c", 'model_provider="openrouter"'],
            "prompt",
            "/tmp",
            1,
            env={"OPENROUTER_API_KEY": "secret"},
        )

    assert exc_info.value.code == "rate_limited"
    assert exc_info.value.retryable is True


def test_harness_rate_limit_error_carries_retry_after(monkeypatch):
    monkeypatch.setattr(
        harnesses.subprocess,
        "run",
        lambda *_args, **_kwargs: type(
            "Process",
            (),
            {"stdout": '{"status":429,"retry_after":12.5}', "stderr": "", "returncode": 1},
        )(),
    )

    with pytest.raises(harnesses.HarnessError) as exc_info:
        harnesses._run_process(["codex", "exec"], "prompt", "/tmp", 1, env={})

    assert exc_info.value.code == "rate_limited"
    assert exc_info.value.retry_after_seconds == 12.5


def test_harness_usage_limit_error_carries_natural_language_reset_time():
    retry_at = datetime.now(timezone.utc) + timedelta(days=2)
    formatted = retry_at.strftime("%b DAYth, %Y %I:%M %p").replace("DAY", str(retry_at.day))

    retry_after = harnesses._retry_after_seconds(f"You've hit your usage limit; try again at {formatted}.")

    assert retry_after is not None
    assert 47 * 60 * 60 < retry_after <= 48 * 60 * 60


def test_github_repo_url_normalizes_to_owner_repo():
    assert normalize_repo_full("https://github.com/anza-xyz/agave") == "anza-xyz/agave"
    assert normalize_repo_full("https://github.com/anza-xyz/agave.git") == "anza-xyz/agave"
    assert safe_repo_dir("/repos", "https://github.com/anza-xyz/agave.git").endswith("anza-xyz__agave")
    assert github_clone_url("https://github.com/anza-xyz/agave") == "https://github.com/anza-xyz/agave.git"


def test_job_workspace_skips_transient_codex_tmp(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    codex_home = tmp_path / "source-codex"
    claude_home = tmp_path / "source-claude"
    codex_home.mkdir()
    claude_home.mkdir()
    (codex_home / "auth.json").write_text("{}", encoding="utf-8")
    (codex_home / "config.toml").write_text(
        '[mcp_servers.private]\ncommand = "print-secret"\nenv = { TOKEN = "mcp-secret" }\n',
        encoding="utf-8",
    )
    (codex_home / ".tmp" / "plugins").mkdir(parents=True)
    (codex_home / ".tmp" / "plugins" / "large-cache").write_text("skip", encoding="utf-8")
    (claude_home / "settings.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("ENGINE_CODEX_HOME", str(codex_home))
    monkeypatch.setenv("CODEX_HOME", str(codex_home))
    monkeypatch.setenv("CLAUDE_HOME", str(claude_home))
    monkeypatch.setenv("OPENAI_API_KEY", "openai-secret")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "anthropic-secret")
    monkeypatch.setenv("OPENROUTER_API_KEY", "openrouter-secret")
    monkeypatch.setenv("GITHUB_TOKEN", "github-secret")
    monkeypatch.setenv("DATABASE_URL", "database-secret")

    workspace = prepare_job_workspace(str(tmp_path / "data"), 123, model_provider="codex")

    home = Path(workspace.env["HOME"])
    assert (home / ".codex" / "auth.json").exists()
    assert not (home / ".codex" / "config.toml").exists()
    assert not (home / ".codex" / ".tmp").exists()
    assert not (home / ".claude" / "settings.json").exists()
    assert workspace.env["CODEX_API_KEY"] == "openai-secret"
    assert "ANTHROPIC_API_KEY" not in workspace.env
    assert "OPENROUTER_API_KEY" not in workspace.env
    assert "GITHUB_TOKEN" not in workspace.env
    assert "DATABASE_URL" not in workspace.env


def test_job_workspace_copies_only_claude_credentials(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    claude_home = tmp_path / "source-claude"
    backup_dir = claude_home / "backups"
    backup_dir.mkdir(parents=True)
    (backup_dir / ".claude.json.backup.123").write_text('{"restored":true}', encoding="utf-8")
    credential = '{"claudeAiOauth":{"accessToken":"test","refreshToken":"refresh","expiresAt":9999999999999}}'
    (claude_home / ".credentials.json").write_text(credential, encoding="utf-8")
    (claude_home / ".open-kritt-account.json").write_text(
        '{"provider":"claude","accountId":"claude-account-id","email":"researcher@example.test"}',
        encoding="utf-8",
    )
    (claude_home / "settings.json").write_text('{"hooks":{"PreToolUse":"leak"}}', encoding="utf-8")
    monkeypatch.setenv("CLAUDE_HOME", str(claude_home))

    workspace = prepare_job_workspace(
        str(tmp_path / "data"),
        124,
        harness_name="claude-code",
        model_provider="claude",
    )

    job_claude_home = Path(workspace.env["CLAUDE_HOME"])
    assert (job_claude_home / ".credentials.json").read_text(encoding="utf-8") == credential
    assert (job_claude_home / ".claude.json").read_text(encoding="utf-8") == "{}\n"
    assert not (job_claude_home / "backups").exists()
    assert not (job_claude_home / "settings.json").exists()
    assert workspace.provider_account_provider == "claude"
    assert workspace.provider_account_home == str(claude_home)
    assert workspace.provider_account_id == "claude-account-id"
    assert workspace.provider_account_email == "researcher@example.test"
    assert workspace.codex_account_id is None
    assert workspace.codex_account_email is None


def test_job_workspace_rotates_between_configured_codex_homes(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    home_a = tmp_path / "homes" / "primary"
    home_b = tmp_path / "homes" / "secondary"
    claude_home = tmp_path / "source-claude"
    (home_a / ".codex").mkdir(parents=True)
    (home_b / ".codex").mkdir(parents=True)
    claude_home.mkdir()
    (home_a / ".codex" / "auth.json").write_text('{"account":"a"}', encoding="utf-8")
    (home_b / ".codex" / "auth.json").write_text('{"account":"b"}', encoding="utf-8")
    monkeypatch.setenv("ENGINE_CODEX_HOME", f"{home_a},{home_b}")
    monkeypatch.setenv("CLAUDE_HOME", str(claude_home))

    workspace_1 = prepare_job_workspace(str(tmp_path / "data"), 1, model_provider="codex")
    workspace_2 = prepare_job_workspace(str(tmp_path / "data"), 2, model_provider="codex")
    workspace_3 = prepare_job_workspace(str(tmp_path / "data"), 3, model_provider="codex")

    assert _configured_codex_homes() == [str(home_a / ".codex"), str(home_b / ".codex")]
    assert Path(workspace_1.codex_source_home) == home_a / ".codex"
    assert Path(workspace_2.codex_source_home) == home_b / ".codex"
    assert Path(workspace_3.codex_source_home) == home_a / ".codex"
    assert "OPEN_KRITT_CODEX_SOURCE_HOME" not in workspace_1.env
    assert (Path(workspace_1.env["CODEX_HOME"]) / "auth.json").read_text(encoding="utf-8") == '{"account":"a"}'
    assert (Path(workspace_2.env["CODEX_HOME"]) / "auth.json").read_text(encoding="utf-8") == '{"account":"b"}'
    assert (Path(workspace_3.env["CODEX_HOME"]) / "auth.json").read_text(encoding="utf-8") == '{"account":"a"}'


def test_claude_rotation_reloads_live_account_list_without_engine_restart(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    runtime_path = data_dir / "engine-runtime.env"
    home_a = tmp_path / "claude-accounts" / "account-a" / ".claude"
    home_b = tmp_path / "claude-accounts" / "account-b" / ".claude"
    home_a.mkdir(parents=True)
    home_b.mkdir(parents=True)
    (home_a / ".credentials.json").write_text("{}", encoding="utf-8")
    (home_b / ".credentials.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr(workspace_module, "_provider_account_health", lambda _provider: {})

    runtime_path.write_text(f"ENGINE_CLAUDE_HOME={home_a}\n", encoding="utf-8")
    assert _configured_claude_homes(data_dir=str(data_dir)) == [str(home_a)]
    assert provider_home_for_job("claude", 1, data_dir=str(data_dir)) == str(home_a)

    runtime_path.write_text(f"ENGINE_CLAUDE_HOME={home_a},{home_b}\n", encoding="utf-8")
    assert _configured_claude_homes(data_dir=str(data_dir)) == [str(home_a), str(home_b)]
    assert {
        provider_home_for_job("claude", 2, data_dir=str(data_dir)),
        provider_home_for_job("claude", 3, data_dir=str(data_dir)),
    } == {str(home_a), str(home_b)}

    runtime_path.write_text(f"ENGINE_CLAUDE_HOME={home_b}\n", encoding="utf-8")
    assert _configured_claude_homes(data_dir=str(data_dir)) == [str(home_b)]
    assert provider_home_for_job("claude", 4, data_dir=str(data_dir)) == str(home_b)


@pytest.mark.parametrize("provider", ["codex", "claude"])
def test_provider_rotation_skips_limited_accounts_until_all_are_limited(monkeypatch, tmp_path, provider):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    home_a = tmp_path / provider / "account-a"
    home_b = tmp_path / provider / "account-b"
    home_a.mkdir(parents=True)
    home_b.mkdir(parents=True)
    if provider == "codex":
        (home_a / "auth.json").write_text("{}", encoding="utf-8")
        (home_b / "auth.json").write_text("{}", encoding="utf-8")
    setting = "ENGINE_CODEX_HOME" if provider == "codex" else "ENGINE_CLAUDE_HOME"
    monkeypatch.setenv(setting, f"{home_a},{home_b}")

    first = provider_home_for_job(provider, 1)
    mark_provider_account_rate_limited(provider, first)
    second = provider_home_for_job(provider, 2)
    third = provider_home_for_job(provider, 3)

    assert second == third
    assert second != first
    assert not provider_accounts_all_rate_limited(provider)

    mark_provider_account_rate_limited(provider, second)
    assert provider_accounts_all_rate_limited(provider)
    assert provider_home_for_job(provider, 4) in {str(home_a), str(home_b)}

    mark_provider_account_available(provider, first)
    assert provider_home_for_job(provider, 5) == first


def test_provider_rotation_prefers_live_available_account(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    home_a = tmp_path / "homes" / "limited-a"
    home_b = tmp_path / "homes" / "limited-b"
    home_c = tmp_path / "homes" / "available"
    for home in (home_a, home_b, home_c):
        home.mkdir(parents=True)
        (home / "auth.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("ENGINE_CODEX_HOME", f"{home_a},{home_b},{home_c}")
    monkeypatch.setattr(
        "open_kritt_engine.workspace._provider_account_health",
        lambda provider: {
            str(home_a): workspace_module._ProviderAccountHealth(False, 100),
            str(home_b): workspace_module._ProviderAccountHealth(False, 100),
            str(home_c): workspace_module._ProviderAccountHealth(True, 100),
        },
    )

    assert provider_home_for_job("codex", 1) == str(home_c)
    assert provider_home_for_job("codex", 2) == str(home_c)
    assert not provider_accounts_all_rate_limited("codex")


def test_provider_rotation_releases_stale_local_limit_after_newer_available_observation(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    home_a = tmp_path / "homes" / "recovered"
    home_b = tmp_path / "homes" / "available"
    for home in (home_a, home_b):
        home.mkdir(parents=True)
        (home / "auth.json").write_text("{}", encoding="utf-8")
    monkeypatch.setenv("ENGINE_CODEX_HOME", f"{home_a},{home_b}")
    observed_at = 99.0
    monkeypatch.setattr(workspace_module.time, "time", lambda: 100.0)
    monkeypatch.setattr(
        workspace_module,
        "_provider_account_health",
        lambda provider: {
            str(home_a): workspace_module._ProviderAccountHealth(True, observed_at),
            str(home_b): workspace_module._ProviderAccountHealth(True, observed_at),
        },
    )

    mark_provider_account_rate_limited("codex", str(home_a))

    assert provider_home_for_job("codex", 1) == str(home_b)

    observed_at = 101.0

    assert {provider_home_for_job("codex", 2), provider_home_for_job("codex", 3)} == {
        str(home_a),
        str(home_b),
    }


def test_provider_health_timestamp_parses_account_service_observation():
    observed_at = workspace_module._provider_health_timestamp("2026-07-26T08:45:09.977704Z")

    assert observed_at == datetime(2026, 7, 26, 8, 45, 9, 977704, tzinfo=timezone.utc).timestamp()


def test_provider_account_lease_reloads_worker_limit_live(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    runtime_path = data_dir / "engine-runtime.env"
    runtime_path.write_text("ENGINE_WORKERS_PER_ACCOUNT=1\n", encoding="utf-8")
    home = str(tmp_path / "account" / ".codex")
    first_entered = threading.Event()
    release_first = threading.Event()
    second_entered = threading.Event()

    def first_call():
        with provider_account_lease("codex", home, data_dir=str(data_dir)):
            first_entered.set()
            assert release_first.wait(2)

    def second_call():
        assert first_entered.wait(2)
        with provider_account_lease("codex", home, data_dir=str(data_dir)):
            second_entered.set()

    first = threading.Thread(target=first_call)
    second = threading.Thread(target=second_call)
    first.start()
    assert first_entered.wait(2)
    second.start()
    assert not second_entered.wait(0.05)
    runtime_path.write_text("ENGINE_WORKERS_PER_ACCOUNT=2\n", encoding="utf-8")
    assert second_entered.wait(1.5)
    release_first.set()
    first.join(timeout=2)
    second.join(timeout=2)

    assert not first.is_alive()
    assert not second.is_alive()


def test_provider_account_lease_defaults_to_fifteen_parallel_root_calls(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_WORKERS_PER_ACCOUNT", raising=False)
    assert workspace_module._provider_account_worker_limit() == 15

    home = str(tmp_path / "parallel-account" / ".codex")
    first_entered = threading.Event()
    release_first = threading.Event()
    second_entered = threading.Event()

    def first_call():
        with provider_account_lease("codex", home):
            first_entered.set()
            assert release_first.wait(2)

    def second_call():
        assert first_entered.wait(2)
        with provider_account_lease("codex", home):
            second_entered.set()

    first = threading.Thread(target=first_call)
    second = threading.Thread(target=second_call)
    first.start()
    assert first_entered.wait(2)
    second.start()
    assert second_entered.wait(0.5)
    release_first.set()
    first.join(timeout=2)
    second.join(timeout=2)

    assert not first.is_alive()
    assert not second.is_alive()


def test_job_workspace_reloads_codex_homes_from_runtime_file(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    home_a = tmp_path / "homes" / "primary"
    home_b = tmp_path / "homes" / "secondary"
    claude_home = tmp_path / "source-claude"
    (home_a / ".codex").mkdir(parents=True)
    (home_b / ".codex").mkdir(parents=True)
    claude_home.mkdir()
    (home_a / ".codex" / "auth.json").write_text('{"account":"a"}', encoding="utf-8")
    (home_b / ".codex" / "auth.json").write_text('{"account":"b"}', encoding="utf-8")
    data_dir = tmp_path / "data"
    monkeypatch.setenv("ENGINE_CODEX_HOME", str(home_a))
    monkeypatch.setenv("ENGINE_WORKER_COUNT", "2")
    monkeypatch.setenv("CLAUDE_HOME", str(claude_home))

    runtime_path = ensure_runtime_config_file(str(data_dir))
    workspace_1 = prepare_job_workspace(str(data_dir), 1, model_provider="codex")
    runtime_path.write_text(
        f"ENGINE_WORKER_COUNT=2\nENGINE_CODEX_HOME={home_b}\n",
        encoding="utf-8",
    )
    workspace_2 = prepare_job_workspace(str(data_dir), 2, model_provider="codex")

    assert Path(workspace_1.codex_source_home) == home_a / ".codex"
    assert Path(workspace_2.codex_source_home) == home_b / ".codex"
    assert "OPEN_KRITT_CODEX_SOURCE_HOME" not in workspace_1.env
    assert (Path(workspace_1.env["CODEX_HOME"]) / "auth.json").read_text(encoding="utf-8") == '{"account":"a"}'
    assert (Path(workspace_2.env["CODEX_HOME"]) / "auth.json").read_text(encoding="utf-8") == '{"account":"b"}'


def test_cleanup_job_workspace_removes_metadata_directory(tmp_path):
    workspace = prepare_job_workspace(str(tmp_path / "data"), 123)
    root = Path(workspace.root_dir)
    (root / "file.txt").write_text("temporary", encoding="utf-8")

    cleanup_job_workspace(str(tmp_path / "data"), 123)

    assert not root.exists()


def test_queue_repeats_each_task_before_feeding_accumulated_results_downstream():
    workflow = Workflow(
        id=3,
        name="wf",
        steps=(
            step(1, 0, multi=True),
            step(2, 1, is_last=True),
        ),
    )
    sc = scan({"repeat_runs": 2})
    assert repeat_runs(sc) == 2

    pending = build_pending_jobs(scan=sc, workflow=workflow, completed=set(), step_results={})
    assert [(j.step.id, j.state.repeat_run) for j in pending] == [(1, 1)]

    completed = {(1, 0, None, 1)}
    results = {
        (1, 0, None, 1): [
            StepResultRow(id=10, step_id=1, prev_id=0, prev_table=None, repeat_run=1, json_answer={"thing": "x"})
        ]
    }
    pending = build_pending_jobs(scan=sc, workflow=workflow, completed=completed, step_results=results)
    assert [(j.step.id, j.depth, j.state.prev_id, j.state.repeat_run) for j in pending] == [(1, 0, 0, 2)]

    claimed = completed | {(1, 0, None, 2)}
    pending = build_pending_jobs(scan=sc, workflow=workflow, completed=completed, claimed=claimed, step_results=results)
    assert pending == []

    completed.add((1, 0, None, 2))
    results[(1, 0, None, 2)] = [
        StepResultRow(id=11, step_id=1, prev_id=0, prev_table=None, repeat_run=2, json_answer={"thing": "y"})
    ]
    pending = build_pending_jobs(scan=sc, workflow=workflow, completed=completed, step_results=results)
    assert [(j.step.id, j.state.prev_id, j.state.repeat_run) for j in pending] == [(2, 10, 1), (2, 11, 1)]

    completed.add((2, 10, "workflows.step_results", 1))
    pending = build_pending_jobs(scan=sc, workflow=workflow, completed=completed, step_results=results)
    assert [(j.step.id, j.state.prev_id, j.state.repeat_run) for j in pending] == [(2, 11, 1), (2, 10, 2)]


def test_queue_can_shuffle_one_steps_pending_lineages_without_changing_membership():
    workflow = Workflow(
        id=3,
        name="wf",
        steps=(
            step(1, 0, multi=True),
            step(2, 1, is_last=True),
        ),
    )
    completed = {(1, 0, None, 1)}
    results = {
        (1, 0, None, 1): [
            StepResultRow(
                id=result_id,
                step_id=1,
                prev_id=0,
                prev_table=None,
                repeat_run=1,
                json_answer={"item": result_id},
            )
            for result_id in range(10, 30)
        ]
    }
    ordered = build_pending_jobs(
        scan=scan(),
        workflow=workflow,
        completed=completed,
        step_results=results,
    )
    shuffled_scan = scan(
        {
            "shuffle_pending_step_ids": [2],
            "skip_attempted_step_ids": [2, "bad"],
            "pending_shuffle_seed": "deterministic-test-seed",
        }
    )
    shuffled = build_pending_jobs(
        scan=shuffled_scan,
        workflow=workflow,
        completed=completed,
        step_results=results,
    )

    assert configured_step_ids(shuffled_scan, "skip_attempted_step_ids") == {2}
    assert {job.state.prev_id for job in shuffled} == {job.state.prev_id for job in ordered}
    assert [job.state.prev_id for job in shuffled] != [job.state.prev_id for job in ordered]
    assert [job.state.prev_id for job in shuffled] == [
        job.state.prev_id
        for job in build_pending_jobs(
            scan=shuffled_scan,
            workflow=workflow,
            completed=completed,
            step_results=results,
        )
    ]


def test_queue_can_apply_an_explicit_pending_lineage_order_before_fallback_work():
    workflow = Workflow(
        id=3,
        name="wf",
        steps=(
            step(1, 0, multi=True),
            step(2, 1, is_last=True),
        ),
    )
    completed = {(1, 0, None, 1)}
    results = {
        (1, 0, None, 1): [
            StepResultRow(
                id=result_id,
                step_id=1,
                prev_id=0,
                prev_table=None,
                repeat_run=1,
                json_answer={"item": result_id},
            )
            for result_id in range(10, 15)
        ]
    }
    prioritized_scan = scan(
        {
            "pending_lineage_order_by_step": {"2": [13, "11", "bad", 13]},
            "shuffle_pending_step_ids": [2],
            "pending_shuffle_seed": "fallback-only",
        }
    )

    pending = build_pending_jobs(
        scan=prioritized_scan,
        workflow=workflow,
        completed=completed,
        step_results=results,
    )

    assert [job.state.prev_id for job in pending[:2]] == [13, 11]
    assert {job.state.prev_id for job in pending} == set(range(10, 15))


def test_database_load_prior_repeat_results_keeps_every_earlier_step_output():
    captured = {}

    class PriorResultsConn:
        def execute(self, query, params):
            captured["query"] = query
            captured["params"] = params
            return SimpleNamespace(
                fetchall=lambda: [
                    {"result_kind": "step_result", "result_id": 4, "repeat_run": 1, "json_answer": {"item": "a"}},
                    {"result_kind": "finding", "result_id": 8, "repeat_run": 2, "json_answer": {"item": "b"}},
                ]
            )

    results = Database("").load_prior_repeat_results(
        PriorResultsConn(),
        scan_id=7,
        step_id=3,
        prev_id=42,
        prev_table="workflows.step_results",
        repeat_run=3,
    )

    assert results == [
        {"repeat_run": 1, "result": {"item": "a"}},
        {"repeat_run": 2, "result": {"item": "b"}},
    ]
    assert "workflows.step_results" in captured["query"]
    assert "workflows.vulnerabilities" in captured["query"]
    assert captured["params"] == {
        "scan_id": 7,
        "step_id": 3,
        "prev_id": 42,
        "prev_table": "workflows.step_results",
        "repeat_run": 3,
    }
    assert "r.prev_table IS NOT DISTINCT FROM" in captured["query"]
    assert "v.prev_table IS NOT DISTINCT FROM" in captured["query"]


class FakeConn:
    def commit(self):
        pass


class FakeDb:
    def __init__(self):
        self.metadata = []
        self.step_results = []
        self.vulnerabilities = []
        self.prior_repeat_results = []
        self.prior_repeat_requests = []

    @contextmanager
    def connect(self):
        yield FakeConn()

    def load_scan(self, _conn, _scan_id):
        return {**scan(), "status": "running"}

    def load_prior_repeat_results(self, _conn, **kwargs):
        self.prior_repeat_requests.append(kwargs)
        return self.prior_repeat_results

    def insert_metadata(self, _conn, **kwargs):
        self.metadata.append(kwargs)
        return len(self.metadata)

    def claim_step_metadata(self, _conn, **kwargs):
        self.metadata.append(
            {
                **kwargs,
                "status": "running",
                "error": None,
                "run_time_ms": 0,
                "raw_token_usage": None,
                "codex_session_id": None,
            }
        )
        return len(self.metadata)

    def update_metadata(self, _conn, metadata_id, *, status, error, run_time_ms, raw_token_usage, **kwargs):
        self.metadata[metadata_id - 1].update(
            {
                "status": status,
                "error": error,
                "run_time_ms": run_time_ms,
                "raw_token_usage": raw_token_usage,
                **kwargs,
            }
        )

    def insert_step_result(self, _conn, **kwargs):
        self.step_results.append(kwargs)
        return len(self.step_results)

    def next_vulnerability_rank(self, _conn, _scan_id):
        return len(self.vulnerabilities) + 1

    def insert_vulnerability(self, _conn, **kwargs):
        self.vulnerabilities.append(kwargs)
        return len(self.vulnerabilities)


class FakeHarness:
    def __init__(self, payloads):
        self.payloads = list(payloads)
        self.calls = []

    def run(self, **kwargs):
        self.calls.append(kwargs)
        payload = self.payloads.pop(0)
        return HarnessResult(payload=payload, usage={"total_tokens": 3})


def test_worker_rechecks_runtime_worker_count_before_claiming(monkeypatch, tmp_path):
    class ClaimDb:
        def __init__(self):
            self.claims = 0

        @contextmanager
        def connect(self):
            yield FakeConn()

        def claim_scan(self, _conn):
            self.claims += 1
            return None

    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    data_dir = tmp_path / "data"
    runtime_path = ensure_runtime_config_file(str(data_dir))
    runtime_path.write_text("ENGINE_WORKER_COUNT=0\nENGINE_CODEX_HOME=/root/.codex\n", encoding="utf-8")
    fake_db = ClaimDb()
    worker = Worker(
        SimpleNamespace(worker_count=3, workspace_setup_concurrency=1, data_dir=str(data_dir), database_url=""),
        db=fake_db,
    )

    assert worker.run_once(worker_id=1) is False
    assert fake_db.claims == 0

    runtime_path.write_text("ENGINE_WORKER_COUNT=1\nENGINE_CODEX_HOME=/root/.codex\n", encoding="utf-8")
    assert worker.run_once(worker_id=1) is False
    assert fake_db.claims == 1


def test_worker_recovers_orphaned_running_metadata_on_startup():
    class RecoveryDb:
        def __init__(self):
            self.calls = []

        @contextmanager
        def connect(self):
            yield FakeConn()

        def mark_orphaned_running_metadata_interrupted(self, _conn, *, engine_started_at, error):
            self.calls.append({"engine_started_at": engine_started_at, "error": error})
            return {"step": 5, "post": 0}

    fake_db = RecoveryDb()
    worker = Worker(
        SimpleNamespace(worker_count=0, workspace_setup_concurrency=1, data_dir="/tmp", database_url=""),
        db=fake_db,
    )
    started_at = worker_module.now_utc()

    counts = worker.recover_orphaned_metadata(started_at)

    assert counts == {"step": 5, "post": 0}
    assert fake_db.calls == [
        {
            "engine_started_at": started_at,
            "error": worker_module.ORPHANED_METADATA_ERROR,
        }
    ]


def test_worker_does_not_claim_more_jobs_for_paused_scan():
    class FakePausedDb:
        def __init__(self):
            self.loaded_scan_count = 0

        @contextmanager
        def connect(self):
            yield FakeConn()

        def load_workflow(self, _conn, workflow_id):
            return Workflow(id=workflow_id, name="wf", steps=(step(1, 0),))

        def load_scan(self, _conn, _scan_id):
            self.loaded_scan_count += 1
            return {**scan(), "status": "paused"}

        def load_completed_metadata(self, *_args):
            raise AssertionError("paused scans should not rebuild the queue")

        def load_claimed_metadata(self, *_args):
            raise AssertionError("paused scans should not rebuild the queue")

        def load_step_results(self, *_args):
            raise AssertionError("paused scans should not rebuild the queue")

    fake_db = FakePausedDb()
    worker = Worker(
        SimpleNamespace(harness_timeout_seconds=5, codex_model_provider=None),
        db=fake_db,
    )

    worker.process_scan({**scan(), "status": "running"})

    assert fake_db.loaded_scan_count == 1


def test_worker_dispatches_each_job_with_its_depth_model_selection(monkeypatch):
    configured_scan = {
        **scan(),
        "status": "running",
        "model_provider": "codex",
        "thinking_effort": "high",
        "model_overrides": {
            "0": {
                "model": "claude-sonnet",
                "model_provider": "claude",
                "harness": "claude-code",
                "thinking_effort": "medium",
            }
        },
    }

    class PendingDb:
        @contextmanager
        def connect(self):
            yield FakeConn()

        def load_workflow(self, _conn, workflow_id):
            return Workflow(id=workflow_id, name="wf", steps=(step(1, 0),))

        def load_scan(self, _conn, _scan_id):
            return configured_scan

        def load_completed_metadata(self, *_args):
            return set()

        def load_claimed_metadata(self, *_args):
            return set()

        def load_step_results(self, *_args):
            return {}

    worker = Worker(SimpleNamespace(data_dir="/tmp", database_url=""), db=PendingDb())
    selected = {}
    selected_harness = object()

    monkeypatch.setattr(worker, "_worker_can_pick_job", lambda _worker_id: True)
    monkeypatch.setattr(worker, "_ensure_scan_cache_prewarmed", lambda *_args, **_kwargs: False)

    def harness_for_selection(selection):
        selected["harness_selection"] = selection
        return selected_harness

    def execute_job(**kwargs):
        selected["execution_selection"] = kwargs["model_selection"]
        selected["harness"] = kwargs["harness"]
        return True

    monkeypatch.setattr(worker, "_harness_for_model_selection", harness_for_selection)
    monkeypatch.setattr(worker, "execute_job", execute_job)

    assert worker.process_scan(configured_scan) is True
    assert selected["execution_selection"].model == "claude-sonnet"
    assert selected["execution_selection"].model_provider == "claude"
    assert selected["harness_selection"] == selected["execution_selection"]
    assert selected["harness"] is selected_harness


def test_execute_job_rechecks_scan_status_after_waiting_for_workspace_slot(monkeypatch):
    class PausedDb(FakeDb):
        def load_scan(self, _conn, _scan_id):
            return {**scan(), "status": "paused"}

    fake_db = PausedDb()
    worker = Worker(
        SimpleNamespace(retry_count=0, data_dir="/tmp", github_token=None),
        db=fake_db,
    )
    job = Job(
        step=step(1, 0, multi=False, output_format='{"thing":"string"}'),
        state=State(prev_id=0, prev_table=None, repeat_run=1, context={"repo_full": "owner/repo"}),
    )
    fake_harness = FakeHarness([marked({"stub": True, "stub_explanation": "No records.", "results": []})])

    def fail_prepare_workspace(**_kwargs):
        raise AssertionError("paused scans should not prepare or claim a workspace")

    monkeypatch.setattr(worker_module, "prepare_dependency_workspace", fail_prepare_workspace)

    did_claim = worker.execute_job(
        scan=scan(),
        workflow_id=3,
        job=job,
        harness=fake_harness,
    )

    assert did_claim is False
    assert fake_db.metadata == []
    assert fake_harness.calls == []


def test_workspace_credential_rate_limit_defers_instead_of_failing_scan(monkeypatch, tmp_path):
    fake_db = FakeDb()
    worker = Worker(
        SimpleNamespace(retry_count=0, data_dir=str(tmp_path), github_token=None),
        db=fake_db,
    )
    job = Job(
        step=step(1, 0, multi=False, output_format='{"thing":"string"}'),
        state=State(prev_id=0, prev_table=None, repeat_run=1, context={"repo_full": "owner/repo"}),
    )

    def rate_limited_workspace(**_kwargs):
        raise ClaudeCredentialRateLimited(
            account_home="/accounts/claude",
            limit_kind="account_quota_limited",
            retry_after_seconds=125,
        )

    monkeypatch.setattr(worker_module, "prepare_dependency_workspace", rate_limited_workspace)

    with pytest.raises(worker_module.RateLimitExhausted) as exc_info:
        worker.execute_job(scan=scan(), workflow_id=3, job=job, harness=FakeHarness([]))

    assert exc_info.value.provider == "claude"
    assert exc_info.value.account_home == "/accounts/claude"
    assert exc_info.value.limit_kind == "account_quota_limited"
    assert exc_info.value.retry_after_seconds == 125
    assert fake_db.metadata[0]["status"] == "interrupted"
    assert fake_db.metadata[0]["phase"] == "interrupted"


def test_worker_moves_finished_workflow_into_post_processing(monkeypatch, tmp_path):
    runtime_path = tmp_path / "engine-runtime.env"
    runtime_path.write_text("ENGINE_WORKER_COUNT=1\nENGINE_CODEX_HOME=/root/.codex\n", encoding="utf-8")
    monkeypatch.setenv("ENGINE_RUNTIME_CONFIG_PATH", str(runtime_path))

    class FakeStatusDb:
        def __init__(self):
            self.status = "running"
            self.statuses = []

        @contextmanager
        def connect(self):
            yield FakeConn()

        def load_workflow(self, _conn, workflow_id):
            return Workflow(id=workflow_id, name="wf", steps=(step(1, 0, is_last=True),))

        def load_scan(self, _conn, _scan_id):
            return {**scan(), "status": self.status}

        def load_completed_metadata(self, *_args):
            return {(1, 0, None, 1)}

        def load_claimed_metadata(self, *_args):
            return {(1, 0, None, 1)}

        def load_step_results(self, *_args):
            return {}

        def set_scan_status(self, _conn, _scan_id, status, error=None):
            self.status = status
            self.statuses.append(status)

        def set_scan_status_if_current(self, _conn, _scan_id, current_status, status):
            if self.status != current_status:
                return False
            self.status = status
            self.statuses.append(status)
            return True

    fake_db = FakeStatusDb()
    worker = Worker(
        SimpleNamespace(
            harness_timeout_seconds=5,
            codex_model_provider="private-openrouter",
            poll_seconds=0,
            retry_count=0,
            data_dir="/tmp",
        ),
        db=fake_db,
    )
    harness_calls = []

    def fake_harness_for(name, **kwargs):
        harness_calls.append((name, kwargs))
        return object()

    def finish_post_processing(_scan, _harness):
        fake_db.set_scan_status(None, 7, "completed")
        return True

    monkeypatch.setattr(worker_module, "harness_for", fake_harness_for)
    monkeypatch.setattr(worker_module, "prewarm_scan_checkout_cache", lambda **_kwargs: {})
    worker.post_processor = SimpleNamespace(process_once=finish_post_processing)
    worker.process_scan({**scan(), "status": "running", "model_provider": "openrouter"})

    assert fake_db.statuses == ["post_processing", "prewarming_cache", "post_processing", "completed"]
    assert harness_calls
    assert all(name == "codex" for name, _kwargs in harness_calls)
    assert all(kwargs["model_provider"] == "openrouter" for _name, kwargs in harness_calls)
    assert all(kwargs["codex_model_provider"] == "private-openrouter" for _name, kwargs in harness_calls)
    assert all(kwargs["codex_max_subagents"] == 5 for _name, kwargs in harness_calls)


def test_worker_retries_strict_validation_then_writes_results(monkeypatch, tmp_path):
    root = tmp_path / "job"
    root.mkdir()

    class Workspace:
        root_dir = str(root)
        env = {"HOME": "/tmp/home"}

    prepared = SimpleNamespace(
        workspace=Workspace(),
        repo_dir="/tmp/repo",
        checked_out_commit="abc",
        layout="Dependency repositories are checked out as top-level directories inside the same workspace root.",
        manifest_json='{"dependencies":[]}',
    )
    fake_db = FakeDb()
    fake_db.prior_repeat_results = [{"repeat_run": 1, "result": {"thing": "existing"}}]
    worker = Worker(
        SimpleNamespace(retry_count=2, data_dir="/tmp", github_token=None),
        db=fake_db,
    )
    workspace_requests = []
    monkeypatch.setattr(
        worker_module,
        "prepare_dependency_workspace",
        lambda **kwargs: workspace_requests.append(kwargs) or prepared,
    )
    job = Job(
        step=step(1, 0, multi=False, output_format='{"thing":"string"}'),
        state=State(prev_id=0, prev_table=None, repeat_run=2, context={"repo_full": "owner/repo"}),
    )

    fake_harness = FakeHarness(
        [
            marked({"stub": False, "stub_explanation": "", "results": [{"thing": "ok", "extra": "bad"}]}),
            marked({"stub": False, "stub_explanation": "", "results": [{"thing": "ok"}]}),
        ]
    )

    configured_scan = {
        **scan(),
        "model_provider": "codex",
        "thinking_effort": "high",
        "model_overrides": {
            "0": {
                "model": "claude-sonnet",
                "model_provider": "claude",
                "harness": "claude-code",
                "thinking_effort": "medium",
            }
        },
    }
    worker.execute_job(
        scan=configured_scan,
        workflow_id=3,
        job=job,
        harness=fake_harness,
    )

    assert [m["status"] for m in fake_db.metadata] == ["completed", "failed"]
    assert fake_db.metadata[1]["error"].startswith("attempt 1:")
    assert fake_db.metadata[0]["prompt_filled"] == fake_harness.calls[0]["prompt"]
    assert fake_db.metadata[1]["prompt_filled"] == fake_harness.calls[0]["prompt"]
    assert "`stub_explanation`" in fake_db.metadata[0]["prompt_filled"]
    assert "The exact JSON Schema" in fake_db.metadata[0]["prompt_filled"]
    assert "Workspace context:" in fake_harness.calls[0]["prompt"]
    assert "This is repeat run 2" in fake_harness.calls[0]["prompt"]
    assert '"thing": "existing"' in fake_harness.calls[0]["prompt"]
    assert fake_db.prior_repeat_requests == [
        {"scan_id": 7, "step_id": 1, "prev_id": 0, "prev_table": None, "repeat_run": 2}
    ]
    assert fake_harness.calls[0]["repo_dir"] == "/tmp/repo"
    assert fake_harness.calls[0]["model"] == "claude-sonnet"
    assert fake_harness.calls[0]["thinking_effort"] == "medium"
    assert workspace_requests[0]["harness_name"] == "claude-code"
    assert workspace_requests[0]["model_provider"] == "claude"
    assert fake_db.metadata[0]["model"] == "claude-sonnet"
    assert fake_db.metadata[0]["harness"] == "claude-code"
    assert fake_db.metadata[0]["model_provider"] == "claude"
    assert fake_db.step_results[0]["json_answer"] == {"thing": "ok"}
    assert not root.exists()


def test_worker_uses_snapshot_image_for_normal_workflow_jobs(monkeypatch, tmp_path):
    runtime_path = tmp_path / "engine-runtime.env"
    runtime_path.write_text("ENGINE_POST_PROCESS_WORKSPACE_MODE=image\n", encoding="utf-8")
    monkeypatch.setenv("ENGINE_RUNTIME_CONFIG_PATH", str(runtime_path))
    root = tmp_path / "job"
    root.mkdir()

    class Workspace:
        root_dir = str(root)
        env = {"HOME": str(tmp_path / "home")}

    prepared = SimpleNamespace(
        workspace=Workspace(),
        repo_dir=str(root / "workspace"),
        checked_out_commit="abc",
        layout="Dependency repositories are checked out as top-level directories inside the same workspace root.",
        manifest_json='{"dependencies":[]}',
        runner_image="open-kritt-workspace-snapshot:test",
    )
    fake_db = FakeDb()
    worker = Worker(
        SimpleNamespace(retry_count=0, data_dir=str(tmp_path), github_token=None),
        db=fake_db,
    )
    workspace_requests = []
    monkeypatch.setattr(
        worker_module,
        "prepare_dependency_workspace",
        lambda **kwargs: workspace_requests.append(kwargs) or prepared,
    )
    job = Job(
        step=step(1, 0, multi=False, output_format='{"thing":"string"}'),
        state=State(prev_id=0, prev_table=None, repeat_run=1, context={"repo_full": "owner/repo"}),
    )
    fake_harness = FakeHarness([marked({"stub": False, "stub_explanation": "", "results": [{"thing": "ok"}]})])

    worker.execute_job(scan=scan(), workflow_id=3, job=job, harness=fake_harness)

    assert workspace_requests[0]["use_snapshot_image"] is True
    assert fake_harness.calls[0]["runner_image"] == "open-kritt-workspace-snapshot:test"
    assert fake_harness.calls[0]["repo_dir"] == str(root / "workspace")
    assert fake_db.metadata[0]["status"] == "completed"
    assert not root.exists()


def test_worker_records_and_rotates_last_five_model_error_outputs(monkeypatch, tmp_path):
    data_dir = tmp_path / "data"
    root = tmp_path / "job"
    root.mkdir()

    class Workspace:
        root_dir = str(root)
        env = {"HOME": str(tmp_path / "home")}

    prepared = SimpleNamespace(
        workspace=Workspace(),
        repo_dir="/tmp/repo",
        checked_out_commit="abc",
        layout="Dependency repositories are checked out as top-level directories inside the same workspace root.",
        manifest_json='{"dependencies":[]}',
    )
    fake_db = FakeDb()
    worker = Worker(
        SimpleNamespace(retry_count=6, data_dir=str(data_dir), github_token=None),
        db=fake_db,
    )
    worker.runtime_retry_count = lambda: 6
    monkeypatch.setattr(worker_module, "prepare_dependency_workspace", lambda **_kwargs: prepared)
    job = Job(
        step=step(1, 0, multi=False, output_format='{"thing":"string"}'),
        state=State(prev_id=0, prev_table=None, repeat_run=1, context={"repo_full": "owner/repo"}),
    )

    class InvalidOutputHarness:
        def __init__(self):
            self.calls = 0

        def run(self, **_kwargs):
            self.calls += 1
            return HarnessResult(
                payload=marked(
                    {
                        "stub": False,
                        "stub_explanation": "",
                        "results": [{"thing": f"bad-{self.calls}", "extra": "invalid"}],
                    }
                ),
                output=HarnessOutput(
                    stdout=f"stdout {self.calls}",
                    stderr=f"stderr {self.calls}",
                    files={"output.json": f"raw output {self.calls}"},
                ),
            )

    fake_harness = InvalidOutputHarness()

    with pytest.raises(worker_module.StepExecutionError):
        worker.execute_job(
            scan=scan(),
            workflow_id=3,
            job=job,
            harness=fake_harness,
        )

    artifact_root = data_dir / "model-error-outputs"
    dirs = sorted(path for path in artifact_root.iterdir() if path.is_dir())
    metas = [json.loads((path / "metadata.json").read_text(encoding="utf-8")) for path in dirs]

    assert fake_harness.calls == 7
    assert "failed after 7 attempts" in fake_db.metadata[0]["error"]
    assert "attempt 1:" in fake_db.metadata[0]["error"]
    assert "attempt 7:" in fake_db.metadata[0]["error"]
    assert len(dirs) == 5
    assert {meta["attempt"] for meta in metas} == {3, 4, 5, 6, 7}
    for path, meta in zip(dirs, metas, strict=False):
        assert meta["kind"] == "step"
        assert meta["metadata_id"] == meta["attempt"] + 1
        assert (path / "stdout.txt").read_text(encoding="utf-8") == f"stdout {meta['attempt']}"
        assert (path / "stderr.txt").read_text(encoding="utf-8") == f"stderr {meta['attempt']}"
        assert (path / "output.json").read_text(encoding="utf-8") == f"raw output {meta['attempt']}"
        assert "model output:" in fake_db.metadata[meta["metadata_id"] - 1]["error"]
    assert not root.exists()


def test_worker_does_not_retry_permanent_harness_failures(monkeypatch, tmp_path):
    root = tmp_path / "job"
    root.mkdir()

    class Workspace:
        root_dir = str(root)
        env = {"HOME": "/tmp/home"}

    class PermanentFailureHarness:
        def __init__(self):
            self.calls = 0

        def run(self, **_kwargs):
            self.calls += 1
            raise harnesses.HarnessError(
                "provider response contained secret-value",
                code="quota_exceeded",
                harness="claude-code",
            )

    prepared = SimpleNamespace(
        workspace=Workspace(),
        repo_dir="/tmp/repo",
        checked_out_commit="abc",
        layout="Dependency repositories are checked out as top-level directories inside the same workspace root.",
        manifest_json='{"dependencies":[]}',
    )
    fake_db = FakeDb()
    worker = Worker(SimpleNamespace(retry_count=2, data_dir="/tmp", github_token=None), db=fake_db)
    monkeypatch.setattr(worker_module, "prepare_dependency_workspace", lambda **_kwargs: prepared)
    job = Job(
        step=step(1, 0),
        state=State(prev_id=0, prev_table=None, repeat_run=1, context={"repo_full": "owner/repo"}),
    )
    fake_harness = PermanentFailureHarness()

    with pytest.raises(worker_module.StepExecutionError):
        worker.execute_job(scan=scan(), workflow_id=3, job=job, harness=fake_harness)

    assert fake_harness.calls == 1
    assert "account quota is exhausted" in fake_db.metadata[0]["error"]
    assert "Diagnostic: quota_exceeded" in fake_db.metadata[0]["error"]
    assert "secret-value" not in fake_db.metadata[0]["error"]
    assert not root.exists()


def test_worker_uses_the_cyber_safety_retry_limit(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    root = tmp_path / "cyber-job"
    root.mkdir()
    (tmp_path / "engine-runtime.env").write_text("ENGINE_CYBER_SAFETY_RETRY_COUNT=3\n", encoding="utf-8")

    class Workspace:
        root_dir = str(root)
        env = {"HOME": "/tmp/home"}

    class CyberBlockedHarness:
        def __init__(self):
            self.calls = 0

        def run(self, **_kwargs):
            self.calls += 1
            raise harnesses.HarnessError(
                "provider response contained secret-value",
                code="cyber_safety_blocked",
                harness="codex",
            )

    prepared = SimpleNamespace(
        workspace=Workspace(),
        repo_dir="/tmp/repo",
        checked_out_commit="abc",
        layout="Dependency repositories are checked out as top-level directories inside the same workspace root.",
        manifest_json='{"dependencies":[]}',
    )
    fake_db = FakeDb()
    worker = Worker(SimpleNamespace(retry_count=0, data_dir=str(tmp_path), github_token=None), db=fake_db)
    monkeypatch.setattr(worker_module, "prepare_dependency_workspace", lambda **_kwargs: prepared)
    job = Job(
        step=step(1, 0),
        state=State(prev_id=0, prev_table=None, repeat_run=1, context={"repo_full": "owner/repo"}),
    )
    fake_harness = CyberBlockedHarness()

    with pytest.raises(worker_module.StepExecutionError, match="failed after 4 attempts"):
        worker.execute_job(scan=scan(), workflow_id=3, job=job, harness=fake_harness)

    assert fake_harness.calls == 4
    assert "Diagnostic: cyber_safety_blocked" in fake_db.metadata[0]["error"]
    assert "secret-value" not in fake_db.metadata[0]["error"]
    assert not root.exists()


def test_worker_rotates_after_interrupting_a_rate_limited_step(monkeypatch, tmp_path):
    root = tmp_path / "job"
    root.mkdir()

    class Workspace:
        root_dir = str(root)
        env = {"HOME": "/tmp/home"}
        provider_account_provider = "codex"
        provider_account_home = "/accounts/limited/.codex"

    prepared = SimpleNamespace(
        workspace=Workspace(),
        repo_dir="/tmp/repo",
        checked_out_commit="abc",
        layout="Dependency repositories are checked out as top-level directories inside the same workspace root.",
        manifest_json='{"dependencies":[]}',
    )
    fake_db = FakeDb()
    worker = Worker(SimpleNamespace(retry_count=2, data_dir="/tmp", github_token=None), db=fake_db)
    worker.runtime_retry_count = lambda: 2
    monkeypatch.setattr(worker_module, "prepare_dependency_workspace", lambda **_kwargs: prepared)
    sleeps = []
    monkeypatch.setattr(worker_module.time, "sleep", sleeps.append)
    job = Job(
        step=step(1, 0),
        state=State(prev_id=0, prev_table=None, repeat_run=1, context={"repo_full": "owner/repo"}),
    )

    class RateLimitedHarness:
        def __init__(self):
            self.calls = 0

        def run(self, **_kwargs):
            self.calls += 1
            raise HarnessError(
                "provider rate limit",
                code="rate_limited",
                harness="codex",
                retry_after_seconds=7.0,
            )

    fake_harness = RateLimitedHarness()

    with pytest.raises(worker_module.RateLimitExhausted) as exc_info:
        worker.execute_job(scan=scan(), workflow_id=3, job=job, harness=fake_harness)

    assert fake_harness.calls == 1
    assert sleeps == []
    assert exc_info.value.retry_after_seconds == 7.0
    assert exc_info.value.provider == "codex"
    assert exc_info.value.account_home == "/accounts/limited/.codex"
    assert fake_db.metadata[0]["status"] == "interrupted"
    assert fake_db.metadata[0]["phase"] == "interrupted"
    assert not root.exists()


def test_post_processing_harness_uses_dependency_workspace(monkeypatch, tmp_path):
    root = tmp_path / "post-job"
    root.mkdir()

    class Workspace:
        root_dir = str(root)
        env = {"HOME": "/tmp/home"}

    prepared = SimpleNamespace(
        workspace=Workspace(),
        repo_dir="/tmp/post-repo",
        checked_out_commit="def",
        layout="Dependency repositories are checked out as top-level directories inside the same workspace root.",
        manifest_json='{"dependencies":[{"alias":"agave"}]}',
    )

    class FakePostDb:
        def __init__(self):
            self.updates = []

        @contextmanager
        def connect(self):
            yield FakeConn()

        def update_post_process_metadata(self, _conn, metadata_id, **kwargs):
            self.updates.append({"metadata_id": metadata_id, **kwargs})

    workspace_arguments = {}

    def prepare_workspace(**kwargs):
        workspace_arguments.update(kwargs)
        return prepared

    monkeypatch.setattr(post_processing_module, "prepare_dependency_workspace", prepare_workspace)
    fake_db = FakePostDb()
    processor = PostProcessor(SimpleNamespace(retry_count=0, data_dir="/tmp", github_token=None), fake_db)
    fake_harness = FakeHarness([{"ok": True}])
    post_scan = {
        **scan(
            {
                "post_processing_model": "gpt-5-codex",
                "post_processing_model_provider": "codex",
                "post_processing_harness": "codex",
                "post_processing_thinking_effort": "xhigh",
            }
        ),
        "model": "claude-sonnet",
        "model_provider": "claude",
        "harness": "claude-code",
        "thinking_effort": "high",
    }

    payload, usage, _session, checked_out_commit = processor._run_harness_with_retries(
        metadata_id=9,
        scan=post_scan,
        harness=fake_harness,
        prompt="Rank findings.",
        schema={},
        validator=lambda _payload: None,
    )

    assert payload == {"ok": True}
    assert usage == {"total_tokens": 3}
    assert checked_out_commit == "def"
    assert fake_harness.calls[0]["repo_dir"] == "/tmp/post-repo"
    assert fake_harness.calls[0]["model"] == "gpt-5-codex"
    assert fake_harness.calls[0]["thinking_effort"] == "xhigh"
    assert workspace_arguments["harness_name"] == "codex"
    assert workspace_arguments["model_provider"] == "codex"
    assert "Workspace context:" in fake_harness.calls[0]["prompt"]
    assert fake_db.updates[0]["prompt_filled"] == fake_harness.calls[0]["prompt"]
    assert not root.exists()


def test_post_processing_does_not_retry_permanent_harness_failures(monkeypatch, tmp_path):
    root = tmp_path / "post-job"
    root.mkdir()

    class Workspace:
        root_dir = str(root)
        env = {"HOME": "/tmp/home"}

    class FakePostDb:
        def __init__(self):
            self.updates = []

        @contextmanager
        def connect(self):
            yield FakeConn()

        def update_post_process_metadata(self, _conn, metadata_id, **kwargs):
            self.updates.append({"metadata_id": metadata_id, **kwargs})

    class PermanentFailureHarness:
        def __init__(self):
            self.calls = 0

        def run(self, **_kwargs):
            self.calls += 1
            raise harnesses.HarnessError(
                "provider response contained secret-value",
                code="quota_exceeded",
                harness="claude-code",
            )

    prepared = SimpleNamespace(
        workspace=Workspace(),
        repo_dir="/tmp/post-repo",
        checked_out_commit="def",
        layout="Dependency repositories are checked out as top-level directories inside the same workspace root.",
        manifest_json='{"dependencies":[]}',
    )
    monkeypatch.setattr(post_processing_module, "prepare_dependency_workspace", lambda **_kwargs: prepared)
    fake_db = FakePostDb()
    processor = PostProcessor(SimpleNamespace(retry_count=2, data_dir="/tmp", github_token=None), fake_db)
    fake_harness = PermanentFailureHarness()

    with pytest.raises(post_processing_module.PostProcessExecutionError, match="quota_exceeded"):
        processor._run_harness_with_retries(
            metadata_id=9,
            scan=scan(),
            harness=fake_harness,
            prompt="Rank findings.",
            schema={},
            validator=lambda _payload: None,
        )

    assert fake_harness.calls == 1
    assert "account quota is exhausted" in fake_db.updates[-1]["error"]
    assert "secret-value" not in fake_db.updates[-1]["error"]
    assert not root.exists()


def test_post_processing_uses_the_cyber_safety_retry_limit(monkeypatch, tmp_path):
    monkeypatch.delenv("ENGINE_RUNTIME_CONFIG_PATH", raising=False)
    root = tmp_path / "cyber-post-job"
    root.mkdir()
    (tmp_path / "engine-runtime.env").write_text("ENGINE_CYBER_SAFETY_RETRY_COUNT=3\n", encoding="utf-8")

    class Workspace:
        root_dir = str(root)
        env = {"HOME": "/tmp/home"}

    class FakePostDb:
        def __init__(self):
            self.updates = []

        @contextmanager
        def connect(self):
            yield FakeConn()

        def update_post_process_metadata(self, _conn, metadata_id, **kwargs):
            self.updates.append({"metadata_id": metadata_id, **kwargs})

    class CyberBlockedHarness:
        def __init__(self):
            self.calls = 0

        def run(self, **_kwargs):
            self.calls += 1
            raise harnesses.HarnessError(
                "provider response contained secret-value",
                code="cyber_safety_blocked",
                harness="codex",
            )

    prepared = SimpleNamespace(
        workspace=Workspace(),
        repo_dir="/tmp/post-repo",
        checked_out_commit="def",
        layout="Dependency repositories are checked out as top-level directories inside the same workspace root.",
        manifest_json='{"dependencies":[]}',
    )
    monkeypatch.setattr(post_processing_module, "prepare_dependency_workspace", lambda **_kwargs: prepared)
    fake_db = FakePostDb()
    processor = PostProcessor(SimpleNamespace(retry_count=0, data_dir=str(tmp_path), github_token=None), fake_db)
    fake_harness = CyberBlockedHarness()

    with pytest.raises(post_processing_module.PostProcessExecutionError, match="cyber_safety_blocked"):
        processor._run_harness_with_retries(
            metadata_id=9,
            scan=scan(),
            harness=fake_harness,
            prompt="Rank findings.",
            schema={},
            validator=lambda _payload: None,
        )

    assert fake_harness.calls == 4
    assert "Diagnostic: cyber_safety_blocked" in fake_db.updates[-1]["error"]
    assert "secret-value" not in fake_db.updates[-1]["error"]
    assert not root.exists()


def test_post_processing_preserves_rate_limit_for_scan_retry(monkeypatch, tmp_path):
    root = tmp_path / "post-job"
    root.mkdir()

    class Workspace:
        root_dir = str(root)
        env = {"HOME": "/tmp/home"}
        provider_account_provider = "claude"
        provider_account_home = "/accounts/limited/.claude"

    class FakePostDb:
        def __init__(self):
            self.updates = []

        @contextmanager
        def connect(self):
            yield FakeConn()

        def update_post_process_metadata(self, _conn, metadata_id, **kwargs):
            self.updates.append({"metadata_id": metadata_id, **kwargs})

    class RateLimitedHarness:
        def __init__(self):
            self.calls = 0

        def run(self, **_kwargs):
            self.calls += 1
            raise HarnessError(
                "provider rate limit",
                code="rate_limited",
                harness="claude-code",
                retry_after_seconds=25.0,
            )

    prepared = SimpleNamespace(
        workspace=Workspace(),
        repo_dir="/tmp/post-repo",
        checked_out_commit="def",
        layout="Dependency repositories are checked out as top-level directories inside the same workspace root.",
        manifest_json='{"dependencies":[]}',
    )
    monkeypatch.setattr(post_processing_module, "prepare_dependency_workspace", lambda **_kwargs: prepared)
    fake_db = FakePostDb()
    processor = PostProcessor(SimpleNamespace(retry_count=2, data_dir="/tmp", github_token=None), fake_db)
    harness = RateLimitedHarness()

    with pytest.raises(PostProcessRateLimited) as exc_info:
        processor._run_harness_with_retries(
            metadata_id=9,
            scan=scan(),
            harness=harness,
            prompt="Rank findings.",
            schema={},
            validator=lambda _payload: None,
        )

    assert exc_info.value.retry_after_seconds == 25.0
    assert exc_info.value.provider == "claude"
    assert exc_info.value.account_home == "/accounts/limited/.claude"
    assert harness.calls == 1
    assert "Diagnostic: rate_limited" in str(exc_info.value)
    assert not root.exists()


def test_post_processing_marks_rate_limited_batch_interrupted(monkeypatch):
    current = {**scan(), "status": "post_processing", "thinking_effort": "medium"}

    class FakePostDb:
        def __init__(self):
            self.updates = []

        @contextmanager
        def connect(self):
            yield FakeConn()

        def count_running_post_process(self, _conn, _scan_id, _kind):
            return 0

        def load_scan(self, _conn, _scan_id):
            return current

        def load_vulnerabilities(self, _conn, _scan_id):
            return [{"id": 11}]

        def next_post_process_batch_index(self, _conn, _scan_id, _kind):
            return 0

        def claim_post_process_metadata(self, _conn, **_kwargs):
            return 9

        def update_post_process_metadata(self, _conn, metadata_id, **kwargs):
            self.updates.append({"metadata_id": metadata_id, **kwargs})

    fake_db = FakePostDb()
    processor = PostProcessor(SimpleNamespace(data_dir="/tmp", github_token=None), fake_db)
    monkeypatch.setattr(post_processing_module, "dedupe_batch", lambda _rows: ([], [{"id": 11}]))
    monkeypatch.setattr(post_processing_module, "build_dedupe_prompt", lambda *_args: "dedupe")
    processor._run_harness_with_retries = lambda **_kwargs: (_ for _ in ()).throw(
        PostProcessRateLimited("provider rate limit", retry_after_seconds=25.0)
    )

    with pytest.raises(PostProcessRateLimited):
        processor._run_next_dedupe_batch(current, object())

    assert fake_db.updates[-1]["status"] == "interrupted"
    assert fake_db.updates[-1]["phase"] == "interrupted"

import json
from datetime import datetime, timezone
from typing import Any

from jsonschema import Draft202012Validator

from .claude_auth import ClaudeCredentialRateLimited
from .db import now_utc
from .harnesses import (
    CAPACITY_RATE_LIMIT_FAILURES,
    RETRYABLE_RATE_LIMIT_FAILURES,
    HarnessError,
    normalize_harness_name,
)
from .model_output_artifacts import record_model_error_output
from .models import post_processing_model_selection
from .prompting import (
    append_schema_prompt,
    harness_prompt,
    native_agent_skills_prompt,
    patched_since_prompt,
    patched_since_workspace_history_context,
    render_prompt,
    scan_context,
    scan_revision,
)
from .runtime_config import runtime_int
from .schema import EXTRACTOR_HELPER_FIELD, OutputValidationError, output_schema, validate_payload
from .workspace import (
    cleanup_job_workspace,
    cleanup_workspace,
    image_workspace_enabled,
    mark_provider_account_available,
    mark_provider_account_rate_limited,
    prepare_dependency_workspace,
    provider_account_lease,
    workspace_context,
    workspace_prompt_context,
)

BATCH_SIZE = 50
POST_WORKSPACE_ID_OFFSET = 1_000_000_000
IMPACT_LEVELS = {"critical", "high", "medium", "low", "informational"}


class PostProcessExecutionError(RuntimeError):
    pass


class PostProcessRateLimited(PostProcessExecutionError):
    def __init__(
        self,
        message: str,
        *,
        retry_after_seconds: float,
        provider: str | None = None,
        account_home: str | None = None,
        limit_kind: str = "rate_limited",
    ):
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds
        self.provider = provider
        self.account_home = account_home
        self.limit_kind = limit_kind


def dedupe_schema() -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            EXTRACTOR_HELPER_FIELD: {"type": "boolean", "const": True},
            "clusters": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "ids": {"type": "array", "items": {"type": "integer"}, "minItems": 1},
                        "reason": {"type": "string"},
                    },
                    "required": ["ids", "reason"],
                    "additionalProperties": False,
                },
            },
        },
        "required": [EXTRACTOR_HELPER_FIELD, "clusters"],
        "additionalProperties": False,
    }


def ranker_schema() -> dict[str, Any]:
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object",
        "properties": {
            EXTRACTOR_HELPER_FIELD: {"type": "boolean", "const": True},
            "rankings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "integer"},
                        "rank": {"type": "number"},
                        "impact_level": {"type": "string", "enum": sorted(IMPACT_LEVELS)},
                        "minimum_reward": {"type": "integer"},
                        "maximum_reward": {"type": "integer"},
                        "reasoning": {"type": "string"},
                        "root_bug": {"type": "string"},
                    },
                    "required": [
                        "id",
                        "rank",
                        "impact_level",
                        "minimum_reward",
                        "maximum_reward",
                        "reasoning",
                        "root_bug",
                    ],
                    "additionalProperties": False,
                },
            },
            "summary": {"type": "string"},
            "missing_from_prompt": {"type": "string"},
        },
        "required": [EXTRACTOR_HELPER_FIELD, "rankings", "summary", "missing_from_prompt"],
        "additionalProperties": False,
    }


def _int(value: Any) -> int:
    return int(value)


def _json_text(value: Any, max_chars: int = 4000) -> str:
    if value is None:
        return ""
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
    text = text.strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 3] + "..."


def _vuln_item(row: dict[str, Any], *, include_rank: bool = False) -> dict[str, Any]:
    answer = row.get("json_answer") if isinstance(row.get("json_answer"), dict) else {}
    item: dict[str, Any] = {
        "id": _int(row["id"]),
        "summary": answer.get("summary"),
        "vulnerability_type": answer.get("vulnerability_type"),
        "file_path": answer.get("file_path"),
        "line": answer.get("line"),
        "exploitable": answer.get("exploitable"),
        "malicious_actor": answer.get("malicious_actor"),
        "trigger_flow": answer.get("trigger_flow"),
        "explanation": _json_text(answer.get("explanation")),
        "dedupe_is_canonical": row.get("dedupe_is_canonical"),
        "dedupe_canonical_id": _int(row["dedupe_canonical_id"]) if row.get("dedupe_canonical_id") is not None else None,
        "dedupe_cluster_id": row.get("dedupe_cluster_id"),
    }
    if include_rank:
        item.update(
            {
                "bounty_rank": row.get("bounty_rank"),
                "impact_level": row.get("bounty_rank_impact_level"),
                "minimum_reward": _int(row["bounty_rank_minimum_reward"])
                if row.get("bounty_rank_minimum_reward") is not None
                else None,
                "maximum_reward": _int(row["bounty_rank_maximum_reward"])
                if row.get("bounty_rank_maximum_reward") is not None
                else None,
                "rank_reasoning": row.get("bounty_rank_reasoning"),
                "root_bug": row.get("rank_root_bug"),
            }
        )
    return {k: v for k, v in item.items() if v not in (None, "", [])}


def dedupe_batch(
    vulnerabilities: list[dict[str, Any]], batch_size: int = BATCH_SIZE
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    anchors = [row for row in vulnerabilities if row.get("dedupe_is_canonical") is True]
    targets = [row for row in vulnerabilities if row.get("dedupe_is_canonical") is None]
    return anchors, targets[:batch_size]


def ranker_batch(
    vulnerabilities: list[dict[str, Any]], batch_size: int = BATCH_SIZE
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    canonicals = [row for row in vulnerabilities if row.get("dedupe_is_canonical") is True]
    anchors = [row for row in canonicals if row.get("bounty_rank") is not None]
    anchors.sort(key=lambda row: (_int(row.get("bounty_rank") or 0), _int(row["id"])))
    targets = [row for row in canonicals if row.get("bounty_rank") is None]
    targets.sort(key=lambda row: (_int(row.get("rank") or 0), _int(row["id"])))
    return anchors, targets[:batch_size]


def build_dedupe_prompt(scan: dict[str, Any], anchors: list[dict[str, Any]], targets: list[dict[str, Any]]) -> str:
    anchor_items = [_vuln_item(row) for row in anchors]
    target_items = [_vuln_item(row) for row in targets]
    return (
        "You are a senior security engineer doing semantic deduplication for one scan.\n"
        f"Repository: {scan['repo_full']}\n"
        f"Revision: {scan_revision(scan)}\n\n"
        "Task:\n"
        "- Cluster target findings that describe the same underlying vulnerability instance.\n"
        "- Existing canonical anchors are already chosen; do not demote or replace them.\n"
        "- A target can join an anchor cluster, join other target duplicates, or remain a singleton.\n"
        "- Every target id must appear exactly once in the output clusters, including singleton targets.\n"
        "- Include an anchor id in a cluster only when one or more target findings duplicate that anchor.\n"
        "- Do not cluster findings only because they share a vulnerability class.\n"
        "- Prefer clustering only when one fix would address the same root cause and location/entrypoint.\n\n"
        "Return only minified JSON matching the provided schema.\n\n"
        f"Canonical anchors JSON:\n{json.dumps(anchor_items, ensure_ascii=False, separators=(',', ':'))}\n\n"
        f"Target findings JSON:\n{json.dumps(target_items, ensure_ascii=False, separators=(',', ':'))}"
    )


def build_ranker_prompt(scan: dict[str, Any], anchors: list[dict[str, Any]], targets: list[dict[str, Any]]) -> str:
    mode = "append_unranked_to_ranked_anchors" if anchors else "full_rerank"
    return (
        "You are a bug bounty triager ranking canonical security findings for one scan.\n"
        f"Repository: {scan['repo_full']}\n"
        f"Revision: {scan_revision(scan)}\n"
        f"Mode: {mode}\n\n"
        "Task:\n"
        "- Rank target findings by expected bounty priority, combining impact, exploit likelihood, scope fit, and payout likelihood.\n"
        "- Use the existing ranked anchors as placement context. Preserve their relative order.\n"
        "- Return every target id exactly once. Do not return anchor ids.\n"
        "- In append mode, `rank` is an insertion position on the existing anchor scale: use decimals to place targets between anchors.\n"
        "- In full rerank mode, use unique consecutive ranks 1..N for the target findings.\n"
        "- If a finding is likely duplicate, non-payable, out of scope, or weakly evidenced, reflect that in impact and reward.\n\n"
        "Return only minified JSON matching the provided schema.\n\n"
        f"Scan context JSON:\n{json.dumps(scan_context(scan), ensure_ascii=False, separators=(',', ':'))}\n\n"
        f"Ranked anchors JSON:\n{json.dumps([_vuln_item(row, include_rank=True) for row in anchors], ensure_ascii=False, separators=(',', ':'))}\n\n"
        f"Target findings JSON:\n{json.dumps([_vuln_item(row, include_rank=True) for row in targets], ensure_ascii=False, separators=(',', ':'))}"
    )


def validate_dedupe_payload(
    payload: dict[str, Any], *, anchors: list[dict[str, Any]], targets: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    errors = sorted(Draft202012Validator(dedupe_schema()).iter_errors(payload), key=lambda e: list(e.path))
    if errors:
        first = errors[0]
        path = ".".join(str(p) for p in first.path) or "<root>"
        raise OutputValidationError(f"{path}: {first.message}")
    anchor_ids = {_int(row["id"]) for row in anchors}
    target_ids = {_int(row["id"]) for row in targets}
    allowed = anchor_ids | target_ids
    seen_targets: set[int] = set()
    seen_any: set[int] = set()
    cleaned: list[dict[str, Any]] = []
    for cluster in payload.get("clusters") or []:
        ids = []
        for raw_id in cluster.get("ids") or []:
            row_id = _int(raw_id)
            if row_id not in allowed:
                raise OutputValidationError(f"dedupe cluster contains unexpected id {row_id}")
            if row_id in seen_any:
                raise OutputValidationError(f"dedupe id {row_id} appears more than once")
            seen_any.add(row_id)
            ids.append(row_id)
        cluster_target_ids = [row_id for row_id in ids if row_id in target_ids]
        cluster_anchor_ids = [row_id for row_id in ids if row_id in anchor_ids]
        if not cluster_target_ids:
            raise OutputValidationError("dedupe cluster must contain at least one target id")
        if len(cluster_anchor_ids) > 1:
            raise OutputValidationError("dedupe cluster must not merge canonical anchors")
        seen_targets.update(cluster_target_ids)
        cleaned.append({"ids": ids, "reason": str(cluster.get("reason") or "")})
    if seen_targets != target_ids:
        missing = sorted(target_ids - seen_targets)
        extra = sorted(seen_targets - target_ids)
        raise OutputValidationError(f"dedupe target coverage mismatch missing={missing} extra={extra}")
    return cleaned


def dedupe_mapping_from_clusters(
    clusters: list[dict[str, Any]],
    *,
    scan_id: int,
    anchors: list[dict[str, Any]],
    targets: list[dict[str, Any]],
) -> dict[int, tuple[int, bool, str, str]]:
    anchor_ids = {_int(row["id"]) for row in anchors}
    target_ids = {_int(row["id"]) for row in targets}
    mapping: dict[int, tuple[int, bool, str, str]] = {}
    for cluster in clusters:
        ids = [_int(row_id) for row_id in cluster["ids"]]
        cluster_anchors = sorted(row_id for row_id in ids if row_id in anchor_ids)
        cluster_targets = sorted(row_id for row_id in ids if row_id in target_ids)
        canonical_id = cluster_anchors[0] if cluster_anchors else cluster_targets[0]
        cluster_id = f"{scan_id}:{canonical_id}"
        reason = str(cluster.get("reason") or "singleton")
        for row_id in cluster_targets:
            mapping[row_id] = (canonical_id, row_id == canonical_id, cluster_id, reason)
    return mapping


def validate_ranker_payload(payload: dict[str, Any], *, targets: list[dict[str, Any]]) -> list[dict[str, Any]]:
    errors = sorted(Draft202012Validator(ranker_schema()).iter_errors(payload), key=lambda e: list(e.path))
    if errors:
        first = errors[0]
        path = ".".join(str(p) for p in first.path) or "<root>"
        raise OutputValidationError(f"{path}: {first.message}")
    target_ids = {_int(row["id"]) for row in targets}
    seen: set[int] = set()
    out: list[dict[str, Any]] = []
    for item in payload.get("rankings") or []:
        row_id = _int(item["id"])
        if row_id not in target_ids:
            raise OutputValidationError(f"ranker returned unexpected id {row_id}")
        if row_id in seen:
            raise OutputValidationError(f"ranker id {row_id} appears more than once")
        if _int(item["minimum_reward"]) > _int(item["maximum_reward"]):
            raise OutputValidationError(f"ranker id {row_id} has minimum_reward > maximum_reward")
        seen.add(row_id)
        out.append(dict(item))
    if seen != target_ids:
        raise OutputValidationError(f"ranker target coverage mismatch missing={sorted(target_ids - seen)}")
    return out


def rank_updates_from_payload(
    payload: dict[str, Any],
    *,
    anchors: list[dict[str, Any]],
    targets: list[dict[str, Any]],
    rank_run_id: int,
    model: str,
    prompt_filled: str,
) -> list[dict[str, Any]]:
    items_by_id = {_int(item["id"]): item for item in validate_ranker_payload(payload, targets=targets)}
    combined: list[dict[str, Any]] = []
    for anchor in anchors:
        combined.append(
            {
                "id": _int(anchor["id"]),
                "rank_position": float(anchor.get("bounty_rank") or anchor.get("rank") or 0),
                "anchor": True,
            }
        )
    for row in targets:
        item = items_by_id[_int(row["id"])]
        combined.append(
            {
                "id": _int(row["id"]),
                "rank_position": float(item["rank"]),
                "item": item,
                "anchor": False,
            }
        )
    combined.sort(key=lambda item: (float(item["rank_position"]), 1 if item.get("anchor") else 0, _int(item["id"])))
    now = datetime.now(timezone.utc)
    total = len(combined)
    updates: list[dict[str, Any]] = []
    summary = str(payload.get("summary") or "")
    missing = str(payload.get("missing_from_prompt") or "")
    for index, entry in enumerate(combined, start=1):
        if entry.get("anchor"):
            updates.append(
                {
                    "id": entry["id"],
                    "bounty_rank": index,
                    "bounty_rank_total_issues": total,
                    "bounty_rank_run_id": rank_run_id,
                    "bounty_rank_model": model,
                    "bounty_rank_ts": now,
                }
            )
            continue
        item = entry["item"]
        response = {
            "rank": index,
            "impact_level": str(item["impact_level"]),
            "minimum_reward": _int(item["minimum_reward"]),
            "maximum_reward": _int(item["maximum_reward"]),
            "reasoning": str(item["reasoning"]),
            "root_bug": str(item["root_bug"]),
            "summary": summary,
        }
        updates.append(
            {
                "id": _int(item["id"]),
                "bounty_rank_response": response,
                "bounty_rank": index,
                "bounty_rank_impact_level": str(item["impact_level"]),
                "bounty_rank_minimum_reward": _int(item["minimum_reward"]),
                "bounty_rank_maximum_reward": _int(item["maximum_reward"]),
                "bounty_rank_reasoning": str(item["reasoning"]),
                "rank_root_bug": str(item["root_bug"]),
                "bounty_rank_missing_from_prompt": missing,
                "bounty_rank_total_issues": total,
                "bounty_rank_run_id": rank_run_id,
                "bounty_rank_model": model,
                "bounty_rank_ts": now,
                "bounty_rank_prompt_filled": prompt_filled,
            }
        )
    return updates


def post_script_context(scan: dict[str, Any], vulnerability: dict[str, Any]) -> dict[str, Any]:
    answer = vulnerability.get("json_answer") if isinstance(vulnerability.get("json_answer"), dict) else {}
    return {
        **scan_context(scan),
        **answer,
    }


def configured_post_script_ids(scan: dict[str, Any]) -> list[int]:
    ids: list[int] = []

    def add(value: Any):
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            return
        if parsed > 0 and parsed not in ids:
            ids.append(parsed)

    add(scan.get("post_script_id"))
    config = scan.get("configuration") if isinstance(scan.get("configuration"), dict) else {}
    configured = config.get("post_script_ids") or config.get("post_scripts") or []
    if isinstance(configured, str):
        try:
            configured = json.loads(configured)
        except json.JSONDecodeError:
            configured = [part.strip() for part in configured.split(",")]
    if isinstance(configured, list):
        for item in configured:
            add(item.get("id") if isinstance(item, dict) else item)
    return ids


class PostProcessor:
    def __init__(self, config, db, *, workspace_setup_slots=None):
        self.config = config
        self.db = db
        self.workspace_setup_slots = workspace_setup_slots

    def process_once(self, scan: dict[str, Any], harness) -> bool:
        scan_id = _int(scan["id"])
        with self.db.connect() as conn:
            current = self.db.load_scan(conn, scan_id)
            if not current or current["status"] in {"paused", "stopped", "failed", "completed"}:
                return False
            vulnerabilities = self.db.load_vulnerabilities(conn, scan_id)
            if not vulnerabilities:
                self.db.set_scan_status_if_current(conn, scan_id, "post_processing", "completed")
                conn.commit()
                return True
            conn.commit()

        if any(row.get("dedupe_is_canonical") is None for row in vulnerabilities):
            return self._run_next_dedupe_batch(scan, harness)

        ranking_pending = any(
            row.get("dedupe_is_canonical") is True and row.get("bounty_rank") is None for row in vulnerabilities
        )
        if ranking_pending and self._run_next_ranker_batch(scan, harness):
            return True

        # A different worker owns the serialized ranker. This worker can still
        # enrich findings because post scripts do not participate in rank ordering.
        return self._run_next_post_script_or_complete(
            scan,
            harness,
            allow_complete=not ranking_pending,
        )

    def _agent_skills(self, scan: dict[str, Any]) -> list[dict[str, Any]]:
        if not hasattr(self.db, "load_agent_skills"):
            return []
        with self.db.connect() as conn:
            return self.db.load_agent_skills(conn, scan)

    def _retry_count(self) -> int:
        return runtime_int(
            "ENGINE_RETRY_COUNT",
            2,
            data_dir=getattr(self.config, "data_dir", None),
            minimum=0,
            maximum=10,
        )

    def _prepare_workspace(
        self, metadata_id: int, scan: dict[str, Any], agent_skills: list[dict[str, Any]] | None = None
    ):
        def prepare():
            selection = post_processing_model_selection(scan)
            return prepare_dependency_workspace(
                data_dir=self.config.data_dir,
                checkout_cache_dir=getattr(self.config, "checkout_cache_dir", None),
                metadata_id=POST_WORKSPACE_ID_OFFSET + metadata_id,
                scan=scan,
                github_token=self.config.github_token,
                agent_skills=agent_skills or [],
                harness_name=normalize_harness_name(selection.harness),
                model_provider=selection.model_provider,
                use_snapshot_image=image_workspace_enabled(data_dir=getattr(self.config, "data_dir", None)),
            )

        if self.workspace_setup_slots is None:
            return prepare()
        with self.workspace_setup_slots:
            return prepare()

    def _run_harness_with_retries(
        self,
        *,
        metadata_id: int,
        scan: dict[str, Any],
        harness,
        prompt: str,
        schema: dict[str, Any],
        validator,
        prompt_template: str | None = None,
        prompt_context: dict[str, Any] | None = None,
        multi_output: bool = False,
        kind: str = "post_process",
    ) -> tuple[dict[str, Any], dict[str, Any] | None, str | None, str]:
        prepared = None
        try:
            selection = post_processing_model_selection(scan)
            agent_skills = self._agent_skills(scan)
            prepared = self._prepare_workspace(metadata_id, scan, agent_skills=agent_skills)
            checked_out_commit = prepared.checked_out_commit
            if prompt_template is not None:
                context = {**(prompt_context or {}), **workspace_context(prepared)}
                if "{{patched_since_history}}" in prompt_template:
                    context["patched_since_history"] = patched_since_workspace_history_context(
                        getattr(prepared, "source_repo_dir", None) or prepared.repo_dir,
                        prepared.manifest,
                        scan,
                        context.get("file_path"),
                        github_token=getattr(self.config, "github_token", None),
                    )
                rendered = render_prompt(prompt_template, context)
                prompt_body = harness_prompt(rendered, multi_output=multi_output, schema=schema)
            else:
                prompt_body = append_schema_prompt(prompt, schema)
            prompt_parts = [
                native_agent_skills_prompt(agent_skills, normalize_harness_name(selection.harness)),
                workspace_prompt_context(prepared.layout, prepared.manifest_json),
                prompt_body,
            ]
            final_prompt = "\n\n".join(part for part in prompt_parts if part)
            thinking_effort = selection.thinking_effort
            with self.db.connect() as conn:
                self.db.update_post_process_metadata(
                    conn,
                    metadata_id,
                    status="running",
                    error=None,
                    run_time_ms=0,
                    raw_token_usage=None,
                    checked_out_commit=checked_out_commit,
                    prompt_filled=final_prompt,
                    phase="running_harness",
                    codex_source_home=getattr(prepared.workspace, "codex_source_home", None),
                    codex_account_id=getattr(prepared.workspace, "provider_account_id", None),
                    codex_account_email=getattr(prepared.workspace, "provider_account_email", None),
                )
                conn.commit()

            last_error = None
            last_exception: Exception | None = None
            attempt_errors: list[str] = []
            for attempt in range(1, self._retry_count() + 2):
                started = now_utc()
                usage = None
                codex_session_id = None
                result = None
                try:
                    with provider_account_lease(
                        getattr(prepared.workspace, "provider_account_provider", None),
                        getattr(prepared.workspace, "provider_account_home", None),
                        data_dir=getattr(self.config, "data_dir", None),
                    ):
                        harness_arguments = {
                            "prompt": final_prompt,
                            "schema": schema,
                            "repo_dir": prepared.repo_dir,
                            "model": selection.model,
                            "thinking_effort": thinking_effort,
                            "env": prepared.workspace.env,
                        }
                        runner_image = getattr(prepared, "runner_image", None)
                        if runner_image:
                            harness_arguments["runner_image"] = runner_image
                        result = harness.run(
                            **harness_arguments,
                        )
                    mark_provider_account_available(
                        getattr(prepared.workspace, "provider_account_provider", None),
                        getattr(prepared.workspace, "provider_account_home", None),
                    )
                    usage = result.usage
                    codex_session_id = result.codex_session_id
                    validator(result.payload)
                    run_time_ms = int((now_utc() - started).total_seconds() * 1000)
                    with self.db.connect() as conn:
                        self.db.update_post_process_metadata(
                            conn,
                            metadata_id,
                            status="running",
                            error=None,
                            run_time_ms=run_time_ms,
                            raw_token_usage=usage,
                            codex_session_id=codex_session_id,
                            phase="writing_db",
                        )
                        conn.commit()
                    return result.payload, usage, codex_session_id, checked_out_commit
                except (HarnessError, OutputValidationError, ValueError) as exc:
                    last_exception = exc
                    detail = (
                        f"{exc.public_message} Diagnostic: {exc.code}." if isinstance(exc, HarnessError) else str(exc)
                    )
                    attempt_error = f"attempt {attempt}: {detail}"
                    output = getattr(exc, "output", None) or getattr(result, "output", None)
                    if output is not None:
                        artifact_dir = record_model_error_output(
                            self.config.data_dir,
                            scan_id=_int(scan["id"]),
                            workflow_id=_int(scan["workflow_id"]) if scan.get("workflow_id") is not None else None,
                            metadata_id=metadata_id,
                            attempt=attempt,
                            error=exc,
                            output=output,
                            kind=kind,
                        )
                        if artifact_dir:
                            attempt_error = f"{attempt_error}; model output: {artifact_dir}"
                    attempt_errors.append(attempt_error)
                    last_error = " | ".join(attempt_errors)
                    run_time_ms = int((now_utc() - started).total_seconds() * 1000)
                    with self.db.connect() as conn:
                        self.db.update_post_process_metadata(
                            conn,
                            metadata_id,
                            status="running",
                            error=last_error,
                            run_time_ms=run_time_ms,
                            raw_token_usage=usage,
                            codex_session_id=codex_session_id,
                            phase="running_harness",
                            codex_source_home=getattr(prepared.workspace, "codex_source_home", None),
                            codex_account_id=getattr(prepared.workspace, "provider_account_id", None),
                            codex_account_email=getattr(prepared.workspace, "provider_account_email", None),
                        )
                        conn.commit()
                    if isinstance(exc, HarnessError) and (
                        exc.code in RETRYABLE_RATE_LIMIT_FAILURES or not exc.retryable
                    ):
                        if exc.code in RETRYABLE_RATE_LIMIT_FAILURES and exc.code not in CAPACITY_RATE_LIMIT_FAILURES:
                            mark_provider_account_rate_limited(
                                getattr(prepared.workspace, "provider_account_provider", None),
                                getattr(prepared.workspace, "provider_account_home", None),
                            )
                        break
            if isinstance(last_exception, HarnessError) and last_exception.code in RETRYABLE_RATE_LIMIT_FAILURES:
                raise PostProcessRateLimited(
                    last_error or "post-processing provider rate limit",
                    retry_after_seconds=last_exception.retry_after_seconds or 0.0,
                    provider=getattr(prepared.workspace, "provider_account_provider", None),
                    account_home=getattr(prepared.workspace, "provider_account_home", None),
                    limit_kind=last_exception.code,
                )
            raise PostProcessExecutionError(
                last_error or "The model process exited before post-processing returned a structured result."
            )
        except ClaudeCredentialRateLimited as exc:
            with self.db.connect() as conn:
                self.db.update_post_process_metadata(
                    conn,
                    metadata_id,
                    status="interrupted",
                    error=str(exc),
                    run_time_ms=0,
                    raw_token_usage=None,
                    phase="interrupted",
                )
                conn.commit()
            raise PostProcessRateLimited(
                str(exc),
                retry_after_seconds=exc.retry_after_seconds,
                provider="claude",
                account_home=exc.account_home,
                limit_kind=exc.limit_kind,
            ) from exc
        finally:
            if prepared is not None:
                cleanup_workspace(prepared.workspace)
            else:
                cleanup_job_workspace(self.config.data_dir, POST_WORKSPACE_ID_OFFSET + metadata_id)

    def _run_next_dedupe_batch(self, scan: dict[str, Any], harness) -> bool:
        scan_id = _int(scan["id"])
        with self.db.connect() as conn:
            if self.db.count_running_post_process(conn, scan_id, "dedupe"):
                return False
            current = self.db.load_scan(conn, scan_id)
            if not current or current["status"] != "post_processing":
                return False
            vulnerabilities = self.db.load_vulnerabilities(conn, scan_id)
            anchors, targets = dedupe_batch(vulnerabilities)
            if not targets:
                return False
            prompt = build_dedupe_prompt(current, anchors, targets)
            batch_index = self.db.next_post_process_batch_index(conn, scan_id, "dedupe")
            started = now_utc()
            selection = post_processing_model_selection(current)
            metadata_id = self.db.claim_post_process_metadata(
                conn,
                scan_id=scan_id,
                workflow_id=_int(current["workflow_id"]),
                kind="dedupe",
                batch_index=batch_index,
                target_vulnerability_ids=[_int(row["id"]) for row in targets],
                prompt_template="anchored-dedupe",
                prompt_filled="",
                model=selection.model,
                harness=selection.harness,
                thinking_effort=selection.thinking_effort,
                model_provider=selection.model_provider,
                run_started_at=started,
            )
            conn.commit()
        if metadata_id is None:
            return False

        def validator(payload):
            return validate_dedupe_payload(payload, anchors=anchors, targets=targets)

        started = now_utc()
        try:
            payload, usage, codex_session_id, checked_out_commit = self._run_harness_with_retries(
                metadata_id=metadata_id,
                scan=current,
                harness=harness,
                prompt=prompt,
                schema=dedupe_schema(),
                validator=validator,
                kind="dedupe",
            )
            clusters = validate_dedupe_payload(payload, anchors=anchors, targets=targets)
            mapping = dedupe_mapping_from_clusters(clusters, scan_id=scan_id, anchors=anchors, targets=targets)
            run_time_ms = int((now_utc() - started).total_seconds() * 1000)
            with self.db.connect() as conn:
                self.db.apply_dedupe_mapping(
                    conn,
                    scan_id=scan_id,
                    dedupe_run_id=metadata_id,
                    dedupe_model=selection.model,
                    mapping=mapping,
                )
                self.db.update_post_process_metadata(
                    conn,
                    metadata_id,
                    status="completed",
                    error=None,
                    run_time_ms=run_time_ms,
                    raw_token_usage=usage,
                    output_json=payload,
                    codex_session_id=codex_session_id,
                    checked_out_commit=checked_out_commit,
                    phase="completed",
                )
                conn.commit()
            return True
        except Exception as exc:
            run_time_ms = int((now_utc() - started).total_seconds() * 1000)
            with self.db.connect() as conn:
                self.db.update_post_process_metadata(
                    conn,
                    metadata_id,
                    status="interrupted" if isinstance(exc, PostProcessRateLimited) else "failed",
                    error=str(exc),
                    run_time_ms=run_time_ms,
                    raw_token_usage=None,
                    phase="interrupted" if isinstance(exc, PostProcessRateLimited) else "failed",
                )
                conn.commit()
            raise

    def _run_next_ranker_batch(self, scan: dict[str, Any], harness) -> bool:
        scan_id = _int(scan["id"])
        with self.db.connect() as conn:
            if self.db.count_running_post_process(conn, scan_id, "ranker"):
                return False
            current = self.db.load_scan(conn, scan_id)
            if not current or current["status"] != "post_processing":
                return False
            vulnerabilities = self.db.load_vulnerabilities(conn, scan_id)
            anchors, targets = ranker_batch(vulnerabilities)
            if not targets:
                return False
            prompt = build_ranker_prompt(current, anchors, targets)
            batch_index = self.db.next_post_process_batch_index(conn, scan_id, "ranker")
            started = now_utc()
            selection = post_processing_model_selection(current)
            metadata_id = self.db.claim_post_process_metadata(
                conn,
                scan_id=scan_id,
                workflow_id=_int(current["workflow_id"]),
                kind="ranker",
                batch_index=batch_index,
                target_vulnerability_ids=[_int(row["id"]) for row in targets],
                prompt_template="anchored-ranker",
                prompt_filled="",
                model=selection.model,
                harness=selection.harness,
                thinking_effort=selection.thinking_effort,
                model_provider=selection.model_provider,
                run_started_at=started,
            )
            conn.commit()
        if metadata_id is None:
            return False

        def validator(payload):
            return validate_ranker_payload(payload, targets=targets)

        started = now_utc()
        try:
            payload, usage, codex_session_id, checked_out_commit = self._run_harness_with_retries(
                metadata_id=metadata_id,
                scan=current,
                harness=harness,
                prompt=prompt,
                schema=ranker_schema(),
                validator=validator,
                kind="ranker",
            )
            updates = rank_updates_from_payload(
                payload,
                anchors=anchors,
                targets=targets,
                rank_run_id=metadata_id,
                model=selection.model,
                prompt_filled=prompt,
            )
            run_time_ms = int((now_utc() - started).total_seconds() * 1000)
            with self.db.connect() as conn:
                self.db.apply_rank_updates(conn, scan_id=scan_id, updates=updates)
                self.db.update_post_process_metadata(
                    conn,
                    metadata_id,
                    status="completed",
                    error=None,
                    run_time_ms=run_time_ms,
                    raw_token_usage=usage,
                    output_json=payload,
                    codex_session_id=codex_session_id,
                    checked_out_commit=checked_out_commit,
                    phase="completed",
                )
                conn.commit()
            return True
        except Exception as exc:
            run_time_ms = int((now_utc() - started).total_seconds() * 1000)
            with self.db.connect() as conn:
                self.db.update_post_process_metadata(
                    conn,
                    metadata_id,
                    status="interrupted" if isinstance(exc, PostProcessRateLimited) else "failed",
                    error=str(exc),
                    run_time_ms=run_time_ms,
                    raw_token_usage=None,
                    phase="interrupted" if isinstance(exc, PostProcessRateLimited) else "failed",
                )
                conn.commit()
            raise

    def _run_next_post_script_or_complete(
        self,
        scan: dict[str, Any],
        harness,
        *,
        allow_complete: bool = True,
    ) -> bool:
        scan_id = _int(scan["id"])
        with self.db.connect() as conn:
            current = self.db.load_scan(conn, scan_id)
            if not current or current["status"] != "post_processing":
                return False

            def complete_if_ready() -> bool:
                if not allow_complete or self.db.count_running_post_process(conn, scan_id, "ranker"):
                    return False
                self.db.set_scan_status_if_current(conn, scan_id, "post_processing", "completed")
                conn.commit()
                return True

            post_script_ids = configured_post_script_ids(current)
            if not post_script_ids:
                return complete_if_ready()
            rows = conn.execute(
                "SELECT * FROM public.post_scripts WHERE id = ANY(%s::bigint[])",
                (post_script_ids,),
            ).fetchall()
            scripts_by_id = {_int(row["id"]): row for row in rows}
            post_scripts = [
                scripts_by_id[post_script_id] for post_script_id in post_script_ids if post_script_id in scripts_by_id
            ]
            if not post_scripts:
                return complete_if_ready()
            post_script = None
            row = None
            for candidate_script in post_scripts:
                candidate_row = conn.execute(
                    """
                    SELECT v.*
                    FROM workflows.vulnerabilities v
                    WHERE v.scan_id = %s
                      AND v.dedupe_is_canonical = true
                      AND NOT EXISTS (
                          SELECT 1
                          FROM workflows.vulnerability_enrichments e
                          WHERE e.vulnerability_id = v.id
                            AND e.post_script_id = %s
                      )
                      AND NOT EXISTS (
                          SELECT 1
                          FROM workflows.post_process_metadata m
                          WHERE m.scan_id = v.scan_id
                            AND m.vulnerability_id = v.id
                            AND m.kind = 'post_script'
                            AND m.post_script_id = %s
                            AND m.status IN ('running', 'completed')
                      )
                    ORDER BY v.bounty_rank NULLS LAST, v.id ASC
                    LIMIT 1
                    """,
                    (scan_id, _int(candidate_script["id"]), _int(candidate_script["id"])),
                ).fetchone()
                if candidate_row:
                    post_script = candidate_script
                    row = candidate_row
                    break
            if not post_script or not row:
                if self.db.count_running_post_process(conn, scan_id, "post_script"):
                    return False
                return complete_if_ready()
            prompt_template = post_script["content"]
            if str(post_script.get("name") or "").strip().casefold() == "patched since":
                prompt_template = patched_since_prompt(prompt_template)
            started = now_utc()
            selection = post_processing_model_selection(current)
            metadata_id = self.db.claim_post_process_metadata(
                conn,
                scan_id=scan_id,
                workflow_id=_int(current["workflow_id"]),
                post_script_id=_int(post_script["id"]),
                post_script_name=post_script["name"],
                vulnerability_id=_int(row["id"]),
                kind="post_script",
                batch_index=None,
                target_vulnerability_ids=[_int(row["id"])],
                prompt_template=prompt_template,
                prompt_filled="",
                model=selection.model,
                harness=selection.harness,
                thinking_effort=selection.thinking_effort,
                model_provider=selection.model_provider,
                run_started_at=started,
            )
            conn.commit()
        if metadata_id is None:
            return False

        schema = output_schema(post_script["output_format"], multi_output=False)

        def validator(payload):
            return validate_payload(payload, schema, multi_output=False)

        prompt = ""
        started = now_utc()
        try:
            payload, usage, codex_session_id, checked_out_commit = self._run_harness_with_retries(
                metadata_id=metadata_id,
                scan=current,
                harness=harness,
                prompt=prompt,
                schema=schema,
                validator=validator,
                prompt_template=prompt_template,
                prompt_context=post_script_context(current, row),
                multi_output=False,
                kind="post_script",
            )
            rows = validate_payload(payload, schema, multi_output=False)
            result = rows[0] if rows else {}
            run_time_ms = int((now_utc() - started).total_seconds() * 1000)
            with self.db.connect() as conn:
                self.db.upsert_vulnerability_enrichment(
                    conn,
                    scan_id=scan_id,
                    vulnerability_id=_int(row["id"]),
                    post_script_id=_int(post_script["id"]),
                    post_script_name=post_script["name"],
                    result=result,
                    stub=bool(payload.get("stub")),
                    stub_explanation=(payload.get("stub_explanation") or "").strip() or None,
                )
                self.db.update_post_process_metadata(
                    conn,
                    metadata_id,
                    status="completed",
                    error=None,
                    run_time_ms=run_time_ms,
                    raw_token_usage=usage,
                    output_json=payload,
                    codex_session_id=codex_session_id,
                    checked_out_commit=checked_out_commit,
                    phase="completed",
                )
                conn.commit()
            return True
        except Exception as exc:
            run_time_ms = int((now_utc() - started).total_seconds() * 1000)
            with self.db.connect() as conn:
                self.db.update_post_process_metadata(
                    conn,
                    metadata_id,
                    status="interrupted" if isinstance(exc, PostProcessRateLimited) else "failed",
                    error=str(exc),
                    run_time_ms=run_time_ms,
                    raw_token_usage=None,
                    phase="interrupted" if isinstance(exc, PostProcessRateLimited) else "failed",
                )
                conn.commit()
            raise

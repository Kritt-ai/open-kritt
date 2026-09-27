# Recall-First External Flow Review v2.7

v2.7 is a separate profile for new scans. It leaves v2.6 and existing scan data intact.

1. D0 emits one record per production handler, including the least-privileged actor and reachability evidence.
2. D1-A/B/C map authority, protocol/state, and input/availability respectively. Each emits at most one record per handler, keeping paths and variants in arrays.
3. Bound routing sends D1-A only to D2-A, D1-B only to D2-B, and D1-C only to D2-C. D2 emits one raw finding per concrete root cause. A missing dependency is an explicit coverage gap. There is no global consume-all step.
4. OpenKritt stores all D2 candidates and applies its built-in semantic deduplication to them. Only canonical findings go to the following post-scripts.
5. D3 checks source, reachability, guards, deployment facts, impact, novelty and scope, and returns a hostile verification verdict without spending time on a PoC. It also defines the proof target: a separate bug claim and impact claim, an impact objective with a terminal outcome and required evidence, the resolved evidence dimensions for the impact family, an impact chain plan, structured assumptions, the first unsupported hop and a falsification plan.
6. D4 runs only for D3 `confirmed` or `plausible_needs_poc` results. It attempts a local PoC, negative control and repeated runs, then reports `bug_status` (did the defective behaviour occur) and `impact_status` (did the required terminal outcome occur) separately, fills the impact chain with the same hop ids as the D3 plan, and lists the artifacts that show the outcome. The engine captures the union of all evidence paths as scan artifacts before temporary workspace cleanup.
7. D5 runs only after the engine recorded `bug_status=reproduced` with complete artifact capture and an `impact_status` of `proven`, `partial` or `not_proven`. It maps every required outcome to what was observed, assesses scope, severity and novelty, and claims readiness. The engine then evaluates its own readiness rules and stores both the claim and the decision.

The three post-scripts are in `post-scripts/`. New scans using this workflow automatically snapshot their IDs in the order D3, D4, D5. The engine uses these IDs for conditional stage gating. Other workflows and existing scans use their prior post-script behavior.

## Investigation kind

Scans on this workflow must choose an `investigation_kind` at creation (`public_bounty`, `audit_competition`, `private_audit`, `threat_model_validation` or `internal_research`). The backend snapshots `investigation_kind_source=user` and `readiness_policy_version=v2.7-impact-gate-1` beside it; the keys are immutable afterwards. The kind decides which objective sources D3 may rely on, whether scope and novelty must be verified, and whether the readiness label is `submission_ready` or `report_ready`. Scans created before the gate existed are read as `internal_research` with a legacy default and are never ready.

## Stage contracts

Shared shapes:

- `hop`: `{ id, claim, status (proven | falsified | partial | unverified | blocked | not_applicable), evidence_paths: string[], covers: string[], assessment }`. `proven` needs at least one evidence path; `falsified`, `partial`, `blocked` and `not_applicable` need an assessment. Evidence paths are artifact-relative file paths, never prose.
- `assumption`: `{ id, assumption, kind (deployment | configuration | dependency | actor | economic | other), material: boolean, status (open | resolved | falsified) }`.
- `evidence_dimension`: `{ tag, status (required | not_applicable), rationale }`; `tag` must come from the impact family's dimension table.

| Stage | Keeps | Adds |
| --- | --- | --- |
| D3 | `verdict`, `reason`, `reachability_evidence`, `guard_analysis`, `impact_evidence`, `negative_control_plan`, `missing_evidence`, `novelty_status`, `scope_status` | `bug_claim`, `impact_claim`, `impact_family`, `impact_objective { claim, source_type, source_reference, affected_subject, terminal_outcome, required_evidence[] }`, `evidence_dimensions[]`, `impact_chain_plan[]` (hops, normally `unverified`), `unverified_assumptions[]`, `falsification_plan`, `first_unsupported_hop`, `impact_definition_status` |
| D4 | `poc_*`, `negative_control_*`, `repeat_count`, `poc_artifact_paths`, `poc_artifact_dir`, `remaining_limits`, `_reserved_poc` | `bug_status`, `impact_status`, `blocker_kind`, `observed_behavior`, `claimed_impact`, `observed_terminal_outcome`, `impact_chain[]` (hop ids ⊇ D3 plan ids, never renamed or dropped; unnecessary hops stay as `not_applicable` with an assessment), `impact_artifact_paths[]`, `missing_impact_links[]`, `unverified_assumptions[]`, `negative_control_status`, `repeatability_status` |
| D5 | `submission_ready` (model claim only), `scope_status`, `severity`, `novelty_status`, `impact_evidence`, `artifact_reference`, `_reserved_report`, `scope_evidence`, `novelty_evidence` | `missing_requirements` becomes `string[]`; `impact_match_status`, `impact_evidence_status`, `impact_mapping[] { required_outcome, observed_outcome, status, evidence_paths[] }`, `report_readiness_reason` |

The engine writes its own blocks beside the model fields: `_engine_lifecycle` after D3, `_engine_evidence` after D4 (normalized statuses, captured and unresolved paths, `capture_complete`), and `_engine_readiness` plus `model_readiness_claim` and `_chip_lifecycle` after D5. Output formats may not declare `_engine_*` keys or `_chip_lifecycle`; the engine strips them from any model payload. Nothing downstream reads `poc_status` for readiness; the model's assessment is preserved as written.

**D5 eligibility does not imply readiness eligibility.** `partial` and `not_proven` impact reach D5 so scope, mapping and a bounded non-ready report are still recorded, but only `impact_status=proven` can pass the readiness gate. A missing program rule, an open material assumption, an uncovered required evidence dimension, an unresolved evidence path, or a required outcome the D5 mapping marks `missing` keeps the engine decision at `ready=false` no matter what the model claimed. A technically valid bug is never deleted or marked a false positive because its bounty-relevant impact was not established; it keeps the accurate lifecycle status (for example `bug_proven_impact_unproven`).

The PoC stage cannot prove that model-written stdout is authentic by itself; a reviewer must inspect the saved harness, logs and negative control. A successful build or a proposed test is never sufficient for report readiness.

Before claiming effectiveness, benchmark v2.6 and v2.7 on the same pinned commit, scope, model and reasoning settings. Measure ground-truth recall, canonical precision, raw-to-canonical ratio, PoC reproduction, impact-proven rate, submission-ready precision, calls/tokens, wall time, coverage completion and provider failures. Do not launch a full-cost scan merely to test importability.

Run structural checks with `node --test scripts/web3-v2.7-workflow.test.mjs`.

# v2.7 Evidence-to-Impact Validation — Design

Status: approved design, 2026-09-24. Implementation plan follows in a separate document.

## 1. Problem

The v2.7 pipeline can establish that a proof of concept reproduced *something*, but
`poc_status: reproduced` does not distinguish "the defective behaviour was observed" from
"the claimed security impact was demonstrated". A finding whose PoC proves only an
intermediate step (a crash, a bypassed check, one consumed resource) can reach D5 and be
marked `submission_ready`.

The system must answer two separate questions with separate evidence:

1. Did the bug happen?
2. Did the security consequence required by *this* investigation happen?

```text
Bug reproduced ≠ Impact proven ≠ Report ready
```

## 2. Decisions already made

| Decision | Choice |
| --- | --- |
| Profile | Evolve v2.7 in place. No v2.8. No v2.7 scan data exists yet. |
| Approach | Structured, schema-validated fields in the existing post-script output formats plus an engine-owned deterministic gate (Approach A). No new database tables or migrations. |
| Investigation policy source | Explicit, required `investigation_kind` scan setting for gated workflows. The UI may recommend, never silently commit. |
| Legacy results | Interpreted at read time only. Historical enrichment JSON is never rewritten. |
| Policy identity | `readiness_policy_version` snapshotted at scan creation; the engine dispatches on the exact identifier and rejects unknown versions. |
| Model vs engine | The model produces the evidence assessment. The engine enforces structure, provenance, consistency, and readiness rules, and never claims to prove the semantic truth of an artifact. Both the model claim and the engine decision are stored. |

## 3. Nested output-format descriptors

### 3.1 Syntax

An output format remains a JSON object mapping a key to a field definition. A field
definition is either one of the five existing type names (`string`, `number`, `boolean`,
`array`, `object`) or a **descriptor** object:

```json
{
  "type": "array | object | string | number | boolean",
  "items": "<field definition>",
  "fields": { "<key>": "<field definition>" },
  "required": ["<key>"],
  "enum": ["<value>"]
}
```

Example:

```json
"impact_chain": {
  "type": "array",
  "items": {
    "type": "object",
    "fields": {
      "id": "string",
      "claim": "string",
      "status": { "type": "string", "enum": ["proven", "falsified", "partial", "unverified", "blocked", "not_applicable"] },
      "evidence_paths": { "type": "array", "items": "string" },
      "covers": { "type": "array", "items": "string" },
      "assessment": "string"
    },
    "required": ["id", "claim", "status", "evidence_paths", "covers", "assessment"]
  }
}
```

### 3.2 Rules

- `items` is allowed only under `array`; `fields` and `required` only under `object`;
  `enum` only under `string`. Any other descriptor key is rejected.
- A new `array` descriptor **must** declare `items`. The bare type name `"array"` and the
  legacy `{ "type": "array" }` keep their existing meaning (array of strings). New structured
  definitions never rely on that default.
- A new `object` descriptor **must** declare a non-empty `fields` map. Schema-declared objects
  always use `additionalProperties: false`. The bare type name `"object"` and the legacy
  `{ "type": "object" }` keep their existing meaning (free-form object). Arbitrary metadata
  objects inside structured schemas are not supported in this iteration.
- `required` defaults to every declared field. Every `required` entry must exist in `fields`.
- `enum` must be a non-empty array of unique strings.
- A descriptor with only `type` is equivalent to the type name.
- Depth cap 4 and a total-field cap of 64, both measured over the complete recursive
  descriptor for one key, not per branch.
- Keys beginning with `_engine_`, and the exact key `_chip_lifecycle`, are reserved and
  rejected in output formats. Other `_chip_*` keys remain a user-declarable feature
  (post-script chips) and are unchanged.
- Error messages carry the full descriptor path, e.g.
  `outputFormat.impact_chain.items.fields.status.enum`.

### 3.3 Where it is implemented

| Layer | Change |
| --- | --- |
| Backend `constants.js` | `normalizeOutputFormat` preserves descriptors instead of flattening to type names; a new `validateFieldDefinition(path, value)` walks recursively and returns path-qualified errors. Used by workflow, post-script, and import validation. |
| Frontend `lib/keys.js` | Same normalizer and validator in JavaScript; `objectToRows` marks a descriptor row as `structured` with a display type such as `array<object>`. `SchemaEditor` renders structured rows read-only in visual mode; the raw JSON mode edits them. |
| Engine `schema.py` | `normalize_output_format` preserves descriptors; `output_schema` emits real nested JSON Schema (`items`, `properties`, `required`, `additionalProperties: false`, `enum`). `validate_payload` therefore rejects malformed chains at extraction time. |
| Engine `generation.py` | AI-generated workflows and post-scripts keep the flat `{key, type}` list. Not extended. |
| Prompting | `render_value` already serializes non-strings as JSON; nested values render as JSON. Prior-stage results are injected as JSON already. |

### 3.4 Compatibility guarantee

Existing stored formats, exports, and imports behave identically. The guarantee is
semantic and structural: an existing format survives normalize → serialize → import with
the same meaning. Byte-level preservation of whitespace or key order is not required.

## 4. Investigation kind and policy snapshot

### 4.1 Scan configuration keys

| Key | Values | Set by |
| --- | --- | --- |
| `investigation_kind` | `public_bounty`, `audit_competition`, `private_audit`, `threat_model_validation`, `internal_research` | user, at creation |
| `investigation_kind_source` | `user`, `legacy_default` | backend writes `user` for every new gated scan |
| `readiness_policy_version` | `v2.7-impact-gate-1` | backend copies the workflow's gate identifier at creation |

### 4.2 Backend

- `serializeWorkflow` adds `readinessGate`: `"v2.7-impact-gate-1"` for the v2.7 workflow
  (same name match that resolves the pipeline IDs), otherwise `null`. The UI keys every
  gate-specific behaviour on this field.
- `POST /api/scans` on a gated workflow requires a valid `investigation_kind`; the error is a
  field error on `configuration.investigation_kind`. The route writes
  `investigation_kind_source: "user"` and `readiness_policy_version` into the snapshotted
  configuration. Non-gated workflows accept the keys but the response and docs make clear
  no gate runs.
- `PATCH /api/scans/:id` (run settings): the three keys may be omitted or resubmitted with
  their exact existing values. Additions, removals, or value changes are rejected with a
  field error.

### 4.3 Frontend

- Create scan: when `readinessGate` is set, an "Investigation kind" select appears with no
  value chosen. A hint shows the recommendation and its reason (`public_bounty` when a bounty
  URL extra is present, otherwise `internal_research`). Submit stays disabled with the reason
  "Choose the investigation kind" until the user selects a value. The recommendation is a
  pure helper (`investigationKindRecommendation(extra)`).
- Run settings: read-only "Investigation" row showing kind and policy version. Legacy scans
  show "internal research · legacy default".

### 4.4 Engine read-time normalization

A scan without the keys is interpreted, never rewritten, as:

```json
{
  "investigation_kind": "internal_research",
  "investigation_kind_source": "legacy_default",
  "readiness_policy_version": "legacy-unverified"
}
```

Every readiness decision for such a scan is `ready: false` with the blocking reason
"Investigation kind and readiness policy were not explicitly selected when this legacy scan
was created."

## 5. Stage contracts

### 5.1 Shared nested shapes

`hop`:

| Field | Type | Rule |
| --- | --- | --- |
| `id` | string | unique within the chain |
| `claim` | string | |
| `status` | enum `proven, falsified, partial, unverified, blocked, not_applicable` | |
| `evidence_paths` | array of string | artifact-relative paths only; `proven` requires at least one |
| `covers` | array of string | evidence-dimension tags satisfied by this hop |
| `assessment` | string | required (non-empty) for `not_applicable`, `falsified`, `partial`, `blocked` |

`assumption`:

| Field | Type |
| --- | --- |
| `id` | string |
| `assumption` | string |
| `kind` | enum `deployment, configuration, dependency, actor, economic, other` |
| `material` | boolean |
| `status` | enum `open, resolved, falsified` |

`evidence_dimension`:

| Field | Type |
| --- | --- |
| `tag` | string (must be a tag from the family table for the chosen family) |
| `status` | enum `required, not_applicable` |
| `rationale` | string, required when `not_applicable` |

Narrative belongs in `assessment` and `rationale`. `evidence_paths` are never prose.

### 5.2 D3 — hostile verification and proof target

Existing fields stay: `verdict`, `reason`, `reachability_evidence`, `guard_analysis`,
`impact_evidence`, `negative_control_plan`, `missing_evidence`, `novelty_status`,
`scope_status`.

Added:

| Field | Type |
| --- | --- |
| `bug_claim` | string |
| `impact_claim` | string |
| `impact_family` | enum `unauthorized_action, funds_loss, availability_loss, resource_exhaustion, consensus_failure, integrity_violation, confidentiality_loss, privilege_escalation, temporary_freezing, permanent_freezing, other` |
| `impact_objective` | object `{ claim, source_type (enum bounty_rule, audit_spec, threat_model, engagement_scope, researcher_hypothesis), source_reference, affected_subject, terminal_outcome, required_evidence: array<string> }` |
| `evidence_dimensions` | array of `evidence_dimension` — the family defaults resolved for this objective |
| `impact_chain_plan` | array of `hop`; statuses normally `unverified` |
| `unverified_assumptions` | array of `assumption` |
| `falsification_plan` | string |
| `first_unsupported_hop` | string (hop id or empty) |
| `impact_definition_status` | enum `defined, ambiguous, unavailable` |

The required terminal outcome lives only at `impact_objective.terminal_outcome`.
`impact_objective.required_evidence` remains authoritative for the investigation;
`evidence_dimensions` is how the family defaults are resolved against it.

Prompt rules: `confirmed` means source-level support for the bug and a concrete attack path,
not a dynamically proven impact; hedged language (`could`, `may`, `might`, `potentially`)
must become explicit unverified hops; deployment assumptions go in `unverified_assumptions`,
not prose; D3 names the first unsupported hop and how the impact could be falsified.

### 5.3 D4 — bug reproduction separated from impact proof

Existing `poc_*`, `negative_control_*`, `repeat_count`, `poc_artifact_paths`,
`poc_artifact_dir`, `remaining_limits`, `_reserved_poc` stay so the prompt can keep
reporting commands and outputs. Nothing downstream reads `poc_status` for readiness.

Added:

| Field | Type |
| --- | --- |
| `bug_status` | enum `reproduced, not_reproduced, blocked, falsified` |
| `impact_status` | enum `proven, partial, not_proven, blocked, falsified` |
| `blocker_kind` | enum `none, missing_dependency, missing_configuration, deployment_fact, unsafe_external, other` |
| `observed_behavior` | string |
| `claimed_impact` | string |
| `observed_terminal_outcome` | string |
| `impact_chain` | array of `hop` |
| `impact_artifact_paths` | array of string |
| `missing_impact_links` | array of string (hop ids) |
| `unverified_assumptions` | array of `assumption` |
| `negative_control_status` | enum `passed, failed, unavailable` |
| `repeatability_status` | enum `deterministic, non_deterministic, not_tested` |

Chain rules: D4 hop ids must be a superset of the D3 plan ids; every D3 hop appears with
the same id; D4 may add hops; ids are unique; a D3 hop that proved unnecessary is preserved
as `not_applicable` with an assessment; no silent removal, rename, or replacement.

### 5.4 D5 — required outcome versus observed outcome

Existing fields stay: `submission_ready` (model claim), `scope_status`, `severity`,
`novelty_status`, `impact_evidence`, `artifact_reference`, `_reserved_report`,
`scope_evidence`, `novelty_evidence`.

Changed: `missing_requirements` becomes array of string.

Added:

| Field | Type |
| --- | --- |
| `impact_match_status` | enum `exact, partial, none, rules_unavailable` |
| `impact_evidence_status` | enum `verified, insufficient, contradictory` |
| `impact_mapping` | array of `{ required_outcome, observed_outcome, status (enum proven, missing, contradicted), evidence_paths: array<string> }` |
| `report_readiness_reason` | string |

`missing_requirements` normalization for legacy values: missing or empty string → `[]`;
non-empty string → `[string]`; array of strings → unchanged; anything else → validation
failure for new results. Applied wherever old D5 results are read (engine, backend, UI,
exports).

### 5.5 Reserved keys

Output formats may not declare keys starting with `_engine_` or the key `_chip_lifecycle`
(see 3.2). The strict schemas reject them at extraction. Before persisting any model
payload the engine drops any `_engine_*` key and `_chip_lifecycle`, then writes its own
blocks.

## 6. Engine gate

### 6.1 Modules

- `impact_gate.py` — pure functions over plain dicts. No clock, no I/O. `evaluated_at` is
  passed in by the caller.
- `readiness_policies.py` — versioned policy tables keyed by `readiness_policy_version`.
- `v27_pipeline.py` — stage routing, D5 eligibility condition, orchestration of the two
  modules; `poc_artifacts.py` — artifact capture and manifest.

### 6.2 Engine-owned blocks

Written beside model fields after each stage; the model cannot write them (5.5).

| Stage | Block | Contents |
| --- | --- | --- |
| D3 | `_engine_lifecycle` | `{ lifecycle_status, policy_version, legacy: false }` |
| D4 | `_engine_evidence` | normalized `bug_status`, `impact_status` (adds `unverified`), `artifact_dir`, `captured_paths` (manifest-verified), `unresolved_paths`, `capture_complete: bool`, `lifecycle_status`, `policy_version`, `legacy: false` |
| D5 | `_engine_readiness` | `{ ready, label ("submission_ready" or "report_ready"), lifecycle_status, blocking_reasons: [], checks: { rule_name: "pass" or "fail" }, policy: <investigation_kind>, policy_version, evaluated_at, legacy: false }` plus top-level `model_readiness_claim` (copy of the model's `submission_ready`) and `_chip_lifecycle` |

The D4 block replaces the current behaviour of rewriting the model's `poc_status` to
`insufficient_evidence`; the model's assessment is preserved as written.

For historical results the same three blocks are synthesized at read time with
`legacy: true` and are not written back.

### 6.3 Artifact capture (D4)

- Persisted set = deduplicated union of `poc_artifact_paths`, `impact_artifact_paths`, and
  every `evidence_paths` entry in `impact_chain`.
- Paths are normalized relative paths: absolute paths and `..` are rejected; symlinks are
  resolved before copy and the source must remain inside the job workspace; the manifest
  entry records the final artifact-relative name.
- Cap: 20 files after deduplication. If the union exceeds the cap nothing is truncated:
  capture is marked incomplete (`capture_complete: false`) and impact proof and readiness are
  blocked.

### 6.4 Lifecycle statuses

`hypothesis` (no D3), `false_positive`, `not_advanced` (other non-passing D3 verdicts,
verdict in the reason), `code_confirmed` (D3 passed, D4 pending), `bug_not_reproduced`,
`bug_falsified`, `bug_blocked`, `bug_proven_impact_unproven`, `impact_partial`,
`impact_falsified`, `impact_blocked_by_configuration`, `impact_blocked_by_deployment_fact`,
`impact_blocked`, `impact_proven`, `report_ready`,
`legacy_bug_reproduced_impact_unverified`.

A technically valid bug is never deleted or marked false positive because bounty-relevant
impact was not established; it keeps the accurate status above.

### 6.5 D5 eligibility

D5 runs when `_engine_evidence.bug_status == reproduced`, the artifact directory exists,
`capture_complete` is true, and `impact_status` is `proven`, `partial`, or `not_proven`.
`blocked` and `falsified` impact terminate at D4 with their lifecycle status.

**D5 eligibility does not imply readiness eligibility.** Only `impact_status = proven` can
pass the readiness gate; `partial` and `not_proven` reach D5 so scope, mapping, and a
bounded non-ready report are still recorded.

The SQL eligibility condition is built from the same constants the gate uses.

### 6.6 Readiness rules

Each rule yields a named check and, on failure, a blocking reason.

1. `policy_version_supported` — `readiness_policy_version` is known to the engine. Unknown
   versions block; nothing falls through to the latest policy.
2. `investigation_kind_explicit` — `investigation_kind_source` is `user`.
3. `d3_defined` — D3 verdict is `confirmed` or `plausible_needs_poc`,
   `impact_definition_status` is `defined`, the objective has non-empty `claim`,
   `terminal_outcome`, and `required_evidence`, and `source_type` is allowed by the policy
   (6.7). A public bounty without an exact eligible-impact rule stays blocked; the objective
   is never re-labelled as a researcher hypothesis.
4. `d4_bug_and_impact` — `bug_status` is `reproduced`, `impact_status` is `proven`,
   `observed_terminal_outcome` non-empty, `negative_control_status` is `passed`,
   `repeatability_status` is `deterministic` unless the policy allows probabilistic evidence.
5. `chain_complete` — D4 hop ids ⊇ D3 plan ids with identical ids; ids unique; every hop is
   `proven` or `not_applicable` (with assessment); `missing_impact_links` empty; no
   assumption both `material` and `open`; status-specific assessment rules from 5.1 hold.
6. `provenance` — every `proven` hop has ≥ 1 `evidence_paths` entry; every path in hops and
   in D5 `impact_mapping` resolves to a manifest entry of the D4 artifact directory;
   `capture_complete` is true.
7. `dimension_coverage` — every `evidence_dimension` with status `required` is covered by at
   least one `proven` hop's `covers`; `not_applicable` dimensions carry a rationale; tags
   outside the family table are rejected, so a weaker substitute tag cannot satisfy the gate.
8. `d5_match` — `impact_match_status` is `exact`, `impact_evidence_status` is `verified`,
   every mapping entry is `proven`, `artifact_reference` equals the D4 artifact directory,
   `missing_requirements` is empty.
9. `scope_and_novelty` — `scope_status == in_scope_verified` with non-empty `scope_evidence`
   when the policy requires scope; `novelty_status == novel_verified` with non-empty
   `novelty_evidence` when the policy requires novelty.

`ready` is true only when every check passes. The model may claim readiness; the engine
decides and both are stored.

### 6.7 Policy tables (`v2.7-impact-gate-1`)

Investigation kinds:

| Kind | Allowed objective sources | Scope required | Novelty required | Probabilistic evidence | Label |
| --- | --- | --- | --- | --- | --- |
| `public_bounty` | `bounty_rule` | yes | yes | no | `submission_ready` |
| `audit_competition` | `audit_spec`, `engagement_scope` | yes | yes | no | `submission_ready` |
| `private_audit` | `audit_spec`, `engagement_scope`, `threat_model`, `researcher_hypothesis` | yes | no | no | `report_ready` |
| `threat_model_validation` | `threat_model`, `engagement_scope` | no | no | no | `report_ready` |
| `internal_research` | `threat_model`, `researcher_hypothesis`, `engagement_scope` | no | no | no | `report_ready` |

Impact families supply default evidence dimensions; D3 resolves each as `required` or
`not_applicable` with rationale, and the engine verifies coverage of the required ones:

| Family | Default dimensions |
| --- | --- |
| `unauthorized_action` | `initial_actor`, `permission_boundary`, `protected_operation`, `unauthorized_result` |
| `funds_loss` | `balance_before`, `balance_after`, `asset_ownership`, `net_change`, `recipient_control` |
| `availability_loss` | `attacker_workload`, `measurable_degradation`, `duration`, `affected_component`, `recovery` |
| `resource_exhaustion` | `pool_size`, `attacker_cost_per_iteration`, `iterations_required`, `replenishment`, `recovery` |
| `consensus_failure` | `conflicting_state`, `halt_or_divergence`, `affected_participants`, `recovery_requirements` |
| `integrity_violation` | `trusted_value_before`, `trusted_value_after`, `unauthorized_mutation`, `downstream_consumer` |
| `confidentiality_loss` | `protected_data`, `unauthorized_actor`, `disclosure_boundary` |
| `privilege_escalation` | `initial_role`, `acquired_capability`, `protected_operation` |
| `temporary_freezing` | `affected_value`, `duration`, `release_conditions`, `recovery_path` |
| `permanent_freezing` | `affected_value`, `irrecoverability_under_recovery_model` |
| `other` | `terminal_outcome` |

Every dimension row also implicitly requires `terminal_outcome`.

## 7. Frontend

- `readinessGate` on serialized workflows drives the create-scan select, the read-only run
  settings row, and any "gate active" affordance.
- Finding page "Evidence" card, above post-script cards, whenever an engine block exists:
  - Dimensions table: Bug, Impact, Terminal outcome, Deployment (open material
    assumptions), Scope, Novelty, Readiness (label, ready, first blocking reason).
  - Required versus observed terminal outcome side by side.
  - Impact chain table: id, claim, status, covers, assessment, evidence paths marked
    "captured" or "unresolved" from `_engine_evidence`.
  - Missing links, assumptions, D5 mapping, and the full list of blocking reasons with
    check names.
  - "legacy" badge when blocks were synthesized.
- The generic post-script card no longer lists `_engine_*` keys.
- Read-time synthesis lives in one backend module (`impactReadiness.js`) used by the finding
  API and the export. It builds only legacy blocks (`legacy: true`) and normalizes
  `missing_requirements`; it never re-evaluates policy.
- Scan graph funnel: outcome bucketing accepts dotted paths so D3/D4/D5 stages show
  `_engine_lifecycle.lifecycle_status` distributions.
- Finding lists show `_chip_lifecycle` through the existing chip mechanism.

## 8. Exports

- `finding.md` gains a "Readiness" chapter: dimensions table, required and observed
  outcome, evidence chain table with captured status, negative control, repeatability,
  assumptions, missing links, limitations (`remaining_limits`), readiness decision with
  blocking reasons and policy version.
- `report.txt` keeps the model's prose unchanged but is prefixed with a fenced header:
  "NOT READY — <label> — <lifecycle> — reasons: …" when the engine decision is not ready,
  or "READY under <policy_version>" when it is.
- `manifest.json` records per finding `readiness: { ready, label, lifecycleStatus,
  policyVersion, legacy }`; the README table replaces the PoC yes/no column with a
  lifecycle column and adds a count of findings per lifecycle status.
- `post-processing.json` unchanged (already carries raw results including engine blocks).

## 9. Tests

- Shared fixture `test-fixtures/output-format-descriptors.json`: valid and invalid
  descriptor cases with expected error paths, consumed by backend, frontend, and engine
  validator tests.
- Backend: descriptor normalization and recursive validation; reserved prefix rejection;
  legacy format import/export round trip with semantic equality; `investigation_kind`
  required only for gated workflows; PATCH immutability including harmless resubmission;
  legacy synthesis; `missing_requirements` normalization; export chapter, header, manifest
  readiness; workflow `readinessGate`.
- Frontend: descriptor-aware key helpers and structured rows; recommendation helper; submit
  gating; Evidence card including legacy badge and unresolved paths; hidden engine keys;
  graph funnel dotted outcomes.
- Engine: nested `output_schema` acceptance and rejection with full paths; reserved
  prefixes at extraction and before persistence; artifact union, deduplication, cap overflow
  → capture incomplete, traversal and symlink rejection; `impact_gate` covering the twelve
  spec unit cases, every policy row of the source-type matrix, unsupported policy version,
  policy-version stability, pure `evaluated_at`, hop superset rules (renamed or dropped D3
  hops fail), `not_applicable` without assessment fails, dimension resolution and coverage;
  ten cross-family fixtures as JSON files each with expected lifecycle and readiness;
  D5 eligibility condition built from the gate constants.
- Workflow pack structural test: new fields and enums present, no reserved-prefix keys, no
  program name in prompts.

Spec unit cases (all must exist): partial impact → not ready; not proven → not ready;
terminal impact proven → eligible; proven but material assumption open → blocked; evidence
not matching objective → not ready; falsified → not ready; negative control failed → not
ready; non-deterministic → not ready; private audit without novelty → may be `report_ready`;
public bounty with unverified novelty → not `submission_ready`; legacy result → `unverified`
and not ready; model claims readiness but gate fails → overridden.

Cross-family fixtures: authorization bypass with successful protected action; one resource
unit consumed without exhaustion; exhaustion with measurable service failure; direct funds
loss with before/after balances; local crash without degradation; state corruption without
downstream consequence; consensus halt or divergence; confidentiality disclosure; valid bug
dependent on unknown production configuration; PoC whose observed outcome is weaker than
the bounty impact.

## 10. Documentation

- New docs-site page (post-scripts): "Structured output fields" — syntax, rules, limits,
  editor behaviour, compatibility.
- New docs-site page (scans): "Investigation kind and readiness" — kinds, source-type
  matrix, lifecycle states, numbered readiness rules, legacy behaviour, one worked example
  per impact family.
- Update "How to view results" (Evidence card, export changes), the v2.7 pack README
  (stage contracts, "D5 eligibility does not imply readiness eligibility"), and the
  reserved-key gotcha in `AGENTS.md` (`_engine_*`, `_chip_lifecycle`).

## 11. Definition of done

- D3 defines an impact objective, resolved evidence dimensions, and a chain plan for every
  report candidate.
- D4 returns `bug_status` and `impact_status` separately and cannot be treated as
  impact-proven without an observed terminal outcome and captured artifacts.
- D5 performs an explicit required-versus-observed comparison.
- The engine enforces readiness deterministically, stores both the model claim and its own
  decision, and rejects unknown policy versions.
- The UI presents Bug and Impact as separate states and explains why readiness is blocked.
- Exports include the chain, missing links, assumptions, limitations, and the decision.
- Legacy findings are interpreted as impact-unverified and never rewritten.
- Regression tests cover multiple impact families and every investigation kind.
- A successful PoC with incomplete terminal impact can never become ready.

## 12. Out of scope

- A separate evidence table or cross-finding analytics (Approach B).
- Nested types in AI-generated workflows.
- A visual editor for nested descriptors beyond the read-only structured row.
- Migrating historical enrichment JSON.

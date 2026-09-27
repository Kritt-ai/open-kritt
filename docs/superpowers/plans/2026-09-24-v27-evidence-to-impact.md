# v2.7 Evidence-to-Impact Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the v2.7 profile distinguish bug reproduction from impact proof, with a deterministic engine-owned readiness gate, structured stage contracts, policy-aware investigation kinds, and UI/export surfaces that show Bug and Impact separately.

**Architecture:** Nested output-format descriptors are validated identically in backend, frontend, and engine from one shared fixture. The engine gate (`impact_gate.py`, pure) reads D3/D4/D5 enrichment JSON and writes engine-owned blocks beside the model's fields; the backend synthesizes the same blocks for legacy results at read time. No database migration.

**Tech Stack:** Node 20+ ESM (Express, Prisma, node:test), React 19 + Vite (vitest, renderToStaticMarkup), Python 3.11 (jsonschema, pytest, ruff).

**Spec:** `docs/superpowers/specs/2026-09-24-v27-evidence-to-impact-design.md` — the plan argues from the spec; read both.

## Global Constraints

- Conventional Commits; never bump versions; never commit secrets or `.env`.
- Five legacy field types (`string`, `number`, `boolean`, `array`, `object`) keep their exact semantics. `"array"` and `{ "type": "array" }` mean array of strings; `"object"` and `{ "type": "object" }` mean free-form object.
- New descriptors: `array` requires `items`; `object` requires non-empty `fields` and always `additionalProperties: false`; `enum` only under `string`, non-empty, unique; `required` ⊆ `fields`; unknown descriptor keys rejected; depth cap 4, total-field cap 64 over the whole descriptor; errors carry the full path `outputFormat.<key>.items.fields.<key>.enum`.
- Reserved output keys: any key starting with `_engine_`, and the exact key `_chip_lifecycle`. Other `_chip_*` keys stay user-declarable.
- Readiness policy version string: `v2.7-impact-gate-1`. Legacy: `legacy-unverified`. Unknown versions block, never fall through.
- Investigation kinds: `public_bounty`, `audit_competition`, `private_audit`, `threat_model_validation`, `internal_research`. Sources: `user`, `legacy_default`.
- Engine-owned blocks: `_engine_lifecycle` (D3), `_engine_evidence` (D4), `_engine_readiness` + `model_readiness_claim` + `_chip_lifecycle` (D5). Model output can never write them. Legacy results get synthesized blocks with `legacy: true`, never persisted.
- `impact_gate.py` is pure: no clock, no I/O; `evaluated_at` is passed in.
- Artifact cap 20 after dedupe; overflow → `capture_complete: false`, never truncate.
- Shared fixture: `test-fixtures/output-format-descriptors.json` (already written). Every validator test iterates it.
- Run checks per area (see AGENTS.md). Engine venv for this session: `/private/tmp/claude-501/-Volumes-T9-open-kritt/61f35b34-677b-40e5-ba01-193c7be01009/scratchpad/venv/bin` (ruff 0.16.6, pytest).

## Interfaces (shared by all tracks)

### Backend `backend/src/lib/fieldDefinitions.js` (new)

```js
export const FIELD_TYPES = ['string', 'number', 'boolean', 'array', 'object'];
export const DESCRIPTOR_KEYS = ['type', 'items', 'fields', 'required', 'enum'];
export const MAX_DESCRIPTOR_DEPTH = 4;
export const MAX_DESCRIPTOR_FIELDS = 64;
export const RESERVED_OUTPUT_KEY_PREFIXES = ['_engine_'];
export const RESERVED_OUTPUT_KEYS = ['_chip_lifecycle'];
export function isReservedOutputKey(key) // boolean
export function normalizeFieldDefinition(value) // 'string' | descriptor (deep-copied, type-only descriptor collapses to the type name)
export function normalizeOutputFormat(input) // { key: 'type' | descriptor }; accepts object map, [{key,type}], or JSON string; throws on bad JSON
export function validateFieldDefinition(path, value) // [{ field: path, message }] ; path like 'outputFormat.impact_chain'
export function fieldTypeName(definition) // top-level type name
export function isStructuredDefinition(definition) // true when descriptor has items/fields/enum
export function displayType(definition) // 'array<object>', 'string(enum)', 'object{3}'
```

`constants.js` re-exports `normalizeOutputFormat` from this module (same name) so existing imports keep working.

### Frontend `frontend/src/lib/fieldDefinitions.js` (new)

Same exports and semantics as the backend module (duplicated on purpose; both are checked against the shared fixture). `keys.js` re-exports `FIELD_TYPES` from it. `objectToRows` returns `{ key, type, definition, structured }` where `type` is `displayType(definition)` for structured rows and the plain name otherwise; `rowsToObject` writes back `definition` for structured rows.

### Engine `engine/open_kritt_engine/schema.py`

```py
FIELD_TYPES = ("string", "number", "boolean", "array", "object")
RESERVED_OUTPUT_KEY_PREFIXES = ("_engine_",)
RESERVED_OUTPUT_KEYS = frozenset({"_chip_lifecycle"})
def is_reserved_output_key(key: str) -> bool
def normalize_output_format(raw) -> dict[str, str | dict]      # preserves descriptors
def validate_field_definition(path: str, value) -> list[str]  # "outputFormat.x.enum: message"
def field_definition_schema(definition) -> dict                # JSON Schema for one field
def output_schema(raw_output_format, multi_output) -> dict     # unchanged signature, nested-aware
def strip_reserved_keys(payload: dict) -> dict                 # drops _engine_* and _chip_lifecycle from every result row
```

### Engine `engine/open_kritt_engine/readiness_policies.py` (new)

```py
POLICY_VERSION = "v2.7-impact-gate-1"
LEGACY_POLICY_VERSION = "legacy-unverified"
INVESTIGATION_KINDS = ("public_bounty", "audit_competition", "private_audit", "threat_model_validation", "internal_research")
OBJECTIVE_SOURCES = ("bounty_rule", "audit_spec", "threat_model", "engagement_scope", "researcher_hypothesis")
IMPACT_FAMILIES = (...11 from spec 6.7...)
@dataclass(frozen=True) class InvestigationPolicy: kind: str; allowed_sources: frozenset[str]; requires_scope: bool; requires_novelty: bool; allows_probabilistic: bool; label: str  # "submission_ready" | "report_ready"
class UnsupportedPolicyVersion(ValueError)
def policy_for(version: str, kind: str) -> InvestigationPolicy   # raises UnsupportedPolicyVersion / ValueError(kind)
def family_dimensions(version: str, family: str) -> tuple[str, ...]  # always includes "terminal_outcome"
```

Tables exactly as spec 6.7.

### Engine `engine/open_kritt_engine/impact_gate.py` (new, pure)

```py
D3_PASS_VERDICTS = frozenset({"confirmed", "plausible_needs_poc"})
HOP_STATUSES = ("proven", "falsified", "partial", "unverified", "blocked", "not_applicable")
LIFECYCLE = (...16 statuses from spec 6.4...)
def investigation_settings(scan: dict) -> dict  # {investigation_kind, investigation_kind_source, readiness_policy_version, legacy: bool}
def normalize_missing_requirements(value) -> list[str]  # raises ValueError on malformed
def evidence_block(d4: dict, manifest_names: set[str] | None, *, capture_complete: bool, artifact_dir: str, policy_version: str, legacy: bool) -> dict  # _engine_evidence
def lifecycle_status(d3: dict | None, evidence: dict | None, readiness: dict | None) -> str
def lifecycle_block(status: str, policy_version: str, legacy: bool) -> dict  # _engine_lifecycle
def chain_reasons(plan_hops: list, chain_hops: list) -> list[str]          # spec 6.6 rule 5 (+ hop status/assessment rules 5.1)
def provenance_reasons(paths: list[str], captured: set[str]) -> list[str]  # rule 6
def dimension_reasons(dimensions: list, family: str, chain_hops: list, version: str) -> list[str]  # rule 7
def evaluate_readiness(*, scan: dict, d3: dict | None, d4: dict | None, evidence: dict | None, d5: dict | None, evaluated_at: str) -> dict  # _engine_readiness per spec 6.2 + 6.6
def synthesize_legacy_blocks(scan: dict, stage: str, result: dict) -> dict  # {"_engine_lifecycle"|"_engine_evidence"|"_engine_readiness": {...legacy: True}}
def d5_eligible(evidence: dict | None) -> bool
```

`checks` keys in `_engine_readiness`: `policy_version_supported`, `investigation_kind_explicit`, `d3_defined`, `d4_bug_and_impact`, `chain_complete`, `provenance`, `dimension_coverage`, `d5_match`, `scope_and_novelty`.

### Engine `poc_artifacts.py`

```py
MAX_FILES = 20
def capture_evidence(data_dir, repo_dir, *, scan_id, finding_id, metadata_id, result) -> dict
# returns {"artifact_dir": str|"", "captured_paths": [...], "unresolved_paths": [...], "capture_complete": bool, "reason": str}
# union of poc_artifact_paths + impact_artifact_paths + impact_chain[].evidence_paths, deduped; >MAX_FILES → no copy, capture_complete False
```

### Backend `backend/src/lib/impactReadiness.js` (new)

```js
export const READINESS_POLICY_VERSION = 'v2.7-impact-gate-1';
export const LEGACY_POLICY_VERSION = 'legacy-unverified';
export const INVESTIGATION_KINDS = [...];
export function investigationSettings(scan) // same shape as engine
export function normalizeMissingRequirements(value) // [] | [string] | array; throws TypeError on malformed
export function withEngineBlocks(enrichment, { stage, scan }) // returns enrichment.result with synthesized legacy blocks when missing (legacy: true), never mutates input
export function findingReadiness(vulnerability, scan) // { ready, label, lifecycleStatus, policyVersion, legacy, blockingReasons, evidence, lifecycle, readiness } from the latest stage block
```

### Backend serialization

`serializeWorkflow` adds `readinessGate: 'v2.7-impact-gate-1' | null`. `serializeVulnerability` adds `readiness` (from `findingReadiness`) and each enrichment's `result` passes through `withEngineBlocks`.

### Frontend `frontend/src/lib/investigationKind.js` (new)

```js
export const INVESTIGATION_KINDS = [{ value, label, description }...];
export function investigationKindRecommendation(extra) // { value, reason }
export function investigationConfiguration(kind, readinessGate) // { investigation_kind, investigation_kind_source: 'user', readiness_policy_version }
```

---

## Track A — Backend descriptors and investigation kind (Agent A)

Files: `backend/src/lib/fieldDefinitions.js` (new), `backend/src/lib/constants.js`, `backend/src/lib/validation.js`, `backend/src/lib/serialize.js`, `backend/src/lib/v27Pipeline.js`, `backend/src/routes/scans.js`, tests `backend/test/fieldDefinitions.test.js` (new), `backend/test/validation.test.js`, `backend/test/v27Pipeline.test.js`, `backend/test/scanPresentation.test.js`.

### Task A1: fieldDefinitions module

- [ ] Write `backend/test/fieldDefinitions.test.js` iterating `test-fixtures/output-format-descriptors.json` `cases`: for each, `normalizeOutputFormat(case.outputFormat)` then `validateFieldDefinition` per key; valid cases produce no errors; invalid cases' first error `field === case.errorPath`; `normalizedEquals` cases deep-equal after normalization. Add unit tests for `displayType`, `isStructuredDefinition`, `isReservedOutputKey`, JSON-string input, `[{key,type}]` input.
- [ ] Run, see failures. Implement the module. Run, pass.

### Task A2: wire validation

- [ ] Tests in `validation.test.js`: `validateWorkflow` accepts a level whose output format uses the nested chain descriptor and rejects the fixture's invalid cases with `field` equal to `levels[depth=N].` + errorPath; `validatePostScript` same with `outputFormat.` prefix; reserved `_engine_x` and `_chip_lifecycle` rejected; existing tests unchanged and green; terminal required key checks compare `fieldTypeName`.
- [ ] Implement: in both validators replace `if (!FIELD_TYPES.includes(type))` with `errors.push(...validateFieldDefinition(path, definition))`; keep `normalizeOutputFormat` result (descriptor-preserving) as the stored `outputFormat` (it is JSON-stringified into the `steps.output_format` text column already).
- [ ] `serialize.js`: `safeParseFormat` uses the descriptor-preserving normalizer; add `readinessGate` to `serializeWorkflow` using `V27_WORKFLOW_NAME` and a new export `READINESS_POLICY_VERSION = 'v2.7-impact-gate-1'` in `v27Pipeline.js`.

### Task A3: investigation kind on scan create and update

- [ ] Tests: `resolveV27Pipeline` result now includes `readinessPolicyVersion`; in `routes/scans.js` extract a pure `investigationKindForScan(configuration, v27Pipeline)` returning `{ configuration, errors }` and test: gated + missing kind → error `{ field: 'configuration.investigation_kind' }`; gated + valid → configuration gains `investigation_kind_source: 'user'` and `readiness_policy_version`; non-gated → configuration untouched. Test a pure `assertImmutableInvestigationKeys(existing, incoming)` used by PATCH: omitted ok, identical ok, changed/added/removed → ValidationError with field `configuration.<key>`.
- [ ] Implement both helpers (export from `backend/src/lib/investigationKind.js`, new) and call them from POST (after `resolveV27Pipeline`) and from `patchScanIfPresent` where configuration is merged.
- [ ] Run backend: `npm test`, `npm run lint`, `npm run format:check`.

## Track B — Frontend descriptors and scan settings (Agent B)

Files: `frontend/src/lib/fieldDefinitions.js` (new), `frontend/src/lib/keys.js`, `frontend/src/components/SchemaEditor.jsx`, `frontend/src/pages/WorkflowBuilder.jsx`, `frontend/src/pages/PostScriptEditor.jsx`, `frontend/src/lib/investigationKind.js` (new), `frontend/src/pages/CreateScan.jsx`, `frontend/src/pages/ScanDetail.jsx` (run settings rows only, around the `RuntimeSetting` grid), tests `frontend/src/lib/fieldDefinitions.test.js`, `frontend/src/lib/investigationKind.test.js`, `frontend/src/components/SchemaEditor.test.jsx`, `frontend/src/pages/CreateScan.test.jsx`.

### Task B1: fieldDefinitions + keys

- [ ] Test against the shared fixture (import with `readFileSync` + `JSON.parse` from `../../../test-fixtures/output-format-descriptors.json`). Test `objectToRows` marks structured rows and `rowsToObject` round-trips definitions.
- [ ] Implement. `FIELD_TYPES` in `keys.js` becomes the five types (adds `object`, which the backend already accepted).

### Task B2: SchemaEditor structured rows

- [ ] Test (static markup): a structured row renders `array<object>` with a `structured` badge and a disabled type select; raw mode JSON includes the descriptor.
- [ ] Implement; `WorkflowBuilder.fieldError` and `PostScriptEditor.schemaValid` use `validateFieldDefinition` and `isReservedOutputKey`.

### Task B3: investigation kind in create scan and run settings

- [ ] Tests: `investigationKindRecommendation({ bug_bounty_url: 'x' })` → `public_bounty` with reason mentioning the bounty URL; `{}` → `internal_research`; `investigationConfiguration('private_audit', 'v2.7-impact-gate-1')` → three keys with source `user`. CreateScan: export a pure `createScanBlockedReason(form, selectedWorkflow, ...)` (or extend the existing blocked-label logic into an exported helper) and assert gated workflow + no kind → `'Choose the investigation kind'`.
- [ ] Implement: select rendered in section 5 (extras) when `selectedWorkflow.readinessGate`; no default value; hint line; `canCreate` requires `form.investigation_kind` for gated workflows; on submit merge `investigationConfiguration(...)` into `configuration`. ScanDetail run settings: `RuntimeSetting label="investigation"` showing `${kind} · ${source === 'legacy_default' ? 'legacy default' : version}` when `scan.configuration.investigation_kind` or when `scan.workflowReadinessGate` (read from `scan.configuration.readiness_policy_version`).
- [ ] Run `npm test -- --run`, `npm run lint`, `npm run format:check`, `npm run build`.

## Track C — Engine (Agent C)

Files: `engine/open_kritt_engine/schema.py`, `engine/open_kritt_engine/generation.py` (output-format checks only), `engine/open_kritt_engine/readiness_policies.py` (new), `engine/open_kritt_engine/impact_gate.py` (new), `engine/open_kritt_engine/poc_artifacts.py`, `engine/open_kritt_engine/v27_pipeline.py`, `engine/open_kritt_engine/post_processing.py` (D3–D5 section only, lines ~1085–1260), tests `engine/tests/test_schema.py` (new), `engine/tests/test_readiness_policies.py` (new), `engine/tests/test_impact_gate.py` (new), `engine/tests/test_poc_artifacts.py`, `engine/tests/test_v27_pipeline.py`, `engine/tests/fixtures/impact/*.json` (new, ten cross-family cases), `engine/tests/test_impact_fixtures.py` (new).

### Task C1: schema.py nested descriptors

- [ ] `test_schema.py`: iterate the shared fixture (`Path(__file__).parents[2] / "test-fixtures" / ...`) for both `cases` (validate_field_definition first error startswith errorPath) and `payloadCases` (`validate_payload` on `{"_kritt_extractor_helper": True, "stub": False, "stub_explanation": "", "results": [result]}`); reserved keys; `strip_reserved_keys`.
- [ ] Implement per interface. `generation.py` output-format checks call `validate_field_definition` instead of `value_type not in WORKFLOW_FIELD_TYPES`.

### Task C2: readiness_policies.py — table tests for every kind row and family; unknown version raises.

### Task C3: impact_gate.py

- [ ] Tests: the twelve spec cases (spec §9 list), hop superset rules (renamed/dropped D3 hop fails; added D4 hop allowed), `not_applicable` without assessment fails, `proven` without `evidence_paths` fails, provenance rejects paths absent from manifest, absolute, or `..`, dimension coverage with `not_applicable` needing rationale and unknown tags rejected, unsupported version blocks, legacy scan blocks with the exact reason string, `evaluated_at` echoed, policy-version stability (same inputs → identical block), `normalize_missing_requirements` four cases, `lifecycle_status` for every branch, `synthesize_legacy_blocks` for D4 `poc_status: reproduced` → `bug_status reproduced, impact_status unverified, legacy True`.
- [ ] Implement.

### Task C4: poc_artifacts.capture_evidence — union/dedupe, cap overflow → incomplete without copying, symlink resolved inside workspace, traversal rejected, manifest names returned.

### Task C5: pipeline integration

- [ ] Tests with a `FakePostDb` (pattern in `engine/tests/test_engine.py` ~line 3282): after D3 the upserted result contains `_engine_lifecycle`; after D4 `_engine_evidence` and model fields untouched (no `poc_status` rewrite); after D5 `_engine_readiness`, `model_readiness_claim`, `_chip_lifecycle`; a payload containing `_engine_readiness` from the model is stripped; D5 eligibility condition (`v27_pipeline.d5_eligibility_sql()`) references `_engine_evidence` keys and is built from `impact_gate` constants.
- [ ] Implement in `v27_pipeline.py` + `post_processing.py`: replace `finalize_poc_result` call with `capture_evidence` + `evidence_block`; replace `enforce_report_readiness` with `evaluate_readiness(..., evaluated_at=now_utc().isoformat())`; sanitize with `strip_reserved_keys` before upsert; SQL for D5 uses `result->'_engine_evidence'->>'bug_status' = 'reproduced'` and `impact_status IN (...)` and `capture_complete = 'true'`.

### Task C6: cross-family fixtures — ten JSON files `{name, scan, d3, d4, manifest, d5, expected: {lifecycle_status, ready}}` per spec §9, one parametrized test.

- [ ] Run `ruff check .`, `ruff format .`, `pytest`.

## Track D — Post-scripts, pack test, docs (Agent D)

Files: `workflow-packs/web3-v2.7/post-scripts/*.json`, `workflow-packs/web3-v2.7/README.md`, `scripts/web3-v2.7-workflow.test.mjs`, `docs-site/post-scripts/structured-output-fields.mdx` (new), `docs-site/scans/investigation-kind-and-readiness.mdx` (new), `docs-site/docs.json`, `docs-site/scan-results/how-to-view.mdx`, `AGENTS.md`.

### Task D1: rewrite D3/D4/D5 post-script JSON per spec §5 (descriptors from spec 3.1, enums, prompts with the D3 rules, D4 separation, D5 comparison). Names unchanged.
### Task D2: structural test asserts new fields/enums, no reserved keys, no program names; note it depends on Track A's `validatePostScript` accepting descriptors — run it last.
### Task D3: docs pages + nav + AGENTS.md gotcha; `cd docs-site && npm run check-links`.

## Track E — Backend read-time and exports (Agent E, after A and C)

Files: `backend/src/lib/impactReadiness.js` (new), `backend/src/lib/serialize.js` (vulnerability + enrichment), `backend/src/lib/findingExport.js`, tests `backend/test/impactReadiness.test.js` (new), `backend/test/findingExport.test.js`, `backend/test/scanPresentation.test.js`.

- Legacy synthesis mirrors `impact_gate.synthesize_legacy_blocks` exactly (same statuses, same reason string). Exports per spec §8.

## Track F — Frontend evidence card and graph (Agent F, after B and E)

Files: `frontend/src/components/EvidenceCard.jsx` (new) + test, `frontend/src/pages/VulnerabilityPage.jsx` (mount card above post-script cards; `PostScriptCard` filters `_engine_*`, `model_readiness_claim`, `_chip_lifecycle`), `frontend/src/components/ScanGraph.jsx` (dotted outcome paths `_engine_lifecycle.lifecycle_status`) + test.

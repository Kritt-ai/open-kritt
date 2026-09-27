// Read-time readiness for the v2.7 evidence-to-impact gate (spec 4.4, 6.2, 7).
//
// The engine owns the readiness decision and writes `_engine_lifecycle` (D3),
// `_engine_evidence` (D4) and `_engine_readiness` (D5) beside the model's
// fields. Historical results predate those blocks, so this module synthesizes
// the same blocks at read time with `legacy: true` (mirroring the engine's
// `synthesize_legacy_blocks`), never rewrites stored rows, and never
// re-evaluates policy. It is the single source for the finding API and the
// findings export.

import { INVESTIGATION_KINDS } from './investigationKind.js';
import { READINESS_POLICY_VERSION } from './v27Pipeline.js';

export { INVESTIGATION_KINDS, READINESS_POLICY_VERSION };
export const LEGACY_POLICY_VERSION = 'legacy-unverified';
export const PIPELINE_STAGES = Object.freeze(['d3', 'd4', 'd5']);
export const LEGACY_KIND_REASON =
  'Investigation kind and readiness policy were not explicitly selected when this legacy scan was created.';
export const LEGACY_RESULT_REASON = 'Legacy result without structured impact evidence.';

const DEFAULT_KIND = 'internal_research';
const SUBMISSION_READY_KINDS = new Set(['public_bounty', 'audit_competition']);
const D3_PASS_VERDICTS = new Set(['confirmed', 'plausible_needs_poc']);
const D4_BUG_STATUSES = new Set(['reproduced', 'not_reproduced', 'blocked', 'falsified']);
const D4_NOT_REPRODUCED = new Set(['not_reproduced', 'invalidated_by_test']);
const D4_BLOCKED = new Set(['unsafe_external_dependency', 'non_deterministic']);
const BUG_LIFECYCLE = Object.freeze({
  reproduced: 'legacy_bug_reproduced_impact_unverified',
  not_reproduced: 'bug_not_reproduced',
  blocked: 'bug_blocked',
  falsified: 'bug_falsified',
});

const record = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const idString = (value) => (value === null || value === undefined ? '' : `${value}`);

// Spec 4.4: a scan without the keys is interpreted, never rewritten, as the
// legacy internal-research snapshot.
export function investigationSettings(scan) {
  const configuration = record(scan?.configuration) || {};
  const kind = configuration.investigation_kind;
  const explicit = INVESTIGATION_KINDS.includes(kind) && configuration.investigation_kind_source === 'user';
  if (!explicit) {
    return {
      investigation_kind: DEFAULT_KIND,
      investigation_kind_source: 'legacy_default',
      readiness_policy_version: LEGACY_POLICY_VERSION,
    };
  }
  const version = configuration.readiness_policy_version;
  return {
    investigation_kind: kind,
    investigation_kind_source: 'user',
    readiness_policy_version: typeof version === 'string' && version ? version : READINESS_POLICY_VERSION,
  };
}

export function readinessLabelForKind(kind) {
  return SUBMISSION_READY_KINDS.has(kind) ? 'submission_ready' : 'report_ready';
}

// Mirrors the engine's `pipeline_ids`: three distinct positive ids or nothing.
export function pipelineStages(scan) {
  const raw = record(record(scan?.configuration)?.v27_pipeline);
  if (!raw) return null;
  const ids = {};
  for (const stage of PIPELINE_STAGES) {
    const text = idString(raw[stage]);
    if (!/^[1-9]\d*$/.test(text)) return null;
    ids[stage] = text;
  }
  return new Set(Object.values(ids)).size === PIPELINE_STAGES.length ? ids : null;
}

export function stageForEnrichment(enrichment, scan) {
  const stages = pipelineStages(scan);
  if (!stages) return null;
  const id = idString(enrichment?.postScriptId);
  return PIPELINE_STAGES.find((stage) => stages[stage] === id) ?? null;
}

// Spec 5.4: missing/empty string -> [], string -> [string], string[] -> as is.
export function normalizeMissingRequirements(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string') return value.trim() ? [value] : [];
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) return [...value];
  throw new TypeError('missing_requirements must be a string or an array of strings.');
}

// Historical rows may hold shapes the strict rule rejects; read paths coerce
// them to strings instead of failing the whole finding.
function lenientMissingRequirements(value) {
  try {
    return normalizeMissingRequirements(value);
  } catch {
    const entries = Array.isArray(value) ? value : [value];
    return entries.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)));
  }
}

function legacyLifecycle(result) {
  const verdict = result.verdict;
  return {
    lifecycle_status: D3_PASS_VERDICTS.has(verdict)
      ? 'code_confirmed'
      : verdict === 'false_positive'
        ? 'false_positive'
        : 'not_advanced',
    policy_version: LEGACY_POLICY_VERSION,
    legacy: true,
  };
}

function legacyBugStatus(result) {
  if (D4_BUG_STATUSES.has(result.bug_status)) return result.bug_status;
  const status = typeof result.poc_status === 'string' ? result.poc_status : '';
  if (status === 'reproduced') return 'reproduced';
  if (D4_NOT_REPRODUCED.has(status)) return 'not_reproduced';
  if (status.startsWith('blocked_') || D4_BLOCKED.has(status)) return 'blocked';
  return 'not_reproduced';
}

function legacyEvidence(result) {
  const bugStatus = legacyBugStatus(result);
  return {
    bug_status: bugStatus,
    impact_status: 'unverified',
    capture_complete: false,
    artifact_dir: typeof result.poc_artifact_dir === 'string' ? result.poc_artifact_dir : '',
    captured_paths: [],
    unresolved_paths: [],
    lifecycle_status: BUG_LIFECYCLE[bugStatus],
    policy_version: LEGACY_POLICY_VERSION,
    legacy: true,
  };
}

function legacyReadiness(scan, prior) {
  const settings = investigationSettings(scan);
  const evidence = record(record(prior?.d4)?._engine_evidence);
  return {
    ready: false,
    label: readinessLabelForKind(settings.investigation_kind),
    lifecycle_status: typeof evidence?.lifecycle_status === 'string' ? evidence.lifecycle_status : 'code_confirmed',
    blocking_reasons: [settings.investigation_kind_source === 'user' ? LEGACY_RESULT_REASON : LEGACY_KIND_REASON],
    checks: {},
    policy: settings.investigation_kind,
    policy_version: LEGACY_POLICY_VERSION,
    evaluated_at: null,
    legacy: true,
  };
}

// Returns the enrichment's result with the engine block for its stage present:
// persisted blocks verbatim, otherwise a synthesized legacy block. Enrichments
// outside the pipeline, stubs, and non-object results come back unchanged. The
// input is never mutated. `prior` carries earlier stage results (already passed
// through this function) so a legacy D5 decision can report the D4 lifecycle.
export function withEngineBlocks(enrichment, { stage, scan, prior = {} } = {}) {
  const result = enrichment?.result;
  if (!record(result) || enrichment.stub) return result;
  const resolved = stage ?? stageForEnrichment(enrichment, scan);
  if (resolved === 'd3') {
    return record(result._engine_lifecycle) ? result : { ...result, _engine_lifecycle: legacyLifecycle(result) };
  }
  if (resolved === 'd4') {
    return record(result._engine_evidence) ? result : { ...result, _engine_evidence: legacyEvidence(result) };
  }
  if (resolved === 'd5') {
    const output = { ...result, missing_requirements: lenientMissingRequirements(result.missing_requirements) };
    if (!record(result._engine_readiness)) {
      output._engine_readiness = legacyReadiness(scan, prior);
      output.model_readiness_claim = result.submission_ready === true;
    }
    return output;
  }
  return result;
}

// Latest non-stub result per pipeline stage, each with its engine block.
export function findingStageResults(vulnerability, scan) {
  const stages = {};
  if (!pipelineStages(scan)) return stages;
  const latest = {};
  for (const enrichment of vulnerability?.enrichments || []) {
    if (enrichment?.stub || !record(enrichment?.result)) continue;
    const stage = stageForEnrichment(enrichment, scan);
    if (stage) latest[stage] = enrichment;
  }
  for (const stage of PIPELINE_STAGES) {
    if (latest[stage]) stages[stage] = withEngineBlocks(latest[stage], { stage, scan, prior: stages });
  }
  return stages;
}

const STAGE_LABEL = Object.freeze({ d3: 'D3', d4: 'D4' });

// Readiness summary from the latest stage present (D5 > D4 > D3); null when
// the finding has no pipeline stage.
export function findingReadiness(vulnerability, scan) {
  const stages = findingStageResults(vulnerability, scan);
  const stage = [...PIPELINE_STAGES].reverse().find((candidate) => stages[candidate]);
  if (!stage) return null;
  const lifecycle = record(stages.d3?._engine_lifecycle);
  const evidence = record(stages.d4?._engine_evidence);
  const readiness = record(stages.d5?._engine_readiness);
  const label = readinessLabelForKind(investigationSettings(scan).investigation_kind);
  if (stage === 'd5' && readiness) {
    return {
      stage,
      ready: readiness.ready === true,
      label: typeof readiness.label === 'string' ? readiness.label : label,
      lifecycleStatus: readiness.lifecycle_status ?? null,
      policyVersion: readiness.policy_version ?? null,
      legacy: readiness.legacy === true,
      blockingReasons: Array.isArray(readiness.blocking_reasons) ? [...readiness.blocking_reasons] : [],
      evidence,
      lifecycle,
      readiness,
    };
  }
  const block = stage === 'd4' ? evidence : lifecycle;
  const lifecycleStatus = block?.lifecycle_status ?? null;
  return {
    stage,
    ready: false,
    label,
    lifecycleStatus,
    policyVersion: block?.policy_version ?? null,
    legacy: block?.legacy === true,
    blockingReasons: [
      `Readiness was not evaluated: the pipeline ended at ${STAGE_LABEL[stage]} with lifecycle "${lifecycleStatus ?? 'unknown'}".`,
    ],
    evidence,
    lifecycle,
    readiness: null,
  };
}

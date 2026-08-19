// Shared read helpers that assemble the denormalized shapes the UI needs
// (workflows + their steps, scans + finding counts, etc.).

import { prisma } from '../db.js';
import { serializeWorkflow, serializeScan, timeAgo } from './serialize.js';
import { isDefaultWorkflowName } from './defaultWorkflows.js';

const PHASE_LABELS = {
  building_workspace: 'Building workspace',
  running_harness: 'Running harness',
  writing_db: 'Writing to DB',
  completed: 'Completed',
  failed: 'Failed',
  queued: 'Queued',
  pending: 'Pending',
  rate_limited: 'Rate limited',
  prewarming_cache: 'Prewarming cache',
  running: 'Running',
  post_processing: 'Post-processing',
  paused: 'Paused',
};

const CYBER_RISK_FLAG_TEXT =
  'This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request. To get authorized for security work, join the Trusted Access for Cyber program';
const CYBER_RISK_FIX_LINKS = [
  { label: 'ChatGPT cyber access', url: 'https://chatgpt.com/cyber' },
  {
    label: 'Enterprise trusted access',
    url: 'https://openai.com/form/enterprise-trusted-access-for-cyber/',
  },
];
const OPENROUTER_LIMIT_FIX_LINKS = [
  { label: 'View usage and limits in Accounts', url: '/accounts', internal: true },
  { label: 'OpenRouter keys', url: 'https://openrouter.ai/settings/keys' },
  {
    label: 'OpenRouter credits',
    url: 'https://openrouter.ai/settings/credits',
  },
  {
    label: 'Limits docs',
    url: 'https://openrouter.ai/docs/api/reference/limits',
  },
];

// Fetch steps for a set of ids and return a Map keyed by string id.
export async function loadStepsMap(stepIds) {
  const ids = [...new Set(stepIds.map((x) => BigInt(x)))];
  if (ids.length === 0) return new Map();
  const steps = await prisma.step.findMany({ where: { id: { in: ids } } });
  return new Map(steps.map((s) => [s.id.toString(), s]));
}

// scanCount + lastUsed per workflow id.
export async function workflowScanMeta() {
  const grouped = await prisma.scan.groupBy({
    by: ['workflowId'],
    _count: { _all: true },
    _max: { insertedAt: true },
  });
  const map = new Map();
  for (const g of grouped) {
    map.set(g.workflowId.toString(), {
      scanCount: g._count._all,
      lastUsed: timeAgo(g._max.insertedAt),
    });
  }
  return map;
}

export async function assembleWorkflows(workflows) {
  const allStepIds = workflows.flatMap((w) => w.stepIds || []);
  const stepsMap = await loadStepsMap(allStepIds);
  const meta = await workflowScanMeta();
  return workflows.map((w) => {
    const steps = (w.stepIds || []).map((id) => stepsMap.get(id.toString())).filter(Boolean);
    const m = meta.get(w.id.toString()) || { scanCount: 0, lastUsed: null };
    return serializeWorkflow(w, steps, {
      ...m,
      isDefault: isDefaultWorkflowName(w.name),
    });
  });
}

export async function assembleWorkflow(workflow) {
  const [assembled] = await assembleWorkflows([workflow]);
  return assembled;
}

// Raw, listed/canonical, duplicate, and exploitable counts per scan id. The
// findings endpoint hides duplicates, so `findings` deliberately matches the
// number of rows a user can open rather than the number of raw candidates.
export async function findingCountsByScan(scanIds) {
  const ids = scanIds.map((x) => BigInt(x));
  const empty = () => ({
    findings: 0,
    rawCandidates: 0,
    canonicalFindings: 0,
    duplicateFindings: 0,
    unprocessedFindings: 0,
    exploitable: 0,
  });
  const map = new Map(scanIds.map((id) => [id.toString(), empty()]));
  if (ids.length === 0) return map;
  const vulns = await prisma.vulnerability.findMany({
    where: { scanId: { in: ids } },
    select: { scanId: true, jsonAnswer: true, dedupeIsCanonical: true },
  });
  for (const v of vulns) {
    const entry = map.get(v.scanId.toString());
    if (!entry) continue;
    entry.rawCandidates += 1;
    if (v.dedupeIsCanonical === false) {
      entry.duplicateFindings += 1;
      continue;
    }
    entry.findings += 1;
    if (v.dedupeIsCanonical === true) entry.canonicalFindings += 1;
    else entry.unprocessedFindings += 1;
    const ex = v.jsonAnswer && typeof v.jsonAnswer === 'object' ? v.jsonAnswer.exploitable : null;
    if (ex === true || ex === 'true') entry.exploitable += 1;
  }
  return map;
}

export function configuredPostScriptIds(scan) {
  const ids = [];
  const add = (value) => {
    const id = value && typeof value === 'object' ? value.id : value;
    const text = `${id ?? ''}`.trim();
    if (/^\d+$/.test(text) && !ids.includes(text)) ids.push(text);
  };
  add(scan.postScriptId);
  const configuration =
    scan.configuration && typeof scan.configuration === 'object' && !Array.isArray(scan.configuration)
      ? scan.configuration
      : {};
  let configured = configuration.post_script_ids ?? configuration.post_scripts ?? [];
  if (typeof configured === 'string') {
    try {
      configured = JSON.parse(configured);
    } catch {
      configured = configured.split(',');
    }
  }
  if (Array.isArray(configured)) configured.forEach(add);
  return ids;
}

export function configuredAgentSkillIds(scan) {
  const ids = [];
  const add = (value) => {
    const id = value && typeof value === 'object' ? value.id : value;
    const text = `${id ?? ''}`.trim();
    if (/^\d+$/.test(text) && !ids.includes(text)) ids.push(text);
  };
  const direct = scan.agentSkillIds ?? scan.agent_skill_ids ?? [];
  if (Array.isArray(direct)) direct.forEach(add);
  const configuration =
    scan.configuration && typeof scan.configuration === 'object' && !Array.isArray(scan.configuration)
      ? scan.configuration
      : {};
  let configured = configuration.agent_skill_ids ?? configuration.agent_skills ?? [];
  if (typeof configured === 'string') {
    try {
      configured = JSON.parse(configured);
    } catch {
      configured = configured.split(',');
    }
  }
  if (Array.isArray(configured)) configured.forEach(add);
  return ids;
}

function repeatRuns(scan) {
  const configuration =
    scan.configuration && typeof scan.configuration === 'object' && !Array.isArray(scan.configuration)
      ? scan.configuration
      : {};
  const parsed = Number.parseInt(configuration.repeat_runs ?? 1, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : 1;
}

function lineageKey(stepId, prevId, prevTable, repeatRun) {
  return `${stepId}|${prevId || 0}|${prevTable || ''}|${repeatRun || 1}`;
}

// Reconstruct the final reachable lineage graph for progress reporting. Every
// concrete step/input task has its own sequential repeat series; its accumulated
// output reaches the next depth only after all configured repeats complete.
export function summarizeExpectedWorkflowLineages(scan, steps, metadata, results) {
  const completed = new Set(
    metadata
      .filter((row) => (row.kind || 'step') === 'step' && row.status === 'completed')
      .map((row) => lineageKey(row.stepId, row.prevId, row.prevTable, row.repeatRun))
  );
  const resultsByLineage = new Map();
  for (const row of results) {
    const key = lineageKey(row.stepId, row.prevId, row.prevTable, row.repeatRun);
    if (!resultsByLineage.has(key)) resultsByLineage.set(key, []);
    resultsByLineage.get(key).push(row);
  }

  const depths = [...new Set(steps.map((step) => step.depth))].sort((a, b) => a - b);
  const byDepth = new Map(depths.map((depth) => [depth, steps.filter((step) => step.depth === depth)]));
  const runs = Array.from({ length: repeatRuns(scan) }, (_, index) => index + 1);
  let states = [{ prevId: 0, prevTable: null, sourceStepId: null }];
  let previousDepthComplete = true;
  const expected = new Set();

  for (const depth of depths) {
    const depthSteps = byDepth.get(depth) || [];
    const consumesAll = depth > 0 && depthSteps.length > 0 && depthSteps.every((step) => step.consumesAll);
    const nextStates = [];
    let depthComplete = previousDepthComplete;
    let inputStates = states;
    if (consumesAll) {
      inputStates = previousDepthComplete && states.length ? [{ prevId: 0, prevTable: null, sourceStepId: null }] : [];
    }

    for (const step of depthSteps) {
      const routedStates = step.boundSourceStepId
        ? inputStates.filter((state) => `${state.sourceStepId ?? ''}` === `${step.boundSourceStepId}`)
        : inputStates;
      for (const state of routedStates) {
        let taskComplete = true;
        const taskResults = [];
        for (const repeatRun of runs) {
          const key = lineageKey(step.id, state.prevId, state.prevTable, repeatRun);
          expected.add(key);
          if (!completed.has(key)) {
            taskComplete = false;
            depthComplete = false;
            continue;
          }
          taskResults.push(...(resultsByLineage.get(key) || []));
        }
        if (!taskComplete || step.isLastStep) continue;
        for (const row of taskResults) {
          nextStates.push({
            prevId: row.id,
            prevTable: 'workflows.step_results',
            sourceStepId: step.id,
          });
        }
      }
    }
    states = nextStates;
    previousDepthComplete = depthComplete;
  }

  let completedLineages = 0;
  for (const key of expected) if (completed.has(key)) completedLineages += 1;
  return { expectedLineages: expected.size, completedLineages };
}

// Best-effort progress for running scans, derived from step_results partitions.
async function runningProgress(scan, statusSummary) {
  if (scan.status === 'prewarming_cache') {
    return {
      progress: '8%',
      progressLabel: 'prewarming checkout cache…',
    };
  }
  if (scan.status === 'post_processing') {
    const [total, done] = await Promise.all([
      prisma.postProcessMetadata.count({ where: { scanId: scan.id } }),
      prisma.postProcessMetadata.count({
        where: { scanId: scan.id, status: 'completed' },
      }),
    ]);
    return {
      progress: total ? `${Math.min(100, Math.round((done / total) * 100))}%` : '70%',
      progressLabel: total ? `post-processing ${done} / ${total}` : 'post-processing…',
    };
  }
  if (scan.status !== 'running') return { progress: null, progressLabel: null };
  const expected = statusSummary?.expectedStepLineages || 0;
  const done = statusSummary?.completedStepLineages || 0;
  if (!expected) return { progress: null, progressLabel: 'discovering workflow lineages…' };
  const pct = Math.min(100, Math.round((done / expected) * 100));
  return {
    progress: `${pct}%`,
    progressLabel: `${done} / ${expected} workflow lineages`,
  };
}

function phaseLabel(phase) {
  return (
    PHASE_LABELS[phase] ||
    String(phase || 'unknown')
      .replaceAll('_', ' ')
      .replace(/\b\w/g, (m) => m.toUpperCase())
  );
}

function effectivePhase(row) {
  if (['completed', 'failed', 'paused', 'pending'].includes(row.status)) return row.status;
  return row.phase || (row.status === 'running' ? 'running_harness' : row.status || 'unknown');
}

function compactError(value) {
  if (!value) return null;
  const compact = String(value).split(/\s+/).join(' ').trim();
  return compact || null;
}

export function isDerivativeScanStatusError(value) {
  const compact = compactError(value);
  return Boolean(compact && /^scan became [a-z_]+ before harness started$/i.test(compact));
}

export function orderScanErrorsForDisplay(errors) {
  const priority = (error) => {
    if (error.previousRun) return 0;
    if (error.kind === 'scan' && error.status === 'failed') return 3;
    if (error.knownError) return 2;
    if (error.status === 'failed') return 1;
    return 0;
  };
  const timestamp = (error) => new Date(error.updatedAt || error.insertedAt || 0).getTime() || 0;
  return [...errors].sort((a, b) => priority(b) - priority(a) || timestamp(b) - timestamp(a));
}

export function knownError(value) {
  const compact = compactError(value);
  if (!compact) return null;
  const lower = compact.toLowerCase();
  if (lower.includes('no space left on device') || lower.includes('enospc')) {
    return {
      key: 'engine_storage_full',
      title: 'Engine storage full',
      message:
        'The scanner ran out of disk space while creating a job workspace. Free local disk space, then resume the scan.',
    };
  }
  if (lower.includes('cannot set path in scalar')) {
    return {
      key: 'storage_warning_persistence_failed',
      title: 'Low-storage pause failed',
      message:
        'The engine ran low on disk space, then could not save its automatic pause warning. Free disk space, lower Minimum free storage, or enable Ignore low-storage safeguard in Settings, then resume the scan; completed work is preserved.',
      fixLinks: [{ label: 'Open Settings', url: '/settings', internal: true }],
    };
  }
  if (
    compact.includes(CYBER_RISK_FLAG_TEXT) ||
    lower.includes('openai has flagged these tasks as unauthorized') ||
    lower.includes('diagnostic: cyber_safety_blocked') ||
    lower.includes('cybersecurity safety policy')
  ) {
    return {
      key: 'openai_cyber_access_blocked',
      title: 'Cyber access blocked',
      message: 'OpenAI blocked this security task. Request cyber access or run the scan on another provider/model.',
      fixLinks: CYBER_RISK_FIX_LINKS,
    };
  }
  if (
    lower.includes('key limit exceeded (total limit)') &&
    (lower.includes('openrouter') || lower.includes('api error: 403'))
  ) {
    return {
      key: 'openrouter_key_limit_exceeded',
      title: 'OpenRouter key limit exceeded',
      message:
        'This OpenRouter API key hit its total credit limit. Raise or remove the key limit, add credits, or switch keys before resuming.',
      fixLinks: OPENROUTER_LIMIT_FIX_LINKS,
    };
  }
  if (lower.includes('this request requires more credits, or fewer max_tokens') && lower.includes('openrouter')) {
    return {
      key: 'openrouter_credit_or_token_limit',
      title: 'OpenRouter credits or key limit too low',
      message:
        'OpenRouter rejected the request because the key/account budget is too low for the requested output. Add credits, raise the key limit, or lower max tokens.',
      fixLinks: OPENROUTER_LIMIT_FIX_LINKS,
    };
  }
  if (
    lower.includes('reconnect claude in accounts') ||
    (lower.includes('claude') && lower.includes('oauth credential') && lower.includes('refresh'))
  ) {
    return {
      key: 'claude_reconnect_required',
      title: 'Claude sign-in required',
      message: 'Claude could not renew the saved login. Reconnect Claude in Accounts, then resume the scan.',
      fixLinks: [{ label: 'Open Accounts', url: '/accounts', internal: true }],
    };
  }
  if (lower.includes('diagnostic: model_capacity') || lower.includes('selected model is currently at capacity')) {
    return {
      key: 'model_capacity',
      title: 'Model at capacity',
      message: 'The selected model had no available capacity. Wait and resume, or choose another model.',
      preserveMessage: true,
    };
  }
  if (lower.includes('diagnostic: provider_throttled')) {
    return {
      key: 'provider_throttled',
      title: 'Provider busy',
      message:
        'The provider temporarily throttled server capacity. This did not mean the account usage quota was exhausted.',
      preserveMessage: true,
    };
  }
  if (lower.includes('diagnostic: subagent_limited')) {
    return {
      key: 'subagent_limited',
      title: 'Subagent limit reached',
      message:
        "Codex reached a separate premium limit while starting a subagent. The account's normal usage quota may still be available.",
      preserveMessage: true,
    };
  }
  if (lower.includes('diagnostic: account_quota_limited')) {
    return {
      key: 'account_quota_limited',
      title: 'Account quota exhausted',
      message: 'The provider reports that this account reached its usage quota. Wait for reset or use another account.',
      preserveMessage: true,
      fixLinks: [{ label: 'View usage and limits in Accounts', url: '/accounts', internal: true }],
    };
  }
  if (lower.includes('diagnostic: network_error') || lower.includes('dns lookup failed')) {
    return {
      key: 'provider_network_error',
      title: 'Provider network failure',
      message: 'The engine could not reach the provider. Check its DNS and network connectivity, then resume.',
      preserveMessage: true,
    };
  }
  if (lower.includes('diagnostic: provider_rejected')) {
    return {
      key: 'provider_rejected',
      title: 'Provider rejected request',
      message: 'The provider rejected the request. Review the saved model output for its specific reason.',
      preserveMessage: true,
    };
  }
  if (lower.includes('diagnostic: model_process_error')) {
    return {
      key: 'model_process_error',
      title: 'Model process stopped',
      message: 'The model process stopped before returning a structured result. Review its saved output.',
      preserveMessage: true,
    };
  }
  return null;
}

export function cleanError(value) {
  const known = knownError(value);
  if (known?.preserveMessage) return compactError(value);
  if (known) return `${known.title}. ${known.message}`;
  return compactError(value);
}

export function activeJobElapsedMs(row = {}, phase = effectivePhase(row), now = Date.now()) {
  const recordedRunTime = Number(row.runTimeMs);
  if (phase === 'writing_db' && Number.isFinite(recordedRunTime) && recordedRunTime >= 0) {
    return recordedRunTime;
  }
  if (phase !== 'running_harness') return null;

  // updatedAt is refreshed when the metadata enters running_harness. Using
  // runStartedAt here would include workspace preparation and make the UI
  // report a much longer duration than the active model process.
  const harnessStartedAt = row.updatedAt || row.runStartedAt || row.insertedAt;
  if (!harnessStartedAt) return null;
  const startedAt = new Date(harnessStartedAt).getTime();
  if (!Number.isFinite(startedAt)) return null;
  return Math.max(0, now - startedAt);
}

export function errorIsFromPreviousRun(scan, error) {
  if (!scan?.lastResumedAt) return false;
  const resumedAt = new Date(scan.lastResumedAt).getTime();
  const errorAt = new Date(error?.startedAt || error?.insertedAt || error?.updatedAt || 0).getTime();
  return Number.isFinite(resumedAt) && Number.isFinite(errorAt) && errorAt < resumedAt;
}

function metadataKindLabel(row) {
  const kind = row.kind || 'step';
  if (kind === 'post_script' || kind === 'supplemental_post_script') return row.postScriptName || 'Post-script';
  if (kind === 'dedupe') return 'Dedupe';
  if (kind === 'ranker') return 'Ranker';
  return 'Workflow step';
}

function metadataTitle(row, stepsMap) {
  const kind = row.kind || 'step';
  if (kind !== 'step') {
    const label = metadataKindLabel(row);
    return row.batchIndex ? `${label} batch ${row.batchIndex}` : label;
  }
  const step = stepsMap.get(row.stepId.toString());
  return `${step?.depth ?? '?'} · ${step?.name || `Step ${row.stepId.toString()}`}`;
}

function runtimeValue(configuration, snakeKey, camelKey = snakeKey) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) return null;
  return configuration[snakeKey] || configuration[camelKey] || null;
}

export function activeJobRuntimeSelection(row = {}, step = null, scan = {}) {
  const kind = row.kind || 'step';
  const overrides = scan.modelOverrides;
  const override =
    kind === 'step' && step && overrides && typeof overrides === 'object' && !Array.isArray(overrides)
      ? overrides[String(step.depth)]
      : null;
  const postProcessingEffort =
    runtimeValue(scan.configuration, 'post_processing_thinking_effort', 'postProcessingThinkingEffort') ||
    scan.thinkingEffort;
  const postProcessingModel =
    runtimeValue(scan.configuration, 'post_processing_model', 'postProcessingModel') || scan.model;
  const postProcessingModelProvider =
    runtimeValue(scan.configuration, 'post_processing_model_provider', 'postProcessingModelProvider') ||
    scan.modelProvider;
  const postProcessingHarness =
    runtimeValue(scan.configuration, 'post_processing_harness', 'postProcessingHarness') || scan.harness;

  return {
    model: row.model || runtimeValue(override, 'model') || (kind === 'step' ? scan.model : postProcessingModel) || null,
    modelProvider:
      row.modelProvider ||
      runtimeValue(override, 'model_provider', 'modelProvider') ||
      (kind === 'step' ? scan.modelProvider : postProcessingModelProvider) ||
      null,
    harness:
      row.harness ||
      runtimeValue(override, 'harness') ||
      (kind === 'step' ? scan.harness : postProcessingHarness) ||
      null,
    thinkingEffort:
      row.thinkingEffort ||
      runtimeValue(override, 'thinking_effort', 'thinkingEffort') ||
      (kind === 'step' ? scan.thinkingEffort : postProcessingEffort) ||
      null,
  };
}

export function activeJobWorkflowDepth(row = {}, step = null) {
  if ((row.kind || 'step') !== 'step') return null;
  const depth = Number(step?.depth);
  return Number.isInteger(depth) && depth >= 0 ? depth : null;
}

function metadataJob(row, stepsMap, scan) {
  const phase = effectivePhase(row);
  const step = (row.kind || 'step') === 'step' ? stepsMap.get(row.stepId.toString()) : null;
  const runtime = activeJobRuntimeSelection(row, step, scan);
  return {
    id: row.id.toString(),
    metadataId: row.id.toString(),
    kind: row.kind || 'step',
    title: metadataTitle(row, stepsMap),
    source: metadataKindLabel(row),
    status: row.status,
    phase,
    phaseLabel: phaseLabel(phase),
    depth: activeJobWorkflowDepth(row, step),
    startedAt: row.runStartedAt || row.insertedAt,
    elapsedMs: activeJobElapsedMs(row, phase),
    runTimeMs: row.runTimeMs == null ? null : Number(row.runTimeMs),
    codexAccountEmail: row.codexAccountEmail || null,
    codexAccountId: row.codexAccountId || null,
    ...runtime,
  };
}

function metadataError(row, stepsMap, scan) {
  return {
    ...metadataJob(row, stepsMap, scan),
    message: cleanError(row.error),
    knownError: knownError(row.error),
    insertedAt: row.insertedAt,
    updatedAt: row.updatedAt,
  };
}

function scanReasoningError(scan) {
  const reasoning = scan.reasoning && typeof scan.reasoning === 'object' ? scan.reasoning : null;
  const message = cleanError(reasoning?.error || reasoning?.message);
  if (!message) return null;
  return {
    id: `scan-${scan.id.toString()}`,
    metadataId: null,
    kind: 'scan',
    title: 'Scan failure',
    source: 'Scan',
    status: scan.status,
    phase: scan.status,
    phaseLabel: phaseLabel(scan.status),
    message,
    knownError: knownError(reasoning?.error || reasoning?.message),
    insertedAt: scan.insertedAt,
    updatedAt: scan.updatedAt,
  };
}

function emptyStatusSummary(scan) {
  return {
    canResume: ['failed', 'paused', 'stopped'].includes(scan.status),
    totalAttempts: 0,
    completedAttempts: 0,
    runningAttempts: 0,
    failedAttempts: 0,
    currentFailedAttempts: 0,
    stepAttempts: 0,
    stepCompletedAttempts: 0,
    stepRunningAttempts: 0,
    stepFailedAttempts: 0,
    expectedStepLineages: 0,
    completedStepLineages: 0,
    postAttempts: 0,
    postCompletedAttempts: 0,
    postRunningAttempts: 0,
    postFailedAttempts: 0,
    activeJobCount: 0,
    activeJobs: [],
    latestError: null,
    recentErrors: [],
  };
}

async function statusSummariesByScan(scans, stepsMap, workflowsById) {
  const summaries = new Map(scans.map((scan) => [scan.id.toString(), emptyStatusSummary(scan)]));
  const scansById = new Map(scans.map((scan) => [scan.id.toString(), scan]));
  if (scans.length === 0) return summaries;

  const scanIds = scans.map((scan) => scan.id);
  const [countRows, activeRows, errorRows] = await Promise.all([
    prisma.stepMetadata.groupBy({
      by: ['scanId', 'kind', 'status'],
      where: { scanId: { in: scanIds } },
      _count: { _all: true },
    }),
    prisma.stepMetadata.findMany({
      where: { scanId: { in: scanIds }, status: 'running' },
      select: {
        id: true,
        scanId: true,
        kind: true,
        stepId: true,
        status: true,
        phase: true,
        postScriptName: true,
        batchIndex: true,
        runStartedAt: true,
        runTimeMs: true,
        codexAccountId: true,
        codexAccountEmail: true,
        model: true,
        modelProvider: true,
        harness: true,
        thinkingEffort: true,
        insertedAt: true,
        updatedAt: true,
      },
      orderBy: [{ runStartedAt: 'asc' }, { insertedAt: 'asc' }],
    }),
    prisma.stepMetadata.findMany({
      where: { scanId: { in: scanIds }, error: { not: null } },
      select: {
        id: true,
        scanId: true,
        kind: true,
        stepId: true,
        status: true,
        phase: true,
        error: true,
        postScriptName: true,
        batchIndex: true,
        runStartedAt: true,
        runTimeMs: true,
        codexAccountId: true,
        codexAccountEmail: true,
        model: true,
        modelProvider: true,
        harness: true,
        thinkingEffort: true,
        insertedAt: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: Math.max(200, scans.length * 5),
    }),
  ]);

  for (const row of countRows) {
    const summary = summaries.get(row.scanId.toString());
    if (!summary) continue;
    const count = row._count._all;
    const isPost = (row.kind || 'step') !== 'step';
    summary.totalAttempts += count;
    if (row.status === 'completed') summary.completedAttempts += count;
    if (row.status === 'running') summary.runningAttempts += count;
    if (row.status === 'failed') summary.failedAttempts += count;

    const prefix = isPost ? 'post' : 'step';
    summary[`${prefix}Attempts`] += count;
    if (row.status === 'completed') summary[`${prefix}CompletedAttempts`] += count;
    if (row.status === 'running') summary[`${prefix}RunningAttempts`] += count;
    if (row.status === 'failed') summary[`${prefix}FailedAttempts`] += count;
  }

  for (const row of activeRows) {
    const summary = summaries.get(row.scanId.toString());
    if (!summary) continue;
    const scan = scansById.get(row.scanId.toString());
    summary.activeJobs.push(metadataJob(row, stepsMap, scan));
  }

  for (const scan of scans) {
    const summary = summaries.get(scan.id.toString());
    const reasoningError = scanReasoningError(scan);
    if (reasoningError) summary.recentErrors.push(reasoningError);
  }

  for (const row of errorRows) {
    const summary = summaries.get(row.scanId.toString());
    if (isDerivativeScanStatusError(row.error)) continue;
    const scan = scansById.get(row.scanId.toString());
    const error = metadataError(row, stepsMap, scan);
    if (!summary || !error.message) continue;
    error.previousRun = errorIsFromPreviousRun(scan, error);
    if (!error.previousRun && row.status === 'failed') summary.currentFailedAttempts += 1;
    summary.recentErrors.push(error);
  }

  for (const summary of summaries.values()) {
    summary.activeJobCount = summary.activeJobs.length;
    summary.recentErrors = orderScanErrorsForDisplay(summary.recentErrors).slice(0, 5);
    summary.latestError = summary.recentErrors.find((error) => !error.previousRun) || null;
    summary.expectedStepLineages = summary.stepAttempts;
    summary.completedStepLineages = summary.stepCompletedAttempts;
  }

  const activeScans = scans.filter((scan) => ['running', 'rate_limited', 'paused', 'failed'].includes(scan.status));
  if (activeScans.length) {
    const activeIds = activeScans.map((scan) => scan.id);
    const [lineageMetadata, lineageResults] = await Promise.all([
      prisma.stepMetadata.findMany({
        where: { scanId: { in: activeIds }, kind: 'step' },
        select: {
          scanId: true,
          stepId: true,
          prevId: true,
          prevTable: true,
          repeatRun: true,
          kind: true,
          status: true,
        },
      }),
      prisma.stepResult.findMany({
        where: { scanId: { in: activeIds } },
        select: {
          id: true,
          scanId: true,
          stepId: true,
          prevId: true,
          prevTable: true,
          repeatRun: true,
        },
      }),
    ]);
    for (const scan of activeScans) {
      const workflow = workflowsById.get(scan.workflowId.toString());
      const steps = (workflow?.stepIds || []).map((id) => stepsMap.get(id.toString())).filter(Boolean);
      const lineages = summarizeExpectedWorkflowLineages(
        scan,
        steps,
        lineageMetadata.filter((row) => row.scanId === scan.id),
        lineageResults.filter((row) => row.scanId === scan.id)
      );
      const summary = summaries.get(scan.id.toString());
      summary.expectedStepLineages = lineages.expectedLineages;
      summary.completedStepLineages = lineages.completedLineages;
    }
  }

  return summaries;
}

export async function assembleScans(scans) {
  if (scans.length === 0) return [];
  const workflowIds = [...new Set(scans.map((s) => s.workflowId))];
  const postScriptIds = [...new Set(scans.flatMap((scan) => configuredPostScriptIds(scan)).map((id) => BigInt(id)))];
  const agentSkillIds = [...new Set(scans.flatMap((s) => s.agentSkillIds || []))];
  const [workflows, postScripts, agentSkills, counts] = await Promise.all([
    prisma.workflow.findMany({
      where: { id: { in: workflowIds } },
      select: { id: true, name: true, stepIds: true },
    }),
    prisma.postScript.findMany({
      where: { id: { in: postScriptIds } },
      select: { id: true, name: true },
    }),
    prisma.agentSkill.findMany({
      where: { id: { in: agentSkillIds } },
      select: {
        id: true,
        slug: true,
        name: true,
        sourceUrl: true,
        licenseSpdx: true,
      },
    }),
    findingCountsByScan(scans.map((s) => s.id)),
  ]);
  const wfMap = new Map(workflows.map((w) => [w.id.toString(), w]));
  const psMap = new Map(postScripts.map((p) => [p.id.toString(), p]));
  const skillMap = new Map(agentSkills.map((skill) => [skill.id.toString(), skill]));
  const stepsMap = await loadStepsMap(workflows.flatMap((w) => w.stepIds || []));
  const statusSummaries = await statusSummariesByScan(scans, stepsMap, wfMap);

  const out = [];
  for (const s of scans) {
    const wf = wfMap.get(s.workflowId.toString());
    const workflowSteps = (wf?.stepIds || []).map((id) => stepsMap.get(id.toString())).filter(Boolean);
    const workflowDepths = [...new Set(workflowSteps.map((step) => step.depth))].sort((left, right) => left - right);
    const ps = psMap.get(s.postScriptId.toString());
    const scanPostScripts = configuredPostScriptIds(s)
      .map((id) => psMap.get(id))
      .filter(Boolean);
    const scanSkills = (s.agentSkillIds || []).map((id) => skillMap.get(id.toString())).filter(Boolean);
    const c = counts.get(s.id.toString()) || {
      findings: 0,
      rawCandidates: 0,
      canonicalFindings: 0,
      duplicateFindings: 0,
      unprocessedFindings: 0,
      exploitable: 0,
    };
    const statusSummary = statusSummaries.get(s.id.toString());
    const prog = await runningProgress(s, statusSummary);
    out.push(
      serializeScan(s, {
        workflowName: wf?.name ?? null,
        workflowDepths,
        postScriptName: ps?.name ?? null,
        postScripts: scanPostScripts,
        agentSkills: scanSkills,
        findings: c.findings,
        rawCandidates: c.rawCandidates,
        canonicalFindings: c.canonicalFindings,
        duplicateFindings: c.duplicateFindings,
        unprocessedFindings: c.unprocessedFindings,
        exploitable: c.exploitable,
        progress: prog.progress,
        progressLabel: prog.progressLabel,
        statusSummary,
      })
    );
  }
  return out;
}

export async function assembleScan(scan) {
  const [assembled] = await assembleScans([scan]);
  return assembled;
}

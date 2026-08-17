// Helpers that turn raw DB rows into the clean JSON shapes the frontend consumes.

import {
  normalizeOutputFormat,
  extractExtraKeys,
  GENERATION_STATUSES,
  GENERATION_REQUEST_MAX_LENGTH,
} from './constants.js';
import { validateGeneratedPostScript, validateGeneratedWorkflow, ValidationError } from './validation.js';

// "2h ago" style relative time from a Date.
export function timeAgo(date) {
  if (!date) return null;
  const then = new Date(date).getTime();
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 45) return 'now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

function safeParseFormat(text) {
  try {
    return normalizeOutputFormat(text);
  } catch {
    return {};
  }
}

export function serializeStep(step) {
  return {
    id: step.id.toString(),
    name: step.name,
    depth: step.depth,
    multiOutput: step.multiOutput,
    consumesAll: step.consumesAll ?? false,
    isLast: step.isLastStep,
    content: step.content,
    outputFormat: safeParseFormat(step.outputFormat),
    outputTable: step.outputTable,
  };
}

export function serializeWorkflow(workflow, steps, { scanCount = 0, lastUsed = null, isDefault = false } = {}) {
  const ordered = [...steps].sort((a, b) => a.depth - b.depth || Number(a.id - b.id));
  const serializedSteps = ordered.map(serializeStep);
  const depths = [...new Set(serializedSteps.map((s) => s.depth))].sort((a, b) => a - b);
  // `extra` is authoritative from the step prompts: the distinct {{extra.<key>}}
  // sub-keys referenced anywhere in this workflow. We union with whatever is stored
  // on the row so it's always correct, even for workflows saved before this field.
  const fromSteps = [...new Set(ordered.flatMap((s) => extractExtraKeys(s.content)))];
  const extra = [...new Set([...(workflow.extra || []), ...fromSteps])];
  return {
    id: workflow.id.toString(),
    name: workflow.name,
    description: workflow.description ?? '',
    extra,
    stepIds: (workflow.stepIds || []).map((x) => x.toString()),
    stepCount: serializedSteps.length,
    depths,
    depthChips: depths.map((d) => {
      const cnt = serializedSteps.filter((s) => s.depth === d).length;
      return { depth: d, count: cnt, label: `d${d}${cnt > 1 ? ` ×${cnt}` : ''}` };
    }),
    steps: serializedSteps,
    scanCount,
    lastUsed,
    isDefault,
    insertedAt: workflow.insertedAt,
    updatedAt: workflow.updatedAt,
  };
}

export function serializePostScript(ps) {
  const outputFormat = safeParseFormat(ps.outputFormat);
  return {
    id: ps.id.toString(),
    name: ps.name,
    description: ps.description ?? '',
    content: ps.content,
    outputFormat,
    keys: Object.keys(outputFormat),
    insertedAt: ps.insertedAt,
    updatedAt: ps.updatedAt,
  };
}

function publicText(value, maxLength = 4000) {
  if (typeof value !== 'string') return null;
  const sanitized = [...value]
    .map((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && ![9, 10, 13].includes(code)) || code === 127 ? ' ' : character;
    })
    .join('');
  const text = sanitized.trim().slice(0, maxLength);
  return text || null;
}

function publicValidationErrors(value) {
  const source = Array.isArray(value) ? value : Array.isArray(value?.errors) ? value.errors : [];
  return source.slice(0, 25).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const message = publicText(item.message, 1000);
    if (!message) return [];
    return [{ field: publicText(item.field, 200) || 'result', message }];
  });
}

function normalizeGeneratedWorkflow(result) {
  const valid = validateGeneratedWorkflow(result);
  return {
    name: valid.name,
    description: valid.description ?? '',
    levels: valid.levels.map((level) => ({
      depth: level.depth,
      multiOutput: level.multiOutput,
      consumesAll: level.consumesAll,
      outputFormat: level.outputFormat,
      steps: level.steps.map((step) => ({
        name: typeof step?.name === 'string' ? step.name.trim() : '',
        content: step.content,
      })),
    })),
  };
}

function normalizeGeneratedPostScript(result) {
  const valid = validateGeneratedPostScript(result);
  return {
    name: valid.name,
    description: valid.description ?? '',
    content: valid.content,
    outputFormat: valid.outputFormat,
  };
}

export function validateGeneratedArtifact(kind, result) {
  try {
    if (kind === 'workflow') return { result: normalizeGeneratedWorkflow(result), errors: [] };
    if (kind === 'post_script') return { result: normalizeGeneratedPostScript(result), errors: [] };
    return { result: null, errors: [{ field: 'kind', message: 'Generation kind is invalid.' }] };
  } catch (error) {
    if (error instanceof ValidationError) return { result: null, errors: publicValidationErrors(error.errors) };
    return { result: null, errors: [{ field: 'result', message: 'Generated draft is invalid.' }] };
  }
}

export function serializeGeneration(generation) {
  const rawStatus = generation?.status;
  let status = GENERATION_STATUSES.includes(rawStatus) ? rawStatus : 'failed';
  let result = null;
  let error = status === 'failed' ? publicText(generation?.error) || 'Generation failed.' : null;
  let validationErrors = status === 'failed' ? publicValidationErrors(generation?.validationErrors) : [];

  if (status === 'completed') {
    const validated = validateGeneratedArtifact(generation?.kind, generation?.result);
    if (validated.errors.length) {
      status = 'failed';
      error = 'The generated draft did not satisfy the project rules.';
      validationErrors = validated.errors;
    } else {
      result = validated.result;
    }
  } else if (!GENERATION_STATUSES.includes(rawStatus)) {
    error = 'Generation entered an invalid state.';
  }

  return {
    id: generation.id.toString(),
    kind: generation.kind,
    request: publicText(generation.request, GENERATION_REQUEST_MAX_LENGTH) || '',
    status,
    model: generation.model,
    modelProvider: generation.modelProvider,
    harness: generation.harness,
    thinkingEffort: generation.thinkingEffort,
    result,
    error,
    validationErrors,
    runStartedAt: generation.runStartedAt ?? null,
    completedAt: generation.completedAt ?? null,
    insertedAt: generation.insertedAt,
    updatedAt: generation.updatedAt,
  };
}

export function serializeAgentSkill(skill) {
  return {
    id: skill.id.toString(),
    slug: skill.slug,
    name: skill.name,
    description: skill.description ?? '',
    content: skill.content,
    sourceUrl: skill.sourceUrl ?? null,
    licenseSpdx: skill.licenseSpdx ?? null,
    attribution: skill.attribution ?? null,
    insertedAt: skill.insertedAt,
    updatedAt: skill.updatedAt,
  };
}

export function serializeSeverityRanker(r, { isDefault = false } = {}) {
  return {
    id: r.id.toString(),
    name: r.name,
    description: r.description ?? '',
    content: r.content,
    isDefault,
    insertedAt: r.insertedAt,
    updatedAt: r.updatedAt,
  };
}

// A short display label for a repo: org/repo for a remote URL, the folder name
// for a local repo, otherwise the raw value.
export function repoDisplayName(repoFull, repoKind) {
  if (!repoFull) return repoFull;
  if (repoKind === 'local') return repoFull;
  try {
    const u = new URL(repoFull);
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length >= 2)
      return segs
        .slice(-2)
        .join('/')
        .replace(/\.git$/, '');
  } catch {
    /* not a URL — fall through */
  }
  return repoFull;
}

// Normalize stored dependencies into [{ kind, repoFull, commitSha, display }].
function serializeDependencies(scan) {
  const detail = Array.isArray(scan.dependenciesDetail) ? scan.dependenciesDetail : null;
  if (detail) {
    return detail.map((d) => {
      const kind = d.kind || 'remote';
      const repoFull = d.repo_full ?? d.repoFull ?? '';
      const commitSha = d.commit_sha ?? d.commitSha ?? null;
      return { kind, repoFull, commitSha, display: repoDisplayName(repoFull, kind) };
    });
  }
  // Legacy text[] — treat each as a remote address.
  return (scan.dependencies || []).map((s) => ({
    kind: 'remote',
    repoFull: s,
    commitSha: null,
    display: repoDisplayName(s, 'remote'),
  }));
}

export function serializeScan(
  scan,
  {
    workflowName,
    postScriptName,
    postScripts = [],
    agentSkills = [],
    findings = 0,
    rawCandidates = findings,
    canonicalFindings = findings,
    duplicateFindings = 0,
    unprocessedFindings = 0,
    exploitable = 0,
    progress = null,
    progressLabel = null,
    statusSummary = null,
  } = {}
) {
  const commit = scan.commitSha || '';
  const agentSkillIds = (scan.agentSkillIds || []).map((id) => id.toString());
  return {
    id: scan.id.toString(),
    repoFull: scan.repoFull,
    repoKind: scan.repoKind ?? 'remote',
    repoDisplay: repoDisplayName(scan.repoFull, scan.repoKind),
    commitSha: commit,
    commitShort: commit.length > 7 ? commit.slice(0, 7) : commit,
    repoScope: scan.repoScope,
    dependencies: serializeDependencies(scan),
    configuration: scan.configuration || {},
    model: scan.model,
    modelProvider: scan.modelProvider ?? null,
    harness: scan.harness,
    thinkingEffort: scan.thinkingEffort ?? null,
    status: scan.status,
    workflowId: scan.workflowId.toString(),
    workflowName: workflowName ?? null,
    postScriptId: scan.postScriptId.toString(),
    postScriptName: postScriptName ?? null,
    postScripts: postScripts.map((postScript) => ({
      id: postScript.id.toString(),
      name: postScript.name,
      primary: postScript.id === scan.postScriptId,
    })),
    postScriptNames: postScripts.map((postScript) => postScript.name),
    postScriptCount: postScripts.length,
    agentSkillIds,
    agentSkills: agentSkills.map((skill) => ({
      id: skill.id.toString(),
      slug: skill.slug ?? null,
      name: skill.name,
      sourceUrl: skill.sourceUrl ?? null,
      licenseSpdx: skill.licenseSpdx ?? null,
    })),
    agentSkillNames: agentSkills.map((skill) => skill.name),
    agentSkillCount: agentSkills.length,
    findings,
    rawCandidates,
    canonicalFindings,
    duplicateFindings,
    unprocessedFindings,
    exploitable,
    progress,
    progressLabel,
    statusSummary: statusSummary ? { ...statusSummary, progress, progressLabel } : null,
    scopes: scan.scopes || {},
    reasoning: scan.reasoning ?? null,
    jobLimit: scan.jobLimit ?? null,
    jobsStarted: scan.jobsStarted ?? 0,
    lastResumedAt: scan.lastResumedAt ?? null,
    severityRanker: scan.severityRanker ?? '',
    extra: scan.extra || {},
    insertedAt: scan.insertedAt,
    updatedAt: scan.updatedAt,
    age: timeAgo(scan.insertedAt),
  };
}

function serializeEnrichment(e) {
  return {
    id: e.id.toString(),
    scanId: e.scanId.toString(),
    vulnerabilityId: e.vulnerabilityId.toString(),
    postScriptId: e.postScriptId.toString(),
    postScriptName: e.postScriptName,
    result: e.result && typeof e.result === 'object' ? e.result : null,
    stub: Boolean(e.stub),
    stubExplanation: e.stubExplanation ?? null,
    insertedAt: e.insertedAt,
    updatedAt: e.updatedAt,
  };
}

export function serializeVulnerability(v, options = {}) {
  const answer = v.jsonAnswer && typeof v.jsonAnswer === 'object' ? v.jsonAnswer : {};
  const post = v.postScriptAnswer && typeof v.postScriptAnswer === 'object' ? v.postScriptAnswer : null;
  const enrichments = (options.enrichments || []).map(serializeEnrichment);
  return {
    id: v.id.toString(),
    scanId: v.scanId.toString(),
    rank: v.rank ?? null,
    // The 8 required vulnerability fields plus optional exploitable.
    explanation: answer.explanation ?? null,
    file_path: answer.file_path ?? null,
    line: answer.line ?? null,
    malicious_input_example: answer.malicious_input_example ?? null,
    summary: answer.summary ?? null,
    trigger_flow: answer.trigger_flow ?? [],
    vulnerability_type: answer.vulnerability_type ?? null,
    exploitable: answer.exploitable ?? null,
    malicious_actor: answer.malicious_actor ?? null,
    // Any extra keys the workflow chose to emit are preserved too.
    jsonAnswer: answer,
    // Post-script enrichment (e.g. severity, cvss, cwe).
    postScriptAnswer: post,
    severity: post?.severity ?? null,
    dedupe: {
      runId: v.dedupeRunId?.toString?.() ?? null,
      model: v.dedupeModel ?? null,
      isCanonical: v.dedupeIsCanonical ?? null,
      canonicalId: v.dedupeCanonicalId?.toString?.() ?? null,
      clusterId: v.dedupeClusterId ?? null,
      reason: v.dedupeReason ?? null,
      duplicateIds: (options.duplicateIds || []).map((id) => id.toString()),
    },
    bountyRank: {
      response: v.bountyRankResponse && typeof v.bountyRankResponse === 'object' ? v.bountyRankResponse : null,
      rank: v.bountyRank ?? null,
      impactLevel: v.bountyRankImpactLevel ?? null,
      minimumReward: v.bountyRankMinimumReward?.toString?.() ?? null,
      maximumReward: v.bountyRankMaximumReward?.toString?.() ?? null,
      reasoning: v.bountyRankReasoning ?? null,
      rootBug: v.rankRootBug ?? null,
      missingFromPrompt: v.bountyRankMissingFromPrompt ?? null,
      totalIssues: v.bountyRankTotalIssues ?? null,
      runId: v.bountyRankRunId?.toString?.() ?? null,
      model: v.bountyRankModel ?? null,
      rankedAt: v.bountyRankTs ?? null,
    },
    enrichments,
    comments: v.comments ?? null,
    // User review: 1 = interesting, 0 = not interesting, null = unmarked.
    interesting: v.interesting === null || v.interesting === undefined ? null : Number(v.interesting),
    insertedAt: v.insertedAt,
  };
}

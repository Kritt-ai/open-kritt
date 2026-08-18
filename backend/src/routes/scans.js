import { Prisma } from '@prisma/client';
import { ZipArchive } from 'archiver';
import { Router } from 'express';
import { Readable } from 'node:stream';
import { prisma } from '../db.js';
import {
  validateScan,
  validateScanJobLimit,
  validateModelSelection,
  validateModelOverrides,
  validateProspectiveScanRuntimeSettings,
  ValidationError,
} from '../lib/validation.js';
import { assembleScans, assembleScan } from '../lib/repo.js';
import { repoDisplayName, serializeSupplementalPostScriptRun, serializeVulnerability } from '../lib/serialize.js';
import { SCAN_STATUSES, extractExtraKeys } from '../lib/constants.js';
import { localRepoNames } from '../lib/localRepos.js';
import { assertModelSelectionAvailable } from '../lib/modelSelection.js';
import { lockWorkflowForScan } from '../lib/workflowLocks.js';
import { lockPostScriptForScan } from '../lib/postScriptLocks.js';
import { lockAgentSkillForScan } from '../lib/agentSkillLocks.js';
import { lockScanForMutation } from '../lib/scanLocks.js';
import {
  createFindingExport,
  createFindingExportLimiter,
  FINDING_EXPORT_STATUSES,
  findingExportAvailability,
  FindingExportBusyError,
  FindingExportSourceTooLargeError,
  FindingExportTooLargeError,
  FindingExportTooManyFindingsError,
  FindingExportTooManyRelatedRecordsError,
  MAX_FINDING_EXPORT_FINDINGS,
  MAX_FINDING_EXPORT_RELATED_RECORDS,
  MAX_FINDING_EXPORT_SOURCE_BYTES,
  MAX_FINDING_EXPORT_SOURCE_RECORD_BYTES,
} from '../lib/findingExport.js';

const router = Router();
const runFindingExport = createFindingExportLimiter();
const DELETABLE_SCAN_STATUSES = new Set(['completed', 'stopped', 'failed', 'paused']);
export const ACTIVE_SCAN_STATUSES = ['prewarming_cache', 'running', 'post_processing'];
export const SCAN_LAUNCH_POLICIES = ['immediate', 'queue'];
export const DEFAULT_SCAN_PAGE_SIZE = 6;
export const MAX_SCAN_PAGE_SIZE = 100;
export const MAX_SUPPLEMENTAL_POST_SCRIPT_TARGETS = 10_000;
export const SUPPLEMENTAL_POST_SCRIPT_SCAN_STATUSES = ['paused', 'completed', 'stopped', 'failed'];
export const SCAN_LIST_ORDER = Object.freeze([{ updatedAt: 'desc' }, { id: 'desc' }]);
const USER_STATUS_TRANSITIONS = Object.freeze({
  queued: new Set(['stopped']),
  pending: new Set(['stopped']),
  prewarming_cache: new Set(['paused', 'stopped']),
  running: new Set(['paused', 'stopped']),
  rate_limited: new Set(['stopped']),
  paused: new Set(['pending', 'stopped']),
  post_processing: new Set(['paused', 'stopped']),
  completed: new Set(),
  stopped: new Set(['pending']),
  failed: new Set(['pending']),
});

function paginationInteger(value) {
  if (Array.isArray(value) || typeof value === 'object' || !/^\d+$/.test(String(value ?? ''))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

export function scanListPagination(query = {}) {
  const enabled = query.page !== undefined || query.pageSize !== undefined;
  if (!enabled) return null;

  const page = query.page === undefined ? 1 : paginationInteger(query.page);
  const pageSize = query.pageSize === undefined ? DEFAULT_SCAN_PAGE_SIZE : paginationInteger(query.pageSize);
  const errors = [];
  if (page === null) errors.push({ field: 'page', message: 'Page must be a positive integer.' });
  if (pageSize === null || pageSize > MAX_SCAN_PAGE_SIZE) {
    errors.push({ field: 'pageSize', message: `Page size must be between 1 and ${MAX_SCAN_PAGE_SIZE}.` });
  }
  if (errors.length) throw new ValidationError(errors);

  return { page, pageSize, skip: (page - 1) * pageSize };
}

function invalidScanTransition(current, requested) {
  const error = new Error(`Cannot change a ${current} scan to ${requested}.`);
  error.status = 409;
  return error;
}

export function scanLaunchDecision(body, activeScanCount) {
  const hasCamelCase = Object.prototype.hasOwnProperty.call(body || {}, 'launchPolicy');
  const hasSnakeCase = Object.prototype.hasOwnProperty.call(body || {}, 'launch_policy');
  const launchPolicy = hasCamelCase ? body.launchPolicy : hasSnakeCase ? body.launch_policy : undefined;

  if (launchPolicy === undefined) {
    return activeScanCount > 0 ? { kind: 'choice-required' } : { kind: 'ready', status: 'pending' };
  }
  if (!SCAN_LAUNCH_POLICIES.includes(launchPolicy)) {
    throw new ValidationError([
      {
        field: 'launchPolicy',
        message: `Launch policy must be one of: ${SCAN_LAUNCH_POLICIES.join(', ')}.`,
      },
    ]);
  }
  return { kind: 'ready', status: launchPolicy === 'queue' ? 'queued' : 'pending' };
}

export async function deleteScanOwnedData(tx, scanId) {
  const vulnerabilities = await tx.vulnerability.findMany({
    where: { scanId },
    select: { id: true },
  });
  const vulnerabilityIds = vulnerabilities.map((vulnerability) => vulnerability.id);

  await tx.triage.deleteMany({ where: { vulnerabilityId: { in: vulnerabilityIds } } });
  await tx.vulnerabilityEnrichment.deleteMany({ where: { scanId } });
  await tx.supplementalPostScriptTarget.deleteMany({ where: { scanId } });
  await tx.supplementalPostScriptRun.deleteMany({ where: { scanId } });
  await tx.stepMetadata.deleteMany({ where: { scanId } });
  await tx.postProcessMetadata.deleteMany({ where: { scanId } });
  await tx.vulnerability.deleteMany({ where: { scanId } });
  await tx.stepResult.deleteMany({ where: { scanId } });
  await tx.scan.delete({ where: { id: scanId } });
}

function positiveDatabaseId(value, field, errors) {
  const text = typeof value === 'bigint' ? value.toString() : typeof value === 'number' ? `${value}` : value;
  if (typeof text !== 'string' || !/^[1-9]\d*$/.test(text)) {
    errors.push({ field, message: 'Choose a valid record.' });
    return null;
  }
  try {
    return BigInt(text);
  } catch {
    errors.push({ field, message: 'Choose a valid record.' });
    return null;
  }
}

export function validateSupplementalPostScriptRequest(body, postScript = null) {
  const errors = [];
  const postScriptId = positiveDatabaseId(body?.postScriptId ?? body?.post_script_id, 'postScriptId', errors);
  const requestedIds = body?.vulnerabilityIds ?? body?.vulnerability_ids;
  let vulnerabilityIds = [];
  if (!Array.isArray(requestedIds) || requestedIds.length === 0) {
    errors.push({ field: 'vulnerabilityIds', message: 'Select at least one finding.' });
  } else if (requestedIds.length > MAX_SUPPLEMENTAL_POST_SCRIPT_TARGETS) {
    errors.push({
      field: 'vulnerabilityIds',
      message: `Select no more than ${MAX_SUPPLEMENTAL_POST_SCRIPT_TARGETS} findings in one run.`,
    });
  } else {
    vulnerabilityIds = requestedIds.flatMap((value, index) => {
      const parsed = positiveDatabaseId(value, `vulnerabilityIds[${index}]`, errors);
      return parsed === null ? [] : [parsed];
    });
    if (new Set(vulnerabilityIds.map((id) => id.toString())).size !== vulnerabilityIds.length) {
      errors.push({ field: 'vulnerabilityIds', message: 'Each finding may only be selected once.' });
    }
  }

  const providedExtra = body?.extra;
  if (
    providedExtra !== undefined &&
    (providedExtra === null || typeof providedExtra !== 'object' || Array.isArray(providedExtra))
  ) {
    errors.push({ field: 'extra', message: 'Extra values must be an object.' });
  }
  const requiredExtraKeys = postScript ? extractExtraKeys(postScript.content) : [];
  const extraSource =
    providedExtra && typeof providedExtra === 'object' && !Array.isArray(providedExtra) ? providedExtra : {};
  for (const key of requiredExtraKeys) {
    const value = extraSource[key];
    if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
      errors.push({
        field: `extra.${key}`,
        message: `Extra value "${key}" is required by the selected post-script.`,
      });
    }
  }
  if (errors.length) throw new ValidationError(errors);

  const extra = {};
  for (const key of requiredExtraKeys) extra[key] = extraSource[key];
  return { postScriptId, vulnerabilityIds, requiredExtraKeys, extra };
}

function supplementalModelSelection(scan, body = {}, fallbackRun = null) {
  const configuration =
    scan?.configuration && typeof scan.configuration === 'object' && !Array.isArray(scan.configuration)
      ? scan.configuration
      : {};
  const fallback = {
    model:
      fallbackRun?.model ?? configuration.post_processing_model ?? configuration.postProcessingModel ?? scan?.model,
    model_provider:
      fallbackRun?.modelProvider ??
      configuration.post_processing_model_provider ??
      configuration.postProcessingModelProvider ??
      scan?.modelProvider,
    harness:
      fallbackRun?.harness ??
      configuration.post_processing_harness ??
      configuration.postProcessingHarness ??
      scan?.harness,
    thinking_effort:
      fallbackRun?.thinkingEffort ??
      configuration.post_processing_thinking_effort ??
      configuration.postProcessingThinkingEffort ??
      scan?.thinkingEffort,
  };
  return validateModelSelection({
    model: body?.model ?? fallback.model,
    model_provider: body?.model_provider ?? body?.modelProvider ?? fallback.model_provider,
    harness: body?.harness ?? fallback.harness,
    thinking_effort: body?.thinking_effort ?? body?.thinkingEffort ?? fallback.thinking_effort,
  });
}

async function createSupplementalRunRecords(tx, scanId, postScript, vulnerabilityIds, extra, selection) {
  const run = await tx.supplementalPostScriptRun.create({
    data: {
      scanId,
      postScriptId: postScript.id,
      postScriptName: postScript.name,
      postScriptContent: postScript.content,
      postScriptOutputFormat: postScript.outputFormat,
      model: selection.model,
      modelProvider: selection.modelProvider,
      harness: selection.harness,
      thinkingEffort: selection.thinkingEffort,
      extra,
      targetCount: vulnerabilityIds.length,
    },
  });
  await tx.supplementalPostScriptTarget.createMany({
    data: vulnerabilityIds.map((vulnerabilityId) => ({
      runId: run.id,
      scanId,
      vulnerabilityId,
    })),
  });
  const targets = await tx.supplementalPostScriptTarget.findMany({
    where: { runId: run.id },
    orderBy: { id: 'asc' },
  });
  return { kind: 'created', run, targets };
}

export async function createSupplementalPostScriptRun(tx, scanId, body, { assertAvailable } = {}) {
  await lockScanForMutation(tx, scanId);
  const scan = await tx.scan.findUnique({ where: { id: scanId } });
  if (!scan) return { kind: 'scan-not-found' };
  if (!SUPPLEMENTAL_POST_SCRIPT_SCAN_STATUSES.includes(scan.status)) {
    return { kind: 'scan-active', status: scan.status };
  }

  const preliminary = validateSupplementalPostScriptRequest(body);
  await lockPostScriptForScan(tx, preliminary.postScriptId);
  const postScript = await tx.postScript.findUnique({ where: { id: preliminary.postScriptId } });
  if (!postScript) return { kind: 'post-script-not-found' };
  const valid = validateSupplementalPostScriptRequest(body, postScript);
  const selection = supplementalModelSelection(scan, body);
  if (typeof assertAvailable === 'function') await assertAvailable(selection);

  const findings = await tx.vulnerability.findMany({
    where: {
      scanId,
      id: { in: valid.vulnerabilityIds },
      OR: [{ dedupeIsCanonical: true }, { dedupeIsCanonical: null }],
    },
    select: { id: true },
  });
  const foundIds = new Set(findings.map((finding) => finding.id.toString()));
  const missingIds = valid.vulnerabilityIds.filter((id) => !foundIds.has(id.toString()));
  if (missingIds.length) {
    throw new ValidationError([
      {
        field: 'vulnerabilityIds',
        message: 'One or more selected findings do not belong to this scan or are duplicate records.',
      },
    ]);
  }

  return createSupplementalRunRecords(tx, scanId, postScript, valid.vulnerabilityIds, valid.extra, selection);
}

export async function retrySupplementalPostScriptRun(tx, scanId, runId, body = {}, { assertAvailable } = {}) {
  await lockScanForMutation(tx, scanId);
  const scan = await tx.scan.findUnique({ where: { id: scanId } });
  if (!scan) return { kind: 'scan-not-found' };
  if (!SUPPLEMENTAL_POST_SCRIPT_SCAN_STATUSES.includes(scan.status)) {
    return { kind: 'scan-active', status: scan.status };
  }

  await tx.$queryRaw`
    SELECT id
    FROM workflows.supplemental_post_script_runs
    WHERE id = ${runId} AND scan_id = ${scanId}
    FOR UPDATE
  `;
  const original = await tx.supplementalPostScriptRun.findFirst({ where: { id: runId, scanId } });
  if (!original) return { kind: 'run-not-found' };
  if (!['completed', 'completed_with_errors'].includes(original.status)) {
    return { kind: 'run-active', status: original.status };
  }

  const failedTargets = await tx.supplementalPostScriptTarget.findMany({
    where: { runId, scanId, status: 'failed' },
    select: { vulnerabilityId: true },
    orderBy: { id: 'asc' },
  });
  if (!failedTargets.length) return { kind: 'no-failures' };
  const vulnerabilityIds = failedTargets.map((target) => target.vulnerabilityId);
  const availableFindings = await tx.vulnerability.count({
    where: {
      scanId,
      id: { in: vulnerabilityIds },
      OR: [{ dedupeIsCanonical: true }, { dedupeIsCanonical: null }],
    },
  });
  if (availableFindings !== vulnerabilityIds.length) {
    throw new ValidationError([
      { field: 'vulnerabilityIds', message: 'One or more failed findings are no longer available on this scan.' },
    ]);
  }

  const selection = supplementalModelSelection(scan, body, original);
  if (typeof assertAvailable === 'function') await assertAvailable(selection);
  return createSupplementalRunRecords(
    tx,
    scanId,
    {
      id: original.postScriptId,
      name: original.postScriptName,
      content: original.postScriptContent,
      outputFormat: original.postScriptOutputFormat,
    },
    vulnerabilityIds,
    original.extra,
    selection
  );
}

export async function listSupplementalPostScriptRuns(db, scanId) {
  const runs = await db.supplementalPostScriptRun.findMany({
    where: { scanId },
    orderBy: [{ insertedAt: 'desc' }, { id: 'desc' }],
  });
  if (!runs.length) return [];
  const targets = await db.supplementalPostScriptTarget.findMany({
    where: { runId: { in: runs.map((run) => run.id) } },
    orderBy: { id: 'asc' },
  });
  const byRun = new Map();
  for (const target of targets) {
    const key = target.runId.toString();
    if (!byRun.has(key)) byRun.set(key, []);
    byRun.get(key).push(target);
  }
  return runs.map((run) => serializeSupplementalPostScriptRun(run, byRun.get(run.id.toString()) || []));
}

export async function serializedScanVulnerabilities(
  scanId,
  { includeDuplicates = false, maxFindings = null, maxRelatedRecords = null, db = prisma } = {}
) {
  const bounded = Number.isSafeInteger(maxFindings) && maxFindings > 0;
  const relatedBounded = Number.isSafeInteger(maxRelatedRecords) && maxRelatedRecords > 0;
  const where = includeDuplicates
    ? { scanId }
    : { scanId, OR: [{ dedupeIsCanonical: true }, { dedupeIsCanonical: null }] };
  const vulns = await db.vulnerability.findMany({
    where,
    orderBy: [{ rank: 'asc' }, { id: 'asc' }],
    ...(bounded ? { take: maxFindings + 1 } : {}),
  });
  if (bounded && vulns.length > maxFindings) throw new FindingExportTooManyFindingsError(maxFindings);
  const vulnerabilityIds = vulns.map((vulnerability) => vulnerability.id);
  const enrichments = await db.vulnerabilityEnrichment.findMany({
    where: { scanId, vulnerabilityId: { in: vulnerabilityIds } },
    orderBy: [{ id: 'asc' }],
    ...(relatedBounded ? { take: maxRelatedRecords + 1 } : {}),
  });
  if (relatedBounded && enrichments.length > maxRelatedRecords) {
    throw new FindingExportTooManyRelatedRecordsError(maxRelatedRecords, 'post-processing records');
  }
  const enrichmentsByVulnerability = new Map();
  for (const enrichment of enrichments) {
    const key = enrichment.vulnerabilityId.toString();
    if (!enrichmentsByVulnerability.has(key)) enrichmentsByVulnerability.set(key, []);
    enrichmentsByVulnerability.get(key).push(enrichment);
  }
  const duplicateIdsByCanonical = new Map();
  const duplicates = includeDuplicates
    ? vulns
    : await db.vulnerability.findMany({
        where: {
          scanId,
          dedupeIsCanonical: false,
          dedupeCanonicalId: { in: vulnerabilityIds },
        },
        select: { id: true, dedupeIsCanonical: true, dedupeCanonicalId: true },
        orderBy: [{ id: 'asc' }],
        ...(relatedBounded ? { take: maxRelatedRecords + 1 } : {}),
      });
  if (relatedBounded && duplicates.length > maxRelatedRecords) {
    throw new FindingExportTooManyRelatedRecordsError(maxRelatedRecords, 'duplicate records');
  }
  for (const vulnerability of duplicates) {
    if (vulnerability.dedupeIsCanonical !== false || !vulnerability.dedupeCanonicalId) continue;
    const key = vulnerability.dedupeCanonicalId.toString();
    if (!duplicateIdsByCanonical.has(key)) duplicateIdsByCanonical.set(key, []);
    duplicateIdsByCanonical.get(key).push(vulnerability.id);
  }
  return vulns.map((vulnerability) =>
    serializeVulnerability(vulnerability, {
      enrichments: enrichmentsByVulnerability.get(vulnerability.id.toString()) || [],
      duplicateIds: duplicateIdsByCanonical.get(vulnerability.id.toString()) || [],
    })
  );
}

export async function findingExportSourceProfile(scanId, { db = prisma } = {}) {
  const [profile] = await db.$queryRaw(
    Prisma.sql`
      WITH canonical AS (
        SELECT
          id,
          COALESCE(octet_length(json_answer::text), 0) +
          COALESCE(octet_length(post_script_answer::text), 0) +
          COALESCE(octet_length(comments), 0) +
          COALESCE(octet_length(dedupe_reason), 0) +
          COALESCE(octet_length(bounty_rank_response::text), 0) +
          COALESCE(octet_length(bounty_rank_reasoning), 0) +
          COALESCE(octet_length(rank_root_bug), 0) +
          COALESCE(octet_length(bounty_rank_missing_from_prompt), 0) AS bytes
        FROM workflows.vulnerabilities
        WHERE scan_id = ${scanId} AND dedupe_is_canonical IS DISTINCT FROM FALSE
      ),
      enrichment AS (
        SELECT
          COALESCE(octet_length(e.post_script_name), 0) +
          COALESCE(octet_length(e.result::text), 0) +
          COALESCE(octet_length(e.stub_explanation), 0) AS bytes
        FROM workflows.vulnerability_enrichments e
        INNER JOIN canonical c ON c.id = e.vulnerability_id
      ),
      duplicate AS (
        SELECT v.id
        FROM workflows.vulnerabilities v
        INNER JOIN canonical c ON c.id = v.dedupe_canonical_id
        WHERE v.scan_id = ${scanId} AND v.dedupe_is_canonical = FALSE
      )
      SELECT
        (SELECT COUNT(*) FROM canonical) AS "findingCount",
        (SELECT COUNT(*) FROM enrichment) AS "enrichmentCount",
        (SELECT COUNT(*) FROM duplicate) AS "duplicateCount",
        (SELECT COALESCE(SUM(bytes), 0) FROM canonical) +
          (SELECT COALESCE(SUM(bytes), 0) FROM enrichment) AS "totalBytes",
        GREATEST(
          (SELECT COALESCE(MAX(bytes), 0) FROM canonical),
          (SELECT COALESCE(MAX(bytes), 0) FROM enrichment)
        ) AS "largestRecordBytes"
    `
  );
  return {
    findingCount: BigInt(profile?.findingCount ?? 0),
    enrichmentCount: BigInt(profile?.enrichmentCount ?? 0),
    duplicateCount: BigInt(profile?.duplicateCount ?? 0),
    totalBytes: BigInt(profile?.totalBytes ?? 0),
    largestRecordBytes: BigInt(profile?.largestRecordBytes ?? 0),
  };
}

export async function lockScanConfigurationResources(tx, { workflowId, postScriptIds, agentSkillIds }) {
  await lockWorkflowForScan(tx, workflowId);
  for (const postScriptId of [...postScriptIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    await lockPostScriptForScan(tx, postScriptId);
  }
  for (const agentSkillId of [...agentSkillIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    await lockAgentSkillForScan(tx, agentSkillId);
  }
}

export function requiredScanExtraKeys(workflow, workflowSteps = [], postScripts = []) {
  const declared = Array.isArray(workflow?.extra) ? workflow.extra : [];
  const workflowPromptKeys = workflowSteps.flatMap((step) => extractExtraKeys(step?.content));
  const postScriptPromptKeys = postScripts.flatMap((postScript) => extractExtraKeys(postScript?.content));
  return [...new Set([...declared, ...workflowPromptKeys, ...postScriptPromptKeys])];
}

function modelOverrideSelection(configuration) {
  return {
    model: configuration.model,
    modelProvider: configuration.model_provider ?? configuration.modelProvider,
    harness: configuration.harness,
    thinkingEffort: configuration.thinking_effort ?? configuration.thinkingEffort,
  };
}

async function assertSelectionAvailable(assertAvailable, selection, fieldPrefix = '') {
  try {
    await assertAvailable(selection);
  } catch (error) {
    if (!(error instanceof ValidationError) || !fieldPrefix) throw error;
    throw new ValidationError(
      error.errors.map((item) => ({
        ...item,
        field: `${fieldPrefix}.${item.field}`,
      }))
    );
  }
}

export async function assertModelOverridesAvailable(modelOverrides, assertAvailable) {
  const checked = new Set();
  for (const [depth, configuration] of Object.entries(modelOverrides || {})) {
    const selection = modelOverrideSelection(configuration);
    const signature = JSON.stringify(selection);
    if (checked.has(signature)) continue;
    checked.add(signature);
    await assertSelectionAvailable(assertAvailable, selection, `model_overrides.${depth}`);
  }
}

export async function validateScanRuntimeUpdate(body, current, { assertAvailable, allowedDepths = null } = {}) {
  const runtime = validateProspectiveScanRuntimeSettings(body, current, { allowedDepths });
  if (!runtime.selection && !runtime.postProcessingSelection && runtime.modelOverrides === null) return {};
  if (typeof assertAvailable !== 'function') {
    throw new TypeError('Runtime model availability validation requires a transaction-aware checker.');
  }
  const data = {};
  if (runtime.selection) {
    await assertSelectionAvailable(assertAvailable, runtime.selection);
    Object.assign(data, {
      model: runtime.selection.model,
      modelProvider: runtime.selection.modelProvider,
      harness: runtime.selection.harness,
      thinkingEffort: runtime.selection.thinkingEffort,
    });
  }
  if (
    runtime.postProcessingSelection &&
    JSON.stringify(runtime.postProcessingSelection) !== JSON.stringify(runtime.selection)
  ) {
    await assertSelectionAvailable(assertAvailable, runtime.postProcessingSelection, 'post_processing');
  }
  if (Object.prototype.hasOwnProperty.call(runtime.data, 'postProcessingThinkingEffort')) {
    data.postProcessingThinkingEffort = runtime.data.postProcessingThinkingEffort;
  }
  for (const key of ['postProcessingModel', 'postProcessingModelProvider', 'postProcessingHarness']) {
    if (Object.prototype.hasOwnProperty.call(runtime.data, key)) data[key] = runtime.data[key];
  }
  if (runtime.modelOverrides !== null) {
    await assertModelOverridesAvailable(runtime.modelOverrides, assertAvailable);
    data.modelOverrides = runtime.modelOverrides;
  }
  return data;
}

function transactionModelAvailabilityChecker(tx, options = {}) {
  return (selection) =>
    assertModelSelectionAvailable(selection, {
      ...options,
      getCatalog: (provider) => tx.modelCatalog.findUnique({ where: { provider } }),
    });
}

async function scanWorkflowDepths(tx, workflowId) {
  const workflow = await tx.workflow.findUnique({ where: { id: workflowId }, select: { stepIds: true } });
  if (!workflow) {
    throw new ValidationError([{ field: 'workflowId', message: 'Workflow does not exist.' }]);
  }
  if (!workflow.stepIds?.length) return [];
  const steps = await tx.step.findMany({
    where: { id: { in: workflow.stepIds } },
    select: { depth: true },
  });
  return [...new Set(steps.map((step) => step.depth))];
}

export async function patchScanIfPresent(tx, scanId, body, { assertAvailable, availabilityOptions } = {}) {
  await lockScanForMutation(tx, scanId);
  const existing = await tx.scan.findUnique({ where: { id: scanId } });
  if (!existing) return { kind: 'not-found' };

  const data = {};
  if (
    Object.prototype.hasOwnProperty.call(body, 'jobLimit') ||
    Object.prototype.hasOwnProperty.call(body, 'job_limit')
  ) {
    data.jobLimit = validateScanJobLimit(body.jobLimit ?? body.job_limit);
  }
  if (Object.prototype.hasOwnProperty.call(body, 'status')) {
    const status = body.status;
    if (!status || !SCAN_STATUSES.includes(status)) {
      throw new ValidationError([{ field: 'status', message: `Status must be one of: ${SCAN_STATUSES.join(', ')}.` }]);
    }
    if (status !== existing.status && !USER_STATUS_TRANSITIONS[existing.status]?.has(status)) {
      throw invalidScanTransition(existing.status, status);
    }
    if (status === 'pending' && existing.status !== 'pending') {
      const supplementalWork = await tx.supplementalPostScriptTarget.count({
        where: { scanId, status: { in: ['pending', 'running'] } },
      });
      if (supplementalWork > 0) {
        return { kind: 'supplemental-in-use', supplementalWorkCount: supplementalWork };
      }
    }
    data.status = status;
    if (status === 'pending' && existing.status !== 'pending') {
      // Nullable Prisma JSON fields distinguish SQL NULL from the JSON scalar
      // `null`. Scan reasoning is either an object or SQL NULL; storing a JSON
      // scalar here breaks engine-side nested warning updates.
      data.reasoning = Prisma.DbNull;
      data.lastResumedAt = new Date();
    }
  }

  const availabilityChecker = assertAvailable || transactionModelAvailabilityChecker(tx, availabilityOptions);
  const hasModelOverrides =
    Object.prototype.hasOwnProperty.call(body, 'model_overrides') ||
    Object.prototype.hasOwnProperty.call(body, 'modelOverrides');
  const allowedDepths = hasModelOverrides ? await scanWorkflowDepths(tx, existing.workflowId) : null;
  const runtimeData = await validateScanRuntimeUpdate(body, existing, {
    assertAvailable: availabilityChecker,
    allowedDepths,
  });
  const postProcessingConfigurationKeys = {
    postProcessingModel: 'post_processing_model',
    postProcessingModelProvider: 'post_processing_model_provider',
    postProcessingHarness: 'post_processing_harness',
    postProcessingThinkingEffort: 'post_processing_thinking_effort',
  };
  if (
    Object.keys(postProcessingConfigurationKeys).some((key) => Object.prototype.hasOwnProperty.call(runtimeData, key))
  ) {
    const configuration = {
      ...(existing.configuration && typeof existing.configuration === 'object' && !Array.isArray(existing.configuration)
        ? existing.configuration
        : {}),
    };
    for (const [runtimeKey, configurationKey] of Object.entries(postProcessingConfigurationKeys)) {
      if (!Object.prototype.hasOwnProperty.call(runtimeData, runtimeKey)) continue;
      const value = runtimeData[runtimeKey];
      if (value === null) delete configuration[configurationKey];
      else configuration[configurationKey] = value;
      delete runtimeData[runtimeKey];
    }
    data.configuration = configuration;
  }
  Object.assign(data, runtimeData);
  if (Object.keys(data).length === 0) {
    throw new ValidationError([{ field: 'scan', message: 'Provide a status or runtime setting to update.' }]);
  }

  const scan = await tx.scan.update({ where: { id: scanId }, data });
  return { kind: 'updated', scan };
}

export async function deleteScanIfSafe(tx, scanId) {
  await lockScanForMutation(tx, scanId);
  const existing = await tx.scan.findUnique({ where: { id: scanId } });
  if (!existing) return { kind: 'not-found' };
  if (!DELETABLE_SCAN_STATUSES.has(existing.status)) {
    return { kind: 'not-terminal', status: existing.status };
  }

  const [runningStepCount, runningPostProcessCount, supplementalWorkCount] = await Promise.all([
    tx.stepMetadata.count({ where: { scanId, status: 'running' } }),
    tx.postProcessMetadata.count({ where: { scanId, status: 'running' } }),
    tx.supplementalPostScriptTarget.count({ where: { scanId, status: { in: ['pending', 'running'] } } }),
  ]);
  if (runningStepCount > 0 || runningPostProcessCount > 0 || supplementalWorkCount > 0) {
    return { kind: 'in-use', runningStepCount, runningPostProcessCount, supplementalWorkCount };
  }

  await deleteScanOwnedData(tx, scanId);
  return { kind: 'deleted' };
}

// GET /api/scans?status=running
router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    const where = {};
    if (status === 'running') where.status = { in: ACTIVE_SCAN_STATUSES };
    else if (status && status !== 'all') where.status = status;
    const pagination = scanListPagination(req.query);
    if (!pagination) {
      const scans = await prisma.scan.findMany({ where, orderBy: SCAN_LIST_ORDER });
      return res.json(await assembleScans(scans));
    }

    const [totalItems, runningCount, scans] = await Promise.all([
      prisma.scan.count({ where }),
      prisma.scan.count({ where: { status: { in: ACTIVE_SCAN_STATUSES } } }),
      prisma.scan.findMany({
        where,
        orderBy: SCAN_LIST_ORDER,
        skip: pagination.skip,
        take: pagination.pageSize,
      }),
    ]);
    const items = await assembleScans(scans);
    res.json({
      items,
      page: pagination.page,
      pageSize: pagination.pageSize,
      totalItems,
      totalPages: Math.max(1, Math.ceil(totalItems / pagination.pageSize)),
      startIndex: pagination.skip,
      endIndex: pagination.skip + items.length,
      runningCount,
    });
  } catch (e) {
    next(e);
  }
});

// GET /api/scans/:id
router.get('/:id', async (req, res, next) => {
  try {
    const scan = await prisma.scan.findUnique({ where: { id: BigInt(req.params.id) } });
    if (!scan) return res.status(404).json({ error: 'Scan not found.' });
    res.json(await assembleScan(scan));
  } catch (e) {
    next(e);
  }
});

// GET /api/scans/:id/vulnerabilities — ranked findings for a scan.
router.get('/:id/vulnerabilities', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const scan = await prisma.scan.findUnique({ where: { id } });
    if (!scan) return res.status(404).json({ error: 'Scan not found.' });
    const includeDuplicates = req.query.includeDuplicates === '1' || req.query.includeDuplicates === 'true';
    res.json(await serializedScanVulnerabilities(id, { includeDuplicates }));
  } catch (e) {
    next(e);
  }
});

// GET /api/scans/:id/supplemental-post-script-runs — durable history and progress.
router.get('/:id/supplemental-post-script-runs', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const scan = await prisma.scan.findUnique({ where: { id }, select: { id: true } });
    if (!scan) return res.status(404).json({ error: 'Scan not found.' });
    res.json(await listSupplementalPostScriptRuns(prisma, id));
  } catch (e) {
    next(e);
  }
});

// POST /api/scans/:id/supplemental-post-script-runs — queue one script for selected findings.
router.post('/:id/supplemental-post-script-runs', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const result = await prisma.$transaction((tx) =>
      createSupplementalPostScriptRun(tx, id, req.body || {}, {
        assertAvailable: transactionModelAvailabilityChecker(tx),
      })
    );
    if (result.kind === 'scan-not-found') return res.status(404).json({ error: 'Scan not found.' });
    if (result.kind === 'post-script-not-found') return res.status(404).json({ error: 'Post-script not found.' });
    if (result.kind === 'scan-active') {
      return res.status(409).json({
        error: `Cannot add post-processing while this scan is ${result.status}. Pause or stop it first.`,
      });
    }
    res.status(201).json(serializeSupplementalPostScriptRun(result.run, result.targets));
  } catch (e) {
    next(e);
  }
});

// POST /api/scans/:id/supplemental-post-script-runs/:runId/retry — requeue only failed findings.
router.post('/:id/supplemental-post-script-runs/:runId/retry', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const runId = BigInt(req.params.runId);
    const result = await prisma.$transaction((tx) =>
      retrySupplementalPostScriptRun(tx, id, runId, req.body || {}, {
        assertAvailable: transactionModelAvailabilityChecker(tx),
      })
    );
    if (result.kind === 'scan-not-found' || result.kind === 'run-not-found') {
      return res.status(404).json({ error: 'Supplemental post-script run not found.' });
    }
    if (result.kind === 'scan-active') {
      return res.status(409).json({
        error: `Cannot retry post-processing while this scan is ${result.status}. Pause or stop it first.`,
      });
    }
    if (result.kind === 'run-active') {
      return res.status(409).json({ error: `This supplemental run is still ${result.status}.` });
    }
    if (result.kind === 'no-failures') {
      return res.status(409).json({ error: 'This supplemental run has no failed findings to retry.' });
    }
    res.status(201).json(serializeSupplementalPostScriptRun(result.run, result.targets));
  } catch (e) {
    next(e);
  }
});

// GET /api/scans/:id/export — canonical findings from a terminal scan.
router.get('/:id/export', async (req, res, next) => {
  try {
    await runFindingExport(async () => {
      const id = BigInt(req.params.id);
      const scan = await prisma.scan.findUnique({
        where: { id },
        select: {
          id: true,
          status: true,
          repoFull: true,
          repoKind: true,
          workflowId: true,
          postScriptId: true,
          insertedAt: true,
          updatedAt: true,
        },
      });
      if (!scan) return res.status(404).json({ error: 'Scan not found.' });
      if (!FINDING_EXPORT_STATUSES.includes(scan.status)) {
        const availability = findingExportAvailability(scan, 0);
        return res.status(409).json({ error: availability.message });
      }

      const sourceProfile = await findingExportSourceProfile(id);
      const findingCount = Number(sourceProfile.findingCount);
      const availability = findingExportAvailability(scan, findingCount);
      if (!availability.ready) return res.status(409).json({ error: availability.message });
      if (findingCount > MAX_FINDING_EXPORT_FINDINGS) {
        throw new FindingExportTooManyFindingsError(MAX_FINDING_EXPORT_FINDINGS);
      }
      if (sourceProfile.enrichmentCount > BigInt(MAX_FINDING_EXPORT_RELATED_RECORDS)) {
        throw new FindingExportTooManyRelatedRecordsError(
          MAX_FINDING_EXPORT_RELATED_RECORDS,
          'post-processing records'
        );
      }
      if (sourceProfile.duplicateCount > BigInt(MAX_FINDING_EXPORT_RELATED_RECORDS)) {
        throw new FindingExportTooManyRelatedRecordsError(MAX_FINDING_EXPORT_RELATED_RECORDS, 'duplicate records');
      }
      if (sourceProfile.totalBytes > BigInt(MAX_FINDING_EXPORT_SOURCE_BYTES)) {
        throw new FindingExportSourceTooLargeError(MAX_FINDING_EXPORT_SOURCE_BYTES, 'finding data');
      }
      if (sourceProfile.largestRecordBytes > BigInt(MAX_FINDING_EXPORT_SOURCE_RECORD_BYTES)) {
        throw new FindingExportSourceTooLargeError(MAX_FINDING_EXPORT_SOURCE_RECORD_BYTES, 'finding record');
      }

      const [workflow, postScript, findings] = await Promise.all([
        prisma.workflow.findUnique({ where: { id: scan.workflowId }, select: { name: true } }),
        prisma.postScript.findUnique({ where: { id: scan.postScriptId }, select: { name: true } }),
        serializedScanVulnerabilities(id, {
          maxFindings: MAX_FINDING_EXPORT_FINDINGS,
          maxRelatedRecords: MAX_FINDING_EXPORT_RELATED_RECORDS,
        }),
      ]);
      const exportScan = {
        id: scan.id.toString(),
        status: scan.status,
        repoDisplay: repoDisplayName(scan.repoFull, scan.repoKind),
        repoKind: scan.repoKind ?? 'remote',
        workflowId: scan.workflowId.toString(),
        workflowName: workflow?.name ?? null,
        postScriptName: postScript?.name ?? null,
        findings: findingCount,
        insertedAt: scan.insertedAt,
        updatedAt: scan.updatedAt,
      };
      const bundle = createFindingExport(exportScan, findings);
      const archiveDate = new Date(exportScan.updatedAt || Date.now());
      const archive = new ZipArchive({ zlib: { level: 6 } });
      archive.on('warning', (warning) => {
        if (warning.code !== 'ENOENT' && !res.destroyed) res.destroy(warning);
      });
      archive.on('error', (archiveError) => {
        if (!res.destroyed) res.destroy(archiveError);
      });
      req.on('aborted', () => archive.abort());

      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${bundle.filename}"`);
      res.setHeader('Cache-Control', 'no-store');
      archive.pipe(res);
      for (const file of bundle.files) {
        // The generator defers creating each bounded string until archiver asks
        // for that entry, rather than retaining the complete export in memory.
        const content = Readable.from(
          (function* findingExportFileContent() {
            yield file.content();
          })()
        );
        archive.append(content, {
          name: `${bundle.root}/${file.path}`,
          date: archiveDate,
          mode: 0o644,
        });
      }
      try {
        await archive.finalize();
      } catch (archiveError) {
        if (!res.destroyed) res.destroy(archiveError);
      }
    });
  } catch (e) {
    if (
      e instanceof FindingExportTooLargeError ||
      e instanceof FindingExportTooManyFindingsError ||
      e instanceof FindingExportTooManyRelatedRecordsError ||
      e instanceof FindingExportSourceTooLargeError
    ) {
      return res.status(413).json({ error: e.message });
    }
    if (e instanceof FindingExportBusyError) {
      res.setHeader('Retry-After', String(e.retryAfterSeconds));
      return res.status(429).json({ error: e.message });
    }
    next(e);
  }
});

// POST /api/scans — create a scan now or place it behind active scans.
router.post('/', async (req, res, next) => {
  try {
    const valid = validateScan(req.body, { localNames: localRepoNames() });
    await assertModelSelectionAvailable(valid);
    await assertSelectionAvailable(assertModelSelectionAvailable, valid.postProcessingSelection, 'post_processing');
    const activeScanCount = await prisma.scan.count({ where: { status: { in: ACTIVE_SCAN_STATUSES } } });
    const launchDecision = scanLaunchDecision(req.body, activeScanCount);
    if (launchDecision.kind === 'choice-required') {
      return res.status(409).json({
        error: 'Another scan is running. Choose whether to start immediately or queue this scan.',
        code: 'scan_launch_policy_required',
        errors: [
          {
            field: 'launchPolicy',
            message: 'Choose whether to start immediately or queue this scan.',
          },
        ],
      });
    }

    const configurationObject =
      valid.configuration && typeof valid.configuration === 'object' && !Array.isArray(valid.configuration)
        ? valid.configuration
        : {};
    const configuredPostScriptIds = [
      ...new Set(
        [
          `${valid.postScriptId}`,
          ...(Array.isArray(configurationObject.post_script_ids)
            ? configurationObject.post_script_ids
            : Array.isArray(configurationObject.post_scripts)
              ? configurationObject.post_scripts
              : []
          ).map((id) => `${id}`),
        ].filter((id) => id.trim() !== '')
      ),
    ];
    const invalidPostScriptIds = configuredPostScriptIds.filter((id) => !/^\d+$/.test(id));
    const queryPostScriptIds = configuredPostScriptIds.filter((id) => /^\d+$/.test(id));
    const requestedAgentSkills =
      req.body?.agentSkillIds ??
      req.body?.agent_skill_ids ??
      configurationObject.agent_skill_ids ??
      configurationObject.agent_skills ??
      [];
    const configuredAgentSkillIds = [
      ...new Set(
        (Array.isArray(requestedAgentSkills)
          ? requestedAgentSkills
          : typeof requestedAgentSkills === 'string'
            ? requestedAgentSkills.split(',')
            : []
        )
          .map((item) => (item && typeof item === 'object' ? item.id : item))
          .map((id) => `${id}`.trim())
          .filter(Boolean)
      ),
    ];
    const invalidAgentSkillIds = configuredAgentSkillIds.filter((id) => !/^\d+$/.test(id));
    const queryAgentSkillIds = configuredAgentSkillIds.filter((id) => /^\d+$/.test(id));

    const created = await prisma.$transaction(async (tx) => {
      await lockScanConfigurationResources(tx, {
        workflowId: BigInt(valid.workflowId),
        postScriptIds: queryPostScriptIds.map((id) => BigInt(id)),
        agentSkillIds: queryAgentSkillIds.map((id) => BigInt(id)),
      });
      const [workflow, postScripts, agentSkills] = await Promise.all([
        tx.workflow.findUnique({ where: { id: BigInt(valid.workflowId) } }),
        tx.postScript.findMany({ where: { id: { in: queryPostScriptIds.map((id) => BigInt(id)) } } }),
        tx.agentSkill.findMany({ where: { id: { in: queryAgentSkillIds.map((id) => BigInt(id)) } } }),
      ]);
      const postScriptMap = new Map(postScripts.map((ps) => [ps.id.toString(), ps]));
      const agentSkillMap = new Map(agentSkills.map((skill) => [skill.id.toString(), skill]));
      const missingPostScriptIds = queryPostScriptIds.filter((id) => !postScriptMap.has(id));
      const missingAgentSkillIds = queryAgentSkillIds.filter((id) => !agentSkillMap.has(id));
      const postScript = postScriptMap.get(`${valid.postScriptId}`);
      const errors = [];
      if (!workflow) errors.push({ field: 'workflowId', message: 'Workflow does not exist.' });
      if (!postScript) errors.push({ field: 'postScriptId', message: 'Post-script does not exist.' });
      if (invalidPostScriptIds.length)
        errors.push({
          field: 'postScriptIds',
          message: `Post-script id(s) are invalid: ${invalidPostScriptIds.join(', ')}.`,
        });
      if (missingPostScriptIds.length)
        errors.push({
          field: 'postScriptIds',
          message: `Post-script(s) do not exist: ${missingPostScriptIds.join(', ')}.`,
        });
      if (invalidAgentSkillIds.length)
        errors.push({
          field: 'agentSkillIds',
          message: `Agent skill id(s) are invalid: ${invalidAgentSkillIds.join(', ')}.`,
        });
      if (missingAgentSkillIds.length)
        errors.push({
          field: 'agentSkillIds',
          message: `Agent skill(s) do not exist: ${missingAgentSkillIds.join(', ')}.`,
        });
      if (errors.length) throw new ValidationError(errors);

      // The selected workflow and post-scripts declare which extra.<key> values
      // their prompts expect. Derive workflow keys from the steps (authoritative)
      // unioned with the stored array, so this also supports workflows saved before
      // the extra field existed. Every selected-config key must be supplied.
      const wfSteps = workflow.stepIds?.length
        ? await tx.step.findMany({ where: { id: { in: workflow.stepIds } }, select: { content: true, depth: true } })
        : [];
      validateModelOverrides(valid.modelOverrides, { allowedDepths: wfSteps.map((step) => step.depth) });
      await assertModelOverridesAvailable(valid.modelOverrides, transactionModelAvailabilityChecker(tx));
      const selectedPostScripts = queryPostScriptIds.map((id) => postScriptMap.get(id));
      const expectedExtra = requiredScanExtraKeys(workflow, wfSteps, selectedPostScripts);
      const providedExtra = valid.extra && typeof valid.extra === 'object' ? valid.extra : {};
      const missingExtra = expectedExtra.filter((k) => {
        const v = providedExtra[k];
        return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
      });
      if (missingExtra.length) {
        throw new ValidationError(
          missingExtra.map((k) => ({
            field: `extra.${k}`,
            message: `Extra value "${k}" is required by the selected workflow or post-scripts.`,
          }))
        );
      }
      // Keep only the keys the selected workflow and post-scripts expect.
      const extra = {};
      for (const k of expectedExtra) extra[k] = providedExtra[k];

      // Structured dependencies for the engine; the legacy text[] keeps the addresses/names.
      const dependenciesDetail = valid.dependencies.map((d) => ({
        kind: d.kind,
        repo_full: d.repoFull,
        commit_sha: d.commitSha,
      }));

      return tx.scan.create({
        data: {
          workflowId: workflow.id,
          postScriptId: postScript.id,
          repoFull: valid.repoFull,
          repoKind: valid.repoKind,
          commitSha: valid.commitSha,
          repoScope: valid.repoScope,
          dependencies: valid.dependencies.map((d) => d.repoFull),
          dependenciesDetail,
          agentSkillIds: queryAgentSkillIds.map((id) => BigInt(id)),
          configuration: {
            ...configurationObject,
            post_script_ids: configuredPostScriptIds,
            agent_skill_ids: configuredAgentSkillIds,
            post_processing_thinking_effort: valid.postProcessingThinkingEffort,
            ...(valid.postProcessingModelOverride
              ? {
                  post_processing_model: valid.postProcessingSelection.model,
                  post_processing_model_provider: valid.postProcessingSelection.modelProvider,
                  post_processing_harness: valid.postProcessingSelection.harness,
                }
              : {}),
          },
          model: valid.model,
          modelProvider: valid.modelProvider,
          harness: valid.harness,
          thinkingEffort: valid.thinkingEffort,
          modelOverrides: valid.modelOverrides,
          severityRanker: valid.severityRanker,
          status: launchDecision.status,
          jobLimit: valid.jobLimit,
          // Legacy JSON column retained for existing schema compatibility; scan columns are authoritative.
          config: {},
          // scopes must include files, lines.
          scopes: { files: [], lines: [] },
          extra: expectedExtra.length ? extra : null,
        },
      });
    });
    res.status(201).json(await assembleScan(created));
  } catch (e) {
    next(e);
  }
});

// PATCH /api/scans/:id — update status and/or runtime settings.
router.patch('/:id', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const body = req.body || {};
    const result = await prisma.$transaction((tx) => patchScanIfPresent(tx, id, body));
    if (result.kind === 'not-found') return res.status(404).json({ error: 'Scan not found.' });
    if (result.kind === 'supplemental-in-use') {
      return res.status(409).json({
        error: 'Wait for supplemental post-script work to finish before resuming this scan.',
      });
    }
    res.json(await assembleScan(result.scan));
  } catch (e) {
    next(e);
  }
});

// DELETE /api/scans/:id
router.delete('/:id', async (req, res, next) => {
  try {
    const id = BigInt(req.params.id);
    const result = await prisma.$transaction((tx) => deleteScanIfSafe(tx, id));
    if (result.kind === 'not-found') return res.status(404).json({ error: 'Scan not found.' });
    if (result.kind === 'not-terminal') {
      return res.status(409).json({
        error: `Cannot delete a ${result.status} scan. Stop it and wait for active work to finish first.`,
      });
    }
    if (result.kind === 'in-use') {
      return res.status(409).json({ error: 'Cannot delete: the engine is still writing scan results.' });
    }
    res.status(204).end();
  } catch (e) {
    next(e);
  }
});

export default router;

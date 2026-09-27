// Build the per-scan stage graph: one node per workflow step with attempt
// counts, edges between steps with lineage counts, and the post-processing
// funnel (dedupe, ranker, and every configured post-script). The function is
// pure so it can be exercised with plain rows; the route loads the rows.

import { configuredPostScriptIds, summarizeWorkflowLineageDetail } from './repo.js';

const ATTEMPT_STATUSES = ['completed', 'running', 'failed', 'interrupted', 'stopped'];
// Enrichment result keys whose values summarize a script's decision. Only keys
// that actually appear in a script's results are reported.
const OUTCOME_KEYS = ['verdict', 'poc_status', 'submission_ready'];
const POST_SCRIPT_KINDS = new Set(['post_script', 'v27_poc']);
const BUILTIN_STAGES = [
  { id: 'dedupe', kind: 'dedupe', name: 'Semantic dedupe' },
  { id: 'ranker', kind: 'ranker', name: 'Severity ranker' },
];

const key = (value) => (value === null || value === undefined ? null : value.toString());

function emptyAttempts() {
  return Object.fromEntries(ATTEMPT_STATUSES.map((status) => [status, 0]));
}

function countAttempt(attempts, status) {
  if (ATTEMPT_STATUSES.includes(status)) attempts[status] += 1;
}

function stepNodes(steps, metadata, results, vulnerabilities, lineages) {
  const ordered = [...steps].sort((a, b) => a.depth - b.depth || Number(a.id - b.id));
  const nodes = new Map(
    ordered.map((step) => [
      key(step.id),
      {
        id: key(step.id),
        stepId: key(step.id),
        name: step.name || 'Untitled step',
        depth: step.depth,
        multiOutput: !!step.multiOutput,
        consumesAll: !!step.consumesAll,
        isLastStep: !!step.isLastStep,
        boundSourceStepId: key(step.boundSourceStepId),
        attempts: emptyAttempts(),
        stubs: 0,
        expected: lineages.byStep[key(step.id)]?.expected || 0,
        records: 0,
      },
    ])
  );

  const metadataStep = new Map();
  for (const row of metadata) {
    if ((row.kind || 'step') !== 'step') continue;
    const node = nodes.get(key(row.stepId));
    if (!node) continue;
    metadataStep.set(key(row.id), node);
    countAttempt(node.attempts, row.status);
    if (row.status === 'completed' && row.stub) node.stubs += 1;
  }
  for (const row of results) nodes.get(key(row.stepId)) && (nodes.get(key(row.stepId)).records += 1);
  for (const row of vulnerabilities) {
    const node = metadataStep.get(key(row.scanMetadataId));
    if (node) node.records += 1;
  }
  return [...nodes.values()];
}

function stepEdges(metadata, results, lineages) {
  const resultStep = new Map(results.map((row) => [key(row.id), key(row.stepId)]));
  const attempted = new Map();
  for (const row of metadata) {
    if ((row.kind || 'step') !== 'step' || row.prevTable !== 'workflows.step_results') continue;
    const from = resultStep.get(key(row.prevId));
    if (!from) continue;
    const edgeKey = `${from}|${key(row.stepId)}`;
    if (!attempted.has(edgeKey)) attempted.set(edgeKey, new Set());
    attempted.get(edgeKey).add(key(row.prevId));
  }
  const edgeKeys = new Set([...attempted.keys(), ...Object.keys(lineages.edges)]);
  return [...edgeKeys]
    .map((edgeKey) => {
      const [from, to] = edgeKey.split('|');
      return { from, to, lineages: attempted.get(edgeKey)?.size || 0, expected: lineages.edges[edgeKey] || 0 };
    })
    .sort((a, b) => Number(a.from) - Number(b.from) || Number(a.to) - Number(b.to));
}

function outcomeCounts(rows) {
  const outcomes = {};
  for (const row of rows) {
    const result = row.result && typeof row.result === 'object' && !Array.isArray(row.result) ? row.result : {};
    for (const outcomeKey of OUTCOME_KEYS) {
      if (!(outcomeKey in result)) continue;
      const value = result[outcomeKey];
      const label = typeof value === 'boolean' ? String(value) : `${value ?? ''}`.trim() || 'unknown';
      outcomes[outcomeKey] ??= {};
      outcomes[outcomeKey][label] = (outcomes[outcomeKey][label] || 0) + 1;
    }
  }
  return outcomes;
}

function postFunnel(scan, vulnerabilities, enrichments, postMetadata, postScripts) {
  const canonical = vulnerabilities.filter((row) => row.dedupeIsCanonical === true).length;
  const duplicates = vulnerabilities.filter((row) => row.dedupeIsCanonical === false).length;
  const scriptNames = new Map(postScripts.map((script) => [key(script.id), script.name]));
  const stages = [
    ...BUILTIN_STAGES.map((stage) => ({ ...stage, attempts: emptyAttempts() })),
    ...configuredPostScriptIds(scan).map((id) => ({
      id: `post_script:${id}`,
      kind: 'post_script',
      postScriptId: `${id}`,
      name: scriptNames.get(`${id}`) || `Post-script ${id}`,
      attempts: emptyAttempts(),
      enrichments: 0,
      stubs: 0,
      outcomes: {},
    })),
  ];
  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  for (const row of postMetadata) {
    const stage = POST_SCRIPT_KINDS.has(row.kind)
      ? byId.get(`post_script:${key(row.postScriptId)}`)
      : byId.get(row.kind);
    if (stage) countAttempt(stage.attempts, row.status);
  }
  const enrichmentsByScript = new Map();
  for (const row of enrichments) {
    if (row.supplementalRunId != null) continue;
    const stage = byId.get(`post_script:${key(row.postScriptId)}`);
    if (!stage) continue;
    stage.enrichments += 1;
    if (row.stub) stage.stubs += 1;
    else {
      if (!enrichmentsByScript.has(stage.id)) enrichmentsByScript.set(stage.id, []);
      enrichmentsByScript.get(stage.id).push(row);
    }
  }
  for (const [stageId, rows] of enrichmentsByScript) byId.get(stageId).outcomes = outcomeCounts(rows);
  return {
    rawFindings: vulnerabilities.length,
    canonicalFindings: canonical,
    duplicateFindings: duplicates,
    stages,
  };
}

export function buildScanGraph({
  scan,
  steps,
  metadata = [],
  results = [],
  vulnerabilities = [],
  enrichments = [],
  postMetadata = [],
  postScripts = [],
}) {
  const stepRows = metadata.filter((row) => (row.kind || 'step') === 'step');
  const lineages = summarizeWorkflowLineageDetail(scan, steps, stepRows, results);
  return {
    scanId: key(scan.id),
    status: scan.status,
    nodes: stepNodes(steps, stepRows, results, vulnerabilities, lineages),
    edges: stepEdges(stepRows, results, lineages),
    post: postFunnel(scan, vulnerabilities, enrichments, postMetadata, postScripts),
  };
}

// Load every row the graph needs for one scan. `db` is the Prisma client (or a
// stand-in with the same shape) so the loader stays testable without Postgres.
export async function loadScanGraph(db, scan) {
  const scanId = BigInt(scan.id);
  const workflow = await db.workflow.findUnique({
    where: { id: BigInt(scan.workflowId) },
    select: { stepIds: true },
  });
  const stepIds = workflow?.stepIds || [];
  const postScriptIds = configuredPostScriptIds(scan).map((id) => BigInt(id));
  const [steps, metadata, results, vulnerabilities, enrichments, postMetadata, postScripts] = await Promise.all([
    stepIds.length ? db.step.findMany({ where: { id: { in: stepIds } } }) : [],
    db.stepMetadata.findMany({
      where: { scanId, kind: 'step' },
      select: {
        id: true,
        stepId: true,
        prevId: true,
        prevTable: true,
        repeatRun: true,
        kind: true,
        status: true,
        stub: true,
      },
    }),
    db.stepResult.findMany({
      where: { scanId },
      select: { id: true, stepId: true, prevId: true, prevTable: true, repeatRun: true },
    }),
    db.vulnerability.findMany({
      where: { scanId },
      select: { id: true, scanMetadataId: true, dedupeIsCanonical: true },
    }),
    db.vulnerabilityEnrichment.findMany({
      where: { scanId },
      select: { vulnerabilityId: true, postScriptId: true, stub: true, supplementalRunId: true, result: true },
    }),
    db.postProcessMetadata.findMany({
      where: { scanId },
      select: { kind: true, postScriptId: true, status: true },
    }),
    postScriptIds.length
      ? db.postScript.findMany({ where: { id: { in: postScriptIds } }, select: { id: true, name: true } })
      : [],
  ]);
  return buildScanGraph({ scan, steps, metadata, results, vulnerabilities, enrichments, postMetadata, postScripts });
}

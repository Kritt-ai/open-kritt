import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildScanGraph } from '../src/lib/scanGraph.js';

// A v2.7-shaped scan: one D0 mapper, three D1 lanes, three D2 investigators
// bound one-to-one to their lanes, then dedupe, ranker, and D3/D4/D5 scripts.
const steps = [
  {
    id: 1n,
    name: 'Map entrypoints',
    depth: 0,
    multiOutput: true,
    consumesAll: false,
    boundSourceStepId: null,
    isLastStep: false,
  },
  {
    id: 2n,
    name: 'D1 authority',
    depth: 1,
    multiOutput: false,
    consumesAll: false,
    boundSourceStepId: null,
    isLastStep: false,
  },
  {
    id: 3n,
    name: 'D1 state',
    depth: 1,
    multiOutput: false,
    consumesAll: false,
    boundSourceStepId: null,
    isLastStep: false,
  },
  {
    id: 4n,
    name: 'D1 input',
    depth: 1,
    multiOutput: false,
    consumesAll: false,
    boundSourceStepId: null,
    isLastStep: false,
  },
  {
    id: 5n,
    name: 'D2 authority',
    depth: 2,
    multiOutput: true,
    consumesAll: false,
    boundSourceStepId: 2n,
    isLastStep: true,
  },
  {
    id: 6n,
    name: 'D2 state',
    depth: 2,
    multiOutput: true,
    consumesAll: false,
    boundSourceStepId: 3n,
    isLastStep: true,
  },
  {
    id: 7n,
    name: 'D2 input',
    depth: 2,
    multiOutput: true,
    consumesAll: false,
    boundSourceStepId: 4n,
    isLastStep: true,
  },
];

const RESULTS = 'workflows.step_results';
const row = (id, stepId, prevId, status, extra = {}) => ({
  id: BigInt(id),
  stepId: BigInt(stepId),
  prevId: prevId === null ? null : BigInt(prevId),
  prevTable: prevId ? RESULTS : null,
  repeatRun: 1,
  kind: 'step',
  status,
  stub: false,
  ...extra,
});

const metadata = [
  row(100, 1, null, 'completed'), // D0 -> two entrypoints
  row(101, 2, 1, 'completed'), // lane A on entrypoint 1
  row(102, 2, 2, 'completed', { stub: true }), // lane A on entrypoint 2: nothing relevant
  row(103, 3, 1, 'completed'), // lane B on entrypoint 1
  row(104, 3, 2, 'running'), // lane B on entrypoint 2: still running
  row(105, 4, 1, 'completed'), // lane C on entrypoint 1
  row(106, 4, 2, 'failed'), // lane C on entrypoint 2: first attempt failed
  row(107, 4, 2, 'completed'), // lane C on entrypoint 2: retry succeeded
  row(108, 5, 3, 'completed'), // D2 authority on lane A record
  row(109, 6, 4, 'completed'), // D2 state on lane B record
  row(110, 7, 5, 'completed', { stub: true }), // D2 input on lane C record 1: nothing
  // D2 input on lane C record 2 (result 6) has not been attempted yet.
];

const results = [
  { id: 1n, stepId: 1n, prevId: 0n, prevTable: null, repeatRun: 1 },
  { id: 2n, stepId: 1n, prevId: 0n, prevTable: null, repeatRun: 1 },
  { id: 3n, stepId: 2n, prevId: 1n, prevTable: RESULTS, repeatRun: 1 },
  { id: 4n, stepId: 3n, prevId: 1n, prevTable: RESULTS, repeatRun: 1 },
  { id: 5n, stepId: 4n, prevId: 1n, prevTable: RESULTS, repeatRun: 1 },
  { id: 6n, stepId: 4n, prevId: 2n, prevTable: RESULTS, repeatRun: 1 },
];

const vulnerabilities = [
  { id: 41n, scanMetadataId: 108n, dedupeIsCanonical: true },
  { id: 42n, scanMetadataId: 108n, dedupeIsCanonical: false },
  { id: 43n, scanMetadataId: 109n, dedupeIsCanonical: true },
];

const enrichments = [
  { vulnerabilityId: 41n, postScriptId: 11n, stub: false, supplementalRunId: null, result: { verdict: 'confirmed' } },
  {
    vulnerabilityId: 43n,
    postScriptId: 11n,
    stub: false,
    supplementalRunId: null,
    result: { verdict: 'false_positive' },
  },
  {
    vulnerabilityId: 41n,
    postScriptId: 12n,
    stub: false,
    supplementalRunId: null,
    result: { poc_status: 'reproduced' },
  },
];

const postMetadata = [
  { kind: 'dedupe', postScriptId: null, status: 'completed' },
  { kind: 'ranker', postScriptId: null, status: 'completed' },
  { kind: 'post_script', postScriptId: 11n, status: 'completed' },
  { kind: 'post_script', postScriptId: 11n, status: 'completed' },
  { kind: 'v27_poc', postScriptId: 12n, status: 'completed' },
  { kind: 'post_script', postScriptId: 13n, status: 'running' },
];

const postScripts = [
  { id: 11n, name: 'v2.7 D3 Hostile Canonical Verification' },
  { id: 12n, name: 'v2.7 D4 Local PoC and Negative Control' },
  { id: 13n, name: 'v2.7 D5 Scope Severity and Report Readiness' },
];

const scan = {
  id: 9n,
  status: 'post_processing',
  postScriptId: 11n,
  configuration: { post_script_ids: ['11', '12', '13'], repeat_runs: 1 },
};

function graph() {
  return buildScanGraph({ scan, steps, metadata, results, vulnerabilities, enrichments, postMetadata, postScripts });
}

const node = (stepId) => graph().nodes.find((candidate) => candidate.stepId === String(stepId));
const edge = (from, to) =>
  graph().edges.find((candidate) => candidate.from === String(from) && candidate.to === String(to));

test('each workflow step becomes a node with attempt, stub, expected, and record counts', () => {
  const { nodes } = graph();
  assert.deepEqual(
    nodes.map((item) => item.stepId),
    ['1', '2', '3', '4', '5', '6', '7']
  );
  assert.deepEqual(node(1).attempts, { completed: 1, running: 0, failed: 0, interrupted: 0, stopped: 0 });
  assert.equal(node(1).depth, 0);
  assert.equal(node(1).expected, 1);
  assert.equal(node(1).records, 2);

  assert.equal(node(2).expected, 2);
  assert.equal(node(2).attempts.completed, 2);
  assert.equal(node(2).stubs, 1);
  assert.equal(node(2).records, 1);

  assert.equal(node(3).attempts.running, 1);
  assert.equal(node(3).attempts.completed, 1);

  assert.equal(node(4).attempts.failed, 1);
  assert.equal(node(4).attempts.completed, 2);
  assert.equal(node(4).records, 2);
});

test('terminal steps count findings as their records', () => {
  assert.equal(node(5).isLastStep, true);
  assert.equal(node(5).records, 2);
  assert.equal(node(6).records, 1);
  assert.equal(node(7).records, 0);
  assert.equal(node(7).stubs, 1);
});

test('expected lineages follow bound routing, including inputs not yet attempted', () => {
  assert.equal(node(5).expected, 1);
  assert.equal(node(6).expected, 1);
  assert.equal(node(7).expected, 2);
  assert.equal(node(7).attempts.completed, 1);
});

test('edges carry attempted and expected lineage counts and respect bound routing', () => {
  assert.deepEqual(edge(1, 2), { from: '1', to: '2', lineages: 2, expected: 2 });
  assert.deepEqual(edge(1, 3), { from: '1', to: '3', lineages: 2, expected: 2 });
  assert.deepEqual(edge(2, 5), { from: '2', to: '5', lineages: 1, expected: 1 });
  assert.deepEqual(edge(4, 7), { from: '4', to: '7', lineages: 1, expected: 2 });
  assert.equal(edge(2, 6), undefined);
  assert.equal(edge(3, 5), undefined);
  assert.equal(graph().edges.length, 6);
});

test('post-processing funnel reports dedupe totals and per-script outcomes', () => {
  const { post } = graph();
  assert.equal(post.rawFindings, 3);
  assert.equal(post.canonicalFindings, 2);
  assert.equal(post.duplicateFindings, 1);
  assert.deepEqual(
    post.stages.map((stage) => stage.id),
    ['dedupe', 'ranker', 'post_script:11', 'post_script:12', 'post_script:13']
  );
  const [dedupe, ranker, d3, d4, d5] = post.stages;
  assert.equal(dedupe.attempts.completed, 1);
  assert.equal(ranker.attempts.completed, 1);
  assert.equal(d3.name, 'v2.7 D3 Hostile Canonical Verification');
  assert.equal(d3.attempts.completed, 2);
  assert.equal(d3.enrichments, 2);
  assert.deepEqual(d3.outcomes, { verdict: { confirmed: 1, false_positive: 1 } });
  assert.equal(d4.attempts.completed, 1);
  assert.deepEqual(d4.outcomes, { poc_status: { reproduced: 1 } });
  assert.equal(d5.attempts.running, 1);
  assert.equal(d5.enrichments, 0);
  assert.deepEqual(d5.outcomes, {});
});

test('an empty scan produces nodes with zero counts and no edges', () => {
  const empty = buildScanGraph({
    scan: { ...scan, status: 'running' },
    steps,
    metadata: [],
    results: [],
    vulnerabilities: [],
    enrichments: [],
    postMetadata: [],
    postScripts,
  });
  assert.equal(empty.nodes.length, 7);
  assert.equal(empty.nodes[0].expected, 1);
  assert.equal(empty.nodes[1].expected, 0);
  assert.deepEqual(empty.edges, []);
  assert.equal(empty.post.rawFindings, 0);
});

test('loadScanGraph reads every table for one scan through the database client', async () => {
  const { loadScanGraph } = await import('../src/lib/scanGraph.js');
  const calls = [];
  const db = {
    workflow: {
      findUnique: async (args) => (calls.push(['workflow', args]), { stepIds: steps.map((step) => step.id) }),
    },
    step: { findMany: async (args) => (calls.push(['step', args]), steps) },
    stepMetadata: { findMany: async (args) => (calls.push(['stepMetadata', args]), metadata) },
    stepResult: { findMany: async (args) => (calls.push(['stepResult', args]), results) },
    vulnerability: { findMany: async (args) => (calls.push(['vulnerability', args]), vulnerabilities) },
    vulnerabilityEnrichment: { findMany: async (args) => (calls.push(['enrichment', args]), enrichments) },
    postProcessMetadata: { findMany: async (args) => (calls.push(['postMetadata', args]), postMetadata) },
    postScript: { findMany: async (args) => (calls.push(['postScript', args]), postScripts) },
  };
  const loaded = await loadScanGraph(db, { ...scan, workflowId: 7n });
  assert.equal(loaded.scanId, '9');
  assert.equal(loaded.nodes.length, 7);
  assert.equal(loaded.post.canonicalFindings, 2);
  const byTable = Object.fromEntries(calls);
  assert.deepEqual(byTable.workflow.where, { id: 7n });
  assert.deepEqual(byTable.step.where, { id: { in: steps.map((step) => step.id) } });
  for (const table of ['stepMetadata', 'stepResult', 'vulnerability', 'enrichment', 'postMetadata']) {
    assert.equal(byTable[table].where.scanId, 9n, table);
  }
  assert.deepEqual(byTable.stepMetadata.where.kind, 'step');
  assert.deepEqual(byTable.postScript.where, { id: { in: [11n, 12n, 13n] } });
});

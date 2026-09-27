import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validatePostScript, validateWorkflow } from '../backend/src/lib/validation.js';
import { parseWorkflowImport } from '../frontend/src/lib/workflowTransfer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../workflow-packs/web3-v2.7');
const workflowPath = path.join(root, '01-recall-first-verified-external-flow-review-v2.7.workflow.json');

async function loadWorkflow() {
  return parseWorkflowImport(await readFile(workflowPath, 'utf8'));
}

test('v2.7 bounds fan-out and routes each D1 lane only to its matching D2 investigator', async () => {
  const workflow = await loadWorkflow();
  const valid = validateWorkflow(workflow);

  assert.equal(valid.maxDepth, 2);
  assert.deepEqual(valid.levels.map((level) => level.steps.length), [1, 3, 3]);
  assert.equal(valid.levels[0].multiOutput, true);
  assert.equal(valid.levels[1].multiOutput, false);
  assert.equal(valid.levels[2].multiOutput, true);
  assert.ok(valid.levels.every((level) => !level.consumesAll));
  assert.equal(valid.levels[1].bindPrevious, false);
  assert.equal(valid.levels[2].bindPrevious, true);
  assert.deepEqual(
    valid.levels[2].steps.map((step) => step.boundSourceStepId),
    valid.levels[1].steps.map((step) => step.clientId)
  );
  assert.match(valid.levels[1].steps[0].content, /AT MOST ONE output record/);
  assert.match(valid.levels[2].steps[0].content, /ONE record per root cause/);
});

test('v2.7 persists D2 candidates before post-processing and defines separate D3, D4, D5 scripts', async () => {
  const workflow = await loadWorkflow();
  const terminal = workflow.levels[2].outputFormat;
  for (const key of [
    'summary', 'explanation', 'file_path', 'line', 'trigger_flow', 'malicious_actor',
    'malicious_input_example', 'vulnerability_type', 'root_cause_fingerprint', 'fix_locus',
  ]) {
    assert.ok(key in terminal, key);
  }

  const names = [
    'd3-hostile-verification.post-script.json',
    'd4-local-poc.post-script.json',
    'd5-report-readiness.post-script.json',
  ];
  const scripts = await Promise.all(names.map(async (name) =>
    JSON.parse(await readFile(path.join(root, 'post-scripts', name), 'utf8'))
  ));
  scripts.forEach((script) => validatePostScript(script));
  assert.equal(scripts[0].outputFormat.verdict, 'string');
  assert.equal(scripts[1].outputFormat.poc_artifact_paths, 'array');
  assert.equal(scripts[2].outputFormat.submission_ready, 'boolean');
});

// ---------------------------------------------------------------------------
// v2.7 evidence-to-impact stage contracts
// ---------------------------------------------------------------------------

const POST_SCRIPT_NAMES = {
  'd3-hostile-verification.post-script.json': 'v2.7 D3 Hostile Canonical Verification',
  'd4-local-poc.post-script.json': 'v2.7 D4 Local PoC and Negative Control',
  'd5-report-readiness.post-script.json': 'v2.7 D5 Scope Severity and Report Readiness',
};

const HOP_STATUSES = ['proven', 'falsified', 'partial', 'unverified', 'blocked', 'not_applicable'];
const ASSUMPTION_KINDS = ['deployment', 'configuration', 'dependency', 'actor', 'economic', 'other'];
const ASSUMPTION_STATUSES = ['open', 'resolved', 'falsified'];
const IMPACT_FAMILIES = [
  'unauthorized_action', 'funds_loss', 'availability_loss', 'resource_exhaustion',
  'consensus_failure', 'integrity_violation', 'confidentiality_loss', 'privilege_escalation',
  'temporary_freezing', 'permanent_freezing', 'other',
];
const OBJECTIVE_SOURCES = ['bounty_rule', 'audit_spec', 'threat_model', 'engagement_scope', 'researcher_hypothesis'];
const ALLOWED_TEMPLATE_REFS = new Set([
  'repo_full', 'commit_sha', 'repo_scope', 'dependencies', 'configuration', 'summary',
  'vulnerability_type', 'file_path', 'line', 'malicious_actor', 'malicious_input_example',
  'trigger_flow', 'explanation',
]);
// Bounty programs, audit platforms, chains, and projects that must never leak into a
// generic prompt. Matched on word boundaries, case-insensitively.
const FORBIDDEN_PROGRAM_NAMES = [
  'somnia', 'immunefi', 'code4rena', 'sherlock', 'cantina', 'hackerone', 'bugcrowd', 'hats',
  'bitcoin', 'btc', 'ethereum', 'solana', 'polygon', 'arbitrum', 'optimism', 'avalanche',
  'cosmos', 'polkadot', 'sui', 'aptos', 'near', 'monad', 'uniswap', 'aave', 'compound',
  'makerdao', 'lido', 'chainlink',
];

const HOP_DESCRIPTOR = {
  type: 'object',
  fields: {
    id: 'string',
    claim: 'string',
    status: { type: 'string', enum: HOP_STATUSES },
    evidence_paths: { type: 'array', items: 'string' },
    covers: { type: 'array', items: 'string' },
    assessment: 'string',
  },
  required: ['id', 'claim', 'status', 'evidence_paths', 'covers', 'assessment'],
};

const ASSUMPTION_DESCRIPTOR = {
  type: 'object',
  fields: {
    id: 'string',
    assumption: 'string',
    kind: { type: 'string', enum: ASSUMPTION_KINDS },
    material: 'boolean',
    status: { type: 'string', enum: ASSUMPTION_STATUSES },
  },
  required: ['id', 'assumption', 'kind', 'material', 'status'],
};

async function loadPostScripts() {
  const entries = await Promise.all(Object.keys(POST_SCRIPT_NAMES).map(async (name) => [
    name,
    JSON.parse(await readFile(path.join(root, 'post-scripts', name), 'utf8')),
  ]));
  return Object.fromEntries(entries);
}

function collectKeys(definition, found = []) {
  if (!definition || typeof definition !== 'object') return found;
  for (const [key, value] of Object.entries(definition.fields ?? definition)) {
    found.push(key);
    if (value && typeof value === 'object') {
      if (value.fields) collectKeys(value, found);
      if (value.items) collectKeys(value.items, found);
    }
  }
  return found;
}

function templateRefs(content) {
  return [...content.matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g)].map((match) => match[1]);
}

test('v2.7 post-scripts keep their names and validate', async () => {
  const scripts = await loadPostScripts();
  for (const [file, name] of Object.entries(POST_SCRIPT_NAMES)) {
    assert.equal(scripts[file].name, name);
    const validated = validatePostScript(scripts[file]);
    assert.equal(validated.name, name);
  }
});

test('v2.7 D3 defines the proof target with structured descriptors', async () => {
  const { 'd3-hostile-verification.post-script.json': d3 } = await loadPostScripts();
  const format = d3.outputFormat;
  for (const key of [
    'verdict', 'reason', 'reachability_evidence', 'guard_analysis', 'impact_evidence',
    'negative_control_plan', 'missing_evidence', 'novelty_status', 'scope_status',
    'bug_claim', 'impact_claim', 'falsification_plan', 'first_unsupported_hop',
  ]) {
    assert.equal(format[key], 'string', key);
  }
  assert.deepEqual(format.impact_family, { type: 'string', enum: IMPACT_FAMILIES });
  assert.deepEqual(format.impact_definition_status, {
    type: 'string',
    enum: ['defined', 'ambiguous', 'unavailable'],
  });
  assert.deepEqual(format.impact_objective, {
    type: 'object',
    fields: {
      claim: 'string',
      source_type: { type: 'string', enum: OBJECTIVE_SOURCES },
      source_reference: 'string',
      affected_subject: 'string',
      terminal_outcome: 'string',
      required_evidence: { type: 'array', items: 'string' },
    },
    required: ['claim', 'source_type', 'source_reference', 'affected_subject', 'terminal_outcome', 'required_evidence'],
  });
  assert.deepEqual(format.evidence_dimensions, {
    type: 'array',
    items: {
      type: 'object',
      fields: {
        tag: 'string',
        status: { type: 'string', enum: ['required', 'not_applicable'] },
        rationale: 'string',
      },
      required: ['tag', 'status', 'rationale'],
    },
  });
  assert.deepEqual(format.impact_chain_plan, { type: 'array', items: HOP_DESCRIPTOR });
  assert.deepEqual(format.unverified_assumptions, { type: 'array', items: ASSUMPTION_DESCRIPTOR });
  assert.ok(!('evidence' in format.impact_chain_plan.items.fields), 'hops use evidence_paths, not evidence');

  for (const rule of [
    /hedged/i, /first_unsupported_hop/, /falsification_plan/, /unverified_assumptions/,
    /impact_objective/, /evidence_dimensions/, /impact_chain_plan/, /Do not build or run a PoC/,
  ]) {
    assert.match(d3.content, rule);
  }
});

test('v2.7 D4 separates bug reproduction from impact proof', async () => {
  const { 'd4-local-poc.post-script.json': d4 } = await loadPostScripts();
  const format = d4.outputFormat;
  assert.equal(format.poc_status, 'string');
  assert.equal(format.poc_artifact_paths, 'array');
  assert.equal(format.poc_artifact_dir, 'string');
  assert.equal(format._reserved_poc, 'string');
  for (const key of ['observed_behavior', 'claimed_impact', 'observed_terminal_outcome', 'remaining_limits']) {
    assert.equal(format[key], 'string', key);
  }
  assert.deepEqual(format.bug_status, {
    type: 'string',
    enum: ['reproduced', 'not_reproduced', 'blocked', 'falsified'],
  });
  assert.deepEqual(format.impact_status, {
    type: 'string',
    enum: ['proven', 'partial', 'not_proven', 'blocked', 'falsified'],
  });
  assert.deepEqual(format.blocker_kind, {
    type: 'string',
    enum: ['none', 'missing_dependency', 'missing_configuration', 'deployment_fact', 'unsafe_external', 'other'],
  });
  assert.deepEqual(format.negative_control_status, { type: 'string', enum: ['passed', 'failed', 'unavailable'] });
  assert.deepEqual(format.repeatability_status, {
    type: 'string',
    enum: ['deterministic', 'non_deterministic', 'not_tested'],
  });
  assert.deepEqual(format.impact_chain, { type: 'array', items: HOP_DESCRIPTOR });
  assert.deepEqual(format.impact_artifact_paths, { type: 'array', items: 'string' });
  assert.deepEqual(format.missing_impact_links, { type: 'array', items: 'string' });
  assert.deepEqual(format.unverified_assumptions, { type: 'array', items: ASSUMPTION_DESCRIPTOR });

  for (const rule of [
    /bug_status/, /impact_status/, /observed_terminal_outcome/, /same id/,
    /Never remove, rename/, /not_applicable and an assessment/, /never justifies impact_status=proven/,
  ]) {
    assert.match(d4.content, rule);
  }
});

test('v2.7 D5 compares required against observed outcome and only claims readiness', async () => {
  const { 'd5-report-readiness.post-script.json': d5 } = await loadPostScripts();
  const format = d5.outputFormat;
  assert.equal(format.submission_ready, 'boolean');
  assert.equal(format._reserved_report, 'string');
  for (const key of [
    'scope_status', 'severity', 'novelty_status', 'impact_evidence', 'artifact_reference',
    'scope_evidence', 'novelty_evidence', 'report_readiness_reason',
  ]) {
    assert.equal(format[key], 'string', key);
  }
  assert.deepEqual(format.missing_requirements, { type: 'array', items: 'string' });
  assert.deepEqual(format.impact_match_status, {
    type: 'string',
    enum: ['exact', 'partial', 'none', 'rules_unavailable'],
  });
  assert.deepEqual(format.impact_evidence_status, {
    type: 'string',
    enum: ['verified', 'insufficient', 'contradictory'],
  });
  assert.deepEqual(format.impact_mapping, {
    type: 'array',
    items: {
      type: 'object',
      fields: {
        required_outcome: 'string',
        observed_outcome: 'string',
        status: { type: 'string', enum: ['proven', 'missing', 'contradicted'] },
        evidence_paths: { type: 'array', items: 'string' },
      },
      required: ['required_outcome', 'observed_outcome', 'status', 'evidence_paths'],
    },
  });

  for (const rule of [
    /required_outcome/, /observed_outcome/, /submission_ready is your claim only/,
    /engine evaluates readiness/, /missing_requirements as an array of strings/,
  ]) {
    assert.match(d5.content, rule);
  }
});

test('v2.7 post-scripts never declare engine-owned keys', async () => {
  const scripts = await loadPostScripts();
  for (const [file, script] of Object.entries(scripts)) {
    const keys = collectKeys(script.outputFormat);
    assert.ok(keys.length > 0, file);
    for (const key of keys) {
      assert.ok(!key.startsWith('_engine_'), `${file}: ${key} uses the reserved _engine_ prefix`);
      assert.notEqual(key, '_chip_lifecycle', `${file}: _chip_lifecycle is engine-owned`);
    }
  }
});

test('v2.7 post-script prompts stay generic and use only reserved finding references', async () => {
  const scripts = await loadPostScripts();
  for (const [file, script] of Object.entries(scripts)) {
    const haystack = `${script.name}\n${script.description ?? ''}\n${script.content}`;
    for (const name of FORBIDDEN_PROGRAM_NAMES) {
      const pattern = new RegExp(`\\b${name}\\b`, 'i');
      assert.ok(!pattern.test(haystack), `${file}: prompt mentions "${name}"`);
    }
    const refs = new Set(templateRefs(script.content));
    assert.ok(refs.size > 0, file);
    for (const ref of refs) assert.ok(ALLOWED_TEMPLATE_REFS.has(ref), `${file}: unexpected reference {{${ref}}}`);
    assert.ok(!/\{\{\s*extra\./.test(script.content), `${file}: extra references are not allowed`);
  }
});

test('v2.7 D3 and D5 tie novelty verification to the known-issues corpus', async () => {
  const scripts = await loadPostScripts();
  for (const file of ['d3-hostile-verification.post-script.json', 'd5-report-readiness.post-script.json']) {
    const content = scripts[file].content;
    assert.match(content, /\.open-kritt\/known-issues\/INDEX\.md/, `${file} must point at the corpus index`);
    assert.match(content, /novel_verified[^.]*searched[^.]*corpus/i, `${file} must require searched corpus files`);
    assert.match(content, /unreadable[^.]*unverified/i, `${file} must keep unreadable sources unverified`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';

import { prismaUniqueConflict } from '../src/app.js';
import { DEFAULT_WORKFLOW_NAMES } from '../src/lib/defaultWorkflows.js';
import { validateScanJobLimit, ValidationError } from '../src/lib/validation.js';
import { agentSkillMutationState, countAgentSkillScanUsage } from '../src/routes/agentSkills.js';
import { summarizeCanonicalFindings } from '../src/routes/overview.js';
import { countPostScriptScanUsage, postScriptMutationState } from '../src/routes/postScripts.js';
import {
  ACTIVE_SCAN_STATUSES,
  deleteScanIfSafe,
  deleteScanOwnedData,
  lockScanConfigurationResources,
  patchScanIfPresent,
  requiredScanExtraKeys,
  scanLaunchDecision,
  validateScanRuntimeUpdate,
} from '../src/routes/scans.js';
import { deleteWorkflowIfUnused, replaceWorkflowIfUnused } from '../src/routes/workflows.js';

test('scan creation requests a launch choice only while another scan is active', () => {
  assert.deepEqual(scanLaunchDecision({}, 0), { kind: 'ready', status: 'pending' });
  assert.deepEqual(scanLaunchDecision({}, 1), { kind: 'choice-required' });
  assert.deepEqual(ACTIVE_SCAN_STATUSES, ['prewarming_cache', 'running', 'post_processing']);
});

test('scan launch choices map immediate work to pending and queued work to queued', () => {
  assert.deepEqual(scanLaunchDecision({ launchPolicy: 'immediate' }, 3), { kind: 'ready', status: 'pending' });
  assert.deepEqual(scanLaunchDecision({ launch_policy: 'queue' }, 3), { kind: 'ready', status: 'queued' });
  assert.throws(
    () => scanLaunchDecision({ launchPolicy: 'later' }, 1),
    (error) => error instanceof ValidationError && error.errors[0]?.field === 'launchPolicy'
  );
});

test('referenced workflows cannot be rewritten or have their steps deleted', async () => {
  const mutations = [];
  const tx = {
    $queryRaw: async () => [],
    workflow: {
      findUnique: async () => ({ id: 7n, stepIds: [10n, 11n] }),
      update: async () => mutations.push('workflow.update'),
    },
    scan: { count: async () => 3 },
    step: {
      create: async () => mutations.push('step.create'),
      deleteMany: async () => mutations.push('step.deleteMany'),
    },
  };

  const result = await replaceWorkflowIfUnused(tx, 7n, {
    name: 'Changed',
    description: '',
    levels: [],
    maxDepth: 0,
    extraKeys: [],
  });

  assert.deepEqual(result, { kind: 'in-use', scanCount: 3 });
  assert.deepEqual(mutations, []);
});

test('referenced workflows cannot be deleted after taking the workflow row lock', async () => {
  const calls = [];
  const tx = {
    $queryRaw: async () => calls.push('lock'),
    workflow: {
      findUnique: async () => ({ id: 7n, name: 'Custom', stepIds: [10n] }),
      delete: async () => calls.push('workflow.delete'),
    },
    scan: { count: async () => 2 },
    step: { deleteMany: async () => calls.push('step.deleteMany') },
  };

  assert.deepEqual(await deleteWorkflowIfUnused(tx, 7n), { kind: 'in-use', scanCount: 2 });
  assert.deepEqual(calls, ['lock']);
});

test('unused custom workflows and their steps are deleted after the usage check', async () => {
  const calls = [];
  const tx = {
    $queryRaw: async () => calls.push({ operation: 'lock' }),
    workflow: {
      findUnique: async (args) => {
        calls.push({ operation: 'workflow.findUnique', args });
        return { id: 7n, name: 'Custom', stepIds: [10n, 11n] };
      },
      delete: async (args) => calls.push({ operation: 'workflow.delete', args }),
    },
    scan: {
      count: async (args) => {
        calls.push({ operation: 'scan.count', args });
        return 0;
      },
    },
    step: { deleteMany: async (args) => calls.push({ operation: 'step.deleteMany', args }) },
  };

  assert.deepEqual(await deleteWorkflowIfUnused(tx, 7n), { kind: 'deleted' });
  assert.deepEqual(calls, [
    { operation: 'lock' },
    { operation: 'workflow.findUnique', args: { where: { id: 7n } } },
    { operation: 'scan.count', args: { where: { workflowId: 7n } } },
    { operation: 'workflow.delete', args: { where: { id: 7n } } },
    { operation: 'step.deleteMany', args: { where: { id: { in: [10n, 11n] } } } },
  ]);
});

test('built-in and missing workflows cannot be deleted', async () => {
  const mutations = [];
  const defaultTx = {
    $queryRaw: async () => [],
    workflow: {
      findUnique: async () => ({ id: 7n, name: DEFAULT_WORKFLOW_NAMES[0], stepIds: [10n] }),
      delete: async () => mutations.push('workflow.delete'),
    },
    scan: { count: async () => mutations.push('scan.count') },
    step: { deleteMany: async () => mutations.push('step.deleteMany') },
  };
  assert.deepEqual(await deleteWorkflowIfUnused(defaultTx, 7n), { kind: 'default' });

  const missingTx = {
    ...defaultTx,
    workflow: { ...defaultTx.workflow, findUnique: async () => null },
  };
  assert.deepEqual(await deleteWorkflowIfUnused(missingTx, 99n), { kind: 'not-found' });
  assert.deepEqual(mutations, []);
});

test('scan cleanup deletes every owned record in dependency order', async () => {
  const calls = [];
  const deletion = (name) => ({
    deleteMany: async (args) => calls.push({ name, args }),
  });
  const tx = {
    vulnerability: {
      findMany: async () => [{ id: 31n }, { id: 32n }],
      deleteMany: async (args) => calls.push({ name: 'vulnerability', args }),
    },
    triage: deletion('triage'),
    vulnerabilityEnrichment: deletion('vulnerabilityEnrichment'),
    stepMetadata: deletion('stepMetadata'),
    postProcessMetadata: deletion('postProcessMetadata'),
    stepResult: deletion('stepResult'),
    scan: { delete: async (args) => calls.push({ name: 'scan', args }) },
  };

  await deleteScanOwnedData(tx, 9n);

  assert.deepEqual(
    calls.map((call) => call.name),
    ['triage', 'vulnerabilityEnrichment', 'stepMetadata', 'postProcessMetadata', 'vulnerability', 'stepResult', 'scan']
  );
  assert.deepEqual(calls[0].args, { where: { vulnerabilityId: { in: [31n, 32n] } } });
  for (const call of calls.slice(1)) {
    assert.deepEqual(call.args, call.name === 'scan' ? { where: { id: 9n } } : { where: { scanId: 9n } });
  }
});

test('scan deletion requires a terminal status and no active engine metadata', async () => {
  const mutations = [];
  const base = {
    $queryRaw: async () => [],
    vulnerability: { findMany: async () => [], deleteMany: async () => mutations.push('vulnerability') },
    triage: { deleteMany: async () => mutations.push('triage') },
    vulnerabilityEnrichment: { deleteMany: async () => mutations.push('enrichment') },
    stepResult: { deleteMany: async () => mutations.push('stepResult') },
  };
  const nonTerminal = {
    ...base,
    scan: { findUnique: async () => ({ id: 9n, status: 'running' }), delete: async () => mutations.push('scan') },
    stepMetadata: { count: async () => 0, deleteMany: async () => mutations.push('stepMetadata') },
    postProcessMetadata: { count: async () => 0, deleteMany: async () => mutations.push('postMetadata') },
  };
  assert.deepEqual(await deleteScanIfSafe(nonTerminal, 9n), { kind: 'not-terminal', status: 'running' });

  const active = {
    ...base,
    scan: { findUnique: async () => ({ id: 9n, status: 'stopped' }), delete: async () => mutations.push('scan') },
    stepMetadata: { count: async () => 1, deleteMany: async () => mutations.push('stepMetadata') },
    postProcessMetadata: { count: async () => 0, deleteMany: async () => mutations.push('postMetadata') },
  };
  assert.deepEqual(await deleteScanIfSafe(active, 9n), {
    kind: 'in-use',
    runningStepCount: 1,
    runningPostProcessCount: 0,
  });
  assert.deepEqual(mutations, []);

  const paused = {
    ...base,
    scan: { findUnique: async () => ({ id: 9n, status: 'paused' }), delete: async () => mutations.push('scan') },
    stepMetadata: { count: async () => 0, deleteMany: async () => mutations.push('stepMetadata') },
    postProcessMetadata: { count: async () => 0, deleteMany: async () => mutations.push('postMetadata') },
  };
  assert.deepEqual(await deleteScanIfSafe(paused, 9n), { kind: 'deleted' });
  assert.ok(mutations.includes('scan'));
});

test('runtime scan updates validate the complete prospective model selection', async () => {
  const current = {
    model: 'gpt-5.5',
    modelProvider: 'codex',
    harness: 'codex',
    thinkingEffort: 'high',
  };

  await assert.rejects(
    validateScanRuntimeUpdate({ harness: 'claude-code' }, current),
    (error) => error instanceof ValidationError && error.errors.some((item) => item.field === 'harness')
  );
  await assert.rejects(
    validateScanRuntimeUpdate({ model: { id: 'gpt-5.5' } }, current),
    (error) =>
      error instanceof ValidationError &&
      error.errors.some((item) => item.field === 'model' && item.message === 'Model must be a string.')
  );

  let checkedSelection = null;
  const data = await validateScanRuntimeUpdate({ model: 'gpt-5.6' }, current, {
    assertAvailable: async (selection) => {
      checkedSelection = selection;
    },
  });
  assert.deepEqual(data, { ...current, model: 'gpt-5.6' });
  assert.deepEqual(checkedSelection, { ...current, model: 'gpt-5.6' });
});

test('runtime PATCH locks the scan and atomically writes the full normalized tuple', async () => {
  const calls = [];
  const current = {
    id: 8n,
    status: 'paused',
    model: 'gpt-5.5',
    modelProvider: 'codex',
    harness: 'codex',
    thinkingEffort: null,
  };
  const tx = {
    $queryRaw: async () => calls.push('lock'),
    scan: {
      findUnique: async () => current,
      update: async ({ data }) => {
        calls.push({ data });
        return { ...current, ...data };
      },
    },
  };

  const result = await patchScanIfPresent(tx, 8n, { model: 'gpt-5.6' }, { assertAvailable: async () => {} });

  assert.equal(result.kind, 'updated');
  assert.deepEqual(calls, [
    'lock',
    {
      data: {
        model: 'gpt-5.6',
        modelProvider: 'codex',
        harness: 'codex',
        thinkingEffort: 'medium',
      },
    },
  ]);
});

test('runtime PATCH reads the model catalog through the transaction client', async () => {
  const calls = [];
  const current = {
    id: 8n,
    status: 'paused',
    model: 'gpt-5.5',
    modelProvider: 'codex',
    harness: 'codex',
    thinkingEffort: 'medium',
  };
  const tx = {
    $queryRaw: async () => calls.push('lock'),
    modelCatalog: {
      findUnique: async ({ where }) => {
        calls.push({ catalogProvider: where.provider });
        return {
          provider: where.provider,
          models: [{ id: 'gpt-5.6', thinkingEfforts: ['high'] }],
          defaultModel: 'gpt-5.6',
        };
      },
    },
    scan: {
      findUnique: async () => current,
      update: async ({ data }) => {
        calls.push({ data });
        return { ...current, ...data };
      },
    },
  };

  const result = await patchScanIfPresent(
    tx,
    8n,
    { model: 'gpt-5.6', thinking_effort: 'high' },
    {
      availabilityOptions: { providerConfigured: async () => true },
    }
  );

  assert.equal(result.kind, 'updated');
  assert.deepEqual(calls, [
    'lock',
    { catalogProvider: 'codex' },
    {
      data: {
        model: 'gpt-5.6',
        modelProvider: 'codex',
        harness: 'codex',
        thinkingEffort: 'high',
      },
    },
  ]);
});

test('failed scans resume through pending and establish a new error-history boundary', async () => {
  const calls = [];
  const existing = { id: 8n, status: 'failed', reasoning: { error: 'step 14 failed' } };
  const tx = {
    $queryRaw: async () => calls.push('lock'),
    scan: {
      findUnique: async () => existing,
      update: async ({ data }) => {
        calls.push({ data });
        return { ...existing, ...data };
      },
    },
  };

  const result = await patchScanIfPresent(tx, 8n, { status: 'pending' }, { assertAvailable: async () => {} });

  assert.equal(result.kind, 'updated');
  assert.equal(calls[0], 'lock');
  assert.equal(calls[1].data.status, 'pending');
  assert.equal(calls[1].data.reasoning, Prisma.DbNull);
  assert.ok(calls[1].data.lastResumedAt instanceof Date);
});

test('scan status updates accept only user-owned lifecycle transitions', async () => {
  const tx = {
    $queryRaw: async () => [],
    scan: {
      findUnique: async () => ({ id: 8n, status: 'running' }),
      update: async () => assert.fail('invalid transition must not mutate the scan'),
    },
  };

  await assert.rejects(
    patchScanIfPresent(tx, 8n, { status: 'completed' }, { assertAvailable: async () => {} }),
    (error) => error.status === 409
  );
});

test('scan job limits are validated and can be raised or removed', async () => {
  assert.equal(validateScanJobLimit('250'), 250);
  assert.equal(validateScanJobLimit(null), null);
  assert.throws(() => validateScanJobLimit('0'), ValidationError);
  assert.throws(() => validateScanJobLimit('1.5'), ValidationError);

  const writes = [];
  const tx = {
    $queryRaw: async () => [],
    scan: {
      findUnique: async () => ({ id: 8n, status: 'stopped', jobLimit: 100 }),
      update: async ({ data }) => {
        writes.push(data);
        return { id: 8n, status: 'stopped', ...data };
      },
    },
  };
  await patchScanIfPresent(tx, 8n, { jobLimit: 250 }, { assertAvailable: async () => {} });
  await patchScanIfPresent(tx, 8n, { jobLimit: null }, { assertAvailable: async () => {} });
  assert.deepEqual(writes, [{ jobLimit: 250 }, { jobLimit: null }]);
});

test('scan creation locks configured workflows, post-scripts, and agent skills in stable order', async () => {
  const locks = [];
  const tx = {
    $queryRaw: async (query, id) => {
      const table = query.join('').match(/public\.([a-z_]+)/)?.[1];
      locks.push([table, id]);
    },
  };

  await lockScanConfigurationResources(tx, {
    workflowId: 9n,
    postScriptIds: [5n, 2n],
    agentSkillIds: [4n, 1n],
  });

  assert.deepEqual(locks, [
    ['llm_workflows', 9n],
    ['post_scripts', 2n],
    ['post_scripts', 5n],
    ['agent_skills', 1n],
    ['agent_skills', 4n],
  ]);
});

test('scan extras include workflow and selected post-script prompt requirements', () => {
  const keys = requiredScanExtraKeys(
    { extra: ['stored_key', 'shared_key'] },
    [{ content: '{{extra.workflow_key}} and {{extra.shared_key}}' }],
    [
      { content: '{{extra.primary_post_script_key}} and {{extra.shared_key}}' },
      { content: '{{extra.secondary_post_script_key}}' },
    ]
  );

  assert.deepEqual(keys, [
    'stored_key',
    'shared_key',
    'workflow_key',
    'primary_post_script_key',
    'secondary_post_script_key',
  ]);
});

test('post-script deletion usage includes primary and secondary configuration ids', async () => {
  const tx = {
    scan: {
      findMany: async () => [
        { postScriptId: 4n, configuration: {} },
        { postScriptId: 1n, configuration: { post_script_ids: ['1', '4'] } },
        { postScriptId: 2n, configuration: { post_scripts: [{ id: 4 }] } },
        { postScriptId: 3n, configuration: { post_script_ids: ['3'] } },
      ],
    },
  };

  assert.equal(await countPostScriptScanUsage(tx, 4n), 3);
});

test('post-script mutation is blocked when a secondary configured id uses it', async () => {
  const tx = {
    $queryRaw: async () => [],
    postScript: { findUnique: async () => ({ id: 4n }) },
    scan: {
      findMany: async () => [{ postScriptId: 1n, configuration: { post_script_ids: ['1', '4'] } }],
    },
  };
  assert.deepEqual(await postScriptMutationState(tx, 4n), { kind: 'in-use', scanCount: 1 });
});

test('agent-skill mutation is blocked for direct and secondary configured ids', async () => {
  const scans = [
    { agentSkillIds: [4n], configuration: {} },
    { agentSkillIds: [], configuration: { agent_skill_ids: ['4'] } },
    { agentSkillIds: [], configuration: { agent_skills: [{ id: 4 }] } },
    { agentSkillIds: [3n], configuration: {} },
  ];
  const tx = {
    $queryRaw: async () => [],
    agentSkill: { findUnique: async () => ({ id: 4n }) },
    scan: { findMany: async () => scans },
  };

  assert.equal(await countAgentSkillScanUsage(tx, 4n), 3);
  assert.deepEqual(await agentSkillMutationState(tx, 4n), { kind: 'in-use', scanCount: 3 });
});

test('overview counts canonical and unprocessed findings but excludes duplicates', () => {
  assert.deepEqual(
    summarizeCanonicalFindings([
      { dedupeIsCanonical: true, jsonAnswer: { exploitable: true } },
      { dedupeIsCanonical: null, jsonAnswer: { exploitable: 'true' } },
      { dedupeIsCanonical: false, jsonAnswer: { exploitable: true } },
      { dedupeIsCanonical: true, jsonAnswer: { exploitable: false } },
    ]),
    { findingsCount: 3, exploitableCount: 2 }
  );
});

test('Prisma unique agent-skill slug failures become a field-level conflict', () => {
  assert.deepEqual(prismaUniqueConflict({ code: 'P2002', meta: { target: ['slug'] } }), {
    status: 409,
    body: {
      error: 'Agent skill slug already exists.',
      errors: [{ field: 'slug', message: 'Choose a unique agent skill slug.' }],
    },
  });
  assert.equal(prismaUniqueConflict({ code: 'P2025' }), null);
});

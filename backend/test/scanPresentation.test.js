import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cleanError,
  configuredPostScriptIds,
  errorIsFromPreviousRun,
  isDerivativeScanStatusError,
  knownError,
  orderScanErrorsForDisplay,
  summarizeExpectedWorkflowLineages,
} from '../src/lib/repo.js';
import { serializeScan } from '../src/lib/serialize.js';
import { SCAN_STATUSES } from '../src/lib/constants.js';

test('lineage summary includes unclaimed fan-out work in the denominator', () => {
  const scan = { configuration: {} };
  const steps = [
    { id: 10n, depth: 0, consumesAll: false, isLastStep: false },
    { id: 20n, depth: 1, consumesAll: false, isLastStep: true },
    { id: 21n, depth: 1, consumesAll: false, isLastStep: true },
    { id: 22n, depth: 1, consumesAll: false, isLastStep: true },
  ];
  const results = Array.from({ length: 71 }, (_, index) => ({
    id: BigInt(index + 1),
    stepId: 10n,
    prevId: null,
    prevTable: null,
    repeatRun: 1,
  }));
  const metadata = [
    {
      kind: 'step',
      status: 'completed',
      stepId: 10n,
      prevId: null,
      prevTable: null,
      repeatRun: 1,
    },
    ...results.slice(0, 7).map((result) => ({
      kind: 'step',
      status: 'completed',
      stepId: 20n,
      prevId: result.id,
      prevTable: 'workflows.step_results',
      repeatRun: 1,
    })),
  ];

  assert.deepEqual(summarizeExpectedWorkflowLineages(scan, steps, metadata, results), {
    expectedLineages: 214,
    completedLineages: 8,
  });
});

test('lineage summary repeats each concrete task before exposing accumulated output downstream', () => {
  const scan = { configuration: { repeat_runs: 2 } };
  const steps = [
    { id: 10n, depth: 0, consumesAll: false, isLastStep: false },
    { id: 20n, depth: 1, consumesAll: false, isLastStep: true },
  ];
  const results = [
    { id: 1n, stepId: 10n, prevId: null, prevTable: null, repeatRun: 1 },
    { id: 2n, stepId: 10n, prevId: null, prevTable: null, repeatRun: 2 },
  ];
  const firstRepeatOnly = [
    { kind: 'step', status: 'completed', stepId: 10n, prevId: null, prevTable: null, repeatRun: 1 },
  ];

  assert.deepEqual(summarizeExpectedWorkflowLineages(scan, steps, firstRepeatOnly, results), {
    expectedLineages: 2,
    completedLineages: 1,
  });

  const rootComplete = [
    ...firstRepeatOnly,
    { kind: 'step', status: 'completed', stepId: 10n, prevId: null, prevTable: null, repeatRun: 2 },
  ];
  assert.deepEqual(summarizeExpectedWorkflowLineages(scan, steps, rootComplete, results), {
    expectedLineages: 6,
    completedLineages: 2,
  });
});

test('configured post-scripts preserve primary-first order and remove duplicates', () => {
  assert.deepEqual(
    configuredPostScriptIds({
      postScriptId: 4n,
      configuration: { post_script_ids: ['4', { id: 3 }, 2, 'invalid', 3] },
    }),
    ['4', '3', '2']
  );
});

test('scan serialization distinguishes raw candidates from listed findings', () => {
  const serialized = serializeScan(
    {
      id: 58n,
      workflowId: 2n,
      postScriptId: 4n,
      repoFull: 'stacks-network/stacks-core',
      repoKind: 'remote',
      commitSha: '4a7dfc2',
      repoScope: 'full',
      dependencies: [],
      configuration: {},
      model: 'gpt-5.4',
      modelProvider: 'codex',
      harness: 'codex',
      thinkingEffort: 'xhigh',
      status: 'completed',
      agentSkillIds: [],
      insertedAt: new Date(),
      updatedAt: new Date(),
    },
    {
      findings: 14,
      rawCandidates: 18,
      canonicalFindings: 14,
      duplicateFindings: 4,
      exploitable: 8,
      postScriptName: 'Ease of exploitability',
      postScripts: [
        { id: 4n, name: 'Ease of exploitability' },
        { id: 3n, name: 'Patched since' },
        { id: 2n, name: 'Resource exhaustion' },
      ],
    }
  );

  assert.equal(serialized.findings, 14);
  assert.equal(serialized.rawCandidates, 18);
  assert.equal(serialized.duplicateFindings, 4);
  assert.equal(serialized.exploitable, 8);
  assert.deepEqual(serialized.postScriptNames, ['Ease of exploitability', 'Patched since', 'Resource exhaustion']);
  assert.equal(serialized.postScripts[0].primary, true);
});

test('scan serialization exposes durable logical-job limits and resume boundaries', () => {
  const resumedAt = new Date('2026-07-19T12:00:00Z');
  const serialized = serializeScan({
    id: 58n,
    workflowId: 2n,
    postScriptId: 4n,
    repoFull: 'owner/repo',
    commitSha: 'HEAD',
    repoScope: 'full',
    dependencies: [],
    configuration: {},
    model: 'gpt-5.4',
    harness: 'codex',
    status: 'running',
    jobLimit: 250,
    jobsStarted: 17,
    lastResumedAt: resumedAt,
    agentSkillIds: [],
    insertedAt: new Date(),
    updatedAt: new Date(),
  });

  assert.equal(serialized.jobLimit, 250);
  assert.equal(serialized.jobsStarted, 17);
  assert.equal(serialized.lastResumedAt, resumedAt);
  assert.equal(
    errorIsFromPreviousRun(serialized, {
      insertedAt: '2026-07-19T11:59:59Z',
      updatedAt: '2026-07-19T12:00:01Z',
    }),
    true
  );
  assert.equal(errorIsFromPreviousRun(serialized, { insertedAt: '2026-07-19T12:00:01Z' }), false);
});

test('scan serialization preserves explicit rate-limit scheduling state', () => {
  const reasoning = {
    code: 'rate_limited',
    retry_count: 3,
    retry_after: '2026-07-19T12:30:00Z',
  };
  const serialized = serializeScan({
    id: 58n,
    workflowId: 2n,
    postScriptId: 4n,
    repoFull: 'owner/repo',
    commitSha: '4a7dfc2',
    repoScope: 'full',
    dependencies: [],
    configuration: {},
    model: 'gpt-5.4',
    harness: 'codex',
    status: 'rate_limited',
    reasoning,
    agentSkillIds: [],
    insertedAt: new Date(),
    updatedAt: new Date(),
  });

  assert.equal(SCAN_STATUSES.includes('rate_limited'), true);
  assert.equal(serialized.status, 'rate_limited');
  assert.deepEqual(serialized.reasoning, reasoning);
});

test('provider failure presentation preserves safe retry history and identifies the cause', () => {
  const message =
    'step failed after 2 attempts: attempt 1: DNS lookup failed. Diagnostic: network_error. | ' +
    'attempt 2: The selected model is currently at capacity. Diagnostic: model_capacity.';

  assert.equal(knownError(message)?.title, 'Model at capacity');
  assert.equal(cleanError(message), message);
});

test('provider throttling and account quota exhaustion remain distinct', () => {
  const providerThrottle =
    'The model provider temporarily throttled this request because of server demand. ' +
    'This is not the account usage quota. Diagnostic: provider_throttled.';
  const accountQuota =
    'The model provider reports that this account reached its usage quota. ' + 'Diagnostic: account_quota_limited.';

  assert.equal(knownError(providerThrottle)?.title, 'Provider busy');
  assert.equal(knownError(accountQuota)?.title, 'Account quota exhausted');
  assert.deepEqual(knownError(accountQuota)?.fixLinks, [
    { label: 'View usage and limits in Accounts', url: '/accounts', internal: true },
  ]);
});

test('Claude reconnect failures link directly to Accounts', () => {
  const message =
    'workspace setup failed for step 54: Claude could not refresh its OAuth credential. ' +
    'Reconnect Claude in Accounts.';

  assert.equal(knownError(message)?.title, 'Claude sign-in required');
  assert.deepEqual(knownError(message)?.fixLinks, [
    { label: 'Open Accounts', url: '/accounts', internal: true },
  ]);
});

test('workspace disk exhaustion renders an actionable engine error', () => {
  const message = 'workspace setup failed for step 54: git clone failed: fatal: write error: No space left on device';

  assert.equal(knownError(message)?.title, 'Engine storage full');
  assert.equal(
    cleanError(message),
    'Engine storage full. The scanner ran out of disk space while creating a job workspace. ' +
      'Free local disk space, then resume the scan.'
  );
});

test('cyber policy diagnostics render the actionable provider cause', () => {
  const message =
    'step failed after 1 attempt: The model provider blocked this request under its cybersecurity safety policy. ' +
    'Diagnostic: cyber_safety_blocked.';

  assert.equal(knownError(message)?.title, 'Cyber access blocked');
  assert.equal(
    cleanError(message),
    'Cyber access blocked. OpenAI blocked this security task. Request cyber access or run the scan on another provider/model.'
  );
});

test('terminal scan cause outranks later cleanup interruptions', () => {
  const terminal = {
    id: 'scan-134',
    kind: 'scan',
    status: 'failed',
    message: 'Cyber access blocked.',
    knownError: { key: 'openai_cyber_access_blocked' },
    updatedAt: '2026-07-20T10:54:55Z',
  };
  const cleanup = {
    id: '9970',
    kind: 'step',
    status: 'stopped',
    message: 'scan became failed before harness started',
    knownError: null,
    updatedAt: '2026-07-20T10:55:05Z',
  };

  assert.equal(isDerivativeScanStatusError(cleanup.message), true);
  assert.equal(orderScanErrorsForDisplay([cleanup, terminal])[0], terminal);
});

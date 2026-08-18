import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeJobElapsedMs,
  activeJobRuntimeSelection,
  activeJobWorkflowDepth,
  cleanError,
  configuredPostScriptIds,
  errorIsFromPreviousRun,
  isDerivativeScanStatusError,
  knownError,
  orderScanErrorsForDisplay,
  summarizeExpectedWorkflowLineages,
} from '../src/lib/repo.js';
import {
  serializeScan,
  serializeStep,
  serializeSupplementalPostScriptRun,
  serializeVulnerability,
} from '../src/lib/serialize.js';
import { SCAN_STATUSES } from '../src/lib/constants.js';

test('active workers expose workflow depth only for workflow steps', () => {
  assert.equal(activeJobWorkflowDepth({ kind: 'step' }, { depth: 2 }), 2);
  assert.equal(activeJobWorkflowDepth({}, { depth: 0 }), 0);
  assert.equal(activeJobWorkflowDepth({ kind: 'post_script' }, { depth: 3 }), null);
  assert.equal(activeJobWorkflowDepth({ kind: 'step' }, null), null);
});

test('finding serialization exposes cumulative supplemental enrichment identity', () => {
  const vulnerability = serializeVulnerability(
    {
      id: 31n,
      scanId: 9n,
      jsonAnswer: { summary: 'Finding' },
      postScriptAnswer: null,
      insertedAt: new Date('2026-08-17T10:00:00Z'),
    },
    {
      enrichments: [
        {
          id: 71n,
          scanId: 9n,
          vulnerabilityId: 31n,
          postScriptId: 4n,
          postScriptName: 'Report',
          supplementalRunId: 41n,
          insertedAt: new Date('2026-08-17T10:01:00Z'),
        },
        {
          id: 72n,
          scanId: 9n,
          vulnerabilityId: 31n,
          postScriptId: 5n,
          postScriptName: 'PoC',
          supplementalRunId: 42n,
          insertedAt: new Date('2026-08-17T10:02:00Z'),
        },
      ],
    }
  );

  assert.deepEqual(vulnerability.supplementalPostScripts, {
    count: 2,
    runIds: ['41', '42'],
    lastRunAt: new Date('2026-08-17T10:02:00Z'),
  });
  assert.equal(vulnerability.enrichments[0].supplemental, true);
});

test('supplemental run serialization exposes model settings and safe target errors', () => {
  const serialized = serializeSupplementalPostScriptRun(
    {
      id: 41n,
      scanId: 9n,
      postScriptId: 4n,
      postScriptName: 'Report',
      model: 'gpt-5-codex',
      modelProvider: 'codex',
      harness: 'codex',
      thinkingEffort: 'high',
      status: 'completed_with_errors',
      targetCount: 1,
      completedCount: 0,
      failedCount: 1,
      insertedAt: new Date('2026-08-18T10:00:00Z'),
      updatedAt: new Date('2026-08-18T10:01:00Z'),
    },
    [
      {
        id: 51n,
        vulnerabilityId: 31n,
        status: 'failed',
        attempts: 2,
        error: 'The model timed out.',
      },
    ]
  );

  assert.equal(serialized.model, 'gpt-5-codex');
  assert.equal(serialized.modelProvider, 'codex');
  assert.equal(serialized.thinkingEffort, 'high');
  assert.equal(serialized.targets[0].error, 'The model timed out.');
});

test('step serialization exposes bound routing IDs as JSON-safe strings', () => {
  const serialized = serializeStep({
    id: 20n,
    name: 'Destination',
    depth: 1,
    multiOutput: true,
    consumesAll: false,
    boundSourceStepId: 10n,
    isLastStep: true,
    content: 'Review.',
    outputFormat: '{"finding":"string"}',
    outputTable: 'workflows.vulnerabilities',
  });

  assert.equal(serialized.boundSourceStepId, '10');
});

test('active worker duration begins at the harness phase instead of the earlier metadata claim', () => {
  const now = Date.parse('2026-08-02T12:00:00.000Z');
  const row = {
    status: 'running',
    phase: 'running_harness',
    runStartedAt: new Date('2026-08-02T09:00:00.000Z'),
    updatedAt: new Date('2026-08-02T11:04:00.000Z'),
    runTimeMs: 0,
  };

  assert.equal(activeJobElapsedMs(row, row.phase, now), 56 * 60 * 1000);
  assert.equal(activeJobElapsedMs({ ...row, phase: 'building_workspace' }, 'building_workspace', now), null);
  assert.equal(activeJobElapsedMs({ ...row, runTimeMs: 1234 }, 'writing_db', now), 1234);
});

test('active worker runtime resolves persisted metadata, depth overrides, and scan fallbacks in order', () => {
  const scan = {
    model: 'scan-model',
    modelProvider: 'codex',
    harness: 'codex',
    thinkingEffort: 'xhigh',
    modelOverrides: {
      2: {
        model: 'depth-model',
        model_provider: 'factory',
        harness: 'droid',
        thinking_effort: 'max',
      },
    },
  };

  assert.deepEqual(activeJobRuntimeSelection({ kind: 'step' }, { depth: 2 }, scan), {
    model: 'depth-model',
    modelProvider: 'factory',
    harness: 'droid',
    thinkingEffort: 'max',
  });
  assert.deepEqual(activeJobRuntimeSelection({ kind: 'step', model: 'persisted-model' }, { depth: 2 }, scan), {
    model: 'persisted-model',
    modelProvider: 'factory',
    harness: 'droid',
    thinkingEffort: 'max',
  });
});

test('post-processing workers use their recorded runtime or configured fallback', () => {
  const scan = {
    model: 'scan-model',
    modelProvider: 'codex',
    harness: 'codex',
    thinkingEffort: 'high',
    configuration: {
      post_processing_model: 'post-model',
      post_processing_model_provider: 'factory',
      post_processing_harness: 'droid',
      post_processing_thinking_effort: 'xhigh',
    },
  };

  assert.deepEqual(activeJobRuntimeSelection({ kind: 'post_script' }, null, scan), {
    model: 'post-model',
    modelProvider: 'factory',
    harness: 'droid',
    thinkingEffort: 'xhigh',
  });
  assert.deepEqual(activeJobRuntimeSelection({ kind: 'post_script', model: 'persisted-post-model' }, null, scan), {
    model: 'persisted-post-model',
    modelProvider: 'factory',
    harness: 'droid',
    thinkingEffort: 'xhigh',
  });
});

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

test('lineage summary counts only the one-to-one tasks selected by bound routing', () => {
  const scan = { configuration: {} };
  const steps = [
    { id: 10n, depth: 0, consumesAll: false, boundSourceStepId: null, isLastStep: false },
    { id: 11n, depth: 0, consumesAll: false, boundSourceStepId: null, isLastStep: false },
    { id: 20n, depth: 1, consumesAll: false, boundSourceStepId: 10n, isLastStep: true },
    { id: 21n, depth: 1, consumesAll: false, boundSourceStepId: 11n, isLastStep: true },
  ];
  const results = [
    { id: 1n, stepId: 10n, prevId: null, prevTable: null, repeatRun: 1 },
    { id: 2n, stepId: 11n, prevId: null, prevTable: null, repeatRun: 1 },
  ];
  const metadata = [
    { kind: 'step', status: 'completed', stepId: 10n, prevId: null, prevTable: null, repeatRun: 1 },
    { kind: 'step', status: 'completed', stepId: 11n, prevId: null, prevTable: null, repeatRun: 1 },
    {
      kind: 'step',
      status: 'completed',
      stepId: 20n,
      prevId: 1n,
      prevTable: 'workflows.step_results',
      repeatRun: 1,
    },
  ];

  assert.deepEqual(summarizeExpectedWorkflowLineages(scan, steps, metadata, results), {
    expectedLineages: 4,
    completedLineages: 3,
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
      configuration: {
        post_processing_model: 'gpt-5.6-sol',
        post_processing_model_provider: 'codex',
        post_processing_harness: 'codex',
        post_processing_thinking_effort: 'max',
      },
      model: 'gpt-5.4',
      modelProvider: 'codex',
      harness: 'codex',
      thinkingEffort: 'xhigh',
      modelOverrides: {
        1: {
          model: 'claude-sonnet',
          model_provider: 'claude',
          harness: 'claude-code',
          thinking_effort: 'high',
        },
      },
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
      workflowDepths: [0, 1],
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
  assert.deepEqual(serialized.workflowDepths, [0, 1]);
  assert.equal(serialized.postProcessingModelOverride, true);
  assert.equal(serialized.postProcessingModel, 'gpt-5.6-sol');
  assert.equal(serialized.postProcessingModelProvider, 'codex');
  assert.equal(serialized.postProcessingHarness, 'codex');
  assert.equal(serialized.postProcessingThinkingEffort, 'max');
  assert.deepEqual(serialized.modelOverrides, {
    1: {
      model: 'claude-sonnet',
      modelProvider: 'claude',
      harness: 'claude-code',
      thinkingEffort: 'high',
    },
  });
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

test('provider throttling, subagent limits, and account quota exhaustion remain distinct', () => {
  const providerThrottle =
    'The model provider temporarily throttled this request because of server demand. ' +
    'This is not the account usage quota. Diagnostic: provider_throttled.';
  const accountQuota =
    'The model provider reports that this account reached its usage quota. ' + 'Diagnostic: account_quota_limited.';
  const subagentLimit =
    'Codex reached a separate premium limit while starting a subagent. Diagnostic: subagent_limited.';

  assert.equal(knownError(providerThrottle)?.title, 'Provider busy');
  assert.equal(knownError(subagentLimit)?.title, 'Subagent limit reached');
  assert.equal(knownError(subagentLimit)?.fixLinks, undefined);
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
  assert.deepEqual(knownError(message)?.fixLinks, [{ label: 'Open Accounts', url: '/accounts', internal: true }]);
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

test('low-storage warning persistence failures explain the pause bug', () => {
  const message = 'psycopg.errors.InvalidParameterValue: cannot set path in scalar';

  assert.equal(knownError(message)?.title, 'Low-storage pause failed');
  assert.equal(
    cleanError(message),
    'Low-storage pause failed. The engine ran low on disk space, then could not save its automatic pause warning. ' +
      'Free disk space, lower Minimum free storage, or enable Ignore low-storage safeguard in Settings, then resume the scan; completed work is preserved.'
  );
  assert.deepEqual(knownError(message)?.fixLinks, [{ label: 'Open Settings', url: '/settings', internal: true }]);
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

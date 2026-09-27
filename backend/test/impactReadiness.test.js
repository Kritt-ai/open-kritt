import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  INVESTIGATION_KINDS,
  LEGACY_POLICY_VERSION,
  LEGACY_KIND_REASON,
  LEGACY_RESULT_REASON,
  READINESS_POLICY_VERSION,
  findingReadiness,
  investigationSettings,
  normalizeMissingRequirements,
  pipelineStages,
  readinessLabelForKind,
  stageForEnrichment,
  withEngineBlocks,
} from '../src/lib/impactReadiness.js';

const gatedScan = {
  configuration: {
    v27_pipeline: { d3: '3', d4: '4', d5: '5' },
    investigation_kind: 'public_bounty',
    investigation_kind_source: 'user',
    readiness_policy_version: READINESS_POLICY_VERSION,
  },
};
const legacyScan = { configuration: { v27_pipeline: { d3: '3', d4: '4', d5: '5' } } };

const enrichment = (postScriptId, result, extra = {}) => ({ postScriptId, result, stub: false, ...extra });

test('investigation settings default to the legacy snapshot without rewriting the scan', () => {
  assert.deepEqual(investigationSettings(legacyScan), {
    investigation_kind: 'internal_research',
    investigation_kind_source: 'legacy_default',
    readiness_policy_version: LEGACY_POLICY_VERSION,
  });
  assert.deepEqual(investigationSettings(null), {
    investigation_kind: 'internal_research',
    investigation_kind_source: 'legacy_default',
    readiness_policy_version: LEGACY_POLICY_VERSION,
  });
  assert.deepEqual(investigationSettings(gatedScan), {
    investigation_kind: 'public_bounty',
    investigation_kind_source: 'user',
    readiness_policy_version: READINESS_POLICY_VERSION,
  });
  // An unknown kind never elevates to a user selection.
  assert.equal(
    investigationSettings({ configuration: { investigation_kind: 'other', investigation_kind_source: 'user' } })
      .investigation_kind_source,
    'legacy_default'
  );
  assert.equal(legacyScan.configuration.investigation_kind, undefined);
});

test('readiness labels follow the investigation kind policy table', () => {
  assert.deepEqual(INVESTIGATION_KINDS, [
    'public_bounty',
    'audit_competition',
    'private_audit',
    'threat_model_validation',
    'internal_research',
  ]);
  assert.equal(readinessLabelForKind('public_bounty'), 'submission_ready');
  assert.equal(readinessLabelForKind('audit_competition'), 'submission_ready');
  assert.equal(readinessLabelForKind('private_audit'), 'report_ready');
  assert.equal(readinessLabelForKind('threat_model_validation'), 'report_ready');
  assert.equal(readinessLabelForKind('internal_research'), 'report_ready');
  assert.equal(readinessLabelForKind('unknown'), 'report_ready');
});

test('pipeline stages mirror the engine: three distinct positive ids or nothing', () => {
  assert.deepEqual(pipelineStages(gatedScan), { d3: '3', d4: '4', d5: '5' });
  assert.deepEqual(pipelineStages({ configuration: { v27_pipeline: { d3: 3n, d4: 4, d5: '5' } } }), {
    d3: '3',
    d4: '4',
    d5: '5',
  });
  assert.equal(pipelineStages({ configuration: {} }), null);
  assert.equal(pipelineStages({ configuration: { v27_pipeline: { d3: '3', d4: '3', d5: '5' } } }), null);
  assert.equal(pipelineStages({ configuration: { v27_pipeline: { d3: '3', d4: '0', d5: '5' } } }), null);
  assert.equal(pipelineStages({ configuration: { v27_pipeline: { d3: '3', d4: 'x', d5: '5' } } }), null);
  assert.equal(pipelineStages({ configuration: { v27_pipeline: { d3: '3', d5: '5' } } }), null);
  assert.equal(pipelineStages(undefined), null);

  assert.equal(stageForEnrichment({ postScriptId: 4n }, gatedScan), 'd4');
  assert.equal(stageForEnrichment({ postScriptId: '5' }, gatedScan), 'd5');
  assert.equal(stageForEnrichment({ postScriptId: '9' }, gatedScan), null);
  assert.equal(stageForEnrichment({ postScriptId: '3' }, { configuration: {} }), null);
});

test('missing_requirements normalizes legacy values and rejects malformed ones', () => {
  assert.deepEqual(normalizeMissingRequirements(undefined), []);
  assert.deepEqual(normalizeMissingRequirements(null), []);
  assert.deepEqual(normalizeMissingRequirements(''), []);
  assert.deepEqual(normalizeMissingRequirements('   '), []);
  assert.deepEqual(normalizeMissingRequirements('Need scope proof'), ['Need scope proof']);
  assert.deepEqual(normalizeMissingRequirements(['a', 'b']), ['a', 'b']);
  assert.deepEqual(normalizeMissingRequirements([]), []);
  assert.throws(() => normalizeMissingRequirements(['a', 1]), TypeError);
  assert.throws(() => normalizeMissingRequirements({ a: 1 }), TypeError);
  assert.throws(() => normalizeMissingRequirements(42), TypeError);
});

test('enrichments outside the pipeline and stubs get no engine blocks', () => {
  const result = { verdict: 'confirmed' };
  assert.equal(withEngineBlocks(enrichment('9', result), { scan: gatedScan }), result);
  assert.equal(withEngineBlocks(enrichment('3', result), { scan: { configuration: {} } }), result);
  assert.equal(withEngineBlocks(enrichment('3', result, { stub: true }), { scan: gatedScan }), result);
  assert.equal(withEngineBlocks(enrichment('3', null), { scan: gatedScan }), null);
  assert.equal(withEngineBlocks(enrichment('3', 'text'), { scan: gatedScan }), 'text');
  assert.equal(
    withEngineBlocks(enrichment('9', result), { stage: 'd3', scan: gatedScan })._engine_lifecycle.legacy,
    true
  );
});

test('legacy D3 results synthesize a lifecycle block without mutation', () => {
  const cases = [
    ['confirmed', 'code_confirmed'],
    ['plausible_needs_poc', 'code_confirmed'],
    ['false_positive', 'false_positive'],
    ['not_novel', 'not_advanced'],
    [undefined, 'not_advanced'],
  ];
  for (const [verdict, lifecycle] of cases) {
    const result = verdict === undefined ? { reason: 'x' } : { verdict, reason: 'x' };
    const frozen = Object.freeze({ ...result });
    const output = withEngineBlocks(enrichment('3', frozen), { scan: gatedScan });
    assert.notEqual(output, frozen);
    assert.deepEqual(output._engine_lifecycle, {
      lifecycle_status: lifecycle,
      policy_version: LEGACY_POLICY_VERSION,
      legacy: true,
    });
    assert.equal(output.reason, 'x');
    assert.equal(Object.hasOwn(frozen, '_engine_lifecycle'), false);
  }
});

test('persisted engine blocks are used verbatim', () => {
  const lifecycle = { lifecycle_status: 'code_confirmed', policy_version: READINESS_POLICY_VERSION, legacy: false };
  const d3 = withEngineBlocks(enrichment('3', { verdict: 'false_positive', _engine_lifecycle: lifecycle }), {
    scan: gatedScan,
  });
  assert.equal(d3._engine_lifecycle, lifecycle);

  const evidence = {
    bug_status: 'reproduced',
    impact_status: 'proven',
    lifecycle_status: 'impact_proven',
    policy_version: READINESS_POLICY_VERSION,
    legacy: false,
  };
  const d4 = withEngineBlocks(enrichment('4', { poc_status: 'blocked_dependency', _engine_evidence: evidence }), {
    scan: gatedScan,
  });
  assert.equal(d4._engine_evidence, evidence);

  const readiness = {
    ready: true,
    label: 'submission_ready',
    lifecycle_status: 'report_ready',
    blocking_reasons: [],
    checks: { d5_match: 'pass' },
    policy: 'public_bounty',
    policy_version: READINESS_POLICY_VERSION,
    evaluated_at: '2026-09-24T00:00:00Z',
    legacy: false,
  };
  const d5Result = { submission_ready: true, missing_requirements: 'legacy string', _engine_readiness: readiness };
  const d5 = withEngineBlocks(enrichment('5', d5Result), { scan: gatedScan });
  assert.equal(d5._engine_readiness, readiness);
  // missing_requirements is still normalized for persisted results.
  assert.deepEqual(d5.missing_requirements, ['legacy string']);
  assert.equal(d5Result.missing_requirements, 'legacy string');
});

test('legacy D4 results derive bug status from poc_status and never claim impact', () => {
  const expectations = [
    ['reproduced', 'reproduced', 'legacy_bug_reproduced_impact_unverified'],
    ['not_reproduced', 'not_reproduced', 'bug_not_reproduced'],
    ['invalidated_by_test', 'not_reproduced', 'bug_not_reproduced'],
    ['blocked_missing_dependency', 'blocked', 'bug_blocked'],
    ['blocked_environment', 'blocked', 'bug_blocked'],
    ['unsafe_external_dependency', 'blocked', 'bug_blocked'],
    ['non_deterministic', 'blocked', 'bug_blocked'],
    ['insufficient_evidence', 'not_reproduced', 'bug_not_reproduced'],
    [undefined, 'not_reproduced', 'bug_not_reproduced'],
  ];
  for (const [pocStatus, bugStatus, lifecycle] of expectations) {
    const result = { poc_artifact_dir: pocStatus === 'reproduced' ? '/artifacts/1' : '' };
    if (pocStatus !== undefined) result.poc_status = pocStatus;
    const output = withEngineBlocks(enrichment('4', Object.freeze(result)), { scan: gatedScan });
    assert.deepEqual(output._engine_evidence, {
      bug_status: bugStatus,
      impact_status: 'unverified',
      capture_complete: false,
      artifact_dir: pocStatus === 'reproduced' ? '/artifacts/1' : '',
      captured_paths: [],
      unresolved_paths: [],
      lifecycle_status: lifecycle,
      policy_version: LEGACY_POLICY_VERSION,
      legacy: true,
    });
    assert.notEqual(output._engine_evidence.bug_status, 'falsified');
    assert.equal(output.poc_status, pocStatus);
  }
  // Bug status is never rewritten when the model already reported it.
  const explicit = withEngineBlocks(enrichment('4', { bug_status: 'falsified', poc_status: 'reproduced' }), {
    scan: gatedScan,
  });
  assert.equal(explicit._engine_evidence.bug_status, 'falsified');
  assert.equal(explicit._engine_evidence.lifecycle_status, 'bug_falsified');
  assert.equal(explicit._engine_evidence.impact_status, 'unverified');
});

test('legacy D5 results synthesize a not-ready decision keyed on the scan snapshot', () => {
  const d4 = withEngineBlocks(enrichment('4', { poc_status: 'reproduced', poc_artifact_dir: '/a' }), {
    scan: gatedScan,
  });
  const d5Result = Object.freeze({ submission_ready: true, missing_requirements: '' });

  const explicitKind = withEngineBlocks(enrichment('5', d5Result), {
    scan: gatedScan,
    prior: { d4 },
  });
  assert.deepEqual(explicitKind._engine_readiness, {
    ready: false,
    label: 'submission_ready',
    lifecycle_status: 'legacy_bug_reproduced_impact_unverified',
    blocking_reasons: [LEGACY_RESULT_REASON],
    checks: {},
    policy: 'public_bounty',
    policy_version: LEGACY_POLICY_VERSION,
    evaluated_at: null,
    legacy: true,
  });
  assert.equal(explicitKind.model_readiness_claim, true);
  assert.deepEqual(explicitKind.missing_requirements, []);
  assert.equal(explicitKind.submission_ready, true);
  assert.equal(Object.hasOwn(d5Result, '_engine_readiness'), false);

  const legacyKind = withEngineBlocks(enrichment('5', { submission_ready: 'yes', missing_requirements: 'scope' }), {
    scan: legacyScan,
  });
  assert.deepEqual(legacyKind._engine_readiness, {
    ready: false,
    label: 'report_ready',
    lifecycle_status: 'code_confirmed',
    blocking_reasons: [LEGACY_KIND_REASON],
    checks: {},
    policy: 'internal_research',
    policy_version: LEGACY_POLICY_VERSION,
    evaluated_at: null,
    legacy: true,
  });
  assert.equal(legacyKind.model_readiness_claim, false);
  assert.deepEqual(legacyKind.missing_requirements, ['scope']);

  // Malformed legacy values are coerced at read time instead of throwing.
  const malformed = withEngineBlocks(enrichment('5', { missing_requirements: ['a', { b: 1 }] }), { scan: gatedScan });
  assert.deepEqual(malformed.missing_requirements, ['a', '{"b":1}']);
  assert.deepEqual(
    withEngineBlocks(enrichment('5', { missing_requirements: { b: 1 } }), { scan: gatedScan }).missing_requirements,
    ['{"b":1}']
  );
});

test('finding readiness reads the latest pipeline stage present', () => {
  assert.equal(findingReadiness({ enrichments: [] }, gatedScan), null);
  assert.equal(findingReadiness({ enrichments: [enrichment('9', { verdict: 'confirmed' })] }, gatedScan), null);
  assert.equal(
    findingReadiness({ enrichments: [enrichment('3', { verdict: 'confirmed' })] }, { configuration: {} }),
    null
  );
  assert.equal(
    findingReadiness({ enrichments: [enrichment('3', { verdict: 'confirmed' }, { stub: true })] }, gatedScan),
    null
  );

  const d3Only = findingReadiness({ enrichments: [enrichment('3', { verdict: 'false_positive' })] }, gatedScan);
  assert.equal(d3Only.stage, 'd3');
  assert.equal(d3Only.ready, false);
  assert.equal(d3Only.label, 'submission_ready');
  assert.equal(d3Only.lifecycleStatus, 'false_positive');
  assert.equal(d3Only.policyVersion, LEGACY_POLICY_VERSION);
  assert.equal(d3Only.legacy, true);
  assert.equal(d3Only.blockingReasons.length, 1);
  assert.match(d3Only.blockingReasons[0], /D3/);
  assert.equal(d3Only.lifecycle.lifecycle_status, 'false_positive');
  assert.equal(d3Only.evidence, null);
  assert.equal(d3Only.readiness, null);

  const throughD4 = findingReadiness(
    {
      enrichments: [
        enrichment('3', { verdict: 'confirmed' }),
        enrichment('4', { poc_status: 'reproduced', poc_artifact_dir: '/a' }),
      ],
    },
    gatedScan
  );
  assert.equal(throughD4.stage, 'd4');
  assert.equal(throughD4.lifecycleStatus, 'legacy_bug_reproduced_impact_unverified');
  assert.equal(throughD4.evidence.bug_status, 'reproduced');
  assert.equal(throughD4.lifecycle.lifecycle_status, 'code_confirmed');
  assert.match(throughD4.blockingReasons[0], /D4/);

  const readinessBlock = {
    ready: true,
    label: 'submission_ready',
    lifecycle_status: 'report_ready',
    blocking_reasons: [],
    checks: {},
    policy: 'public_bounty',
    policy_version: READINESS_POLICY_VERSION,
    evaluated_at: '2026-09-24T00:00:00Z',
    legacy: false,
  };
  const throughD5 = findingReadiness(
    {
      enrichments: [
        enrichment('3', { verdict: 'confirmed' }),
        enrichment('4', { poc_status: 'reproduced', poc_artifact_dir: '/a' }),
        enrichment('5', { submission_ready: true, _engine_readiness: readinessBlock }),
      ],
    },
    gatedScan
  );
  assert.deepEqual(throughD5, {
    stage: 'd5',
    ready: true,
    label: 'submission_ready',
    lifecycleStatus: 'report_ready',
    policyVersion: READINESS_POLICY_VERSION,
    legacy: false,
    blockingReasons: [],
    evidence: throughD5.evidence,
    lifecycle: throughD5.lifecycle,
    readiness: readinessBlock,
  });
  assert.equal(throughD5.evidence.legacy, true);

  // The newest non-stub enrichment of a stage wins; order in the array is chronological.
  const rerun = findingReadiness(
    {
      enrichments: [
        enrichment('4', { poc_status: 'not_reproduced' }),
        enrichment('4', { poc_status: 'reproduced', poc_artifact_dir: '/a' }),
        enrichment('4', { poc_status: 'blocked_x' }, { stub: true }),
      ],
    },
    gatedScan
  );
  assert.equal(rerun.lifecycleStatus, 'legacy_bug_reproduced_impact_unverified');

  // Legacy D5 decisions are never ready and always explain why.
  const legacyD5 = findingReadiness(
    { enrichments: [enrichment('5', { submission_ready: true, scope_status: 'in_scope_verified' })] },
    legacyScan
  );
  assert.equal(legacyD5.ready, false);
  assert.deepEqual(legacyD5.blockingReasons, [LEGACY_KIND_REASON]);
  assert.equal(legacyD5.readiness.legacy, true);
  assert.equal(legacyD5.lifecycleStatus, 'code_confirmed');
});

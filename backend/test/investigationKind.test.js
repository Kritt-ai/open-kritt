import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  INVESTIGATION_CONFIGURATION_KEYS,
  INVESTIGATION_KINDS,
  INVESTIGATION_KIND_SOURCES,
  assertImmutableInvestigationKeys,
  investigationKindForScan,
} from '../src/lib/investigationKind.js';
import { READINESS_POLICY_VERSION } from '../src/lib/v27Pipeline.js';
import { ValidationError } from '../src/lib/validation.js';

const gated = { d3: '11', d4: '12', d5: '13', readinessPolicyVersion: READINESS_POLICY_VERSION };

test('investigation kind constants match the spec', () => {
  assert.deepEqual(INVESTIGATION_KINDS, [
    'public_bounty',
    'audit_competition',
    'private_audit',
    'threat_model_validation',
    'internal_research',
  ]);
  assert.deepEqual(INVESTIGATION_KIND_SOURCES, ['user', 'legacy_default']);
  assert.deepEqual(INVESTIGATION_CONFIGURATION_KEYS, [
    'investigation_kind',
    'investigation_kind_source',
    'readiness_policy_version',
  ]);
});

test('gated scans require a valid investigation kind', () => {
  for (const configuration of [
    {},
    { investigation_kind: '' },
    { investigation_kind: 'bounty' },
    { investigation_kind: 7 },
  ]) {
    const result = investigationKindForScan(configuration, gated);
    assert.equal(result.errors.length, 1, JSON.stringify(configuration));
    assert.equal(result.errors[0].field, 'configuration.investigation_kind');
    assert.match(result.errors[0].message, /public_bounty/);
    assert.deepEqual(result.configuration, configuration);
  }
});

test('gated scans snapshot the source and readiness policy version', () => {
  for (const kind of INVESTIGATION_KINDS) {
    const input = { post_script_ids: ['1'], investigation_kind: kind };
    const result = investigationKindForScan(input, gated);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.configuration, {
      post_script_ids: ['1'],
      investigation_kind: kind,
      investigation_kind_source: 'user',
      readiness_policy_version: READINESS_POLICY_VERSION,
    });
    assert.notEqual(result.configuration, input);
  }
  // A client-supplied source is always replaced by the backend's own record.
  assert.equal(
    investigationKindForScan(
      { investigation_kind: 'private_audit', investigation_kind_source: 'legacy_default' },
      gated
    ).configuration.investigation_kind_source,
    'user'
  );
});

test('gated scans reject a readiness policy version that differs from the workflow gate', () => {
  const result = investigationKindForScan(
    { investigation_kind: 'public_bounty', readiness_policy_version: 'v9-unknown' },
    gated
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].field, 'configuration.readiness_policy_version');
  assert.deepEqual(
    investigationKindForScan(
      { investigation_kind: 'public_bounty', readiness_policy_version: READINESS_POLICY_VERSION },
      gated
    ).errors,
    []
  );
});

test('non-gated scans keep their configuration untouched', () => {
  for (const configuration of [{}, { investigation_kind: 'nonsense' }, { investigation_kind: 'public_bounty' }]) {
    const result = investigationKindForScan(configuration, null);
    assert.deepEqual(result.errors, []);
    assert.equal(result.configuration, configuration);
  }
  assert.deepEqual(investigationKindForScan(null, null), { configuration: {}, errors: [] });
});

test('run settings may omit or resubmit the investigation keys unchanged', () => {
  const existing = {
    investigation_kind: 'public_bounty',
    investigation_kind_source: 'user',
    readiness_policy_version: READINESS_POLICY_VERSION,
    post_processing_model: 'm',
  };
  assert.doesNotThrow(() => assertImmutableInvestigationKeys(existing, {}));
  assert.doesNotThrow(() => assertImmutableInvestigationKeys(existing, undefined));
  assert.doesNotThrow(() => assertImmutableInvestigationKeys(existing, { post_processing_model: 'other' }));
  assert.doesNotThrow(() => assertImmutableInvestigationKeys(existing, { ...existing }));
  assert.doesNotThrow(() => assertImmutableInvestigationKeys(existing, { investigation_kind: 'public_bounty' }));
  assert.doesNotThrow(() => assertImmutableInvestigationKeys({}, {}));
  assert.doesNotThrow(() => assertImmutableInvestigationKeys(null, { post_processing_model: 'x' }));
});

test('run settings reject changes, additions, and removals of the investigation keys', () => {
  const existing = {
    investigation_kind: 'public_bounty',
    investigation_kind_source: 'user',
    readiness_policy_version: READINESS_POLICY_VERSION,
  };
  const rejects = (current, incoming, field) =>
    assert.throws(
      () => assertImmutableInvestigationKeys(current, incoming),
      (error) => {
        assert.ok(error instanceof ValidationError);
        assert.equal(error.status, 422);
        assert.deepEqual(
          error.errors.map((item) => item.field),
          [field]
        );
        return true;
      }
    );
  rejects(existing, { investigation_kind: 'private_audit' }, 'configuration.investigation_kind');
  rejects(existing, { investigation_kind_source: 'legacy_default' }, 'configuration.investigation_kind_source');
  rejects(existing, { readiness_policy_version: 'legacy-unverified' }, 'configuration.readiness_policy_version');
  rejects(existing, { investigation_kind: null }, 'configuration.investigation_kind');
  rejects({}, { investigation_kind: 'public_bounty' }, 'configuration.investigation_kind');
  rejects(
    { post_processing_model: 'm' },
    { readiness_policy_version: READINESS_POLICY_VERSION },
    'configuration.readiness_policy_version'
  );

  assert.throws(
    () => assertImmutableInvestigationKeys(existing, { investigation_kind: 'x', readiness_policy_version: 'y' }),
    (error) => error instanceof ValidationError && error.errors.length === 2
  );
});

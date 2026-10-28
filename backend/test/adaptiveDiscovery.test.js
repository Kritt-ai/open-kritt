import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateAdaptiveDiscovery,
  validateAdaptiveDiscoveryWorkflow,
  validateScan,
  ValidationError,
} from '../src/lib/validation.js';

function adaptive(overrides = {}) {
  return { enabled: true, step_id: 11, max_paths: 20, wall_time_seconds: 600, ...overrides };
}

function configuration(overrides = {}, extra = {}) {
  return { ...extra, adaptive_discovery: adaptive(overrides) };
}

function scanBody(config) {
  return {
    workflowId: '1',
    postScriptId: '1',
    repo_kind: 'remote',
    repo_full: 'https://github.com/org/repo',
    commit_sha: 'HEAD',
    model: 'test-model',
    model_provider: 'codex',
    harness: 'codex',
    thinking_effort: 'high',
    severity_ranker: 'Rank by impact.',
    ...(config === undefined ? {} : { configuration: config }),
  };
}

function workflow() {
  return [
    { id: 11n, depth: 0, multiOutput: true, isLastStep: false },
    { id: 12n, depth: 1, multiOutput: false, isLastStep: true },
  ];
}

test('adaptive discovery is opt-in and leaves legacy configuration untouched', () => {
  const cases = [
    undefined,
    null,
    {},
    { repeat_runs: 3, arbitrary: { retained: true } },
    { adaptive_discovery: false, repeat_runs: 3 },
    { adaptive_discovery: { enabled: false, unknown_key: 'retained', max_paths: 'invalid' }, repeat_runs: 3 },
  ];
  for (const value of cases) {
    const before = structuredClone(value);
    assert.equal(validateAdaptiveDiscovery(value), null);
    assert.deepEqual(value, before);
  }
});

test('disabled adaptive discovery does not inspect its budgets, repeats, or workflow', () => {
  const disabled = {
    enabled: false,
    get max_paths() {
      throw new Error('Disabled budgets must not be inspected');
    },
  };
  const value = {
    adaptive_discovery: disabled,
    get repeat_runs() {
      throw new Error('Disabled repeats must not be inspected');
    },
  };
  assert.equal(validateAdaptiveDiscovery(value), null);
  assert.equal(validateAdaptiveDiscoveryWorkflow(value, null), null);
  assert.equal(validateAdaptiveDiscoveryWorkflow({ adaptive_discovery: false }, null), null);
  assert.equal(validateAdaptiveDiscoveryWorkflow({}, null), null);
});

test('enabled adaptive discovery accepts inclusive bounds without mutating configuration', () => {
  for (const limits of [
    { step_id: 1, max_paths: 1, wall_time_seconds: 1 },
    { step_id: Number.MAX_SAFE_INTEGER, max_paths: 1000, wall_time_seconds: 86400 },
  ]) {
    const value = configuration(limits, { arbitrary: { retained: true } });
    const before = structuredClone(value);
    assert.deepEqual(validateAdaptiveDiscovery(value), value.adaptive_discovery);
    assert.deepEqual(value, before);
  }
  assert.deepEqual(validateAdaptiveDiscovery(configuration({}, { repeat_runs: 1 })), adaptive());
});

test('adaptive discovery requires an explicit boolean enabled flag and object envelope', () => {
  for (const value of [null, true, 0, 1, '', 'true', [], {}, { enabled: undefined }]) {
    assert.throws(() => validateAdaptiveDiscovery({ adaptive_discovery: value }), ValidationError);
  }
  for (const enabled of [null, 0, 1, 'true', 'false', [], {}]) {
    assert.throws(() => validateAdaptiveDiscovery(configuration({ enabled })), ValidationError);
  }
});

test('enabled adaptive discovery rejects missing or unknown configuration keys', () => {
  for (const key of ['step_id', 'max_paths', 'wall_time_seconds']) {
    const value = configuration();
    delete value.adaptive_discovery[key];
    assert.throws(() => validateAdaptiveDiscovery(value), ValidationError);
  }
  assert.throws(() => validateAdaptiveDiscovery(configuration({ max_rounds: 3 })), ValidationError);
  assert.throws(() => validateAdaptiveDiscovery(configuration({ max_path: 20 })), ValidationError);
});

test('adaptive discovery limits reject coercions, non-finite values, fractions, and unsafe integers', () => {
  const invalid = [true, false, null, undefined, '', '1', 1.5, NaN, Infinity, -Infinity, [], {}, 0, -1];
  for (const key of ['step_id', 'max_paths', 'wall_time_seconds']) {
    for (const value of [...invalid, Number.MAX_SAFE_INTEGER + 1]) {
      assert.throws(
        () => validateAdaptiveDiscovery(configuration({ [key]: value })),
        ValidationError,
        `${key} must reject ${String(value)}`
      );
    }
  }
  assert.throws(() => validateAdaptiveDiscovery(configuration({ max_paths: 1001 })), ValidationError);
  assert.throws(() => validateAdaptiveDiscovery(configuration({ wall_time_seconds: 86401 })), ValidationError);
});

test('enabled adaptive discovery rejects repeat_runs conflicts instead of multiplying its budget', () => {
  for (const repeat_runs of [null, undefined, true, false, '1', 0, -1, 1.5, 2, NaN, Infinity, [], {}]) {
    assert.throws(() => validateAdaptiveDiscovery(configuration({}, { repeat_runs })), ValidationError);
  }
});

test('validateScan preserves absent and disabled adaptive configuration and unrelated keys', () => {
  assert.deepEqual(validateScan(scanBody()).configuration, {});
  for (const value of [
    { repeat_runs: 3, arbitrary: { retained: true } },
    { adaptive_discovery: false, repeat_runs: 3, arbitrary: ['retained'] },
    { adaptive_discovery: { enabled: false, max_paths: 'unchanged' }, repeat_runs: 3 },
  ]) {
    const before = structuredClone(value);
    for (const input of [value, JSON.stringify(value)]) {
      assert.deepEqual(validateScan(scanBody(input)).configuration, before);
    }
    assert.deepEqual(value, before);
  }
});

test('validateScan validates enabled adaptive discovery in object and JSON-string configuration', () => {
  const value = configuration({}, { repeat_runs: 1, arbitrary: { retained: true } });
  const before = structuredClone(value);
  for (const input of [value, JSON.stringify(value)]) {
    const valid = validateScan(scanBody(input));
    assert.deepEqual(valid.configuration, before);
    assert.equal(valid.model, 'test-model');
    assert.equal(valid.thinkingEffort, 'high');
  }
  assert.deepEqual(value, before);
  for (const invalid of [
    configuration({ max_paths: 0 }),
    configuration({ enabled: 'true' }),
    configuration({}, { repeat_runs: 2 }),
  ]) {
    for (const input of [invalid, JSON.stringify(invalid)]) {
      assert.throws(() => validateScan(scanBody(input)), ValidationError);
    }
  }
});

test('adaptive discovery selects the unique nonterminal multi-output root using its Prisma id', () => {
  const steps = workflow();
  const before = structuredClone(steps);
  assert.equal(validateAdaptiveDiscoveryWorkflow(configuration(), steps), steps[0]);
  assert.deepEqual(steps, before);
  const numericIds = steps.map((step) => ({ ...step, id: Number(step.id) }));
  assert.equal(validateAdaptiveDiscoveryWorkflow(configuration(), numericIds), numericIds[0]);
});

test('adaptive discovery rejects missing, ambiguous, or nonselected root steps', () => {
  assert.throws(() => validateAdaptiveDiscoveryWorkflow(configuration(), []), ValidationError);
  assert.throws(() => validateAdaptiveDiscoveryWorkflow(configuration(), workflow().slice(1)), ValidationError);
  assert.throws(
    () =>
      validateAdaptiveDiscoveryWorkflow(configuration(), [
        ...workflow(),
        { id: 13n, depth: 0, multiOutput: true, isLastStep: false },
      ]),
    ValidationError
  );
  assert.throws(() => validateAdaptiveDiscoveryWorkflow(configuration({ step_id: 12 }), workflow()), ValidationError);
  assert.throws(() => validateAdaptiveDiscoveryWorkflow(configuration({ step_id: 99 }), workflow()), ValidationError);
});

test('adaptive discovery rejects terminal or single-output root steps', () => {
  for (const change of [{ isLastStep: true }, { multiOutput: false }]) {
    const steps = workflow();
    steps[0] = { ...steps[0], ...change };
    assert.throws(() => validateAdaptiveDiscoveryWorkflow(configuration(), steps), ValidationError);
  }
});

test('legacy workflow validation bypass leaves multi-root and terminal workflows unchanged', () => {
  const steps = [
    { id: 11n, depth: 0, multiOutput: false, isLastStep: true },
    { id: 12n, depth: 0, multiOutput: false, isLastStep: true },
  ];
  const before = structuredClone(steps);
  for (const value of [{}, { adaptive_discovery: false }, { adaptive_discovery: { enabled: false }, repeat_runs: 3 }]) {
    assert.equal(validateAdaptiveDiscoveryWorkflow(value, steps), null);
  }
  assert.deepEqual(steps, before);
});
for (const { label, step_id, skip_attempted_step_ids } of [
  { label: 'numeric root ID', step_id: 4, skip_attempted_step_ids: [4] },
  { label: 'string root ID', step_id: 4, skip_attempted_step_ids: ['4'] },
  { label: 'root ID in a mixed list', step_id: 4, skip_attempted_step_ids: [2, '4', 5] },
  { label: 'fraction truncated to the root ID', step_id: 4, skip_attempted_step_ids: [4.5] },
  { label: 'boolean converted to root ID one', step_id: 1, skip_attempted_step_ids: [true] },
  { label: 'scalar string root ID', step_id: 4, skip_attempted_step_ids: '4' },
]) {
  test(`adaptive discovery rejects attempted-step skips matching ${label}`, () => {
    const value = configuration({ step_id }, { skip_attempted_step_ids });
    const before = structuredClone(value);
    const steps = [
      { id: BigInt(step_id), depth: 0, multiOutput: true, isLastStep: false },
      { id: BigInt(step_id + 1), depth: 1, multiOutput: false, isLastStep: true },
    ];
    assert.throws(() => validateAdaptiveDiscovery(value), ValidationError);
    assert.throws(() => validateAdaptiveDiscoveryWorkflow(value, steps), ValidationError);
    for (const input of [value, JSON.stringify(value)]) {
      assert.throws(() => validateScan(scanBody(input)), ValidationError);
    }
    assert.deepEqual(value, before);
  });
}

test('adaptive discovery preserves attempted-step skips that do not match its root', () => {
  const value = configuration({ step_id: 4 }, { skip_attempted_step_ids: [2, '3', 5] });
  const before = structuredClone(value);
  const steps = [
    { id: 4n, depth: 0, multiOutput: true, isLastStep: false },
    { id: 5n, depth: 1, multiOutput: false, isLastStep: true },
  ];
  assert.deepEqual(validateAdaptiveDiscovery(value), value.adaptive_discovery);
  assert.equal(validateAdaptiveDiscoveryWorkflow(value, steps), steps[0]);
  for (const input of [value, JSON.stringify(value)]) {
    assert.deepEqual(validateScan(scanBody(input)).configuration, before);
  }
  assert.deepEqual(value, before);
});

test('absent and disabled adaptive discovery preserve legacy attempted-step skips', () => {
  for (const skip_attempted_step_ids of [[4], ['4'], [2, '4', 5], [4.5], [true], '4']) {
    for (const value of [
      { skip_attempted_step_ids },
      { skip_attempted_step_ids, adaptive_discovery: false },
      { skip_attempted_step_ids, adaptive_discovery: { enabled: false, step_id: 4, max_paths: 'unchanged' } },
    ]) {
      const before = structuredClone(value);
      assert.equal(validateAdaptiveDiscovery(value), null);
      assert.equal(validateAdaptiveDiscoveryWorkflow(value, null), null);
      for (const input of [value, JSON.stringify(value)]) {
        assert.deepEqual(validateScan(scanBody(input)).configuration, before);
      }
      assert.deepEqual(value, before);
    }
  }
});

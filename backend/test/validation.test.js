import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateSeverityRanker,
  validateScan,
  validateWorkflow,
  validatePostScript,
  validateGeneration,
  validateModelSelection,
  ValidationError,
} from '../src/lib/validation.js';

const terminalOutput = {
  explanation: 'string',
  file_path: 'string',
  line: 'number',
  malicious_input_example: 'string',
  summary: 'string',
  trigger_flow: 'array',
  vulnerability_type: 'string',
  malicious_actor: 'string',
};

function workflowWithTerminal(outputFormat) {
  return {
    name: 'generated-workflow',
    levels: [
      {
        depth: 0,
        multiOutput: true,
        outputFormat,
        steps: [{ name: 'Investigate', content: 'Analyze {{repo_full}}.' }],
      },
    ],
  };
}

test('validateSeverityRanker requires name and content', () => {
  assert.throws(() => validateSeverityRanker({ name: '', content: '' }), ValidationError);
  const ok = validateSeverityRanker({ name: 'baseline', content: '1. rule', description: '  trim me  ' });
  assert.equal(ok.name, 'baseline');
  assert.equal(ok.description, 'trim me');
  assert.equal(ok.content, '1. rule');
});

test('generation and scan model selections share normalization rules', () => {
  const selection = validateModelSelection({
    model: ' gpt-5.6 ',
    model_provider: 'CODEX',
    harness: 'codex-cli',
    thinking_effort: 'high',
  });
  assert.deepEqual(selection, {
    model: 'gpt-5.6',
    modelProvider: 'codex',
    harness: 'codex',
    thinkingEffort: 'high',
  });
  assert.deepEqual(
    validateGeneration({
      kind: 'post_script',
      request: '  Generate a triage summary. ',
      model: 'gpt-5.6',
      model_provider: 'codex',
      harness: 'codex',
      thinking_effort: 'high',
    }),
    {
      kind: 'post_script',
      request: 'Generate a triage summary.',
      ...selection,
    }
  );

  assert.throws(
    () => validateGeneration({ kind: 'unknown', request: '', model: '', harness: '' }),
    (error) =>
      error instanceof ValidationError &&
      ['kind', 'request', 'model', 'harness'].every((field) => error.errors.some((item) => item.field === field))
  );

  assert.throws(
    () =>
      validateGeneration({
        kind: 'workflow',
        request: 'x'.repeat(20_001),
        model: 'gpt-5.6',
        model_provider: 'codex',
        harness: 'codex',
      }),
    (error) =>
      error instanceof ValidationError &&
      error.errors.some((item) => item.field === 'request' && item.message.includes('20,000'))
  );
});

test('model selection accepts the provider effort union', () => {
  for (const thinkingEffort of ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']) {
    assert.equal(
      validateModelSelection({
        model: 'custom-model',
        model_provider: 'codex',
        harness: 'codex',
        thinking_effort: thinkingEffort,
      }).thinkingEffort,
      thinkingEffort
    );
  }
  assert.throws(
    () =>
      validateModelSelection({
        model: 'claude-fable-5',
        model_provider: 'claude',
        harness: 'claude-code',
        thinking_effort: 'ultra',
      }),
    (error) =>
      error instanceof ValidationError &&
      error.errors.some(
        (item) => item.field === 'thinking_effort' && item.message.includes('not supported by harness "claude-code"')
      )
  );
});

test('model selection rejects non-string CLI arguments instead of coercing them', () => {
  const base = {
    model: 'gpt-5.6',
    model_provider: 'codex',
    harness: 'codex',
    thinking_effort: 'medium',
  };
  for (const [field, value, errorField] of [
    ['model', ['gpt-5.6'], 'model'],
    ['model_provider', { provider: 'codex' }, 'model_provider'],
    ['harness', 1, 'harness'],
    ['thinking_effort', ['high'], 'thinking_effort'],
  ]) {
    assert.throws(
      () => validateModelSelection({ ...base, [field]: value }),
      (error) =>
        error instanceof ValidationError &&
        error.errors.some((item) => item.field === errorField && item.message.includes('must be a string'))
    );
  }

  assert.deepEqual(validateModelSelection({ model: 'vendor/model', harness: 'claude-code' }), {
    model: 'vendor/model',
    modelProvider: 'openrouter',
    harness: 'claude-code',
    thinkingEffort: 'medium',
  });

  assert.throws(
    () => validateModelSelection({ ...base, model: 'x'.repeat(201) }),
    (error) =>
      error instanceof ValidationError &&
      error.errors.some((item) => item.field === 'model' && item.message.includes('200 characters or fewer'))
  );

  for (const [field, value, message] of [
    ['model', '   ', 'A model is required.'],
    ['harness', '\t', 'A harness is required.'],
  ]) {
    assert.throws(
      () => validateModelSelection({ ...base, [field]: value }),
      (error) =>
        error instanceof ValidationError &&
        error.errors.some((item) => item.field === field && item.message === message)
    );
  }
});

test('validateWorkflow enforces canonical terminal vulnerability field types', () => {
  const valid = validateWorkflow(workflowWithTerminal({ ...terminalOutput, exploitable: 'boolean' }));
  assert.deepEqual(valid.levels[0].outputFormat, { ...terminalOutput, exploitable: 'boolean' });

  for (const [key, type] of [
    ['line', 'string'],
    ['trigger_flow', 'object'],
    ['exploitable', 'string'],
  ]) {
    assert.throws(
      () => validateWorkflow(workflowWithTerminal({ ...terminalOutput, [key]: type })),
      (error) =>
        error instanceof ValidationError &&
        error.errors.some(
          (item) => item.field === 'terminal.outputFormat' && item.message.includes(`"${key}" must use type`)
        )
    );
  }
});

test('validateWorkflow clears individual ancestor keys at a consumesAll boundary', () => {
  const workflow = {
    name: 'batched-workflow',
    levels: [
      {
        depth: 0,
        multiOutput: true,
        outputFormat: { entrypoint: 'string' },
        steps: [{ name: 'Discover', content: 'Discover entrypoints in {{repo_full}}.' }],
      },
      {
        depth: 1,
        multiOutput: true,
        outputFormat: { flow: 'string' },
        steps: [{ name: 'Trace', content: 'Trace {{entrypoint}}.' }],
      },
      {
        depth: 2,
        multiOutput: true,
        consumesAll: true,
        outputFormat: terminalOutput,
        steps: [
          {
            name: 'Investigate batch',
            content: 'Investigate {{multi_output_depth_1}} without reusing ambiguous {{entrypoint}}.',
          },
        ],
      },
    ],
  };

  assert.throws(
    () => validateWorkflow(workflow),
    (error) =>
      error instanceof ValidationError &&
      error.errors.some((item) => item.field.includes('steps[0].content') && item.message.includes('entrypoint'))
  );

  workflow.levels[2].steps[0].content = 'Investigate {{multi_output_depth_1}}.';
  assert.doesNotThrow(() => validateWorkflow(workflow));
});

test('validatePostScript accepts scan, finding, and dynamic extra values', () => {
  const content = '{{repo_full}} {{summary}} {{explanation}} {{extra}} {{extra.impact}}';
  const valid = validatePostScript({
    name: 'context-aware',
    content,
    outputFormat: { _chip_risk: 'string' },
  });

  assert.equal(valid.content, content);
  assert.deepEqual(valid.outputFormat, { _chip_risk: 'string' });
});

test('validatePostScript rejects keys outside the supported scan and finding context', () => {
  assert.throws(
    () =>
      validatePostScript({
        name: 'unsupported-context',
        content: 'Analyze {{workflow_step_output}}.',
        outputFormat: { _chip_risk: 'string' },
      }),
    (error) =>
      error instanceof ValidationError &&
      error.errors.some((item) => item.field === 'content' && item.message.includes('non-reserved'))
  );
});

test('validatePostScript enforces reserved output conventions', () => {
  for (const outputFormat of [{ _reserved_report: 'object' }, { _reserved_poc: 'array' }, { _chip_: 'string' }]) {
    assert.throws(
      () => validatePostScript({ name: 'invalid-output', content: 'Analyze {{summary}}.', outputFormat }),
      ValidationError
    );
  }

  assert.deepEqual(
    validatePostScript({
      name: 'renderable-output',
      content: 'Analyze {{summary}}.',
      outputFormat: { _reserved_report: 'string', _reserved_poc: 'string', _chip_severity: 'string' },
    }).outputFormat,
    { _reserved_report: 'string', _reserved_poc: 'string', _chip_severity: 'string' }
  );
});

test('workflow and post-script validators reject malformed template references', () => {
  for (const content of [
    'Analyze {{entry-point}}.',
    'Analyze {{extra[impact]}}.',
    'Analyze {{}}.',
    'Analyze {{   }}.',
    'Analyze {{repo_full.',
    'Analyze repo_full}}.',
  ]) {
    const workflow = workflowWithTerminal({ ...terminalOutput });
    workflow.levels[0].steps[0].content = content;
    assert.throws(
      () => validateWorkflow(workflow),
      (error) =>
        error instanceof ValidationError &&
        error.errors.some((item) => item.field.includes('content') && item.message.includes('malformed template'))
    );

    assert.throws(
      () =>
        validatePostScript({
          name: 'malformed-template',
          content,
          outputFormat: { _chip_risk: 'string' },
        }),
      (error) =>
        error instanceof ValidationError &&
        error.errors.some((item) => item.field === 'content' && item.message.includes('malformed template'))
    );
  }
});

test('workflow and post-script validators accept spaced and dynamic template references', () => {
  const workflow = workflowWithTerminal({ ...terminalOutput });
  workflow.levels[0].steps[0].content = 'Analyze {{ repo_full }} for {{ extra.impact_1 }}.';
  assert.doesNotThrow(() => validateWorkflow(workflow));
  assert.doesNotThrow(() =>
    validatePostScript({
      name: 'valid-template',
      content: 'Summarize {{ summary }} for {{ extra.impact_1 }}.',
      outputFormat: { _chip_risk: 'string' },
    })
  );
});

test('workflow and post-script validators reject unsafe JavaScript object keys', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const workflowOutput = { ...terminalOutput };
    Object.defineProperty(workflowOutput, key, { value: 'string', enumerable: true });
    assert.throws(
      () => validateWorkflow(workflowWithTerminal(workflowOutput)),
      (error) =>
        error instanceof ValidationError &&
        error.errors.some((item) => item.field.includes('outputFormat') && item.message.includes(`"${key}"`))
    );

    const postScriptOutput = Object.fromEntries([[key, 'string']]);
    assert.throws(
      () =>
        validatePostScript({
          name: 'unsafe-output-key',
          content: 'Analyze {{summary}}.',
          outputFormat: postScriptOutput,
        }),
      ValidationError
    );

    const unsafeExtraWorkflow = workflowWithTerminal({ ...terminalOutput });
    unsafeExtraWorkflow.levels[0].steps[0].content = `Analyze {{extra.${key}}}.`;
    assert.throws(
      () => validateWorkflow(unsafeExtraWorkflow),
      (error) => error instanceof ValidationError && error.errors.some((item) => item.message.includes(`extra.${key}`))
    );
  }
});

test('validateScan requires a non-empty severity ranker', () => {
  const base = {
    workflowId: '1',
    postScriptId: '1',
    repo_kind: 'remote',
    repo_full: 'https://github.com/org/repo',
    commit_sha: 'HEAD',
    model: 'gpt-5.5',
    harness: 'codex',
  };
  assert.throws(
    () => validateScan({ ...base }),
    (e) => e instanceof ValidationError && e.errors.some((x) => x.field === 'severity_ranker')
  );
  const v = validateScan({ ...base, severity_ranker: 'A\n\nB' });
  assert.equal(v.severityRanker, 'A\n\nB');
});

test('validateScan labels local repository contents as a snapshot, not a Git revision', () => {
  const valid = validateScan(
    {
      workflowId: '1',
      postScriptId: '1',
      repo_kind: 'local',
      repo_full: 'working-tree',
      model: 'gpt-5.5',
      harness: 'codex',
      severity_ranker: 'Rank by impact.',
      dependencies: [{ kind: 'local', repo_full: 'shared-library' }],
    },
    { localNames: new Set(['working-tree', 'shared-library']) }
  );

  assert.equal(valid.commitSha, 'LOCAL_SNAPSHOT');
  assert.equal(valid.dependencies[0].commitSha, 'LOCAL_SNAPSHOT');
});

test('validateScan enforces model provider and harness compatibility after normalization', () => {
  const base = {
    workflowId: '1',
    postScriptId: '1',
    repo_kind: 'remote',
    repo_full: 'https://github.com/org/repo',
    commit_sha: 'HEAD',
    model: 'test-model',
    severity_ranker: 'Rank by impact.',
  };

  assert.equal(validateScan({ ...base, model_provider: 'codex', harness: 'codex-cli' }).harness, 'codex');
  assert.equal(validateScan({ ...base, model_provider: 'claude', harness: 'claude-code' }).modelProvider, 'claude');
  assert.equal(validateScan({ ...base, model_provider: 'openrouter', harness: 'codex' }).harness, 'codex');
  assert.equal(validateScan({ ...base, model_provider: 'openrouter', harness: 'claude-code' }).harness, 'claude-code');

  for (const [model_provider, harness] of [
    ['codex', 'claude-code'],
    ['claude', 'codex'],
    ['openrouter', 'cursor'],
  ]) {
    assert.throws(
      () => validateScan({ ...base, model_provider, harness }),
      (e) =>
        e instanceof ValidationError &&
        e.errors.some(
          (error) =>
            error.field === 'harness' &&
            error.message.includes(`model provider "${model_provider}"`) &&
            error.message.includes(`Harness "${harness}"`)
        )
    );
  }
});

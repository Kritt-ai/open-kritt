import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_WORKFLOW_NAMES, DEFAULT_WORKFLOWS } from '../src/lib/defaultWorkflows.js';
import { validateWorkflow } from '../src/lib/validation.js';

test('ships valid default workflows', () => {
  assert.deepEqual(DEFAULT_WORKFLOW_NAMES, ['external-flow-analysis', 'Cosmos ABCI Panic Halt Review']);
  assert.equal(DEFAULT_WORKFLOWS.length, 2);

  for (const workflow of DEFAULT_WORKFLOWS) {
    const validated = validateWorkflow({
      name: workflow.name,
      description: workflow.description,
      levels: workflow.levels.map((level) => ({
        depth: level.depth,
        multiOutput: level.multiOutput,
        consumesAll: level.consumeAll,
        outputFormat: level.outputFormat,
        steps: level.steps,
      })),
    });

    assert.equal(validated.description, workflow.description);
  }
});

test('ships the external-flow-analysis workflow', () => {
  const workflow = DEFAULT_WORKFLOWS.find(({ name }) => name === 'external-flow-analysis');
  assert.deepEqual(
    workflow.levels.map((level) => level.depth),
    [0, 1, 2]
  );
  assert.deepEqual(
    workflow.levels.map((level) => level.steps.map((step) => step.name)),
    [['Map external entrypoints'], ['Trace reachable flows'], ['Investigate flow vulnerabilities']]
  );
  assert.ok(workflow.levels.every((level) => level.multiOutput && !level.consumeAll));
  assert.equal(workflow.levels.at(-1).outputFormat.trigger_flow, 'array');
});

test('ships the Cosmos ABCI panic review workflow', () => {
  const workflow = DEFAULT_WORKFLOWS.find(({ name }) => name === 'Cosmos ABCI Panic Halt Review');

  assert.deepEqual(
    workflow.levels.map((level) => level.depth),
    [0, 1]
  );
  assert.deepEqual(
    workflow.levels.map((level) => level.steps.map((step) => step.name)),
    [
      ['Enumerate ABCI methods'],
      [
        'Investigate explicit panic calls',
        'Investigate arithmetic panics',
        'Investigate nil pointer panics',
        'Investigate bounds and type panics',
      ],
    ]
  );
  assert.ok(workflow.levels.every((level) => level.multiOutput && !level.consumeAll));
  assert.equal(workflow.levels[0].outputFormat.abci_method_name, 'string');
  assert.equal(workflow.levels[1].outputTable, 'workflows.vulnerabilities');
  assert.equal(workflow.levels[1].outputFormat.trigger_flow, 'array');
});

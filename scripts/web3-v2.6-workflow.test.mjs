import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateWorkflow } from '../backend/src/lib/validation.js';
import defaultWorkflowSeeds from '../backend/src/lib/defaultWorkflowSeeds.json' with { type: 'json' };
import { parseWorkflowImport } from '../frontend/src/lib/workflowTransfer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../workflow-packs/web3-v2.6');
const workflowPath = path.join(root, '01-recall-first-external-flow-review-v2.6.workflow.json');

async function loadWorkflow() {
  return parseWorkflowImport(await readFile(workflowPath, 'utf8'));
}

test('v2.6 changes methods while matching upstream external-flow-analysis configuration exactly', async () => {
  const imported = await loadWorkflow();
  const valid = validateWorkflow(imported);
  const upstream = defaultWorkflowSeeds.find((workflow) => workflow.name === 'external-flow-analysis');

  assert.match(imported.name, /Recall-First .* v2\.6$/);
  assert.equal(valid.maxDepth, 2);
  assert.equal(imported.levels.length, upstream.levels.length);

  for (const [index, level] of imported.levels.entries()) {
    const upstreamLevel = upstream.levels[index];
    assert.equal(level.depth, upstreamLevel.depth);
    assert.equal(level.steps.length, upstreamLevel.steps.length);
    assert.equal(level.multiOutput, upstreamLevel.multiOutput);
    assert.equal(level.consumesAll, upstreamLevel.consumeAll);
    assert.equal(level.bindPrevious, false);
    assert.deepEqual(level.outputFormat, upstreamLevel.outputFormat);
  }
});

test('v2.6 discovers technical candidates before precision and program gates', async () => {
  const imported = await loadWorkflow();
  const terminalPrompts = imported.levels[2].steps.map((step) => step.content).join('\n');
  const allPrompts = imported.levels.flatMap((level) => level.steps.map((step) => step.content)).join('\n');

  assert.match(terminalPrompts, /stage skipping/i);
  assert.match(terminalPrompts, /replay across sessions or domains/i);
  assert.match(terminalPrompts, /trailing or unused bits/i);
  assert.match(terminalPrompts, /panic\/exception\/fatal paths/i);
  assert.match(terminalPrompts, /consensus-process crash/i);
  assert.match(terminalPrompts, /cross-component invariant/i);
  assert.match(terminalPrompts, /remains a technical finding/i);
  assert.match(terminalPrompts, /exploitable=false and state the precise evidence gap/i);
  assert.doesNotMatch(allPrompts, /\{\{extra\./);
});

test('v2.6 keeps the terminal finding contract small and standard', async () => {
  const imported = await loadWorkflow();
  const terminalKeys = Object.keys(imported.levels.at(-1).outputFormat).sort();

  assert.deepEqual(terminalKeys, [
    'explanation',
    'exploitable',
    'file_path',
    'line',
    'malicious_actor',
    'malicious_input_example',
    'summary',
    'trigger_flow',
    'vulnerability_type',
  ]);
});

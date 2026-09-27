import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateWorkflow } from '../backend/src/lib/validation.js';
import { parseWorkflowImport } from '../frontend/src/lib/workflowTransfer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../workflow-packs/web3-v2.5');
const workflowPath = path.join(root, '01-cronos-fork-differential-fund-loss-focused-v2.5.workflow.json');

test('v2.5 fund-loss workflow is importable and preserves all candidates before verification', async () => {
  const imported = parseWorkflowImport(await readFile(workflowPath, 'utf8'));
  const valid = validateWorkflow(imported);
  const consumeAllLevels = imported.levels.filter((level) => level.consumesAll);

  assert.match(imported.name, /Focused v2\.5$/);
  assert.equal(valid.maxDepth, 5);
  assert.equal(consumeAllLevels.length, 1);
  assert.equal(consumeAllLevels[0].depth, 3);
  assert.match(consumeAllLevels[0].steps[0].content, /every hypothesis branch has completed/);
  assert.match(imported.levels[4].steps[0].name, /verification/i);
  assert.match(imported.levels[4].steps[0].content, /victim debit/i);
  assert.match(imported.levels[4].steps[0].content, /attacker credit\/capture/i);
  assert.match(imported.levels[5].steps[0].content, /upstream-only/);
  assert.equal(imported.levels.at(-1).multiOutput, true);
});

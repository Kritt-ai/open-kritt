import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateWorkflow } from '../backend/src/lib/validation.js';
import { parseWorkflowImport } from '../frontend/src/lib/workflowTransfer.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../workflow-packs/web3-v2.4');

async function workflowDocuments() {
  const filenames = (await readdir(root)).filter((name) => name.endsWith('.workflow.json')).sort();
  return Promise.all(
    filenames.map(async (filename) => ({
      filename,
      document: JSON.parse(await readFile(path.join(root, filename), 'utf8')),
    }))
  );
}

test('v2.4 workflows complete coverage before canonical candidates fan out', async () => {
  const documents = await workflowDocuments();
  assert.equal(documents.length, 7);

  for (const { filename, document } of documents) {
    const imported = parseWorkflowImport(JSON.stringify(document));
    const valid = validateWorkflow(imported);
    const finalLevel = imported.levels.at(-1);
    const dedupLevels = imported.levels.filter((level) => level.consumesAll);
    const dedupLevel = dedupLevels[0];
    const verificationLevel = imported.levels[dedupLevel?.depth + 1];
    const references = [...JSON.stringify(imported).matchAll(/\{\{([A-Za-z0-9_.]+)\}\}/g)].map((match) => match[1]);

    assert.match(imported.name, /Balanced v2\.4$/, filename);
    assert.doesNotMatch(imported.description, /v2\.3|high-priority PoC gating/, filename);
    assert.equal(valid.maxDepth, imported.levels.length - 1, filename);
    assert.equal(finalLevel.multiOutput, true, filename);
    assert.equal(finalLevel.steps.length, 1, filename);
    assert.equal(dedupLevels.length, 1, filename);
    assert.equal(dedupLevel.multiOutput, true, filename);
    assert.match(dedupLevel.steps[0].name, /Deduplicate/, filename);
    assert.match(dedupLevel.steps[0].content, /every hypothesis branch has completed/, filename);
    assert.match(dedupLevel.steps[0].content, /never discard a candidate solely/, filename);
    assert.match(verificationLevel.steps[0].name, /verify and reproduce/i, filename);
    assert.match(verificationLevel.steps[0].content, /\{\{dedup_canonical_hypothesis_id\}\}/, filename);
    assert.equal(references.some((key) => key.startsWith('dedup_')), true, filename);
    assert.equal(
      references.some((key) => key.startsWith('program_')),
      false,
      filename
    );
  }
});

test('v2.4 bundle matches the seven portable workflow files', async () => {
  const documents = await workflowDocuments();
  const bundle = JSON.parse(await readFile(path.join(root, '_all_workflows_v2.json'), 'utf8'));

  assert.deepEqual(
    bundle.map((document) => document.workflow.name),
    documents.map(({ document }) => document.workflow.name)
  );
});

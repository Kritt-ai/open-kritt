import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../benchmarks/somnia-2025'
);

async function readJson(name) {
  return JSON.parse(await readFile(path.join(root, name), 'utf8'));
}

test('Somnia benchmark remains blind and blocked without a verified source snapshot', async () => {
  const [blindInputs, groundTruth, snapshot] = await Promise.all([
    readJson('blind-inputs.json'),
    readJson('ground-truth.json'),
    readJson('snapshot.json'),
  ]);

  assert.equal(groundTruth.findings.length, 3);
  assert.deepEqual(
    groundTruth.findings.map((finding) => finding.report_id),
    ['SOMNIAAC-131', 'SOMNIAAC-132', 'SOMNIAAC-225']
  );

  const blindText = JSON.stringify(blindInputs).toLowerCase();
  for (const forbidden of [
    'somniaac-131',
    'somniaac-132',
    'somniaac-225',
    'verified_peer_address',
    'ready_to_finish',
    'foreachtrue',
    'challenge replay',
    'bitset capacity',
  ]) {
    assert.equal(blindText.includes(forbidden), false, `blind inputs leaked ${forbidden}`);
  }

  if (snapshot.verification_status !== 'verified') {
    assert.equal(snapshot.resolved_commit, null);
    assert.equal(snapshot.tree_sha256, null);
    assert.notEqual(snapshot.verification_status, 'ready');
  }
});

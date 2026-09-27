import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadPocArtifacts } from '../src/lib/pocArtifactExport.js';
import { createFindingExport } from '../src/lib/findingExport.js';

test('saved D4 PoC evidence is included in the finding export', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'openkritt-poc-export-'));
  try {
    const relative = 'poc-artifacts/scan-4/finding-9/metadata-20';
    const directory = path.join(root, relative);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'attack.log'), 'attack reproduced\n');
    const finding = {
      id: '9',
      summary: 'Example flaw',
      rank: 1,
      enrichments: [{ result: { poc_status: 'reproduced', poc_artifact_dir: relative } }],
    };
    const artifacts = await loadPocArtifacts(4, [finding], root);
    const bundle = createFindingExport(
      { id: '4', status: 'completed', repoDisplay: 'example/project', repoKind: 'remote' },
      [finding],
      { pocArtifacts: artifacts }
    );
    assert.equal(bundle.files.filter((file) => file.path.endsWith('poc-artifacts/attack.log')).length, 1);
    const manifest = JSON.parse(bundle.files.find((file) => file.path === 'manifest.json').content());
    assert.equal(manifest.findings[0].files.pocArtifacts.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('artifact loader rejects a directory outside the finding boundary', async () => {
  await assert.rejects(
    loadPocArtifacts(
      4,
      [
        {
          id: '9',
          enrichments: [
            {
              result: {
                poc_status: 'reproduced',
                poc_artifact_dir: 'poc-artifacts/scan-4/finding-10/metadata-20',
              },
            },
          ],
        },
      ],
      os.tmpdir()
    ),
    /does not match/
  );
});

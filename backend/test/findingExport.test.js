import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createFindingExport,
  exportSlug,
  findingExportAvailability,
  FindingExportTooLargeError,
  findingPostScriptSources,
  reservedFindingMarkdown,
} from '../src/lib/findingExport.js';

const scan = {
  id: '42',
  status: 'completed',
  repoFull: 'https://github.com/example/Protocol.git',
  repoDisplay: 'example/Protocol',
  repoKind: 'remote',
  commitSha: 'abc123',
  repoScope: 'full repository',
  dependencies: [],
  workflowId: '7',
  workflowName: 'Production Exploit Hunt',
  model: 'test-model',
  modelProvider: 'codex',
  harness: 'codex',
  thinkingEffort: 'high',
  postProcessingThinkingEffort: 'high',
  modelOverrides: {},
  postScriptName: 'Scope check',
  postScripts: [{ id: '9', name: 'Scope check', primary: true }],
  agentSkills: [],
  configuration: { include_tests: false },
  extra: { bug_bounty_url: 'https://example.com/bounty' },
  scopes: { files: ['contracts/**'] },
  severityRanker: 'Use production impact.',
  findings: 1,
  rawCandidates: 2,
  duplicateFindings: 1,
  exploitable: 1,
  insertedAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
};

const finding = {
  id: '88',
  scanId: '42',
  rank: 1,
  explanation: 'A complete exploit explanation.',
  file_path: 'contracts/Vault.sol',
  line: 77,
  malicious_input_example: 'amount = 100',
  summary: '../ Unsafe withdrawal | without accounting',
  trigger_flow: ['Call withdraw', { sink: 'transfer' }],
  vulnerability_type: 'Accounting mismatch',
  exploitable: true,
  malicious_actor: 'Unprivileged depositor',
  jsonAnswer: {
    summary: '../ Unsafe withdrawal | without accounting',
    explanation: 'A complete exploit explanation.',
    extra_evidence: { transaction: '0x123' },
  },
  postScriptAnswer: {
    severity: 'Critical',
    _reserved_report: '# Submission report\n\nExact report body.',
    _chip_is_in_scope: 'yes',
  },
  severity: 'Critical',
  dedupe: { isCanonical: true, duplicateIds: ['89'] },
  bountyRank: { impactLevel: 'Critical' },
  enrichments: [
    {
      id: '4',
      postScriptId: '10',
      postScriptName: 'PoC Creator',
      result: { _reserved_poc: '# Proof of concept\n\n`forge test`', proof_status: 'passing' },
      stub: false,
      stubExplanation: null,
    },
    {
      id: '5',
      postScriptId: '11',
      postScriptName: 'Patched since',
      result: { patched: false },
      stub: true,
      stubExplanation: 'Network unavailable.',
    },
  ],
  comments: 'Ready for maintainer review.',
  interesting: 1,
  insertedAt: '2026-08-02T00:00:00.000Z',
};

test('finding export creates safe, complete report and PoC packages', () => {
  const bundle = createFindingExport(scan, [finding], { exportedAt: '2026-08-02T12:00:00.000Z' });

  assert.equal(bundle.filename, 'example-protocol-scan-42-findings.zip');
  assert.equal(bundle.root, 'example-protocol-scan-42-findings');
  assert.equal(
    bundle.files.every((file) => !file.path.includes('..') && !file.path.startsWith('/')),
    true
  );

  const files = new Map(bundle.files.map((file) => [file.path, file.content]));
  const directory = [...files.keys()].find((path) => path.endsWith('/finding.md')).split('/')[0];
  assert.equal(files.get(`${directory}/report.md`), '# Submission report\n\nExact report body.\n');
  assert.equal(files.get(`${directory}/poc.md`), '# Proof of concept\n\n`forge test`\n');
  assert.match(files.get(`${directory}/finding.md`), /Complete workflow result/);
  assert.match(files.get(`${directory}/finding.md`), /Ready for maintainer review/);

  const postProcessing = JSON.parse(files.get(`${directory}/post-processing.json`));
  assert.equal(postProcessing.primary.result._chip_is_in_scope, 'yes');
  assert.equal(postProcessing.enrichments.length, 2);
  assert.equal(postProcessing.enrichments[1].stubExplanation, 'Network unavailable.');

  const manifest = JSON.parse(files.get('manifest.json'));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.exportedAt, '2026-08-02T12:00:00.000Z');
  assert.deepEqual(manifest.scan.configuration, { include_tests: false });
  assert.equal(manifest.scan.extra.bug_bounty_url, 'https://example.com/bounty');
  assert.equal(manifest.scan.severityRanker, 'Use production impact.');
  assert.deepEqual(manifest.findings[0].jsonAnswer.extra_evidence, { transaction: '0x123' });
  assert.deepEqual(manifest.findings[0].dedupe.duplicateIds, ['89']);
  assert.match(files.get('README.md'), new RegExp(`${directory}/report\\.md`));
  assert.match(files.get('README.md'), new RegExp(`${directory}/poc\\.md`));
  assert.equal(
    bundle.uncompressedBytes,
    [...files.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0)
  );
});

test('finding export rejects packages above the uncompressed size cap', () => {
  assert.throws(
    () => createFindingExport(scan, [finding], { maxBytes: 100 }),
    (error) =>
      error instanceof FindingExportTooLargeError &&
      error.limitBytes === 100 &&
      error.message === 'This findings export exceeds the 100 bytes uncompressed size limit.'
  );
});

test('reserved artifacts follow primary then enrichment order', () => {
  const sources = findingPostScriptSources(finding, scan.postScriptName);
  assert.equal(sources.map((source) => source.name).join(', '), 'Scope check, PoC Creator, Patched since');
  assert.match(reservedFindingMarkdown(sources, '_reserved_report'), /Submission report/);
  assert.match(reservedFindingMarkdown(sources, '_reserved_poc'), /Proof of concept/);
});

test('finding export is available only after completed post-processing with findings', () => {
  assert.deepEqual(findingExportAvailability(scan, 1), { ready: true, message: null });
  assert.equal(findingExportAvailability({ ...scan, status: 'post_processing' }, 1).ready, false);
  assert.equal(findingExportAvailability(scan, 0).ready, false);
});

test('export slugs cannot introduce archive paths', () => {
  assert.equal(exportSlug('../../A protocol\\finding'), 'a-protocol-finding');
  assert.equal(exportSlug('***', 'fallback'), 'fallback');
});

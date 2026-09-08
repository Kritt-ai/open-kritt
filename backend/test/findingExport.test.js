import assert from 'node:assert/strict';
import { PassThrough, Readable } from 'node:stream';
import { test } from 'node:test';
import { ZipArchive } from 'archiver';

import {
  createFindingExport,
  createFindingExportLimiter,
  exportSlug,
  findingExportAvailability,
  FindingExportBusyError,
  FindingExportTooLargeError,
  FindingExportTooManyFindingsError,
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

async function renderZip(bundle) {
  const output = new PassThrough();
  const chunks = [];
  output.on('data', (chunk) => chunks.push(chunk));
  const completed = new Promise((resolve, reject) => {
    output.on('end', resolve);
    output.on('error', reject);
  });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on('error', (error) => output.destroy(error));
  archive.pipe(output);
  for (const file of bundle.files) {
    archive.append(
      Readable.from(
        (function* findingExportFileContent() {
          yield file.content();
        })()
      ),
      { name: `${bundle.root}/${file.path}` }
    );
  }
  await archive.finalize();
  await completed;
  return Buffer.concat(chunks);
}

test('finding export creates safe, complete report and PoC packages', () => {
  const bundle = createFindingExport(scan, [finding], { exportedAt: '2026-08-02T12:00:00.000Z' });

  assert.equal(bundle.filename, 'example-protocol-scan-42-findings.zip');
  assert.equal(bundle.root, 'example-protocol-scan-42-findings');
  assert.equal(
    bundle.files.every((file) => !file.path.includes('..') && !file.path.startsWith('/')),
    true
  );

  const files = new Map(bundle.files.map((file) => [file.path, file.content()]));
  const directory = [...files.keys()].find((path) => path.endsWith('/finding.md')).split('/')[0];
  assert.equal(files.get(`${directory}/report.txt`), '# Submission report\n\nExact report body.\n');
  assert.equal(files.get(`${directory}/poc.txt`), '# Proof of concept\n\n`forge test`\n');
  assert.match(files.get(`${directory}/finding.md`), /Complete workflow result/);
  assert.match(files.get(`${directory}/finding.md`), /Ready for maintainer review/);

  const postProcessing = JSON.parse(files.get(`${directory}/post-processing.json`));
  assert.equal(postProcessing.primary.result._chip_is_in_scope, 'yes');
  assert.equal(postProcessing.enrichments.length, 2);
  assert.equal(postProcessing.enrichments[1].stubExplanation, 'Network unavailable.');

  const manifest = JSON.parse(files.get('manifest.json'));
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.privacyProfile, 'share-safe');
  assert.equal(manifest.scan.completeness, 'complete');
  assert.equal(manifest.exportedAt, '2026-08-02T12:00:00.000Z');
  assert.equal(Object.hasOwn(manifest.scan, 'configuration'), false);
  assert.equal(Object.hasOwn(manifest.scan, 'extra'), false);
  assert.equal(Object.hasOwn(manifest.scan, 'severityRanker'), false);
  assert.equal(Object.hasOwn(manifest.scan.repository, 'full'), false);
  assert.deepEqual(Object.keys(manifest.findings[0]), ['id', 'rank', 'severity', 'files']);
  assert.equal(manifest.findings[0].files.report, `${directory}/report.txt`);
  assert.equal(manifest.findings[0].files.poc, `${directory}/poc.txt`);
  assert.match(files.get('README.md'), /derived from untrusted repository and model output/);
  assert.match(files.get('README.md'), new RegExp(`${directory}/report\\.txt`));
  assert.match(files.get('README.md'), new RegExp(`${directory}/poc\\.txt`));
  assert.equal(
    bundle.uncompressedBytes,
    [...files.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0)
  );
  assert.equal(
    bundle.files.every((file) => typeof file.content === 'function'),
    true
  );
});

test('finding export neutralizes active Markdown and hidden layout controls', () => {
  const unsafe = {
    ...finding,
    summary: 'Legitimate](https://attacker.invalid/collect) ![pixel](https://attacker.invalid/pixel)',
    explanation: '<img src="https://attacker.invalid/beacon">\n<script>alert(1)</script>',
    malicious_input_example: '[run me](javascript:alert(1))',
    trigger_flow: ['<details open>', '1. injected list'],
    comments: `safe\u202etxt.exe`,
    jsonAnswer: { ...finding.jsonAnswer, attackerControlled: `safe\u202etxt.exe` },
  };
  const bundle = createFindingExport(scan, [unsafe]);
  const files = new Map(bundle.files.map((file) => [file.path, file.content()]));
  const readme = files.get('README.md');
  const findingText = [...files.entries()].find(([path]) => path.endsWith('/finding.md'))[1];

  assert.doesNotMatch(readme, /\]\(https:\/\/attacker\.invalid/);
  assert.doesNotMatch(readme, /!\[pixel\]/);
  assert.doesNotMatch(findingText, /<img|<script|<details/);
  assert.doesNotMatch(findingText, /\]\(javascript:/);
  assert.doesNotMatch(findingText, /https:\/\/attacker\.invalid/);
  assert.doesNotMatch(findingText, /\u202e/);
  assert.match(findingText, /&lt;img src=/);
  assert.match(findingText, /\\u202e/);
});

test('share-safe metadata does not disclose local repository paths', () => {
  const localScan = {
    ...scan,
    repoFull: '/Users/alice/private/customer-project',
    repoDisplay: '/Users/alice/private/customer-project',
    repoKind: 'local',
  };
  const bundle = createFindingExport(localScan, [finding]);
  const files = new Map(bundle.files.map((file) => [file.path, file.content()]));
  const manifest = JSON.parse(files.get('manifest.json'));

  assert.equal(bundle.filename, 'local-repository-scan-42-findings.zip');
  assert.deepEqual(manifest.scan.repository, { display: 'Local repository', kind: 'local' });
  assert.doesNotMatch(files.get('README.md'), /Users|alice|customer-project/);
});

test('lazy file factories produce a valid ZIP archive', async () => {
  const bundle = createFindingExport(scan, [finding]);
  const archive = await renderZip(bundle);

  assert.equal(archive.subarray(0, 4).toString('hex'), '504b0304');
  assert.match(archive.toString('latin1'), new RegExp(`${bundle.root}/README\\.md`));
  assert.match(archive.toString('latin1'), /report\.txt/);
  assert.doesNotMatch(archive.toString('latin1'), /report\.md/);
});

test('stopped and failed scans produce clearly marked partial exports', () => {
  for (const status of ['stopped', 'failed']) {
    const partialScan = { ...scan, status };
    const bundle = createFindingExport(partialScan, [finding]);
    const files = new Map(bundle.files.map((file) => [file.path, file.content()]));
    const manifest = JSON.parse(files.get('manifest.json'));

    assert.equal(bundle.filename, `example-protocol-scan-42-findings-partial.zip`);
    assert.equal(manifest.scan.status, status);
    assert.equal(manifest.scan.completeness, 'partial');
    assert.match(files.get('README.md'), new RegExp(`partial export from a ${status} scan`));
    assert.match(files.get('README.md'), /artifacts may be incomplete or missing/);
  }
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

test('finding export enforces per-file and finding-count limits', () => {
  assert.throws(
    () => createFindingExport(scan, [finding], { maxFileBytes: 100 }),
    (error) => error instanceof FindingExportTooLargeError && error.path === 'README.md'
  );
  assert.throws(
    () => createFindingExport(scan, [finding, { ...finding, id: '89' }], { maxFindings: 1 }),
    (error) => error instanceof FindingExportTooManyFindingsError && error.limit === 1
  );
});

test('finding export limiter rejects excess work and releases its slot', async () => {
  const run = createFindingExportLimiter(1);
  let release;
  const pending = run(() => new Promise((resolve) => (release = resolve)));
  await assert.rejects(() => run(async () => {}), FindingExportBusyError);
  release();
  await pending;
  await run(async () => {});
});

test('reserved artifacts follow primary then enrichment order', () => {
  const sources = findingPostScriptSources(finding, scan.postScriptName);
  assert.equal(sources.map((source) => source.name).join(', '), 'Scope check, PoC Creator, Patched since');
  assert.match(reservedFindingMarkdown(sources, '_reserved_report'), /Submission report/);
  assert.match(reservedFindingMarkdown(sources, '_reserved_poc'), /Proof of concept/);
});

test('finding export is available for terminal scans with findings', () => {
  assert.deepEqual(findingExportAvailability(scan, 1), { ready: true, message: null });
  assert.deepEqual(findingExportAvailability({ ...scan, status: 'stopped' }, 1), { ready: true, message: null });
  assert.deepEqual(findingExportAvailability({ ...scan, status: 'failed' }, 1), { ready: true, message: null });
  assert.equal(findingExportAvailability({ ...scan, status: 'post_processing' }, 1).ready, false);
  assert.equal(findingExportAvailability({ ...scan, status: 'paused' }, 1).ready, false);
  assert.equal(findingExportAvailability(scan, 0).ready, false);
  assert.equal(findingExportAvailability({ ...scan, status: 'stopped' }, 0).ready, false);
});

test('export slugs cannot introduce archive paths', () => {
  assert.equal(exportSlug('../../A protocol\\finding'), 'a-protocol-finding');
  assert.equal(exportSlug('***', 'fallback'), 'fallback');
});

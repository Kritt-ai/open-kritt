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
  assert.deepEqual(Object.keys(manifest.findings[0]), ['id', 'rank', 'severity', 'readiness', 'files']);
  assert.equal(manifest.findings[0].readiness, null);
  assert.equal(manifest.findings[0].files.report, `${directory}/report.txt`);
  assert.equal(manifest.findings[0].files.poc, `${directory}/poc.txt`);
  assert.match(files.get('README.md'), /derived from untrusted repository and model output/);
  assert.match(files.get('README.md'), new RegExp(`${directory}/report\\.txt`));
  assert.doesNotMatch(files.get('README.md'), /poc\.txt/);
  assert.match(files.get('README.md'), /\| Rank \| Severity \| Finding \| Report \| Lifecycle \|/);
  assert.match(files.get('README.md'), /Findings per lifecycle status: not gated 1\./);
  assert.doesNotMatch(files.get(`${directory}/finding.md`), /## Readiness/);
  assert.doesNotMatch(files.get(`${directory}/report.txt`), /READY/);
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

const gatedFinding = {
  ...finding,
  id: '90',
  rank: 2,
  summary: 'Unauthorized withdrawal',
  postScriptAnswer: null,
  severity: 'High',
  readiness: {
    stage: 'd5',
    ready: false,
    label: 'submission_ready',
    lifecycleStatus: 'impact_partial',
    policyVersion: 'v2.7-impact-gate-1',
    legacy: false,
    blockingReasons: ['chain_complete: hop h2 is partial.', 'd5_match: impact_match_status is partial.'],
    evidence: null,
    lifecycle: null,
    readiness: null,
  },
  enrichments: [
    {
      id: '6',
      postScriptId: '3',
      postScriptName: 'v2.7 D3',
      stage: 'd3',
      result: {
        verdict: 'confirmed',
        impact_objective: {
          claim: 'Attacker drains the vault',
          terminal_outcome: 'Vault balance decreases without authorization',
          required_evidence: ['balance_before', 'balance_after'],
          source_type: 'bounty_rule',
        },
        evidence_dimensions: [
          { tag: 'balance_before', status: 'required' },
          { tag: 'recipient_control', status: 'not_applicable', rationale: 'Attacker EOA receives funds.' },
        ],
        impact_chain_plan: [{ id: 'h1', claim: 'Bypass check', status: 'unverified', evidence_paths: [], covers: [] }],
        unverified_assumptions: [
          {
            id: 'a1',
            assumption: 'Vault is unpaused in production',
            kind: 'deployment',
            material: true,
            status: 'open',
          },
        ],
        _engine_lifecycle: { lifecycle_status: 'code_confirmed', policy_version: 'v2.7-impact-gate-1', legacy: false },
      },
      stub: false,
      stubExplanation: null,
    },
    {
      id: '7',
      postScriptId: '4',
      postScriptName: 'v2.7 D4',
      stage: 'd4',
      result: {
        poc_status: 'reproduced',
        poc_artifact_dir: '/artifacts/90',
        _reserved_poc: '# PoC\n\nforge test',
        bug_status: 'reproduced',
        impact_status: 'partial',
        observed_terminal_outcome: 'Balance decreased by 1 wei',
        negative_control_status: 'passed',
        repeatability_status: 'deterministic',
        impact_chain: [
          {
            id: 'h1',
            claim: 'Bypass check',
            status: 'proven',
            evidence_paths: ['logs/h1.txt'],
            covers: ['balance_before'],
            assessment: '',
          },
          {
            id: 'h2',
            claim: 'Drain <all> | funds',
            status: 'partial',
            evidence_paths: ['logs/h2.txt'],
            covers: [],
            assessment: 'Only dust moved.',
          },
        ],
        missing_impact_links: ['h2'],
        unverified_assumptions: [
          {
            id: 'a1',
            assumption: 'Vault is unpaused in production',
            kind: 'deployment',
            material: true,
            status: 'open',
          },
        ],
        remaining_limits: 'Mainnet fork only.',
        _engine_evidence: {
          bug_status: 'reproduced',
          impact_status: 'partial',
          capture_complete: true,
          artifact_dir: '/artifacts/90',
          captured_paths: ['logs/h1.txt'],
          unresolved_paths: ['logs/h2.txt'],
          lifecycle_status: 'impact_partial',
          policy_version: 'v2.7-impact-gate-1',
          legacy: false,
        },
      },
      stub: false,
      stubExplanation: null,
    },
    {
      id: '8',
      postScriptId: '5',
      postScriptName: 'v2.7 D5',
      stage: 'd5',
      result: {
        submission_ready: true,
        scope_status: 'in_scope_verified',
        novelty_status: 'novelty_unverified',
        missing_requirements: ['Full drain evidence'],
        impact_match_status: 'partial',
        impact_evidence_status: 'insufficient',
        impact_mapping: [
          { required_outcome: 'Vault drained', observed_outcome: 'Dust moved', status: 'missing', evidence_paths: [] },
        ],
        _reserved_report: '# Report\n\nBody.',
        model_readiness_claim: true,
        _engine_readiness: {
          ready: false,
          label: 'submission_ready',
          lifecycle_status: 'impact_partial',
          blocking_reasons: ['chain_complete: hop h2 is partial.', 'd5_match: impact_match_status is partial.'],
          checks: { chain_complete: 'fail', d5_match: 'fail', provenance: 'pass' },
          policy: 'public_bounty',
          policy_version: 'v2.7-impact-gate-1',
          evaluated_at: '2026-09-24T00:00:00.000Z',
          legacy: false,
        },
      },
      stub: false,
      stubExplanation: null,
    },
  ],
};

test('finding export renders the readiness chapter, report header, manifest and lifecycle column', () => {
  const bundle = createFindingExport(scan, [finding, gatedFinding]);
  const files = new Map(bundle.files.map((file) => [file.path, file.content()]));
  const directory = [...files.keys()].find((path) => path.includes('unauthorized-withdrawal')).split('/')[0];
  const markdown = files.get(`${directory}/finding.md`);

  assert.match(markdown, /## Readiness/);
  assert.match(markdown, /\| Bug \| reproduced \|/);
  assert.match(markdown, /\| Impact \| partial \|/);
  assert.match(markdown, /\| Terminal outcome \| Balance decreased by 1 wei \|/);
  assert.match(markdown, /\| Deployment \| 1 open material assumption/);
  assert.match(markdown, /\| Scope \| in\\_scope\\_verified \|/);
  assert.match(markdown, /\| Novelty \| novelty\\_unverified \|/);
  assert.match(
    markdown,
    /\| Readiness \| submission\\_ready — not ready — chain\\_complete\\: hop h2 is partial\\. \|/
  );
  assert.match(markdown, /### Required versus observed outcome/);
  assert.match(markdown, /Vault balance decreases without authorization/);
  assert.match(markdown, /### Evidence chain/);
  assert.match(
    markdown,
    /\| h1 \| Bypass check \| proven \| balance\\_before \| — \| logs\\\/h1\\.txt \(captured\) \|/
  );
  assert.match(
    markdown,
    /\| h2 \| Drain &lt;all&gt; \\\| funds \| partial \| — \| Only dust moved\\. \| logs\\\/h2\\.txt \(unresolved\) \|/
  );
  assert.match(markdown, /Negative control: passed/);
  assert.match(markdown, /Repeatability: deterministic/);
  assert.match(markdown, /### Assumptions/);
  assert.match(markdown, /\| a1 \| Vault is unpaused in production \| deployment \| yes \| open \|/);
  assert.match(markdown, /### Missing links[\s\S]*- h2/);
  assert.match(markdown, /### Limitations[\s\S]*Mainnet fork only\\./);
  assert.match(markdown, /### Readiness decision[\s\S]*\*\*NOT READY\*\* \(submission\\_ready\)/);
  assert.match(markdown, /Policy version: v2\\.7\\-impact\\-gate\\-1/);
  assert.match(markdown, /- chain\\_complete\\: hop h2 is partial\\./);
  assert.match(markdown, /- d5\\_match\\: impact\\_match\\_status is partial\\./);
  assert.match(markdown, /Model claimed readiness: yes/);
  assert.match(markdown, /### Impact mapping[\s\S]*\| Vault drained \| Dust moved \| missing \| — \|/);
  assert.match(markdown, /Missing requirements[\s\S]*- Full drain evidence/);
  assert.match(markdown, /Checks: chain\\_complete fail, d5\\_match fail, provenance pass/);

  const report = files.get(`${directory}/report.txt`);
  assert.equal(
    report,
    '```\nNOT READY — submission_ready — impact_partial — reasons: chain_complete: hop h2 is partial.; d5_match: impact_match_status is partial.\n```\n\n# Report\n\nBody.\n'
  );

  const manifest = JSON.parse(files.get('manifest.json'));
  assert.deepEqual(manifest.findings[1].readiness, {
    ready: false,
    label: 'submission_ready',
    lifecycleStatus: 'impact_partial',
    policyVersion: 'v2.7-impact-gate-1',
    legacy: false,
  });
  assert.equal(manifest.findings[0].readiness, null);

  const readme = files.get('README.md');
  assert.match(readme, /\| Rank \| Severity \| Finding \| Report \| Lifecycle \|/);
  assert.match(readme, /\| 1 \| Critical \| \[[^\]]+\]\([^)]+\) \| \[yes\]\([^)]+\) \| — \|/);
  assert.match(readme, /\| 2 \| High \| \[[^\]]+\]\([^)]+\) \| \[yes\]\([^)]+\) \| impact\\_partial \(not ready\) \|/);
  assert.match(readme, /Findings per lifecycle status: impact\\_partial 1, not gated 1\./);
  assert.doesNotMatch(readme, /\| PoC \|/);
});

test('ready findings export a READY header and legacy decisions are labelled', () => {
  const ready = {
    ...gatedFinding,
    readiness: { ...gatedFinding.readiness, ready: true, lifecycleStatus: 'report_ready', blockingReasons: [] },
  };
  const legacy = {
    ...gatedFinding,
    id: '91',
    rank: 3,
    summary: 'Legacy finding',
    readiness: {
      stage: 'd4',
      ready: false,
      label: 'report_ready',
      lifecycleStatus: 'legacy_bug_reproduced_impact_unverified',
      policyVersion: 'legacy-unverified',
      legacy: true,
      blockingReasons: [
        'Readiness was not evaluated: the pipeline ended at D4 with lifecycle "legacy_bug_reproduced_impact_unverified".',
      ],
      evidence: null,
      lifecycle: null,
      readiness: null,
    },
    enrichments: [
      {
        id: '9',
        postScriptId: '4',
        postScriptName: 'v2.7 D4',
        stage: 'd4',
        result: {
          poc_status: 'reproduced',
          _reserved_report: 'Legacy report',
          _engine_evidence: {
            bug_status: 'reproduced',
            impact_status: 'unverified',
            capture_complete: false,
            artifact_dir: '',
            captured_paths: [],
            unresolved_paths: [],
            lifecycle_status: 'legacy_bug_reproduced_impact_unverified',
            policy_version: 'legacy-unverified',
            legacy: true,
          },
        },
        stub: false,
        stubExplanation: null,
      },
    ],
  };
  const bundle = createFindingExport(scan, [ready, legacy]);
  const files = new Map(bundle.files.map((file) => [file.path, file.content()]));
  const readyDirectory = [...files.keys()].find((path) => path.includes('unauthorized-withdrawal')).split('/')[0];
  const legacyDirectory = [...files.keys()].find((path) => path.includes('legacy-finding')).split('/')[0];

  assert.equal(
    files.get(`${readyDirectory}/report.txt`),
    '```\nREADY under v2.7-impact-gate-1\n```\n\n# Report\n\nBody.\n'
  );
  assert.match(files.get(`${readyDirectory}/finding.md`), /\*\*READY\*\* \(submission\\_ready\)/);
  assert.match(
    files.get(`${legacyDirectory}/report.txt`),
    /^```\nNOT READY — report_ready — legacy_bug_reproduced_impact_unverified — reasons: Readiness was not evaluated/
  );
  const legacyMarkdown = files.get(`${legacyDirectory}/finding.md`);
  assert.match(legacyMarkdown, /## Readiness/);
  assert.match(legacyMarkdown, /\| Impact \| unverified \|/);
  assert.match(legacyMarkdown, /Legacy decision: yes/);
  assert.match(legacyMarkdown, /Policy version: legacy\\-unverified/);
  assert.match(
    files.get('README.md'),
    /Findings per lifecycle status: report\\_ready 1, legacy\\_bug\\_reproduced\\_impact\\_unverified 1\./
  );
  const manifest = JSON.parse(files.get('manifest.json'));
  assert.equal(manifest.findings[0].readiness.ready, true);
  assert.equal(manifest.findings[1].readiness.legacy, true);
});

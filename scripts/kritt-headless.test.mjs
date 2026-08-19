import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  attachmentFilename,
  createScanInteractively,
  formatScanSummary,
  HeadlessApiClient,
  HeadlessApiError,
  importPortableResource,
  requiredExtraKeys,
  resolveHeadlessApiBase,
  runHeadlessCli,
  setRuntimeSetting,
} from './kritt-headless-lib.mjs';
import { FullscreenHeadlessPrompter, headlessStatusTone } from './kritt-headless-ui.mjs';

class BufferStream {
  constructor({ isTTY = false } = {}) {
    this.isTTY = isTTY;
    this.text = '';
  }

  write(value) {
    this.text += value;
    return true;
  }
}

function testIo({ tty = false } = {}) {
  return { input: { isTTY: tty }, output: new BufferStream({ isTTY: tty }), error: new BufferStream() };
}

async function temporaryProject(t) {
  const rootDir = await mkdtemp(join(tmpdir(), 'open-kritt-headless-'));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  return rootDir;
}

test('API base defaults to the project backend port and accepts an explicit /api URL', async (t) => {
  const rootDir = await temporaryProject(t);
  await writeFile(join(rootDir, '.env'), 'BACKEND_PORT=4312\n');

  assert.equal(await resolveHeadlessApiBase({ rootDir, env: {} }), 'http://127.0.0.1:4312/api');
  assert.equal(
    await resolveHeadlessApiBase({ rootDir, env: {}, apiUrl: 'https://scanner.example/base/api/' }),
    'https://scanner.example/base/api'
  );
  await assert.rejects(resolveHeadlessApiBase({ rootDir, apiUrl: 'file:///tmp/socket' }), /must use http or https/);
});

test('attachment filenames reject paths and decode RFC 5987 names', () => {
  assert.equal(attachmentFilename('attachment; filename="../scan.zip"'), 'scan.zip');
  assert.equal(attachmentFilename("attachment; filename*=UTF-8''scan%20results.zip"), 'scan results.zip');
  assert.equal(attachmentFilename('', 'fallback.zip'), 'fallback.zip');
});

test('portable resource imports use the matching API endpoint and strip export metadata', async (t) => {
  const rootDir = await temporaryProject(t);
  const requests = [];
  const client = {
    importResource: async (endpoint, body) => {
      requests.push({ endpoint, body });
      return { id: `${requests.length}`, ...body };
    },
  };
  const fixtures = [
    [
      'workflow',
      'workflow.json',
      {
        kind: 'open-kritt-workflow',
        version: 2,
        workflow: {
          name: 'Portable workflow',
          description: '',
          levels: [
            {
              depth: 0,
              multiOutput: false,
              consumesAll: false,
              bindPrevious: false,
              outputFormat: {
                explanation: 'string',
                file_path: 'string',
                line: 'number',
                malicious_input_example: 'string',
                summary: 'string',
                trigger_flow: 'array',
                vulnerability_type: 'string',
                malicious_actor: 'string',
              },
              steps: [{ clientId: 'step-1', name: 'Review', content: 'Review {{repo_full}}' }],
            },
          ],
        },
      },
      '/workflows',
    ],
    [
      'post-script',
      'post.json',
      {
        kind: 'open-kritt-post-script',
        version: 1,
        postScript: {
          name: 'Report',
          description: '',
          content: 'Write {{summary}}',
          outputFormat: { _reserved_report: 'string' },
          id: 'not-portable',
        },
      },
      '/post-scripts',
    ],
    [
      'skill',
      'skill.json',
      {
        kind: 'open-kritt-agent-skill',
        version: 1,
        agentSkill: {
          name: 'Data flow',
          slug: 'data-flow',
          description: '',
          content: 'Follow tainted input.',
          sourceUrl: null,
          licenseSpdx: null,
          attribution: null,
        },
      },
      '/agent-skills',
    ],
    [
      'ranker',
      'ranker.json',
      {
        kind: 'open-kritt-severity-ranker',
        version: 1,
        severityRanker: { name: 'Impact', description: '', content: '- Critical for full compromise' },
      },
      '/severity-rankers',
    ],
  ];

  for (const [resourceType, filename, document, endpoint] of fixtures) {
    await writeFile(join(rootDir, filename), `${JSON.stringify(document)}\n`);
    await importPortableResource({ client, resourceType, filePath: filename, rootDir });
    assert.equal(requests.at(-1).endpoint, endpoint);
    assert.equal(requests.at(-1).body.id, undefined);
  }
});

test('portable imports reject non-files and oversized files before the API call', async (t) => {
  const rootDir = await temporaryProject(t);
  await mkdir(join(rootDir, 'directory'));
  let called = false;
  const client = { importResource: async () => (called = true) };

  await assert.rejects(
    importPortableResource({ client, resourceType: 'skill', filePath: 'directory', rootDir }),
    /not a file/
  );
  await writeFile(join(rootDir, 'large.json'), Buffer.alloc(2 * 1024 * 1024 + 1));
  await assert.rejects(
    importPortableResource({ client, resourceType: 'ranker', filePath: 'large.json', rootDir }),
    /2 MB or smaller/
  );
  assert.equal(called, false);
});

test('required extras combine workflow declarations with selected post-script templates', () => {
  assert.deepEqual(
    requiredExtraKeys({ extra: ['program'] }, [
      { content: 'Use {{ extra.asset }} and {{extra.program}}.' },
      { content: 'Then inspect {{extra.environment}}.' },
    ]),
    ['program', 'asset', 'environment']
  );
});

class ScanPrompter {
  constructor() {
    this.events = [];
  }

  async select(question, items) {
    this.events.push(`select:${question}`);
    if (question === 'Workflow') return items[0];
    if (question === 'Target repository kind') return 'remote';
    if (question.endsWith('Model provider')) return 'codex';
    if (question.endsWith('Harness')) return 'codex';
    if (question.endsWith('Thinking effort') || question === 'Post-processing thinking effort') return 'medium';
    if (question === 'Model') return items[0];
    throw new Error(`Unexpected select: ${question}`);
  }

  async selectMany(question, items) {
    this.events.push(`selectMany:${question}`);
    if (question === 'Post-scripts') return items;
    if (question.startsWith('Agent skills')) return items;
    if (question.startsWith('Severity rankers')) return items;
    throw new Error(`Unexpected selectMany: ${question}`);
  }

  async ask(question, options = {}) {
    this.events.push(`ask:${question}`);
    if (question.startsWith('Required extra.')) return 'production';
    if (question.startsWith('GitHub target')) return 'acme/service';
    if (question === 'Target revision') return 'HEAD';
    if (question === 'Repository scope') return 'src/';
    if (question.startsWith('Configuration JSON')) return '{"max_files":100}';
    if (question.startsWith('Maximum model jobs')) return '25';
    if (question.startsWith('Additional severity rules')) return '';
    return `${options.defaultValue ?? ''}`;
  }

  async confirm(question) {
    this.events.push(`confirm:${question}`);
    if (question === 'Create this scan?') return true;
    return false;
  }
}

function scanCreationClient() {
  const calls = [];
  return {
    calls,
    workflows: async () => [{ id: '1', name: 'Audit', stepCount: 1, depths: [0], extra: ['environment'] }],
    postScripts: async () => [
      { id: '2', name: 'Report', content: 'Context: {{extra.environment}}', keys: ['_reserved_report'] },
    ],
    agentSkills: async () => [{ id: '3', name: 'Taint', slug: 'taint' }],
    severityRankers: async () => [{ id: '4', name: 'Impact', content: '- High for account takeover' }],
    localRepos: async () => [],
    modelProviders: async () => ({ providers: ['codex'] }),
    modelCatalog: async () => ({
      providers: [
        {
          provider: 'codex',
          input: 'select',
          status: 'ready',
          defaultModel: 'gpt-test',
          models: [{ id: 'gpt-test', label: 'GPT Test', thinkingEfforts: ['medium'] }],
        },
      ],
    }),
    createScan: async (payload) => {
      calls.push(payload);
      return { id: '99', status: 'pending', ...payload };
    },
  };
}

test('interactive scan creation asks workflow and post-scripts first and submits the full UI contract', async (t) => {
  const rootDir = await temporaryProject(t);
  const client = scanCreationClient();
  const prompter = new ScanPrompter();
  const io = testIo();

  const scan = await createScanInteractively({ client, prompter, io, rootDir });

  assert.equal(scan.id, '99');
  assert.deepEqual(prompter.events.slice(0, 3), [
    'select:Workflow',
    'selectMany:Post-scripts',
    'ask:Required extra.environment (prefix a path with @ to read a file)',
  ]);
  assert.deepEqual(client.calls, [
    {
      workflowId: '1',
      postScriptId: '2',
      agentSkillIds: ['3'],
      repo_kind: 'remote',
      repo_full: 'acme/service',
      commit_sha: 'HEAD',
      repo_scope: 'src/',
      dependencies: [],
      configuration: { max_files: 100, post_script_ids: ['2'], agent_skill_ids: ['3'] },
      model: 'gpt-test',
      model_provider: 'codex',
      harness: 'codex',
      thinking_effort: 'medium',
      post_processing_thinking_effort: 'medium',
      model_overrides: {},
      severity_ranker: '- High for account takeover',
      extra: { environment: 'production' },
      jobLimit: 25,
    },
  ]);
});

test('interactive scan creation handles the backend launch-policy choice', async (t) => {
  const rootDir = await temporaryProject(t);
  const client = scanCreationClient();
  let calls = 0;
  client.createScan = async (payload) => {
    calls += 1;
    client.calls.push(payload);
    if (calls === 1) {
      throw new HeadlessApiError('Choose a launch policy.', 409, { code: 'scan_launch_policy_required' });
    }
    return { id: '100', status: 'queued' };
  };
  const prompter = new ScanPrompter();
  const originalSelect = prompter.select.bind(prompter);
  prompter.select = async (question, items) => {
    if (question.startsWith('Another scan is active')) return 'queue';
    return originalSelect(question, items);
  };

  const scan = await createScanInteractively({ client, prompter, io: testIo(), rootDir });

  assert.equal(scan.status, 'queued');
  assert.equal(client.calls[1].launchPolicy, 'queue');
});

test('scan detail formatting includes stages and reasons but not finding bodies', () => {
  const output = formatScanSummary(
    {
      id: '7',
      status: 'failed',
      repoDisplay: 'acme/service',
      workflowName: 'Audit',
      postScriptNames: ['Report'],
      model: 'gpt-test',
      modelProvider: 'codex',
      harness: 'codex',
      insertedAt: '2026-01-01',
      updatedAt: '2026-01-02',
      statusSummary: {
        completedAttempts: 1,
        totalAttempts: 2,
        activeJobs: [{ depth: 1, title: 'Trace input', phaseLabel: 'Running harness', model: 'gpt-test' }],
        recentErrors: [{ source: 'Workflow step', phaseLabel: 'Failed', message: 'Provider rejected request' }],
      },
    },
    { detailed: true }
  );

  assert.match(output, /depth 1 · Trace input · Running harness/);
  assert.match(output, /Provider rejected request/);
  assert.doesNotMatch(output, /jsonAnswer|postScriptAnswer|vulnerabilities/);
});

test('settings set validates against server metadata before patching', async () => {
  const calls = [];
  const client = {
    settings: async () => ({ settings: { workerCount: { value: 2, type: 'integer', min: 0, max: 20 } } }),
    updateSettings: async (patch) => {
      calls.push(patch);
      return { settings: { workerCount: { value: patch.workerCount } } };
    },
  };

  await setRuntimeSetting({ client, key: 'workerCount', value: '4' });
  assert.deepEqual(calls, [{ workerCount: 4 }]);
  await assert.rejects(setRuntimeSetting({ client, key: 'workerCount', value: '4.5' }), /whole number/);
  await assert.rejects(setRuntimeSetting({ client, key: 'missing', value: '1' }), /Unknown runtime setting/);
});

test('scan exports stream to a destination and refuse accidental overwrite', async (t) => {
  const rootDir = await temporaryProject(t);
  const fetchImpl = async () =>
    new Response('zip-bytes', {
      status: 200,
      headers: { 'Content-Disposition': 'attachment; filename="portable-findings.zip"' },
    });
  const client = new HeadlessApiClient({ baseUrl: 'http://127.0.0.1:3002/api', fetchImpl });

  const exported = await client.downloadScanExport('12', rootDir);
  assert.equal(exported, join(rootDir, 'portable-findings.zip'));
  assert.equal(await readFile(exported, 'utf8'), 'zip-bytes');
  await assert.rejects(client.downloadScanExport('12', rootDir), /Refusing to overwrite/);
  assert.equal(await client.downloadScanExport('12', rootDir, { overwrite: true }), exported);
});

test('command mode reports scan status through an injected client', async (t) => {
  const rootDir = await temporaryProject(t);
  const io = testIo();
  const client = {
    scans: async (status) => {
      assert.equal(status, 'running');
      return [{ id: '8', status: 'running', repoDisplay: 'acme/api', workflowName: 'Audit' }];
    },
  };

  assert.equal(await runHeadlessCli(['scan', 'list', 'running'], { client, io, rootDir, env: {} }), 0);
  assert.match(io.output.text, /Scan 8 · running/);
  assert.equal(io.error.text, '');
});

test('scan export command defaults to the repository root', async (t) => {
  const rootDir = await temporaryProject(t);
  const io = testIo();
  const client = {
    downloadScanExport: async (id, destination, options) => {
      assert.equal(id, '12');
      assert.equal(destination, rootDir);
      assert.deepEqual(options, { overwrite: false });
      return join(rootDir, 'scan-12-findings.zip');
    },
  };

  assert.equal(await runHeadlessCli(['scan', 'export', '12'], { client, io, rootDir, env: {} }), 0);
  assert.match(io.output.text, new RegExp(`Export saved to ${rootDir}`));
});

test('full-screen headless prompts add friendly menu metadata and scan status colors', async () => {
  const calls = [];
  const terminal = {
    choose: async (config) => {
      calls.push(config);
      return config.title === 'Command center' ? '0' : '1';
    },
  };
  const prompter = new FullscreenHeadlessPrompter({
    baseUrl: 'http://127.0.0.1:3002/api',
    terminal,
  });

  assert.equal(await prompter.select('Main menu', ['Create scan', 'Exit']), 'Create scan');
  const scans = [
    { id: '1', status: 'running', repoDisplay: 'acme/api' },
    { id: '2', status: 'failed', repoDisplay: 'acme/web' },
  ];
  assert.equal(await prompter.select('Inspect a scan', scans, { label: (scan) => `#${scan.id}` }), scans[1]);

  assert.match(calls[0].subtitle, /connected to http:\/\/127\.0\.0\.1:3002\/api/);
  assert.match(calls[0].options[0].description, /guided setup/);
  assert.equal(calls[1].options[0].tone, 'info');
  assert.equal(calls[1].options[1].tone, 'danger');
  assert.match(calls[1].options[1].description, /acme\/web/);
  assert.equal(headlessStatusTone('completed'), 'success');
  assert.equal(headlessStatusTone('queued'), 'warning');
});

test('full-screen multi-select maps checked indexes back to resources', async () => {
  const resources = [{ name: 'Report' }, { name: 'PoC' }, { name: 'Notify' }];
  const terminal = {
    chooseMany: async (config) => {
      assert.equal(config.required, true);
      assert.deepEqual(
        config.options.map((option) => option.label),
        ['Report', 'PoC', 'Notify']
      );
      return [0, 2];
    },
  };
  const prompter = new FullscreenHeadlessPrompter({ terminal });

  assert.deepEqual(
    await prompter.selectMany('Post-scripts', resources, { label: (item) => item.name, required: true }),
    [resources[0], resources[2]]
  );
});

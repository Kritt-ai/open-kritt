import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { discoverConfiguredModelProviders } from '../src/lib/providerDiscovery.js';
import { configuredModelProviders, isModelProviderConfigured } from '../src/lib/modelProviders.js';

const PROVIDER_ENV_KEYS = [
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'OPEN_KRITT_CODEX_API_KEY_CONFIGURED',
  'OPEN_KRITT_OPENAI_API_KEY_CONFIGURED',
  'OPEN_KRITT_ANTHROPIC_API_KEY_CONFIGURED',
  'OPEN_KRITT_OPENROUTER_API_KEY_CONFIGURED',
  'OPEN_KRITT_CODEX_LOGIN_CONFIGURED',
  'CODEX_LOGIN_CONFIGURED',
];

const NO_LOCAL_LOGIN = {
  codex: {
    primaryHome: '/definitely/missing/codex-primary',
    accountsRoot: '/definitely/missing/codex-accounts',
    runtimeConfigPath: '/definitely/missing/engine-runtime.env',
    initialHome: '',
  },
  claude: { home: '/definitely/missing/claude' },
};

function restoreEnv(previous) {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function requestApp(path, options) {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, options);
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('configuredModelProviders returns canonical providers configured by presence flags', () => {
  const providers = configuredModelProviders({
    env: {
      OPEN_KRITT_OPENAI_API_KEY_CONFIGURED: '1',
      OPEN_KRITT_ANTHROPIC_API_KEY_CONFIGURED: '1',
      OPEN_KRITT_OPENROUTER_API_KEY_CONFIGURED: '1',
    },
  });

  assert.deepEqual(providers, ['codex', 'claude', 'openrouter']);
});

test('configuredModelProviders does not mistake a stale Codex login marker for credentials', () => {
  assert.deepEqual(configuredModelProviders({ env: { OPEN_KRITT_CODEX_LOGIN_CONFIGURED: '1' }, loginOptions: NO_LOCAL_LOGIN }), []);
  assert.deepEqual(configuredModelProviders({ env: { CODEX_LOGIN_CONFIGURED: 'true' }, loginOptions: NO_LOCAL_LOGIN }), []);
});

test('configuredModelProviders does not treat disabled presence flags as credentials', () => {
  const providers = configuredModelProviders({
    env: { OPEN_KRITT_CODEX_LOGIN_CONFIGURED: '0', OPEN_KRITT_OPENROUTER_API_KEY_CONFIGURED: '0' },
    loginOptions: NO_LOCAL_LOGIN,
  });

  assert.deepEqual(providers, []);
});

test('configured provider checks accept local raw credentials', () => {
  const env = { CODEX_API_KEY: 'local-key' };

  assert.equal(isModelProviderConfigured('codex', { env, loginOptions: NO_LOCAL_LOGIN }), true);
  assert.equal(isModelProviderConfigured('claude', { env, loginOptions: NO_LOCAL_LOGIN }), false);
});

test('model provider API exposes configured IDs and rejects unavailable scan providers', async (t) => {
  const previous = new Map(PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROVIDER_ENV_KEYS) delete process.env[key];
  process.env.CODEX_API_KEY = 'test-key';
  t.after(() => restoreEnv(previous));

  const availability = await requestApp('/api/model-providers');
  assert.equal(availability.status, 200);
  assert.equal(availability.body.providers.includes('codex'), true);
  assert.equal(availability.body.providers.includes('openrouter'), false);

  const scan = await requestApp('/api/scans', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflowId: '1',
      postScriptId: '1',
      repo_kind: 'remote',
      repo_full: 'open-kritt/open-kritt',
      commit_sha: 'HEAD',
      model: 'test-model',
      model_provider: 'openrouter',
      harness: 'codex',
      severity_ranker: 'Rank by impact.',
    }),
  });
  assert.equal(scan.status, 422);
  assert.equal(scan.body.error, 'Validation failed.');
  assert.equal(scan.body.errors[0].field, 'model_provider');
  assert.match(scan.body.errors[0].message, /Model provider must be one of:/);
});

test('discovered model providers include authenticated local sessions from the account summary', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-provider-discovery-'));
  const credentialsPath = join(directory, 'providers.json');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  await rm(directory, { recursive: true, force: true });
  const providers = await discoverConfiguredModelProviders({
    credentialsPath,
    statusOptions: {
      env: {},
      loginOptions: {
        codex: {
          primaryHome: '/missing/codex',
          accountsRoot: '/missing/codex-accounts',
          runtimeConfigPath,
          initialHome: '/missing/codex',
        },
        claude: { home: '/missing/claude' },
      },
    },
    getSummary: async () => ({
      providers: [
        { id: 'codex', configured: true },
        { id: 'claude', configured: false },
        { id: 'openrouter', configured: false },
      ],
    }),
  });

  assert.equal(providers.includes('codex'), true);
  assert.equal(providers.includes('claude'), false);
});

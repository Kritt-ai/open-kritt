import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { configuredModelProviders, isModelProviderConfigured } from '../src/lib/modelProviders.js';

const PROVIDER_ENV_KEYS = [
  'CODEX_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'XAI_API_KEY',
  'OPEN_KRITT_CODEX_API_KEY_CONFIGURED',
  'OPEN_KRITT_OPENAI_API_KEY_CONFIGURED',
  'OPEN_KRITT_ANTHROPIC_API_KEY_CONFIGURED',
  'OPEN_KRITT_OPENROUTER_API_KEY_CONFIGURED',
  'OPEN_KRITT_XAI_API_KEY_CONFIGURED',
  'OPEN_KRITT_CODEX_LOGIN_CONFIGURED',
  'CODEX_LOGIN_CONFIGURED',
];

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
  assert.deepEqual(configuredModelProviders({ env: { OPEN_KRITT_CODEX_LOGIN_CONFIGURED: '1' } }), []);
  assert.deepEqual(configuredModelProviders({ env: { CODEX_LOGIN_CONFIGURED: 'true' } }), []);
});

test('configuredModelProviders does not treat disabled presence flags as credentials', () => {
  const providers = configuredModelProviders({
    env: { OPEN_KRITT_CODEX_LOGIN_CONFIGURED: '0', OPEN_KRITT_OPENROUTER_API_KEY_CONFIGURED: '0' },
  });

  assert.deepEqual(providers, []);
});

test('configured provider checks accept local raw credentials', () => {
  const env = { CODEX_API_KEY: 'local-key' };

  assert.equal(isModelProviderConfigured('codex', { env }), true);
  assert.equal(isModelProviderConfigured('claude', { env }), false);
});

test('model provider API exposes configured IDs and rejects unavailable scan providers', async (t) => {
  const previous = new Map(PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of PROVIDER_ENV_KEYS) delete process.env[key];
  process.env.CODEX_API_KEY = 'test-key';
  t.after(() => restoreEnv(previous));

  const availability = await requestApp('/api/model-providers');
  assert.equal(availability.status, 200);
  assert.deepEqual(availability.body, { providers: ['codex'] });

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
  assert.deepEqual(scan.body, {
    error: 'Validation failed.',
    errors: [{ field: 'model_provider', message: 'The selected model provider is not configured.' }],
  });
});

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  consumeCodexManualReset,
  fetchExecutorAccounts,
  getAccountProvider,
  getAccountsOverview,
} from '../src/lib/accounts.js';

test('executor account integration loads each provider independently with the distinct internal bearer token', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const request = { url: String(url), options };
    requests.push(request);
    const provider = new URL(request.url).pathname.split('/').at(-1);
    return {
      ok: true,
      async json() {
        return { kind: provider, accounts: [] };
      },
    };
  };

  const accounts = await fetchExecutorAccounts({
    refresh: true,
    executorViewUrl: 'http://executor-view:8090',
    internalToken: 'backend-only-token',
  });

  assert.deepEqual(
    accounts.providers.map((provider) => provider.kind),
    ['codex', 'claude', 'openrouter']
  );
  assert.deepEqual(
    requests.map((request) => request.url),
    [
      'http://executor-view:8090/api/accounts/codex?refresh=1',
      'http://executor-view:8090/api/accounts/claude?refresh=1',
      'http://executor-view:8090/api/accounts/openrouter?refresh=1',
    ]
  );
  assert.ok(requests.every((request) => request.options.headers.Authorization === 'Bearer backend-only-token'));
  assert.ok(requests.every((request) => request.options.redirect === 'error'));
});

test('executor account integration fails closed when its internal token is unavailable', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error('must not make an unauthenticated internal request');
  };

  const accounts = await fetchExecutorAccounts({
    executorViewUrl: 'http://executor-view:8090',
    internalToken: '',
    internalTokenFile: '/definitely/missing/internal-token',
  });

  assert.equal(accounts, null);
  assert.equal(called, false);
});

test('Codex reset integration uses only the selected internal account endpoint', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), options };
    return {
      ok: true,
      status: 200,
      async json() {
        return { outcome: 'reset', windowsReset: 1 };
      },
    };
  };

  const result = await consumeCodexManualReset('account/one', {
    executorViewUrl: 'http://executor-view:8090',
    internalToken: 'backend-only-token',
  });

  assert.deepEqual(result, { outcome: 'reset', windowsReset: 1 });
  assert.equal(request.url, 'http://executor-view:8090/api/accounts/codex/account%2Fone/reset');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers.Authorization, 'Bearer backend-only-token');
});

test('account provider falls back to local Codex runtime homes when executor detail is unavailable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-accounts-codex-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const primaryHome = join(directory, 'codex-primary');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  await mkdir(primaryHome, { recursive: true });
  const payload = Buffer.from(JSON.stringify({ email: 'reviewer@example.com', name: 'Reviewer' })).toString('base64url');
  await writeFile(join(primaryHome, 'auth.json'), JSON.stringify({ tokens: { id_token: `header.${payload}.sig` } }));
  await writeFile(runtimeConfigPath, 'ENGINE_CODEX_HOME=/runtime/.codex\n');

  const provider = await getAccountProvider('codex', {
    statusOptions: {
      env: {},
      credentialsPath: join(directory, 'missing-credentials.json'),
      loginOptions: {
        codex: {
          primaryHome,
          runtimeConfigPath,
          runtimePrimaryHome: '/runtime/.codex',
        },
      },
    },
    executorOptions: {
      internalToken: '',
      internalTokenFile: join(directory, 'missing-token'),
    },
  });

  assert.equal(provider.loadError, null);
  assert.equal(provider.source, 'codex_login');
  assert.equal(provider.active, 1);
  assert.equal(provider.total, 1);
  assert.deepEqual(provider.accounts.map((account) => account.id), ['primary']);
  assert.equal(provider.accounts[0].email, 'reviewer@example.com');
  assert.equal(provider.accounts[0].statusKind, 'available');
});

test('accounts overview preserves local Claude sessions when executor detail is unavailable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-accounts-claude-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const claudeHome = join(directory, '.claude');
  await mkdir(claudeHome, { recursive: true });
  await writeFile(
    join(claudeHome, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: { accessToken: 'token', refreshToken: 'refresh', expiresAt: Date.parse('2026-08-01T00:00:00Z') },
      email: 'claude@example.com',
      subscriptionType: 'max',
    })
  );

  const overview = await getAccountsOverview({
    statusOptions: {
      env: {},
      credentialsPath: join(directory, 'missing-credentials.json'),
      loginOptions: { claude: { home: claudeHome } },
    },
    executorOptions: {
      internalToken: '',
      internalTokenFile: join(directory, 'missing-token'),
    },
  });

  const claude = overview.providers.find((provider) => provider.id === 'claude');
  assert.equal(claude.source, 'claude_login');
  assert.equal(claude.active, 1);
  assert.equal(claude.total, 1);
  assert.equal(claude.accounts[0].email, 'claude@example.com');
  assert.equal(claude.accounts[0].status, 'logged in');
});

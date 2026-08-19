import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import express from 'express';

import { consumeCodexManualReset, fetchExecutorAccounts, fetchExecutorProvider } from '../src/lib/accounts.js';
import { createAccountsRouter } from '../src/routes/accounts.js';

async function requestRouter(router, path = '/') {
  const app = express();
  app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    return await fetch(`http://127.0.0.1:${port}${path}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('account API responses cannot be stored by browser caches', async () => {
  const router = createAccountsRouter({
    getSummary: () => ({ providers: [] }),
  });

  const response = await requestRouter(router, '/summary');

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

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

test('Claude account refresh renews a rejected login and retries live usage once', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return {
      ok: true,
      async json() {
        return {
          kind: 'claude',
          accounts: [
            requestCount === 1
              ? { status: 'sign-in required', statusKind: 'expired' }
              : { status: 'limit reached', statusKind: 'limited' },
          ],
        };
      },
    };
  };
  const renewals = [];

  const provider = await fetchExecutorProvider('claude', {
    refresh: true,
    executorViewUrl: 'http://executor-view:8090',
    internalToken: 'backend-only-token',
    claudeHome: '/provider-homes/claude',
    renewClaudeLogin: async (home) => {
      renewals.push(home);
      return true;
    },
  });

  assert.equal(requestCount, 2);
  assert.deepEqual(renewals, ['/provider-homes/claude']);
  assert.equal(provider.accounts[0].statusKind, 'limited');
});

test('Claude account refresh preserves sign-in status when credential renewal fails', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return {
      ok: true,
      async json() {
        return {
          kind: 'claude',
          accounts: [{ status: 'sign-in required', statusKind: 'expired' }],
        };
      },
    };
  };

  const provider = await fetchExecutorProvider('claude', {
    refresh: true,
    executorViewUrl: 'http://executor-view:8090',
    internalToken: 'backend-only-token',
    renewClaudeLogin: async () => false,
  });

  assert.equal(requestCount, 1);
  assert.equal(provider.accounts[0].statusKind, 'expired');
});

test('Claude account refresh renews each rejected managed account in its own home', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return {
      ok: true,
      async json() {
        return {
          kind: 'claude',
          accounts:
            requestCount === 1
              ? [
                  { id: 'reviewer', statusKind: 'expired' },
                  { id: 'researcher', statusKind: 'expired' },
                ]
              : [
                  { id: 'reviewer', statusKind: 'available' },
                  { id: 'researcher', statusKind: 'available' },
                ],
        };
      },
    };
  };
  const renewals = [];

  const provider = await fetchExecutorProvider('claude', {
    refresh: true,
    executorViewUrl: 'http://executor-view:8090',
    internalToken: 'backend-only-token',
    claudeAccountsRoot: '/provider-homes/claude-accounts',
    renewClaudeLogin: async (home) => {
      renewals.push(home);
      return true;
    },
  });

  assert.equal(requestCount, 2);
  assert.deepEqual(renewals, [
    '/provider-homes/claude-accounts/reviewer/.claude',
    '/provider-homes/claude-accounts/researcher/.claude',
  ]);
  assert.deepEqual(
    provider.accounts.map((account) => account.statusKind),
    ['available', 'available']
  );
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

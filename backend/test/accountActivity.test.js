import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, stat, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';

import {
  accountActivityId,
  accountIsActive,
  readAccountActivity,
  saveAccountActivity,
} from '../src/lib/accountActivity.js';
import { buildAccountsOverview, setAccountActive } from '../src/lib/accounts.js';
import { AccountLoginManager } from '../src/lib/accountLogins.js';
import { createAccountsRouter } from '../src/routes/accounts.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'account-activity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 'account-activity.json') };
}

test('defaults active and persists independent provider accounts through repeated and concurrent writes', async (t) => {
  const { directory, path } = await fixture(t);
  const credential = join(directory, 'providers.json');
  await writeFile(credential, '{"credentials":{"openrouter":"synthetic-key"}}');
  assert.equal(accountIsActive('codex', '/sample/one', readAccountActivity(path)), true);
  await Promise.all([
    saveAccountActivity('codex', '/sample/one', false, path),
    saveAccountActivity('claude', '/sample/one', false, path),
    saveAccountActivity('openrouter', 'OPENROUTER_API_KEY', false, path),
    saveAccountActivity('xai', '/sample/two', true, path),
  ]);
  await saveAccountActivity('codex', '/sample/one', false, path);
  assert.equal(readAccountActivity(path).length, 4);
  assert.equal(accountIsActive('codex', '/sample/one', readAccountActivity(path)), false);
  assert.equal(accountIsActive('xai', '/sample/two', readAccountActivity(path)), true);
  await saveAccountActivity('codex', '/sample/one', true, path);
  assert.equal(accountIsActive('codex', '/sample/one', readAccountActivity(path)), true);
  assert.equal(accountIsActive('claude', '/sample/one', readAccountActivity(path)), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(await readFile(credential, 'utf8'), '{"credentials":{"openrouter":"synthetic-key"}}');
});

test('corrupt preferences fail closed and failed writes preserve the saved state', async (t) => {
  const { path } = await fixture(t);
  await writeFile(path, 'invalid');
  assert.throws(() => readAccountActivity(path), { statusCode: 503 });
  await assert.rejects(saveAccountActivity('codex', '/sample/one', true, path), { statusCode: 503 });
  assert.equal(await readFile(path, 'utf8'), 'invalid');
});

test('saved activity remains separate from authentication health for every provider', () => {
  for (const id of ['codex', 'claude', 'openrouter', 'xai', 'deepseek']) {
    const overview = buildAccountsOverview(
      [{ id, configured: true }],
      {
        providers: [
          {
            kind: id,
            accounts: [
              { path: '/sample/one', active: false, statusKind: 'expired' },
              { path: '/sample/two', active: true, statusKind: 'available' },
            ],
          },
        ],
      },
      [{ provider: id, path: '/sample/two', active: false }]
    );
    assert.equal(overview.providers[0].accounts[0].active, true);
    assert.equal(overview.providers[0].accounts[0].available, false);
    assert.equal(overview.providers[0].accounts[1].active, false);
    assert.equal(overview.providers[0].accounts[1].available, true);
    assert.equal(overview.active, 1);
  }
});

test('configured environment keys receive their own activity control', () => {
  const overview = buildAccountsOverview(
    [{ id: 'codex', configured: true, apiKeyConfigured: true, apiKeyPath: 'CODEX_API_KEY', label: 'Codex' }],
    null
  );
  assert.equal(overview.providers[0].accounts[0].activityId, accountActivityId('CODEX_API_KEY'));
  assert.equal(overview.providers[0].accounts[0].active, true);
});

test('PATCH validates the provider, account and boolean before persisting', async (t) => {
  const { path } = await fixture(t);
  const activityId = accountActivityId('/sample/one');
  const getProvider = async (provider) =>
    provider === 'codex' ? { accounts: [{ activityId, path: '/sample/one' }] } : null;
  const app = express();
  app.use(express.json());
  app.use(
    createAccountsRouter({
      setActive: (provider, id, active) => setAccountActive(provider, id, active, { getProvider, activityPath: path }),
    })
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const patch = (provider, id, active) =>
    fetch(`http://127.0.0.1:${server.address().port}/${provider}/account/${id}/active`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
  assert.equal((await patch('codex', activityId, 'false')).status, 422);
  assert.equal((await patch('unknown', activityId, false)).status, 404);
  assert.equal((await patch('codex', 'unknown', false)).status, 404);
  const response = await patch('codex', activityId, false);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { activityId, active: false });
  assert.equal(accountIsActive('codex', '/sample/one', readAccountActivity(path)), false);
});

test('manual usage refuses an inactive runtime account before spawning', async (t) => {
  const { directory } = await fixture(t);
  await writeFile(join(directory, 'auth.json'), '{}');
  let spawned = false;
  const manager = new AccountLoginManager({
    codexPrimaryHome: directory,
    codexRuntimePrimaryHome: '/sample/primary',
    isAccountActive(provider, home) {
      assert.equal(provider, 'codex');
      assert.equal(home, '/sample/primary');
      return false;
    },
    spawnProcess() {
      spawned = true;
      throw new Error('Unexpected process');
    },
  });
  await assert.rejects(manager.startWeeklyUsage('primary'), { statusCode: 409 });
  assert.equal(spawned, false);
});

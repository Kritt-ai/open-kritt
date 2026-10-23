import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AccountLoginManager } from '../src/lib/accountLogins.js';

async function loginManager(t) {
  const root = await mkdtemp(join(tmpdir(), 'open-kritt-login-admission-'));
  const homes = [];
  const manager = new AccountLoginManager({
    codexPrimaryHome: join(root, 'primary', '.codex'),
    codexAccountsRoot: join(root, 'codex-accounts'),
    grokAccountsRoot: join(root, 'grok-accounts'),
    spawnProcess: (_command, _args, options) => {
      homes.push(options.env.CODEX_HOME || options.env.GROK_HOME);
      return new EventEmitter();
    },
  });
  t.after(async () => {
    for (const session of manager.sessions.values()) clearTimeout(session.timeout);
    await rm(root, { recursive: true, force: true });
  });
  return { root, manager, homes };
}

test('concurrent relogins share one admission and child for an existing account', async (t) => {
  const { manager, homes } = await loginManager(t);
  await mkdir(manager.codexPrimaryHome, { recursive: true });
  await writeFile(
    join(manager.codexPrimaryHome, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'synthetic' } })
  );
  const [first, second] = await Promise.all([manager.start('codex', 'primary'), manager.start('codex', 'primary')]);
  assert.equal(first.id, second.id);
  assert.deepEqual(homes, [manager.codexPrimaryHome]);
});

test('independent providers can initialize concurrently', async (t) => {
  const { manager, homes } = await loginManager(t);
  const [codex, grok] = await Promise.all([manager.start('codex'), manager.start('xai')]);
  assert.notEqual(codex.id, grok.id);
  assert.equal(homes.length, 2);
  assert.deepEqual(new Set([codex.provider, grok.provider]), new Set(['codex', 'xai']));
});

test('failed admission releases the provider for a later valid start', async (t) => {
  const { manager, homes } = await loginManager(t);
  const attempts = await Promise.allSettled([
    manager.start('codex', 'missing-account'),
    manager.start('codex', 'missing-account'),
  ]);
  assert.equal(
    attempts.every((attempt) => attempt.status === 'rejected'),
    true
  );
  assert.equal(homes.length, 0);
  const result = await manager.start('codex');
  assert.equal(result.status, 'starting');
  assert.equal(homes.length, 1);
});

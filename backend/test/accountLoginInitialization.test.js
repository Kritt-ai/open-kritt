import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AccountLoginManager } from '../src/lib/accountLogins.js';

for (const provider of ['codex', 'claude', 'xai']) {
  test(`${provider} login can retry after repairing its account directory`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'open-kritt-login-setup-'));
    const accountsRoot = join(root, 'accounts');
    await writeFile(accountsRoot, 'synthetic blocked directory');
    let spawned = 0;
    const manager = new AccountLoginManager({
      codexAccountsRoot: accountsRoot,
      claudeAccountsRoot: accountsRoot,
      grokAccountsRoot: accountsRoot,
      claudeHome: join(root, 'primary', '.claude'),
      spawnProcess: () => {
        spawned += 1;
        return new EventEmitter();
      },
    });
    t.after(async () => {
      for (const session of manager.sessions.values()) clearTimeout(session.timeout);
      await rm(root, { recursive: true, force: true });
    });
    await assert.rejects(manager.start(provider));
    await rm(accountsRoot);
    await mkdir(accountsRoot);
    const result = await manager.start(provider);
    assert.equal(spawned, 1);
    assert.equal(result.status, 'starting');
    assert.equal([...manager.sessions.values()].filter((session) => session.status === 'starting').length, 1);
  });
}

test('failed relogin initialization preserves existing account credentials', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'open-kritt-relogin-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, '.codex');
  await mkdir(primary);
  const authPath = join(primary, 'auth.json');
  const original = JSON.stringify({ tokens: { access_token: 'synthetic-existing' } });
  await writeFile(authPath, original);
  const manager = new AccountLoginManager({
    codexPrimaryHome: primary,
    spawnProcess: () => {
      throw new Error('synthetic spawn failure');
    },
  });
  await assert.rejects(manager.start('codex', 'primary'));
  assert.equal(await readFile(authPath, 'utf8'), original);
});

test('failed Claude staging setup removes only its newly allocated account directory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'open-kritt-claude-setup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const accountsRoot = join(root, 'accounts');
  const existing = join(accountsRoot, 'existing');
  await mkdir(existing, { recursive: true });
  await writeFile(join(existing, 'keep'), 'existing account');
  const blocker = join(root, 'blocking-file');
  await writeFile(blocker, 'synthetic blocked directory');
  const manager = new AccountLoginManager({
    claudeAccountsRoot: accountsRoot,
    claudeHome: join(blocker, '.claude'),
    spawnProcess: () => {
      throw new Error('should not reach spawn');
    },
  });
  await assert.rejects(manager.start('claude'));
  assert.deepEqual(await readdir(accountsRoot), ['existing']);
  assert.equal(await readFile(join(existing, 'keep'), 'utf8'), 'existing account');
  assert.equal(
    [...manager.sessions.values()].some((session) => session.status === 'starting'),
    false
  );
});

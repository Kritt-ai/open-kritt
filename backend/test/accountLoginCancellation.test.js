import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AccountLoginManager } from '../src/lib/accountLogins.js';

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kritt-benign-login-proof-'));
  const children = [];
  const manager = new AccountLoginManager({
    claudeHome: join(root, 'claude-primary'),
    claudeAccountsRoot: join(root, 'claude-accounts'),
    claudeRuntimePrimaryHome: '/synthetic/claude-primary',
    claudeRuntimeAccountsRoot: '/synthetic/claude-accounts',
    grokPrimaryHome: join(root, 'grok-primary'),
    grokAccountsRoot: join(root, 'grok-accounts'),
    grokRuntimePrimaryHome: '/synthetic/grok-primary',
    grokRuntimeAccountsRoot: '/synthetic/grok-accounts',
    codexPrimaryHome: join(root, 'primary'),
    codexAccountsRoot: join(root, 'accounts'),
    codexRuntimePrimaryHome: '/synthetic/primary',
    codexRuntimeAccountsRoot: '/synthetic/accounts',
    runtimeConfigPath: join(root, 'runtime.env'),
    environmentFilePath: join(root, 'project.env'),
    spawnProcess: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.signals = [];
      child.kill = (signal) => {
        child.signals.push(signal);
        return true;
      };
      children.push(child);
      return child;
    },
    ...extra,
  });
  t.after(async () => {
    for (const session of manager.sessions.values()) clearTimeout(session.timeout);
    await rm(root, { recursive: true, force: true });
  });
  return { root, manager, children };
}

test('cancel remains terminal after buffered login output and successful child close', async (t) => {
  const { manager, children } = await fixture(t);
  const login = await manager.start('codex');
  const session = manager.sessions.get(login.id);
  await writeFile(join(session.codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'synthetic' } }));
  manager.cancel(login.id);
  children[0].stdout.emit('data', 'https://auth.openai.com/codex/device\nABCD-12345');
  await manager.finish(session, 0);
  assert.equal(manager.get(login.id).status, 'canceled');
  await assert.rejects(readFile(manager.runtimeConfigPath), { code: 'ENOENT' });
  await assert.rejects(readFile(manager.environmentFilePath), { code: 'ENOENT' });
});
test('cancellation during final credential checks cannot complete the login', async (t) => {
  const { manager } = await fixture(t);
  const login = await manager.start('codex');
  const session = manager.sessions.get(login.id);
  await writeFile(join(session.codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'synthetic' } }));
  const finish = manager.finish(session, 0);
  manager.cancel(login.id);
  await finish;
  assert.equal(manager.get(login.id).status, 'canceled');
  await assert.rejects(readFile(manager.runtimeConfigPath), { code: 'ENOENT' });
  await assert.rejects(readFile(manager.environmentFilePath), { code: 'ENOENT' });
});
test('expiration cannot subsequently save a successful child login', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager } = await fixture(t, { timeoutMs: 5 });
  const login = await manager.start('codex');
  const session = manager.sessions.get(login.id);
  await writeFile(join(session.codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'synthetic' } }));
  t.mock.timers.tick(5);
  assert.equal(manager.get(login.id).status, 'failed');
  await manager.finish(session, 0);
  assert.equal(manager.get(login.id).status, 'failed');
  await assert.rejects(readFile(manager.runtimeConfigPath), { code: 'ENOENT' });
  await assert.rejects(readFile(manager.environmentFilePath), { code: 'ENOENT' });
});
test('control: cancellation without late output stays canceled', async (t) => {
  const { manager } = await fixture(t);
  const login = await manager.start('codex');
  manager.cancel(login.id);
  await manager.finish(manager.sessions.get(login.id), 0);
  assert.equal(manager.get(login.id).status, 'canceled');
  await assert.rejects(readFile(manager.runtimeConfigPath), { code: 'ENOENT' });
  await assert.rejects(readFile(manager.environmentFilePath), { code: 'ENOENT' });
});

test('canceling a relogin preserves existing credentials and registration', async (t) => {
  const { manager } = await fixture(t);
  await mkdir(manager.codexPrimaryHome, { recursive: true });
  const credential = JSON.stringify({ tokens: { access_token: 'synthetic-existing' } });
  await writeFile(join(manager.codexPrimaryHome, 'auth.json'), credential);
  const runtime = 'ENGINE_CODEX_HOME=/synthetic/primary\n';
  await writeFile(manager.runtimeConfigPath, runtime);
  const login = await manager.start('codex', 'primary');
  manager.cancel(login.id);
  await manager.finish(manager.sessions.get(login.id), 0);
  assert.equal(await readFile(join(manager.codexPrimaryHome, 'auth.json'), 'utf8'), credential);
  assert.equal(await readFile(manager.runtimeConfigPath, 'utf8'), runtime);
  assert.equal(manager.get(login.id).status, 'canceled');
});

test('a late child error cannot replace the canceled status', async (t) => {
  const { manager, children } = await fixture(t);
  const login = await manager.start('codex');
  manager.cancel(login.id);
  children[0].emit('error', new Error('synthetic termination error'));
  await manager.finish(manager.sessions.get(login.id), 1);
  assert.equal(manager.get(login.id).status, 'canceled');
});

test('cancellation reports a conflict once credential persistence has begun', async (t) => {
  const { manager } = await fixture(t);
  await mkdir(manager.codexPrimaryHome, { recursive: true });
  await writeFile(
    join(manager.codexPrimaryHome, 'auth.json'),
    JSON.stringify({ tokens: { access_token: 'synthetic-existing' } })
  );
  const login = await manager.start('codex');
  const session = manager.sessions.get(login.id);
  await writeFile(join(session.codexHome, 'auth.json'), JSON.stringify({ tokens: { access_token: 'synthetic-new' } }));
  const originalRename = fsPromises.rename;
  let release;
  let reachedPersistence;
  const paused = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    reachedPersistence = resolve;
  });
  fsPromises.rename = async (source, target) => {
    if (target === manager.runtimeConfigPath) {
      reachedPersistence();
      await paused;
    }
    return originalRename(source, target);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsPromises.rename = originalRename;
    syncBuiltinESMExports();
  });
  const finished = manager.finish(session, 0);
  await entered;
  try {
    assert.throws(
      () => manager.cancel(login.id),
      (error) => error.statusCode === 409
    );
    assert.notEqual(manager.get(login.id).status, 'canceled');
  } finally {
    release();
    await finished;
  }
  assert.equal(manager.get(login.id).status, 'completed');
});

for (const provider of ['claude', 'xai']) {
  test(`${provider} cancellation during credential validation does not register an account`, async (t) => {
    const { manager } = await fixture(t);
    const login = await manager.start(provider);
    const session = manager.sessions.get(login.id);
    const path =
      provider === 'claude' ? join(session.claudeLoginHome, '.credentials.json') : join(session.grokHome, 'auth.json');
    const credential =
      provider === 'claude'
        ? { claudeAiOauth: { accessToken: 'synthetic', refreshToken: 'synthetic', expiresAt: 9999999999999 } }
        : { token: 'synthetic' };
    await writeFile(path, JSON.stringify(credential));
    const finished = manager.finish(session, 0);
    manager.cancel(login.id);
    await finished;
    assert.equal(manager.get(login.id).status, 'canceled');
    await assert.rejects(readFile(manager.runtimeConfigPath), { code: 'ENOENT' });
    await assert.rejects(readFile(manager.environmentFilePath), { code: 'ENOENT' });
  });
}

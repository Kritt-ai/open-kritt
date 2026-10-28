import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { AccountLoginManager } from '../src/lib/accountLogins.js';

test('weekly usage action settles and restores permissions when its child stalls', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-kritt-weekly-timeout-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const authPath = join(home, 'auth.json');
  await writeFile(authPath, '{"fixture":"synthetic"}', { mode: 0o600 });
  const originalMode = (await stat(authPath)).mode & 0o7777;

  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => child.emit('close', null));
    return true;
  };
  let markSpawned;
  const spawned = new Promise((resolve) => {
    markSpawned = resolve;
  });
  const manager = new AccountLoginManager({
    codexPrimaryHome: home,
    isAccountActive: () => true,
    spawnProcess: () => {
      markSpawned();
      return child;
    },
  });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  let outcome;
  const pending = manager.startWeeklyUsage('primary').then(
    (value) => {
      outcome = { value };
    },
    (error) => {
      outcome = { error };
    }
  );
  await spawned;
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  await new Promise((resolve) => setImmediate(resolve));
  if (signals.length) await pending; // Wait for permission restoration after a simulated timeout.
  try {
    assert.ok(outcome, 'a stalled child left the HTTP action pending after a simulated day');
    assert.equal(outcome.error?.statusCode, 504);
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal((await stat(authPath)).mode & 0o7777, originalMode);
  } finally {
    if (!outcome) child.emit('close', 1);
    await pending;
  }
});

test('weekly usage escalates and settles when a child never closes after either signal', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-kritt-weekly-no-close-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const authPath = join(home, 'auth.json');
  await writeFile(authPath, '{}', { mode: 0o600 });
  const originalMode = (await stat(authPath)).mode & 0o7777;
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };
  let markSpawned;
  const spawned = new Promise((resolve) => {
    markSpawned = resolve;
  });
  const manager = new AccountLoginManager({
    codexPrimaryHome: home,
    isAccountActive: () => true,
    spawnProcess: () => {
      markSpawned();
      return child;
    },
  });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = manager.startWeeklyUsage('primary');
  await spawned;
  t.mock.timers.tick(2 * 60 * 1000);
  t.mock.timers.tick(1000);
  await assert.rejects(pending, { statusCode: 504 });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal((await stat(authPath)).mode & 0o7777, originalMode);
});

test('weekly usage child error after SIGTERM does not cancel kill escalation', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-kritt-weekly-error-after-term-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'auth.json'), '{}', { mode: 0o600 });
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGTERM') queueMicrotask(() => child.emit('error', new Error('synthetic child error')));
    if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null));
    return true;
  };
  let markSpawned;
  const spawned = new Promise((resolve) => {
    markSpawned = resolve;
  });
  const manager = new AccountLoginManager({
    codexPrimaryHome: home,
    isAccountActive: () => true,
    spawnProcess: () => {
      markSpawned();
      return child;
    },
  });

  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = manager.startWeeklyUsage('primary');
  await spawned;
  t.mock.timers.tick(2 * 60 * 1000);
  await Promise.resolve();
  t.mock.timers.tick(1000);
  await assert.rejects(pending, { statusCode: 504 });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('weekly usage preserves ordinary child errors and clears the deadline on close', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'open-kritt-weekly-close-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeFile(join(home, 'auth.json'), '{}', { mode: 0o600 });
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => signals.push(signal);
  const manager = new AccountLoginManager({
    codexPrimaryHome: home,
    isAccountActive: () => true,
    spawnProcess: () => {
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.deepEqual(await manager.startWeeklyUsage('primary'), { accountId: 'primary', started: true });
  t.mock.timers.tick(24 * 60 * 60 * 1000);
  assert.deepEqual(signals, []);
});

for (const [kind, expectedStatus] of [
  ['spawn', 503],
  ['error', 503],
  ['nonzero', 502],
]) {
  test(`weekly usage returns its existing ${kind} failure status`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), 'open-kritt-weekly-failure-'));
    t.after(() => rm(home, { recursive: true, force: true }));
    await writeFile(join(home, 'auth.json'), '{}', { mode: 0o600 });
    const manager = new AccountLoginManager({
      codexPrimaryHome: home,
      isAccountActive: () => true,
      spawnProcess: () => {
        if (kind === 'spawn') throw new Error('synthetic spawn failure');
        const child = new EventEmitter();
        queueMicrotask(() =>
          kind === 'error' ? child.emit('error', new Error('synthetic child error')) : child.emit('close', 1)
        );
        return child;
      },
    });
    await assert.rejects(manager.startWeeklyUsage('primary'), { statusCode: expectedStatus });
  });
}

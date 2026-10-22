import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { probeGrokCredential } from '../src/lib/grokCredentials.js';

function grokProcess({ code = 0, stdout = '', stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => {};
  queueMicrotask(() => {
    if (stdout) child.stdout.emit('data', stdout);
    if (stderr) child.stderr.emit('data', stderr);
    child.emit('close', code);
  });
  return child;
}

test('Grok credential probe recognizes unauthenticated output even when the CLI exits successfully', async () => {
  const result = await probeGrokCredential('/provider-homes/grok-accounts/reviewer/.grok', {
    spawnProcess: () =>
      grokProcess({
        stdout: 'You are not authenticated.\nAvailable models:\n  * grok-4.6 (default)\n',
      }),
  });

  assert.deepEqual(result, { statusKind: 'expired' });
});

test('Grok credential probe uses the selected home without exposing backend or provider secrets', async () => {
  let invocation;
  const result = await probeGrokCredential('/provider-homes/grok-accounts/reviewer/.grok', {
    sourceEnvironment: {
      PATH: '/usr/local/bin',
      HTTPS_PROXY: 'https://proxy.example.test',
      DATABASE_URL: 'postgres-secret',
      GITHUB_TOKEN: 'github-secret',
      XAI_API_KEY: 'xai-secret',
      OPENROUTER_API_KEY: 'openrouter-secret',
    },
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      return grokProcess({
        stdout: 'Available models:\n  * grok-4.6 (default)\n',
      });
    },
  });

  assert.deepEqual(result, { statusKind: 'available' });
  assert.equal(invocation.command, 'grok');
  assert.deepEqual(invocation.args, ['models']);
  assert.equal(invocation.options.cwd, '/provider-homes/grok-accounts/reviewer');
  assert.deepEqual(invocation.options.env, {
    NO_COLOR: '1',
    TERM: 'dumb',
    PATH: '/usr/local/bin',
    HTTPS_PROXY: 'https://proxy.example.test',
    HOME: '/provider-homes/grok-accounts/reviewer',
    GROK_HOME: '/provider-homes/grok-accounts/reviewer/.grok',
    GROK_TELEMETRY_ENABLED: 'false',
    GROK_TELEMETRY_TRACE_UPLOAD: 'false',
    GROK_TELEMETRY_MIXPANEL_ENABLED: 'false',
  });
  assert.deepEqual(invocation.options.stdio, ['ignore', 'pipe', 'pipe']);
});

test('Grok credential probe treats unrelated command failures as an unavailable check', async () => {
  const result = await probeGrokCredential('/provider-homes/grok', {
    spawnProcess: () => grokProcess({ code: 1, stderr: 'network unavailable' }),
  });

  assert.deepEqual(result, { statusKind: 'stale' });
});

test('timed-out credential probe escalates when a diagnostic child ignores termination', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null));
    return true;
  };

  const result = await probeGrokCredential('/synthetic/grok', {
    timeoutMs: 20,
    spawnProcess: () => child,
  });
  assert.deepEqual(result, { statusKind: 'stale' });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('cooperative diagnostic child closes after termination without escalation', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => child.emit('close', null));
    return true;
  };
  const result = await probeGrokCredential('/synthetic/grok', {
    timeoutMs: 20,
    spawnProcess: () => child,
  });
  assert.deepEqual(result, { statusKind: 'stale' });
  assert.deepEqual(signals, ['SIGTERM']);
});

test('diagnostic probe settles if a child never closes after kill escalation', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    return true;
  };

  const result = await probeGrokCredential('/synthetic/grok', {
    timeoutMs: 20,
    spawnProcess: () => child,
  });
  assert.deepEqual(result, { statusKind: 'stale' });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(child.stdout.listenerCount('data'), 0);
  assert.equal(child.stderr.listenerCount('data'), 0);
});

test('diagnostic probe remains bounded if termination signals throw', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    throw new Error('synthetic signal failure');
  };

  const result = await probeGrokCredential('/synthetic/grok', {
    timeoutMs: 20,
    spawnProcess: () => child,
  });
  assert.deepEqual(result, { statusKind: 'stale' });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

test('diagnostic child error after SIGTERM does not cancel kill escalation', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  const signals = [];
  child.kill = (signal) => {
    signals.push(signal);
    if (signal === 'SIGTERM') queueMicrotask(() => child.emit('error', new Error('synthetic child error')));
    if (signal === 'SIGKILL') queueMicrotask(() => child.emit('close', null));
    return true;
  };

  const result = await probeGrokCredential('/synthetic/grok', {
    timeoutMs: 20,
    spawnProcess: () => child,
  });
  assert.deepEqual(result, { statusKind: 'stale' });
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
});

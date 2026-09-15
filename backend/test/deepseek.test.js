import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventEmitter, once } from 'node:events';
import express from 'express';
import { createAccountsRouter } from '../src/routes/accounts.js';
import { AccountLoginManager } from '../src/lib/accountLogins.js';
import { runClaudeCredentialProbe } from '../src/lib/claudeCredentials.js';
import { createDeepSeekClient, DeepSeekError } from '../src/lib/deepseek.js';
import { getAccountProvider } from '../src/lib/accounts.js';
import { configuredModelProviders } from '../src/lib/modelProviders.js';
import {
  providerCredentialStatuses,
  readManagedCredentialsSync,
  removeManagedProviderCredential,
  saveManagedProviderCredential,
} from '../src/lib/providerCredentials.js';

const models = { data: [{ id: 'example-model-a' }, { id: 'example-model-b' }, { id: 'example-model-a' }, { id: '' }] };
const json = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'provider-api-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { credentialsPath: join(directory, 'providers.json'), environmentFilePath: join(directory, '.env') };
}

test('DeepSeek keys reuse protected storage and expose an active scan provider account', async (t) => {
  const options = await fixture(t);
  await saveManagedProviderCredential('openrouter', 'fake-other-key', options);
  await saveManagedProviderCredential('deepseek', 'fake-deepseek-key', options);
  const statuses = providerCredentialStatuses({ ...options, env: {} });
  const provider = statuses.find((item) => item.id === 'deepseek');
  assert.equal(provider.configured, true);
  assert.equal(provider.management, 'api_key');
  assert.equal(JSON.stringify(statuses).includes('fake-deepseek-key'), false);
  assert.equal((await stat(options.credentialsPath)).mode & 0o777, 0o600);
  assert.equal((await stat(options.environmentFilePath)).mode & 0o777, 0o600);
  assert.match(await readFile(options.environmentFilePath, 'utf8'), /DEEPSEEK_API_KEY=fake-deepseek-key/);
  assert.equal(configuredModelProviders({ ...options, env: {} }).includes('deepseek'), true);
  const overview = await getAccountProvider('deepseek', { statusOptions: { ...options, env: {} } });
  assert.equal(overview.loadError, null);
  assert.equal(overview.configured, true);
  assert.equal(overview.accounts.length, 1);
  assert.equal(overview.accounts[0].path, 'DEEPSEEK_API_KEY');
  assert.equal(overview.accounts[0].active, true);
  assert.equal(overview.active, 1);
  await removeManagedProviderCredential('deepseek', { ...options, disableEnvironment: true });
  assert.deepEqual(readManagedCredentialsSync(options.credentialsPath), { openrouter: 'fake-other-key' });
  const client = createDeepSeekClient({ ...options, env: { DEEPSEEK_API_KEY: 'fake-environment-key' } });
  await assert.rejects(client.listModels(), { statusCode: 409 });
});

test('model discovery and text checks use only the fixed endpoint and bounded request', async (t) => {
  const options = await fixture(t);
  await saveManagedProviderCredential('deepseek', 'fake-managed-key', options);
  const requests = [];
  const client = createDeepSeekClient({
    ...options,
    env: { DEEPSEEK_API_KEY: 'fake-environment-key' },
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return url.endsWith('/models')
        ? json(models)
        : json({ choices: [{ finish_reason: 'stop', message: { content: 'OK' } }] });
    },
  });
  assert.deepEqual(await client.listModels(), {
    models: [
      { id: 'example-model-a', label: 'example-model-a' },
      { id: 'example-model-b', label: 'example-model-b' },
    ],
  });
  assert.deepEqual(await client.check('example-model-b'), { status: 'ok', model: 'example-model-b' });
  assert.equal(requests.length, 3);
  for (const { url, init } of requests) {
    assert.equal(new URL(url).origin, 'https://api.deepseek.com');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer fake-managed-key');
    assert.ok(init.signal instanceof AbortSignal);
  }
  assert.deepEqual(JSON.parse(requests[2].init.body), {
    model: 'example-model-b',
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    thinking: { type: 'disabled' },
    max_tokens: 32,
    stream: false,
  });
});

test('DeepSeek model validation never guesses or silently substitutes a model', async (t) => {
  const options = await fixture(t);
  let calls = 0;
  const client = createDeepSeekClient({
    ...options,
    env: { DEEPSEEK_API_KEY: 'fake-key' },
    fetchImpl: async () => {
      calls += 1;
      return json(models);
    },
  });
  await assert.rejects(client.check('unknown-model'), { statusCode: 422 });
  assert.equal(calls, 1);
  for (const value of ['', null, {}, 'one\ntwo']) await assert.rejects(client.check(value), { statusCode: 422 });
  assert.equal(calls, 1);
});

test('provider HTTP and transport errors are sanitized', async (t) => {
  const options = await fixture(t);
  for (const status of [401, 402, 403, 429, 500, 302]) {
    const client = createDeepSeekClient({
      ...options,
      env: { DEEPSEEK_API_KEY: 'fake-key' },
      fetchImpl: async () => new Response('fake-upstream-secret', { status }),
    });
    await assert.rejects(client.listModels(), (error) => {
      assert.ok(error instanceof DeepSeekError);
      assert.equal(error.message.includes('fake-upstream-secret'), false);
      return true;
    });
  }
  for (const name of ['TimeoutError', 'TypeError']) {
    const client = createDeepSeekClient({
      ...options,
      env: { DEEPSEEK_API_KEY: 'fake-key' },
      fetchImpl: async () => {
        throw Object.assign(new Error('fake-transport-secret'), { name });
      },
    });
    await assert.rejects(client.listModels(), (error) => !error.message.includes('fake-transport-secret'));
  }
});

test('invalid, oversized, empty and incomplete responses fail safely', async (t) => {
  const options = await fixture(t);
  for (const response of [() => new Response('not json'), () => new Response('a'.repeat(300000)), () => json({})]) {
    const client = createDeepSeekClient({ ...options, env: { DEEPSEEK_API_KEY: 'fake-key' }, fetchImpl: response });
    await assert.rejects(client.listModels(), DeepSeekError);
  }
  const emptyClient = createDeepSeekClient({
    ...options,
    env: { DEEPSEEK_API_KEY: 'fake-key' },
    fetchImpl: async () => json({ data: [] }),
  });
  assert.deepEqual(await emptyClient.listModels(), { models: [] });
  const client = createDeepSeekClient({
    ...options,
    env: { DEEPSEEK_API_KEY: 'fake-key' },
    fetchImpl: async (url) =>
      url.endsWith('/models')
        ? json(models)
        : json({ choices: [{ finish_reason: 'length', message: { content: 'partial' } }] }),
  });
  await assert.rejects(client.check('example-model-a'), DeepSeekError);
});

test('account diagnostic routes are uncached, forward only a model, and sanitize unexpected errors', async (t) => {
  const received = [];
  const app = express();
  app.use(express.json());
  app.use(
    createAccountsRouter({
      deepseek: {
        listModels: async () => {
          throw new Error('fake-private-upstream-body');
        },
        check: async (...args) => {
          received.push(args);
          return { status: 'ok', model: args[0] };
        },
      },
    })
  );
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const failure = await fetch(`${base}/deepseek/models`);
  assert.equal(failure.status, 502);
  assert.equal(failure.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await failure.json(), { error: 'Could not load DeepSeek models.' });
  const success = await fetch(`${base}/deepseek/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'example-model-a',
      prompt: 'unused synthetic text',
      baseUrl: 'https://example.invalid',
    }),
  });
  assert.equal(success.status, 200);
  assert.deepEqual(received, [['example-model-a']]);
  assert.equal(success.headers.get('cache-control'), 'no-store');
});

test('native DeepSeek keys are excluded from other provider login and credential probe processes', async (t) => {
  const { credentialsPath } = await fixture(t);
  const prior = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'fake-native-key';
  t.after(() => {
    if (prior === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = prior;
  });
  const invocations = [];
  const spawnProcess = (command, args, options) => {
    invocations.push({ command, env: options.env });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = Object.assign(new EventEmitter(), { end: () => queueMicrotask(() => child.emit('close', 0)) });
    child.kill = () => {};
    return child;
  };
  const manager = new AccountLoginManager({
    spawnProcess,
    codexAccountsRoot: `${credentialsPath}-codex`,
    claudeHome: `${credentialsPath}-claude/home`,
    claudeAccountsRoot: `${credentialsPath}-claude/accounts`,
  });
  for (const provider of ['codex', 'claude']) {
    const session = await manager.start(provider);
    manager.cancel(session.id);
  }
  await runClaudeCredentialProbe(`${credentialsPath}-probe`, { spawnProcess });
  assert.equal(invocations.length, 3);
  for (const invocation of invocations) assert.equal(invocation.env.DEEPSEEK_API_KEY, undefined);
});

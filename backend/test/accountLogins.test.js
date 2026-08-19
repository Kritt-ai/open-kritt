import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  AccountLoginManager,
  addClaudeRuntimeHome,
  addCodexRuntimeHome,
  parseLoginInstructions,
  removeClaudeRuntimeHome,
  removeCodexRuntimeHome,
  stripTerminalFormatting,
} from '../src/lib/accountLogins.js';
import { parseEnvironmentText } from '../src/lib/environmentFile.js';

test('login output parser extracts Codex device instructions without terminal formatting', () => {
  const output = [
    '\u001b[94mhttps://auth.openai.com/codex/device\u001b[0m',
    'Enter this one-time code',
    '\u001b[94mABCD-12345\u001b[0m',
  ].join('\n');
  assert.deepEqual(parseLoginInstructions('codex', output), {
    authorizationUrl: 'https://auth.openai.com/codex/device',
    deviceCode: 'ABCD-12345',
    requiresInput: false,
  });
  assert.equal(stripTerminalFormatting(output).includes('\u001b'), false);
});

test('login output parser recognizes the Claude callback step', () => {
  const output =
    "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?state=test\nPaste code here if prompted > ";
  assert.deepEqual(parseLoginInstructions('claude', output), {
    authorizationUrl: 'https://claude.com/cai/oauth/authorize?state=test',
    deviceCode: null,
    requiresInput: true,
  });
});

test('Codex login is added to runtime homes atomically and idempotently', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  const environmentFilePath = join(directory, '.env');
  await writeFile(runtimeConfigPath, 'ENGINE_WORKER_COUNT=4\nENGINE_CODEX_HOME=/root/.codex\n');
  await writeFile(environmentFilePath, 'KEEP=value\nENGINE_CODEX_HOME=/root/.codex\nCODEX_LOGIN_CONFIGURED=\n');

  await addCodexRuntimeHome('/codex-accounts/reviewer/.codex', { runtimeConfigPath, environmentFilePath });
  await addCodexRuntimeHome('/codex-accounts/reviewer/.codex', { runtimeConfigPath, environmentFilePath });

  const text = await readFile(runtimeConfigPath, 'utf8');
  assert.match(text, /^ENGINE_WORKER_COUNT=4$/m);
  assert.match(text, /^ENGINE_CODEX_HOME=\/root\/\.codex,\/codex-accounts\/reviewer\/\.codex$/m);
  assert.equal((text.match(/\/codex-accounts\/reviewer\/\.codex/g) || []).length, 1);
  assert.deepEqual(parseEnvironmentText(await readFile(environmentFilePath, 'utf8')), {
    KEEP: 'value',
    ENGINE_CODEX_HOME: '/root/.codex,/codex-accounts/reviewer/.codex',
    CODEX_LOGIN_CONFIGURED: '1',
  });
});

test('Codex runtime registry is seeded from .env when its live file is missing', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-runtime-seed-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  const environmentFilePath = join(directory, '.env');
  await writeFile(environmentFilePath, 'ENGINE_CODEX_HOME=/codex-accounts/existing/.codex\nCODEX_LOGIN_CONFIGURED=1\n');

  await addCodexRuntimeHome('/codex-accounts/new/.codex', {
    runtimeConfigPath,
    environmentFilePath,
  });

  const expected = '/codex-accounts/existing/.codex,/codex-accounts/new/.codex';
  assert.match(await readFile(runtimeConfigPath, 'utf8'), new RegExp(`^ENGINE_CODEX_HOME=${expected}$`, 'm'));
  assert.equal(parseEnvironmentText(await readFile(environmentFilePath, 'utf8')).ENGINE_CODEX_HOME, expected);
});

test('Claude login is added to the live runtime registry idempotently', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-claude-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  await writeFile(runtimeConfigPath, 'ENGINE_WORKER_COUNT=4\nENGINE_CLAUDE_HOME=/root/.claude\n');

  await addClaudeRuntimeHome('/claude-accounts/reviewer/.claude', { runtimeConfigPath });
  await addClaudeRuntimeHome('/claude-accounts/reviewer/.claude', { runtimeConfigPath });
  assert.equal(await removeClaudeRuntimeHome('/claude-accounts/missing/.claude', { runtimeConfigPath }), false);

  const text = await readFile(runtimeConfigPath, 'utf8');
  assert.match(text, /^ENGINE_WORKER_COUNT=4$/m);
  assert.match(text, /^ENGINE_CLAUDE_HOME=\/root\/\.claude,\/claude-accounts\/reviewer\/\.claude$/m);
  assert.equal((text.match(/\/claude-accounts\/reviewer\/\.claude/g) || []).length, 1);
});

test('failed .env persistence does not leave an orphaned Codex login', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-persistence-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accountDirectory = join(directory, 'accounts', 'new');
  const codexHome = join(accountDirectory, '.codex');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  const invalidParent = join(directory, 'not-a-directory');
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'auth.json'), '{"tokens":{"access_token":"test"}}');
  await writeFile(runtimeConfigPath, 'ENGINE_CODEX_HOME=/codex-accounts/existing/.codex\n');
  await writeFile(invalidParent, 'blocking file');
  const manager = new AccountLoginManager({
    runtimeConfigPath,
    environmentFilePath: join(invalidParent, '.env'),
  });
  const session = {
    provider: 'codex',
    codexDirectory: accountDirectory,
    codexHome,
    codexRuntimeHome: '/codex-accounts/new/.codex',
    status: 'waiting',
    settled: false,
    child: {},
    timeout: setTimeout(() => {}, 10_000),
  };

  await manager.finish(session, 0);

  assert.equal(session.status, 'failed');
  await assert.rejects(stat(accountDirectory), { code: 'ENOENT' });
  assert.match(await readFile(runtimeConfigPath, 'utf8'), /^ENGINE_CODEX_HOME=\/codex-accounts\/existing\/\.codex$/m);
});

test('completed Codex login replaces an empty legacy primary home', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-replace-empty-primary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accountDirectory = join(directory, 'accounts', 'new');
  const codexHome = join(accountDirectory, '.codex');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  const environmentFilePath = join(directory, '.env');
  await mkdir(codexHome, { recursive: true });
  await writeFile(join(codexHome, 'auth.json'), '{"tokens":{"access_token":"test"}}');
  await writeFile(runtimeConfigPath, 'ENGINE_CODEX_HOME=/root/.codex\n');
  await writeFile(environmentFilePath, 'ENGINE_CODEX_HOME=/root/.codex\nCODEX_LOGIN_CONFIGURED=\n');
  const manager = new AccountLoginManager({
    codexPrimaryHome: join(directory, 'empty-primary'),
    runtimeConfigPath,
    environmentFilePath,
  });
  const session = {
    provider: 'codex',
    codexDirectory: accountDirectory,
    codexHome,
    codexRuntimeHome: '/codex-accounts/new/.codex',
    status: 'waiting',
    settled: false,
    child: {},
    timeout: setTimeout(() => {}, 10_000),
  };

  await manager.finish(session, 0);

  assert.equal(session.status, 'completed');
  assert.match(await readFile(runtimeConfigPath, 'utf8'), /^ENGINE_CODEX_HOME=\/codex-accounts\/new\/\.codex$/m);
  assert.deepEqual(parseEnvironmentText(await readFile(environmentFilePath, 'utf8')), {
    ENGINE_CODEX_HOME: '/codex-accounts/new/.codex',
    CODEX_LOGIN_CONFIGURED: '1',
  });
});

test('Codex runtime home removal preserves unrelated settings and accounts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-runtime-remove-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  const environmentFilePath = join(directory, '.env');
  await writeFile(
    runtimeConfigPath,
    'ENGINE_WORKER_COUNT=4\nENGINE_CODEX_HOME=/codex-accounts/reviewer/.codex,/codex-accounts/other/.codex\n'
  );
  await writeFile(
    environmentFilePath,
    'ENGINE_CODEX_HOME=/codex-accounts/reviewer/.codex,/codex-accounts/other/.codex\nCODEX_LOGIN_CONFIGURED=1\n'
  );

  assert.equal(
    await removeCodexRuntimeHome('/codex-accounts/reviewer/.codex', {
      runtimeConfigPath,
      environmentFilePath,
    }),
    true
  );
  assert.equal(
    await removeCodexRuntimeHome('/codex-accounts/reviewer/.codex', {
      runtimeConfigPath,
      environmentFilePath,
    }),
    false
  );

  const text = await readFile(runtimeConfigPath, 'utf8');
  assert.match(text, /^ENGINE_WORKER_COUNT=4$/m);
  assert.match(text, /^ENGINE_CODEX_HOME=\/codex-accounts\/other\/\.codex$/m);
  assert.equal(text.includes('/codex-accounts/reviewer/.codex'), false);
  assert.deepEqual(parseEnvironmentText(await readFile(environmentFilePath, 'utf8')), {
    ENGINE_CODEX_HOME: '/codex-accounts/other/.codex',
    CODEX_LOGIN_CONFIGURED: '1',
  });
});

test('managed Codex account removal deletes only that account and its runtime entry', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-remove-codex-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accountsRoot = join(directory, 'codex-accounts');
  const accountHome = join(accountsRoot, 'reviewer', '.codex');
  const otherHome = join(accountsRoot, 'other', '.codex');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  await mkdir(accountHome, { recursive: true });
  await mkdir(otherHome, { recursive: true });
  await writeFile(join(accountHome, 'auth.json'), '{"tokens":{"access_token":"test"}}');
  await writeFile(
    runtimeConfigPath,
    'ENGINE_CODEX_HOME=/runtime-accounts/reviewer/.codex,/runtime-accounts/other/.codex\n'
  );
  const manager = new AccountLoginManager({
    codexAccountsRoot: accountsRoot,
    codexRuntimeAccountsRoot: '/runtime-accounts',
    runtimeConfigPath,
  });

  assert.deepEqual(await manager.removeAccount('codex', 'reviewer'), {
    provider: 'codex',
    accountId: 'reviewer',
    removed: true,
  });
  await assert.rejects(stat(join(accountsRoot, 'reviewer')), { code: 'ENOENT' });
  assert.equal((await stat(otherHome)).isDirectory(), true);
  assert.match(await readFile(runtimeConfigPath, 'utf8'), /^ENGINE_CODEX_HOME=\/runtime-accounts\/other\/\.codex$/m);
});

test('Codex sign-in again reuses the selected account home instead of creating a duplicate', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-reuse-codex-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accountsRoot = join(directory, 'codex-accounts');
  const accountHome = join(accountsRoot, 'reviewer', '.codex');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  const environmentFilePath = join(directory, '.env');
  await mkdir(accountHome, { recursive: true });
  await writeFile(join(accountHome, 'auth.json'), '{"tokens":{"access_token":"expired"}}');
  await writeFile(runtimeConfigPath, 'ENGINE_CODEX_HOME=/runtime-accounts/reviewer/.codex\n');
  await writeFile(environmentFilePath, 'ENGINE_CODEX_HOME=/runtime-accounts/reviewer/.codex\n');
  let invocation;
  const manager = new AccountLoginManager({
    codexAccountsRoot: accountsRoot,
    codexRuntimeAccountsRoot: '/runtime-accounts',
    runtimeConfigPath,
    environmentFilePath,
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {};
      child.kill = () => {};
      return child;
    },
  });

  const publicSession = await manager.start('codex', 'reviewer');
  const session = manager.sessions.get(publicSession.id);
  await writeFile(join(accountHome, 'auth.json'), '{"tokens":{"access_token":"renewed"}}');
  await manager.finish(session, 0);

  assert.equal(invocation.command, 'codex');
  assert.deepEqual(invocation.args, ['login', '--device-auth']);
  assert.equal(invocation.options.env.CODEX_HOME, accountHome);
  assert.equal(session.replacesAccountId, 'reviewer');
  assert.equal(session.codexDirectory, undefined);
  assert.equal(session.status, 'completed');
  assert.deepEqual(await readdir(accountsRoot), ['reviewer']);
});

test('Codex sign-in again rejects an unknown target before creating a session', async () => {
  const manager = new AccountLoginManager({ codexAccountsRoot: '/definitely/missing/codex-accounts' });

  await assert.rejects(manager.start('codex', 'missing'), { statusCode: 404 });
  assert.equal(manager.sessions.size, 0);
});

test('Codex weekly usage starter sends exactly 100 random characters through the selected account', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-start-usage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accountsRoot = join(directory, 'codex-accounts');
  const accountHome = join(accountsRoot, 'reviewer', '.codex');
  await mkdir(accountHome, { recursive: true });
  await writeFile(join(accountHome, 'auth.json'), '{"tokens":{"access_token":"test"}}', { mode: 0o600 });
  let invocation;
  const manager = new AccountLoginManager({
    codexAccountsRoot: accountsRoot,
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    },
  });

  assert.deepEqual(await manager.startWeeklyUsage('reviewer'), { accountId: 'reviewer', started: true });
  assert.equal(invocation.command, 'codex');
  assert.deepEqual(invocation.args.slice(0, -1), [
    'exec',
    '--model',
    'gpt-5.6-sol',
    '--config',
    'model_reasoning_effort="xhigh"',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
  ]);
  assert.match(invocation.args.at(-1), /^[a-f0-9]{100}$/);
  assert.equal(invocation.options.env.CODEX_HOME, accountHome);
  assert.equal(invocation.options.env.HOME, '/tmp');
  assert.equal(invocation.options.env.DATABASE_URL, undefined);
  assert.equal(invocation.options.cwd, '/tmp');
});

test('primary Codex account removal signs out the last account without deleting settings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-remove-primary-codex-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const primaryHome = join(directory, 'codex');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  await mkdir(primaryHome, { recursive: true });
  await writeFile(join(primaryHome, 'auth.json'), '{"tokens":{"access_token":"test"}}');
  await writeFile(join(primaryHome, 'config.toml'), 'model = "gpt-5"\n');
  await writeFile(runtimeConfigPath, 'ENGINE_CODEX_HOME=/root/.codex\n');
  const manager = new AccountLoginManager({ codexPrimaryHome: primaryHome, runtimeConfigPath });

  assert.deepEqual(await manager.removeAccount('codex', 'primary'), {
    provider: 'codex',
    accountId: 'primary',
    removed: true,
  });
  await assert.rejects(stat(join(primaryHome, 'auth.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(primaryHome, 'config.toml'), 'utf8'), 'model = "gpt-5"\n');
  assert.match(await readFile(runtimeConfigPath, 'utf8'), /^ENGINE_CODEX_HOME=$/m);
});

test('Codex account removal rejects traversal and symbolic links', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-remove-codex-safety-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accountsRoot = join(directory, 'codex-accounts');
  const outside = join(directory, 'outside');
  const unconfigured = join(accountsRoot, 'unconfigured', '.codex');
  await mkdir(accountsRoot, { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(unconfigured, { recursive: true });
  await writeFile(join(outside, 'keep.txt'), 'keep');
  await symlink(outside, join(accountsRoot, 'linked'));
  const manager = new AccountLoginManager({
    codexAccountsRoot: accountsRoot,
    runtimeConfigPath: join(directory, 'engine-runtime.env'),
  });

  await assert.rejects(manager.removeAccount('codex', '../outside'), { statusCode: 404 });
  await assert.rejects(manager.removeAccount('codex', 'linked'), { statusCode: 404 });
  await assert.rejects(manager.removeAccount('codex', 'unconfigured'), { statusCode: 404 });
  await assert.rejects(manager.startWeeklyUsage('../outside'), { statusCode: 404 });
  await assert.rejects(manager.startWeeklyUsage('linked'), { statusCode: 404 });
  await assert.rejects(manager.startWeeklyUsage('unconfigured'), { statusCode: 404 });
  assert.equal(await readFile(join(outside, 'keep.txt'), 'utf8'), 'keep');
  assert.equal((await stat(unconfigured)).isDirectory(), true);
});

test('Claude account removal signs out without deleting profile settings', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-remove-claude-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const claudeHome = join(directory, '.claude');
  await mkdir(claudeHome, { recursive: true });
  await writeFile(join(claudeHome, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"test"}}');
  await writeFile(join(claudeHome, '.claude.json'), '{"theme":"dark"}');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  await writeFile(runtimeConfigPath, 'ENGINE_CLAUDE_HOME=/root/.claude\n');
  const manager = new AccountLoginManager({ claudeHome, runtimeConfigPath });

  assert.deepEqual(await manager.removeAccount('claude', 'default'), {
    provider: 'claude',
    accountId: 'default',
    removed: true,
  });
  await assert.rejects(stat(join(claudeHome, '.credentials.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(claudeHome, '.claude.json'), 'utf8'), '{"theme":"dark"}');
  assert.match(await readFile(runtimeConfigPath, 'utf8'), /^ENGINE_CLAUDE_HOME=$/m);
});

test('adding a Claude account creates a distinct managed home and registers it for rotation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-add-claude-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const claudeHome = join(directory, 'claude-primary');
  const claudeAccountsRoot = join(directory, 'claude-accounts');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  await mkdir(claudeHome, { recursive: true });
  await writeFile(runtimeConfigPath, 'ENGINE_CLAUDE_HOME=/root/.claude\n');
  let invocation;
  const manager = new AccountLoginManager({
    claudeHome,
    claudeAccountsRoot,
    claudeRuntimeAccountsRoot: '/runtime-claude-accounts',
    runtimeConfigPath,
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {};
      child.kill = () => {};
      return child;
    },
  });

  const publicSession = await manager.start('claude');
  const session = manager.sessions.get(publicSession.id);
  await writeFile(
    join(session.claudeLoginHome, '.credentials.json'),
    '{"claudeAiOauth":{"accessToken":"new","refreshToken":"refresh","expiresAt":9999999999999}}'
  );
  await writeFile(
    join(session.claudeLoginHome, '.claude.json'),
    JSON.stringify({
      oauthAccount: {
        accountUuid: 'claude-account-id',
        emailAddress: 'reviewer@example.test',
        displayName: 'Security Reviewer',
      },
      apiKey: 'must-not-be-copied',
    })
  );
  await manager.finish(session, 0);

  assert.equal(invocation.command, 'claude');
  assert.deepEqual(invocation.args, ['auth', 'login', '--claudeai']);
  assert.equal(invocation.options.env.CLAUDE_HOME, session.claudeLoginHome);
  assert.equal(session.status, 'completed');
  assert.equal(
    JSON.parse(await readFile(join(session.claudeHome, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken,
    'new'
  );
  assert.deepEqual(JSON.parse(await readFile(join(session.claudeHome, '.open-kritt-account.json'), 'utf8')), {
    provider: 'claude',
    accountId: 'claude-account-id',
    email: 'reviewer@example.test',
    name: 'Security Reviewer',
    organization: null,
  });
  assert.equal(
    (await readFile(join(session.claudeHome, '.open-kritt-account.json'), 'utf8')).includes('must-not-be-copied'),
    false
  );
  assert.match(
    await readFile(runtimeConfigPath, 'utf8'),
    new RegExp(`^ENGINE_CLAUDE_HOME=${session.claudeRuntimeHome}$`, 'm')
  );
  assert.equal((await readdir(claudeAccountsRoot)).length, 1);
});

test('managed Claude account removal deletes only the selected home and runtime entry', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-remove-managed-claude-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accountsRoot = join(directory, 'claude-accounts');
  const reviewerHome = join(accountsRoot, 'reviewer', '.claude');
  const otherHome = join(accountsRoot, 'other', '.claude');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  await mkdir(reviewerHome, { recursive: true });
  await mkdir(otherHome, { recursive: true });
  await writeFile(join(reviewerHome, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"reviewer"}}');
  await writeFile(join(otherHome, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"other"}}');
  await writeFile(
    runtimeConfigPath,
    'ENGINE_CLAUDE_HOME=/runtime-accounts/reviewer/.claude,/runtime-accounts/other/.claude\n'
  );
  const manager = new AccountLoginManager({
    claudeAccountsRoot: accountsRoot,
    claudeRuntimeAccountsRoot: '/runtime-accounts',
    runtimeConfigPath,
  });

  assert.deepEqual(await manager.removeAccount('claude', 'reviewer'), {
    provider: 'claude',
    accountId: 'reviewer',
    removed: true,
  });
  await assert.rejects(stat(join(accountsRoot, 'reviewer')), { code: 'ENOENT' });
  assert.equal((await stat(otherHome)).isDirectory(), true);
  assert.match(await readFile(runtimeConfigPath, 'utf8'), /^ENGINE_CLAUDE_HOME=\/runtime-accounts\/other\/\.claude$/m);
});

test('completed Claude login atomically promotes private OAuth credentials', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-promote-claude-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const claudeHome = join(directory, '.claude');
  const claudeLoginHome = join(directory, '.claude-login');
  await mkdir(claudeHome, { recursive: true });
  await mkdir(claudeLoginHome, { recursive: true });
  await writeFile(join(claudeHome, 'credentials.json'), '{"stale":true}');
  await writeFile(
    join(claudeLoginHome, 'credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'new-access',
        refreshToken: 'new-refresh',
        expiresAt: 9_999_999_999_999,
      },
    })
  );
  const manager = new AccountLoginManager({ claudeHome });
  const session = {
    provider: 'claude',
    claudeLoginHome,
    status: 'waiting',
    settled: false,
    child: {},
    timeout: setTimeout(() => {}, 10_000),
  };

  await manager.finish(session, 0);

  assert.equal(session.status, 'completed');
  const credentialPath = join(claudeHome, '.credentials.json');
  assert.equal(JSON.parse(await readFile(credentialPath, 'utf8')).claudeAiOauth.accessToken, 'new-access');
  assert.equal((await stat(credentialPath)).mode & 0o777, 0o600);
  await assert.rejects(stat(join(claudeHome, 'credentials.json')), { code: 'ENOENT' });
  await assert.rejects(stat(claudeLoginHome), { code: 'ENOENT' });
  await assert.rejects(stat(join(claudeHome, '.open-kritt-auth.lock')), { code: 'ENOENT' });
});

test('Claude sign-in again replaces the default account instead of adding another account home', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-reuse-claude-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const claudeHome = join(directory, '.claude');
  await mkdir(claudeHome, { recursive: true });
  await writeFile(
    join(claudeHome, '.credentials.json'),
    '{"claudeAiOauth":{"accessToken":"expired","refreshToken":"expired","expiresAt":1}}'
  );
  let invocation;
  const manager = new AccountLoginManager({
    claudeHome,
    spawnProcess(command, args, options) {
      invocation = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {};
      child.kill = () => {};
      return child;
    },
  });

  const publicSession = await manager.start('claude', 'default');
  const session = manager.sessions.get(publicSession.id);
  await writeFile(
    join(session.claudeLoginHome, '.credentials.json'),
    '{"claudeAiOauth":{"accessToken":"renewed","refreshToken":"renewed","expiresAt":9999999999999}}'
  );
  await manager.finish(session, 0);

  assert.equal(invocation.command, 'claude');
  assert.deepEqual(invocation.args, ['auth', 'login', '--claudeai']);
  assert.equal(session.replacesAccountId, 'default');
  assert.equal(session.status, 'completed');
  assert.equal(
    JSON.parse(await readFile(join(claudeHome, '.credentials.json'), 'utf8')).claudeAiOauth.accessToken,
    'renewed'
  );
  assert.deepEqual(await readdir(directory), ['.claude']);
});

test('Claude sign-in again rejects an unknown target before creating a session', async () => {
  const manager = new AccountLoginManager();

  await assert.rejects(manager.start('claude', 'other'), { statusCode: 404 });
  assert.equal(manager.sessions.size, 0);
});

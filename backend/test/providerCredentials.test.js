import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { buildAccountsOverview } from '../src/lib/accounts.js';
import { parseEnvironmentText } from '../src/lib/environmentFile.js';
import {
  providerCredentialStatuses,
  readManagedCredentialStateSync,
  readManagedCredentialsSync,
  removeManagedProviderCredential,
  saveManagedProviderCredential,
  validateProviderCredential,
} from '../src/lib/providerCredentials.js';

async function temporaryCredentialPath(t) {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-provider-credentials-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'providers.json');
}

test('managed credentials are saved privately without appearing in status', async (t) => {
  const credentialsPath = await temporaryCredentialPath(t);
  const environmentFilePath = join(dirname(credentialsPath), '.env');
  await writeFile(environmentFilePath, 'KEEP=value\nOPENROUTER_API_KEY=\n');
  await saveManagedProviderCredential('openrouter', 'openrouter-secret', {
    credentialsPath,
    environmentFilePath,
  });

  assert.deepEqual(readManagedCredentialsSync(credentialsPath), { openrouter: 'openrouter-secret' });
  const file = JSON.parse(await readFile(credentialsPath, 'utf8'));
  assert.equal(file.credentials.openrouter, 'openrouter-secret');
  assert.deepEqual(parseEnvironmentText(await readFile(environmentFilePath, 'utf8')), {
    KEEP: 'value',
    OPENROUTER_API_KEY: 'openrouter-secret',
  });

  const [codex, claude, openrouter] = providerCredentialStatuses({ env: {}, credentialsPath });
  assert.equal(codex.configured, false);
  assert.equal(claude.configured, false);
  assert.equal(openrouter.source, 'managed_api_key');
  assert.equal(JSON.stringify(openrouter).includes('openrouter-secret'), false);
});

test('managed credentials override provider availability and can be removed', async (t) => {
  const credentialsPath = await temporaryCredentialPath(t);
  const environmentFilePath = join(dirname(credentialsPath), '.env');
  await writeFile(environmentFilePath, 'OPENROUTER_API_KEY=old\n');
  await saveManagedProviderCredential('openrouter', 'openrouter-secret', {
    credentialsPath,
    environmentFilePath,
  });
  assert.deepEqual(readManagedCredentialsSync(credentialsPath), { openrouter: 'openrouter-secret' });

  assert.equal(await removeManagedProviderCredential('openrouter', { credentialsPath, environmentFilePath }), true);
  assert.deepEqual(readManagedCredentialsSync(credentialsPath), {});
  assert.equal(parseEnvironmentText(await readFile(environmentFilePath, 'utf8')).OPENROUTER_API_KEY, '');
});

test('failed .env persistence rolls back the managed provider store', async (t) => {
  const credentialsPath = await temporaryCredentialPath(t);
  const invalidParent = join(dirname(credentialsPath), 'not-a-directory');
  await writeFile(invalidParent, 'blocking file');

  await assert.rejects(
    saveManagedProviderCredential('openrouter', 'must-not-remain', {
      credentialsPath,
      environmentFilePath: join(invalidParent, '.env'),
    }),
    { code: 'ENOTDIR' }
  );

  assert.deepEqual(readManagedCredentialsSync(credentialsPath), {});
  assert.equal((await readFile(credentialsPath, 'utf8')).includes('must-not-remain'), false);
});

test('removing an environment-bootstrapped key keeps it removed until explicitly added again', async (t) => {
  const credentialsPath = await temporaryCredentialPath(t);
  const options = { env: { OPENROUTER_API_KEY: 'initial-key' }, credentialsPath };

  let openrouter = providerCredentialStatuses(options).find((provider) => provider.id === 'openrouter');
  assert.equal(openrouter.configured, true);
  assert.equal(openrouter.source, 'environment');
  assert.equal(openrouter.canRemove, true);

  await removeManagedProviderCredential('openrouter', { credentialsPath, disableEnvironment: true });
  openrouter = providerCredentialStatuses(options).find((provider) => provider.id === 'openrouter');
  assert.equal(openrouter.configured, false);
  assert.deepEqual(readManagedCredentialStateSync(credentialsPath), {
    version: 1,
    credentials: {},
    disabledEnvironmentProviders: ['openrouter'],
  });

  await saveManagedProviderCredential('openrouter', 'replacement-key', { credentialsPath });
  openrouter = providerCredentialStatuses(options).find((provider) => provider.id === 'openrouter');
  assert.equal(openrouter.source, 'managed_api_key');
  assert.equal(openrouter.canRemove, true);
  assert.deepEqual(readManagedCredentialStateSync(credentialsPath).disabledEnvironmentProviders, []);
});

test('credential validation accepts only a single-line OpenRouter key', () => {
  assert.equal(validateProviderCredential('openrouter', 'valid-key'), null);
  assert.equal(validateProviderCredential('other', 'key').field, 'provider');
  assert.equal(validateProviderCredential('claude', 'key').field, 'provider');
  assert.equal(validateProviderCredential('openrouter', ' ').field, 'credential');
  assert.equal(validateProviderCredential('openrouter', 'one\ntwo').field, 'credential');
});

test('provider status recognizes Codex and Claude login homes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-provider-logins-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const primaryHome = join(directory, 'codex');
  const accountsRoot = join(directory, 'codex-accounts');
  const claudeHome = join(directory, 'claude');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  await mkdir(join(accountsRoot, 'reviewer', '.codex'), { recursive: true });
  await mkdir(claudeHome, { recursive: true });
  await writeFile(join(accountsRoot, 'reviewer', '.codex', 'auth.json'), '{"tokens":{"access_token":"x"}}');
  await writeFile(runtimeConfigPath, 'ENGINE_CODEX_HOME=/codex-accounts/reviewer/.codex\n');
  await writeFile(join(claudeHome, '.claude.json'), '{"oauthAccount":{"emailAddress":"profile@example.com"}}');

  const options = {
    env: {},
    credentialsPath: join(directory, 'missing.json'),
    loginOptions: { codex: { primaryHome, accountsRoot, runtimeConfigPath }, claude: { home: claudeHome } },
  };
  let [codex, claude] = providerCredentialStatuses(options);
  assert.equal(codex.source, 'codex_login');
  assert.equal(claude.configured, false, 'Claude profile metadata alone is not a usable login');

  await writeFile(join(claudeHome, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}');
  [codex, claude] = providerCredentialStatuses(options);
  assert.equal(codex.configured, true);
  assert.equal(claude.source, 'claude_login');
});

test('Codex homes left on disk but removed from the runtime registry stay inactive', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-provider-orphaned-login-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accountsRoot = join(directory, 'codex-accounts');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  await mkdir(join(accountsRoot, 'orphaned', '.codex'), { recursive: true });
  await writeFile(join(accountsRoot, 'orphaned', '.codex', 'auth.json'), '{"tokens":{"access_token":"x"}}');
  await writeFile(runtimeConfigPath, 'ENGINE_CODEX_HOME=\n');

  const codex = providerCredentialStatuses({
    env: {},
    credentialsPath: join(directory, 'missing.json'),
    loginOptions: { codex: { accountsRoot, runtimeConfigPath } },
  }).find((provider) => provider.id === 'codex');

  assert.equal(codex.configured, false);
});

test('provider status recognizes managed Claude homes in the runtime registry', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-provider-claude-accounts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const accountsRoot = join(directory, 'claude-accounts');
  const accountHome = join(accountsRoot, 'reviewer', '.claude');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  await mkdir(accountHome, { recursive: true });
  await writeFile(join(accountHome, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"x"}}');
  await writeFile(runtimeConfigPath, 'ENGINE_CLAUDE_HOME=/claude-accounts/reviewer/.claude\n');

  const claude = providerCredentialStatuses({
    env: {},
    credentialsPath: join(directory, 'missing.json'),
    loginOptions: {
      claude: {
        home: join(directory, 'unused-primary'),
        accountsRoot,
        runtimeConfigPath,
      },
    },
  }).find((provider) => provider.id === 'claude');

  assert.equal(claude.configured, true);
  assert.equal(claude.source, 'claude_login');
});

test('account overview merges executor detail without exposing unrecognized fields', () => {
  const statuses = providerCredentialStatuses({
    env: { OPEN_KRITT_OPENROUTER_API_KEY_CONFIGURED: '1' },
    credentialsPath: '/missing/provider-credentials.json',
  });
  const overview = buildAccountsOverview(statuses, {
    providers: [
      {
        kind: 'openrouter',
        accounts: [
          {
            id: 'openrouter-key',
            label: 'OpenRouter key',
            active: true,
            canRemove: true,
            status: 'verified',
            statusKind: 'available',
            authError: 'safe authentication error',
            secret: 'must-not-leak',
            details: [{ label: 'Plan', value: 'pay-as-you-go' }],
            rateLimits: {
              observedAt: '2026-07-15T10:00:00Z',
              source: 'Provider usage API',
              primary: { usedPercent: 25.5, windowMinutes: 10080, resetsAt: '2026-07-22T10:00:00Z' },
              secondary: null,
              manualResetCredits: {
                availableCount: 3,
                applicableAvailableCount: 1,
                credits: [
                  {
                    id: 'credit-id-must-not-leak',
                    title: 'Full reset',
                    expiresAt: '2026-08-12T18:07:27Z',
                    secret: 'credit-secret-must-not-leak',
                  },
                ],
                secret: 'nested-secret-must-not-leak',
              },
            },
            credit: {
              usage: 25.5,
              limit: 100,
              remaining: 74.5,
              usedPercent: 25.5,
              dailyUsage: 1.25,
              secret: 'nested-secret-must-not-leak',
            },
          },
        ],
      },
    ],
  });

  assert.equal(overview.configuredProviders, 1);
  assert.equal(overview.total, 1);
  const account = overview.providers.find((provider) => provider.id === 'openrouter').accounts[0];
  assert.equal(account.id, 'openrouter-key');
  assert.equal(account.canRemove, true);
  assert.equal(account.status, 'verified');
  assert.equal(account.authError, 'safe authentication error');
  assert.equal(account.rateLimits.primary.windowMinutes, 10080);
  assert.deepEqual(account.rateLimits.manualResetCredits, {
    availableCount: 3,
    applicableAvailableCount: 1,
    credits: [{ title: 'Full reset', expiresAt: '2026-08-12T18:07:27Z' }],
  });
  assert.deepEqual(account.credit, {
    usage: 25.5,
    limit: 100,
    remaining: 74.5,
    usedPercent: 25.5,
    dailyUsage: 1.25,
    weeklyUsage: null,
    monthlyUsage: null,
    limitReset: null,
    expiresAt: null,
  });
  assert.equal(JSON.stringify(overview).includes('must-not-leak'), false);
});

test('account overview never fabricates an account when executor detail is unavailable', () => {
  const statuses = [{ id: 'codex', configured: true, active: 0, total: 0 }];
  const overview = buildAccountsOverview(statuses, null);
  const codex = overview.providers.find((provider) => provider.id === 'codex');

  assert.equal(codex.configured, true);
  assert.equal(codex.total, 0);
  assert.equal(codex.active, 0);
  assert.deepEqual(codex.accounts, []);
});

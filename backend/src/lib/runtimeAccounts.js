import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';

import { CLAUDE_CREDENTIAL_FILENAMES } from './claudeCredentials.js';
import { claudeCliStatus, cliRuntimeStatus, codexCliStatus } from './localCliProviders.js';
import { CLAUDE_HOME, CODEX_ACCOUNTS_ROOT, CODEX_PRIMARY_HOME } from './providerLogins.js';

const ENGINE_RUNTIME_CONFIG_PATH =
  process.env.OPEN_KRITT_ENGINE_RUNTIME_CONFIG_PATH || '/engine-data/engine-runtime.env';
const CODEX_RUNTIME_PRIMARY_HOME = process.env.OPEN_KRITT_CODEX_RUNTIME_PRIMARY_HOME || '/root/.codex';
const CODEX_RUNTIME_ACCOUNTS_ROOT = process.env.OPEN_KRITT_CODEX_RUNTIME_ACCOUNTS_DIR || '/codex-accounts';
const CODEX_INITIAL_HOME = process.env.OPEN_KRITT_CODEX_INITIAL_HOME || CODEX_RUNTIME_PRIMARY_HOME;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const USER_CODEX_HOME = join(homedir(), '.codex');
const USER_CLAUDE_HOME = join(homedir(), '.claude');
const USER_CLAUDE_PROFILE = join(homedir(), '.claude.json');

function safeText(value, limit = 500) {
  return typeof value === 'string' ? value.slice(0, limit) : null;
}

function splitConfiguredHomes(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return text
    .split(text.includes(',') ? ',' : ':')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function runtimeValue(text, key) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (!line.startsWith(`${key}=`)) continue;
    return line
      .slice(key.length + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
  }
  return null;
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'EACCES', 'EPERM'].includes(error?.code)) return null;
    throw error;
  }
}

async function readJsonObject(path) {
  const text = await readText(path);
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string' || !token.includes('.')) return {};
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    const value = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

async function configuredRuntimeHomes({
  runtimeConfigPath = ENGINE_RUNTIME_CONFIG_PATH,
  initialHome = CODEX_INITIAL_HOME,
} = {}) {
  const text = await readText(runtimeConfigPath);
  if (text) {
    const configured = runtimeValue(text, 'ENGINE_CODEX_HOME');
    if (configured !== null) return splitConfiguredHomes(configured);
  }
  return splitConfiguredHomes(initialHome);
}

function mappedCodexHome(runtimeHome, { primaryHome, accountsRoot, runtimePrimaryHome, runtimeAccountsRoot }) {
  if (runtimeHome === runtimePrimaryHome) {
    return { home: primaryHome, accountId: 'primary' };
  }
  const accountPath = relative(runtimeAccountsRoot, runtimeHome);
  const parts = accountPath.split(/[\\/]/);
  if (parts.length !== 2 || parts[1] !== '.codex' || !ACCOUNT_ID_PATTERN.test(parts[0])) return null;
  return { home: join(accountsRoot, parts[0], '.codex'), accountId: parts[0] };
}

function uniqueByPath(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    if (!entry?.home || seen.has(entry.home)) return false;
    seen.add(entry.home);
    return true;
  });
}

function claudeAccountDetails(profile, credentialFiles) {
  const details = [{ label: 'Provider', value: 'Claude Code' }];
  if (credentialFiles.length) details.push({ label: 'Credential source', value: credentialFiles.join(', ') });
  if (profile?.subscriptionType) details.push({ label: 'Plan', value: profile.subscriptionType });
  if (profile?.rateLimitTier) details.push({ label: 'Rate limit tier', value: profile.rateLimitTier });
  return details;
}

function codexAccountLabel(home) {
  return basename(home) === '.codex' ? basename(dirname(home)) : basename(home);
}

export async function localCodexAccountProvider({
  primaryHome = CODEX_PRIMARY_HOME,
  accountsRoot = CODEX_ACCOUNTS_ROOT,
  runtimeConfigPath = ENGINE_RUNTIME_CONFIG_PATH,
  runtimePrimaryHome = CODEX_RUNTIME_PRIMARY_HOME,
  runtimeAccountsRoot = CODEX_RUNTIME_ACCOUNTS_ROOT,
  initialHome = CODEX_INITIAL_HOME,
} = {}) {
  const cli = codexCliStatus();
  const runtimeHomes = await configuredRuntimeHomes({ runtimeConfigPath, initialHome });
  const fallbackRuntimeHomes = primaryHome === CODEX_PRIMARY_HOME && accountsRoot === CODEX_ACCOUNTS_ROOT ? [USER_CODEX_HOME] : [];
  const homes = uniqueByPath(
    [...runtimeHomes, ...fallbackRuntimeHomes]
      .map((runtimeHome) =>
        runtimeHome === USER_CODEX_HOME
          ? { home: USER_CODEX_HOME, accountId: 'local-cli' }
          : mappedCodexHome(runtimeHome, { primaryHome, accountsRoot, runtimePrimaryHome, runtimeAccountsRoot })
      )
      .filter(Boolean)
  );

  const accounts = (
    await Promise.all(
      homes.map(async ({ home, accountId }) => {
        const auth = await readJsonObject(join(home, 'auth.json'));
        if (!auth) return null;
        const payload = decodeJwtPayload(auth?.tokens?.id_token);
        const authInfo =
          payload?.['https://api.openai.com/auth'] &&
          typeof payload['https://api.openai.com/auth'] === 'object' &&
          !Array.isArray(payload['https://api.openai.com/auth'])
            ? payload['https://api.openai.com/auth']
            : {};
        const email = safeText(payload?.email, 320);
        const name = safeText(payload?.name, 200);
        return {
          id: accountId,
          label: email || codexAccountLabel(home),
          path: home,
          email,
          active: true,
          canRemove: true,
          status: 'logged in',
          statusKind: 'available',
          plan: safeText(authInfo?.chatgpt_plan_type, 100),
          subscriptionUntil: safeText(authInfo?.chatgpt_subscription_active_until, 100),
          details: [
            { label: 'Provider', value: 'Codex' },
            ...(cli.found ? [{ label: 'Executable', value: cli.path, mono: true }] : []),
            ...(name ? [{ label: 'Name', value: name }] : []),
          ],
          rateLimits: null,
          credit: null,
          authError: null,
        };
      })
    )
  ).filter(Boolean);

  return {
    kind: 'codex',
    active: accounts.filter((account) => account.active).length,
    total: accounts.length,
    limited: 0,
    stale: 0,
    accounts,
    runtime: cliRuntimeStatus('codex', accounts.some((account) => account.active), cli),
  };
}

async function readClaudeProfile(home) {
  const candidates = [
    ...CLAUDE_CREDENTIAL_FILENAMES.map((name) => join(home, name)),
    join(home, '.claude.json'),
    join(home, 'claude.json'),
    join(home, 'settings.json'),
    ...(home === USER_CLAUDE_HOME ? [USER_CLAUDE_PROFILE] : []),
  ];
  const parsed = (await Promise.all(candidates.map((path) => readJsonObject(path)))).filter(Boolean);
  const fields = (keys) => {
    for (const payload of parsed) {
      for (const key of keys) {
        const value = payload?.[key];
        if (typeof value === 'string' && value.trim()) return value.trim();
      }
    }
    return null;
  };
  return {
    email: safeText(fields(['email', 'user_email', 'account_email']), 320),
    name: safeText(fields(['name', 'username', 'display_name']), 200),
    subscriptionType: safeText(fields(['subscriptionType', 'subscription_type']), 100),
    rateLimitTier: safeText(fields(['rateLimitTier', 'rate_limit_tier']), 100),
  };
}

async function claudeCredentialFiles(home) {
  try {
    const entries = await readdir(home);
    return CLAUDE_CREDENTIAL_FILENAMES.filter((name) => entries.includes(name));
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'EACCES', 'EPERM'].includes(error?.code)) return [];
    throw error;
  }
}

export async function localClaudeAccountProvider({ home = CLAUDE_HOME } = {}) {
  const cli = claudeCliStatus();
  const candidateHome =
    (await claudeCredentialFiles(home)).length || (await readText(join(home, '.claude.json'))) || home !== CLAUDE_HOME
      ? home
      : USER_CLAUDE_HOME;
  const [profile, credentialFiles, userProfile] = await Promise.all([
    readClaudeProfile(candidateHome),
    claudeCredentialFiles(candidateHome),
    readJsonObject(USER_CLAUDE_PROFILE),
  ]);
  const hasCredentials = credentialFiles.length > 0 || (candidateHome === USER_CLAUDE_HOME && Boolean(userProfile));
  const hasProfile = Boolean(profile.email || profile.name || profile.subscriptionType || profile.rateLimitTier);
  const statusKind = hasCredentials ? 'available' : hasProfile ? 'warning' : 'missing';
  const status = hasCredentials ? 'logged in' : hasProfile ? 'profile found; login required' : 'missing config';
  const account = {
    id: 'default',
    label: profile.email || profile.name || 'Claude Code',
    path: candidateHome,
    email: profile.email,
    active: hasCredentials,
    canRemove: hasCredentials,
    status,
    statusKind,
    plan: profile.subscriptionType,
    details: [
      ...claudeAccountDetails(profile, credentialFiles),
      ...(cli.found ? [{ label: 'Executable', value: cli.path, mono: true }] : []),
    ],
    rateLimits: null,
    credit: null,
    authError: null,
  };
  return {
    kind: 'claude',
    active: hasCredentials ? 1 : 0,
    total: hasCredentials || hasProfile ? 1 : 0,
    limited: 0,
    stale: 0,
    accounts: hasCredentials || hasProfile ? [account] : [],
    runtime: cliRuntimeStatus('claude', hasCredentials, cli),
  };
}

export async function localAccountProviders({ codex, claude } = {}) {
  const [codexProvider, claudeProvider] = await Promise.all([
    localCodexAccountProvider(codex),
    localClaudeAccountProvider(claude),
  ]);
  return { providers: [codexProvider, claudeProvider] };
}

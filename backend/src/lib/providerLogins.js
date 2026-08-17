import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import { claudeCliStatus, codexCliStatus } from './localCliProviders.js';

export const CODEX_PRIMARY_HOME = process.env.OPEN_KRITT_CODEX_HOME_DIR || '/provider-homes/codex';
export const CODEX_ACCOUNTS_ROOT = process.env.OPEN_KRITT_CODEX_ACCOUNTS_DIR || '/provider-homes/codex-accounts';
export const CLAUDE_HOME = process.env.OPEN_KRITT_CLAUDE_HOME || '/provider-homes/claude';
const USER_CODEX_HOME = join(homedir(), '.codex');
const USER_CLAUDE_HOME = join(homedir(), '.claude');
const USER_CLAUDE_PROFILE = join(homedir(), '.claude.json');
const CODEX_RUNTIME_CONFIG_PATH =
  process.env.OPEN_KRITT_ENGINE_RUNTIME_CONFIG_PATH || '/engine-data/engine-runtime.env';
const CODEX_RUNTIME_PRIMARY_HOME = process.env.OPEN_KRITT_CODEX_RUNTIME_PRIMARY_HOME || '/root/.codex';
const CODEX_RUNTIME_ACCOUNTS_ROOT = process.env.OPEN_KRITT_CODEX_RUNTIME_ACCOUNTS_DIR || '/codex-accounts';
const CODEX_INITIAL_HOME = process.env.OPEN_KRITT_CODEX_INITIAL_HOME || CODEX_RUNTIME_PRIMARY_HOME;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function readableJsonObject(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
  } catch {
    return false;
  }
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

function splitConfiguredHomes(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return text
    .split(text.includes(',') ? ',' : ':')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function configuredRuntimeHomes(runtimeConfigPath, initialHome) {
  try {
    const configured = runtimeValue(readFileSync(runtimeConfigPath, 'utf8'), 'ENGINE_CODEX_HOME');
    if (configured !== null) return splitConfiguredHomes(configured);
  } catch {
    // The engine creates the runtime file on first start. Until then, .env is
    // the one-time source for the initial account list.
  }
  return splitConfiguredHomes(initialHome);
}

export function codexLoginIsConfigured({
  env = process.env,
  primaryHome = CODEX_PRIMARY_HOME,
  accountsRoot = CODEX_ACCOUNTS_ROOT,
  runtimeConfigPath = CODEX_RUNTIME_CONFIG_PATH,
  runtimePrimaryHome = CODEX_RUNTIME_PRIMARY_HOME,
  runtimeAccountsRoot = CODEX_RUNTIME_ACCOUNTS_ROOT,
  initialHome = CODEX_INITIAL_HOME,
} = {}) {
  if (!codexCliStatus({ env }).found) return false;
  const homes = configuredRuntimeHomes(runtimeConfigPath, initialHome).map((runtimeHome) => {
    if (runtimeHome === runtimePrimaryHome) return primaryHome;
    const accountPath = relative(runtimeAccountsRoot, runtimeHome);
    const parts = accountPath.split(/[\\/]/);
    if (parts.length !== 2 || parts[1] !== '.codex' || !ACCOUNT_ID_PATTERN.test(parts[0])) return null;
    return join(accountsRoot, parts[0], '.codex');
  });
  const fallbackHomes = primaryHome === CODEX_PRIMARY_HOME && accountsRoot === CODEX_ACCOUNTS_ROOT ? [USER_CODEX_HOME] : [];
  return [...homes.filter(Boolean), ...fallbackHomes].some((home) => readableJsonObject(join(home, 'auth.json')));
}

export function claudeLoginIsConfigured({ env = process.env, home = CLAUDE_HOME } = {}) {
  if (!claudeCliStatus({ env }).found) return false;
  // Profile metadata lives in .claude.json, but a usable container login also
  // needs the OAuth credential file written by `claude auth login`.
  if (['.credentials.json', 'credentials.json'].some((name) => readableJsonObject(join(home, name)))) return true;
  if (home !== CLAUDE_HOME) return false;
  return (
    readableJsonObject(join(USER_CLAUDE_HOME, '.credentials.json')) ||
    readableJsonObject(join(USER_CLAUDE_HOME, 'credentials.json')) ||
    readableJsonObject(USER_CLAUDE_PROFILE)
  );
}

export function providerLoginIsConfigured(provider, options = {}) {
  if (provider === 'codex') {
    return codexLoginIsConfigured({ env: options.env, ...options.codex });
  }
  if (provider === 'claude') return claudeLoginIsConfigured({ env: options.env, ...options.claude });
  return false;
}

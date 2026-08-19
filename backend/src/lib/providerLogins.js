import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

export const CODEX_PRIMARY_HOME = process.env.OPEN_KRITT_CODEX_HOME_DIR || '/provider-homes/codex';
export const CODEX_ACCOUNTS_ROOT = process.env.OPEN_KRITT_CODEX_ACCOUNTS_DIR || '/provider-homes/codex-accounts';
export const CLAUDE_HOME = process.env.OPEN_KRITT_CLAUDE_HOME || '/provider-homes/claude';
export const CLAUDE_ACCOUNTS_ROOT = process.env.OPEN_KRITT_CLAUDE_ACCOUNTS_DIR || '/provider-homes/claude-accounts';
const ENGINE_RUNTIME_CONFIG_PATH =
  process.env.OPEN_KRITT_ENGINE_RUNTIME_CONFIG_PATH || '/engine-data/engine-runtime.env';
const CODEX_RUNTIME_PRIMARY_HOME = process.env.OPEN_KRITT_CODEX_RUNTIME_PRIMARY_HOME || '/root/.codex';
const CODEX_RUNTIME_ACCOUNTS_ROOT = process.env.OPEN_KRITT_CODEX_RUNTIME_ACCOUNTS_DIR || '/codex-accounts';
const CODEX_INITIAL_HOME = process.env.OPEN_KRITT_CODEX_INITIAL_HOME || CODEX_RUNTIME_PRIMARY_HOME;
export const CLAUDE_RUNTIME_PRIMARY_HOME = process.env.OPEN_KRITT_CLAUDE_RUNTIME_PRIMARY_HOME || '/root/.claude';
export const CLAUDE_RUNTIME_ACCOUNTS_ROOT = process.env.OPEN_KRITT_CLAUDE_RUNTIME_ACCOUNTS_DIR || '/claude-accounts';
const CLAUDE_INITIAL_HOME = process.env.OPEN_KRITT_CLAUDE_INITIAL_HOME || CLAUDE_RUNTIME_PRIMARY_HOME;
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

function configuredRuntimeHomes(runtimeConfigPath, key, initialHome) {
  try {
    const configured = runtimeValue(readFileSync(runtimeConfigPath, 'utf8'), key);
    if (configured !== null) return splitConfiguredHomes(configured);
  } catch {
    // The engine creates the runtime file on first start. Until then, .env is
    // the one-time source for the initial account list.
  }
  return splitConfiguredHomes(initialHome);
}

export function codexLoginIsConfigured({
  primaryHome = CODEX_PRIMARY_HOME,
  accountsRoot = CODEX_ACCOUNTS_ROOT,
  runtimeConfigPath = ENGINE_RUNTIME_CONFIG_PATH,
  runtimePrimaryHome = CODEX_RUNTIME_PRIMARY_HOME,
  runtimeAccountsRoot = CODEX_RUNTIME_ACCOUNTS_ROOT,
  initialHome = CODEX_INITIAL_HOME,
} = {}) {
  const homes = configuredRuntimeHomes(runtimeConfigPath, 'ENGINE_CODEX_HOME', initialHome).map((runtimeHome) => {
    if (runtimeHome === runtimePrimaryHome) return primaryHome;
    const accountPath = relative(runtimeAccountsRoot, runtimeHome);
    const parts = accountPath.split(/[\\/]/);
    if (parts.length !== 2 || parts[1] !== '.codex' || !ACCOUNT_ID_PATTERN.test(parts[0])) return null;
    return join(accountsRoot, parts[0], '.codex');
  });
  return homes.filter(Boolean).some((home) => readableJsonObject(join(home, 'auth.json')));
}

export function claudeLoginIsConfigured({
  home = CLAUDE_HOME,
  accountsRoot = CLAUDE_ACCOUNTS_ROOT,
  runtimeConfigPath = ENGINE_RUNTIME_CONFIG_PATH,
  runtimePrimaryHome = CLAUDE_RUNTIME_PRIMARY_HOME,
  runtimeAccountsRoot = CLAUDE_RUNTIME_ACCOUNTS_ROOT,
  initialHome = CLAUDE_INITIAL_HOME,
} = {}) {
  // Profile metadata lives in .claude.json, but a usable container login also
  // needs the OAuth credential file written by `claude auth login`.
  const homes = configuredRuntimeHomes(runtimeConfigPath, 'ENGINE_CLAUDE_HOME', initialHome).map((runtimeHome) => {
    if (runtimeHome === runtimePrimaryHome) return home;
    const accountPath = relative(runtimeAccountsRoot, runtimeHome);
    const parts = accountPath.split(/[\\/]/);
    if (parts.length !== 2 || parts[1] !== '.claude' || !ACCOUNT_ID_PATTERN.test(parts[0])) return null;
    return join(accountsRoot, parts[0], '.claude');
  });
  return homes
    .filter(Boolean)
    .some((candidate) =>
      ['.credentials.json', 'credentials.json'].some((name) => readableJsonObject(join(candidate, name)))
    );
}

export function providerLoginIsConfigured(provider, options = {}) {
  if (provider === 'codex') {
    return codexLoginIsConfigured(options.codex);
  }
  if (provider === 'claude') return claudeLoginIsConfigured(options.claude);
  return false;
}

import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, chown, lstat, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join, posix, resolve } from 'node:path';

import {
  mutateEnvironmentFile,
  PROJECT_ENV_FILE_PATH,
  parseEnvironmentText,
  updateEnvironmentFile,
} from './environmentFile.js';
import { CLAUDE_HOME, CODEX_ACCOUNTS_ROOT, CODEX_PRIMARY_HOME } from './providerLogins.js';
import { CLAUDE_CREDENTIAL_FILENAMES, promoteClaudeCredential, withClaudeCredentialLock } from './claudeCredentials.js';
import { providerCliEnv, providerCliStatus } from './localCliProviders.js';

const LOGIN_PROVIDERS = new Set(['codex', 'claude']);
const SESSION_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_CAPTURED_OUTPUT = 32 * 1024;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENGINE_RUNTIME_CONFIG_PATH =
  process.env.OPEN_KRITT_ENGINE_RUNTIME_CONFIG_PATH || '/engine-data/engine-runtime.env';
const CODEX_RUNTIME_ACCOUNTS_ROOT = process.env.OPEN_KRITT_CODEX_RUNTIME_ACCOUNTS_DIR || '/codex-accounts';
const CODEX_RUNTIME_PRIMARY_HOME = process.env.OPEN_KRITT_CODEX_RUNTIME_PRIMARY_HOME || '/root/.codex';

function runtimePathJoin(root, ...parts) {
  const text = String(root || '');
  if (/^[A-Za-z]:[\\/]/.test(text) || text.includes('\\')) return join(text, ...parts);
  return posix.join(text, ...parts);
}

function loginError(message, statusCode = 422) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function stripTerminalFormatting(value) {
  const escape = String.fromCharCode(27);
  const bell = String.fromCharCode(7);
  const operatingSystemCommand = new RegExp(`${escape}\\][^${bell}]*(?:${bell}|${escape}\\\\)`, 'g');
  const controlSequence = new RegExp(`${escape}\\[[0-?]*[ -/]*[@-~]`, 'g');
  return String(value || '')
    .replace(operatingSystemCommand, '')
    .replace(controlSequence, '')
    .replace(/\r/g, '');
}

export function parseLoginInstructions(provider, rawOutput) {
  const output = stripTerminalFormatting(rawOutput);
  const authorizationUrl = output.match(/https:\/\/[^\s<>"']+/)?.[0]?.replace(/[),.;]+$/, '') || null;
  const deviceCode = provider === 'codex' ? output.match(/\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/)?.[0] || null : null;
  const requiresInput = provider === 'claude' && /paste code here/i.test(output);
  return { authorizationUrl, deviceCode, requiresInput };
}

function splitConfiguredHomes(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return text
    .split(text.includes(',') ? ',' : ':')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

async function updateCodexRuntimeHome(
  home,
  present,
  { runtimeConfigPath = ENGINE_RUNTIME_CONFIG_PATH, initialHomes = [] } = {}
) {
  let nextHomes = [];
  const state = await mutateEnvironmentFile(
    (values) => {
      const homes = splitConfiguredHomes(values.ENGINE_CODEX_HOME || initialHomes.join(','));
      const updatedHomes = present
        ? homes.includes(home)
          ? homes
          : [...homes, home]
        : homes.filter((candidate) => candidate !== home);
      // Assign outside the callback so callers receive the normalized list even
      // when no write is needed.
      nextHomes = updatedHomes;
      const changed = updatedHomes.length !== homes.length;
      return changed ? { ENGINE_CODEX_HOME: updatedHomes.join(',') } : null;
    },
    { environmentFilePath: runtimeConfigPath }
  );
  return { changed: state.changed, homes: nextHomes };
}

async function environmentCodexHomes(environmentFilePath) {
  if (!environmentFilePath) return [];
  try {
    const values = parseEnvironmentText(await readFile(environmentFilePath, 'utf8'));
    return splitConfiguredHomes(values.ENGINE_CODEX_HOME);
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'EACCES', 'EPERM'].includes(error?.code)) return [];
    throw error;
  }
}

async function syncCodexEnvironment(homes, environmentFilePath) {
  await updateEnvironmentFile(
    {
      ENGINE_CODEX_HOME: homes.join(','),
      CODEX_LOGIN_CONFIGURED: homes.length ? '1' : '',
    },
    { environmentFilePath }
  );
}

export async function addCodexRuntimeHome(
  home,
  { runtimeConfigPath = ENGINE_RUNTIME_CONFIG_PATH, environmentFilePath = PROJECT_ENV_FILE_PATH } = {}
) {
  const initialHomes = await environmentCodexHomes(environmentFilePath);
  const state = await updateCodexRuntimeHome(home, true, { runtimeConfigPath, initialHomes });
  try {
    await syncCodexEnvironment(state.homes, environmentFilePath);
  } catch (error) {
    if (state.changed) await updateCodexRuntimeHome(home, false, { runtimeConfigPath });
    throw error;
  }
  return state.homes;
}

export async function removeCodexRuntimeHome(
  home,
  { runtimeConfigPath = ENGINE_RUNTIME_CONFIG_PATH, environmentFilePath = PROJECT_ENV_FILE_PATH } = {}
) {
  const initialHomes = await environmentCodexHomes(environmentFilePath);
  const state = await updateCodexRuntimeHome(home, false, { runtimeConfigPath, initialHomes });
  if (!state.changed) return false;
  try {
    await syncCodexEnvironment(state.homes, environmentFilePath);
  } catch (error) {
    await updateCodexRuntimeHome(home, true, { runtimeConfigPath });
    throw error;
  }
  return true;
}

async function usableJsonFile(path) {
  try {
    const file = await stat(path);
    if (!file.isFile() || file.size <= 2 || file.size > 1024 * 1024) return false;
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
  } catch {
    return false;
  }
}

async function codexReloginTarget(accountId, { primaryHome, primaryRuntimeHome, accountsRoot, runtimeAccountsRoot }) {
  if (!accountId) return null;
  if (accountId === 'primary') {
    if (!(await usableJsonFile(join(primaryHome, 'auth.json')))) throw loginError('Codex account not found.', 404);
    return { home: primaryHome, runtimeHome: primaryRuntimeHome };
  }
  if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw loginError('Codex account not found.', 404);
  }
  const resolvedAccountsRoot = resolve(accountsRoot);
  const accountDirectory = resolve(resolvedAccountsRoot, accountId);
  if (dirname(accountDirectory) !== resolvedAccountsRoot) throw loginError('Codex account not found.', 404);
  try {
    const entry = await lstat(accountDirectory);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw loginError('Codex account not found.', 404);
  } catch (error) {
    if (error?.statusCode) throw error;
    if (error?.code === 'ENOENT') throw loginError('Codex account not found.', 404);
    throw error;
  }
  const home = join(accountDirectory, '.codex');
  if (!(await usableJsonFile(join(home, 'auth.json')))) throw loginError('Codex account not found.', 404);
  return { home, runtimeHome: runtimePathJoin(runtimeAccountsRoot, accountId, '.codex') };
}

async function claudeReloginTarget(accountId, home) {
  if (!accountId) return null;
  if (accountId !== 'default') throw loginError('Claude account not found.', 404);
  const configured = await Promise.all(CLAUDE_CREDENTIAL_FILENAMES.map((name) => usableJsonFile(join(home, name))));
  if (!configured.some(Boolean)) throw loginError('Claude account not found.', 404);
  return { home };
}

function publicSession(session) {
  const instructions = parseLoginInstructions(session.provider, session.output);
  return {
    id: session.id,
    provider: session.provider,
    status: session.status,
    authorizationUrl: instructions.authorizationUrl,
    deviceCode: instructions.deviceCode,
    requiresInput: instructions.requiresInput,
    message: session.message,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
  };
}

function sessionMessage(provider, status, instructions) {
  if (status === 'completed') return `${provider === 'codex' ? 'Codex' : 'Claude'} login saved.`;
  if (status === 'failed') return 'Login did not complete. Start a new login and try again.';
  if (status === 'canceled') return 'Login canceled.';
  if (instructions.requiresInput) return 'Finish signing in, then paste the callback code below.';
  if (instructions.authorizationUrl && instructions.deviceCode) {
    return 'Open the sign-in page and enter the device code.';
  }
  if (instructions.authorizationUrl) return 'Open the sign-in page to continue.';
  return 'Starting the provider login…';
}

export class AccountLoginManager {
  constructor({
    spawnProcess = spawn,
    codexPrimaryHome = CODEX_PRIMARY_HOME,
    codexAccountsRoot = CODEX_ACCOUNTS_ROOT,
    codexRuntimePrimaryHome = CODEX_RUNTIME_PRIMARY_HOME,
    codexRuntimeAccountsRoot = CODEX_RUNTIME_ACCOUNTS_ROOT,
    claudeHome = CLAUDE_HOME,
    runtimeConfigPath = ENGINE_RUNTIME_CONFIG_PATH,
    environmentFilePath = PROJECT_ENV_FILE_PATH,
    timeoutMs = SESSION_TIMEOUT_MS,
  } = {}) {
    this.spawnProcess = spawnProcess;
    this.codexPrimaryHome = codexPrimaryHome;
    this.codexAccountsRoot = codexAccountsRoot;
    this.codexRuntimePrimaryHome = codexRuntimePrimaryHome;
    this.codexRuntimeAccountsRoot = codexRuntimeAccountsRoot;
    this.claudeHome = claudeHome;
    this.runtimeConfigPath = runtimeConfigPath;
    this.environmentFilePath = environmentFilePath;
    this.timeoutMs = timeoutMs;
    this.sessions = new Map();
  }

  async start(provider, accountId = null) {
    if (!LOGIN_PROVIDERS.has(provider)) throw loginError('Choose Codex or Claude login.');
    const activeForProvider = [...this.sessions.values()].find(
      (session) => session.provider === provider && ['starting', 'waiting'].includes(session.status)
    );
    if (activeForProvider) return publicSession(activeForProvider);

    const reloginTarget =
      provider === 'codex'
        ? await codexReloginTarget(accountId, {
            primaryHome: this.codexPrimaryHome,
            primaryRuntimeHome: this.codexRuntimePrimaryHome,
            accountsRoot: this.codexAccountsRoot,
            runtimeAccountsRoot: this.codexRuntimeAccountsRoot,
          })
        : await claudeReloginTarget(accountId, this.claudeHome);

    const id = randomUUID();
    const createdAt = new Date();
    const session = {
      id,
      provider,
      status: 'starting',
      message: 'Starting the provider login…',
      output: '',
      child: null,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.timeoutMs).toISOString(),
      settled: false,
    };
    this.sessions.set(id, session);

    let command;
    let args;
    let env = providerCliEnv(provider, { ...process.env, NO_COLOR: '1', TERM: 'dumb' });
    const cli = providerCliStatus(provider, { env });
    if (!cli?.found) {
      session.status = 'failed';
      session.message = cli?.message || `${provider === 'claude' ? 'Claude Code' : 'Codex'} CLI is not installed or not found in PATH.`;
      throw loginError(session.message, 503);
    }
    if (provider === 'codex') {
      if (reloginTarget) {
        session.codexHome = reloginTarget.home;
        session.codexRuntimeHome = reloginTarget.runtimeHome;
        session.replacesAccountId = accountId;
      } else {
        const folder = `account-${createdAt.toISOString().replace(/\D/g, '').slice(0, 14)}-${id.slice(0, 8)}`;
        session.codexDirectory = join(this.codexAccountsRoot, folder);
        session.codexHome = join(session.codexDirectory, '.codex');
        session.codexRuntimeHome = runtimePathJoin(this.codexRuntimeAccountsRoot, folder, '.codex');
        await mkdir(session.codexHome, { recursive: true, mode: 0o700 });
      }
      command = cli.path;
      args = ['login', '--device-auth'];
      env.CODEX_HOME = session.codexHome;
    } else {
      if (reloginTarget) session.replacesAccountId = accountId;
      session.claudeLoginHome = join(dirname(this.claudeHome), `.claude-login-${id}`);
      await mkdir(session.claudeLoginHome, { recursive: true, mode: 0o700 });
      command = cli.path;
      args = ['auth', 'login', '--claudeai'];
      env.HOME = session.claudeLoginHome;
      env.CLAUDE_HOME = session.claudeLoginHome;
      env.CLAUDE_CONFIG_DIR = session.claudeLoginHome;
    }
    delete env.CI;

    let child;
    try {
      child = this.spawnProcess(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      session.status = 'failed';
      session.message = `${provider === 'claude' ? 'Claude Code' : 'Codex'} CLI could not start. Verify the saved executable path.`;
      if (session.claudeLoginHome) void rm(session.claudeLoginHome, { recursive: true, force: true });
      throw loginError(session.message, 503);
    }
    session.child = child;

    const capture = (chunk) => {
      session.output = `${session.output}${String(chunk)}`.slice(-MAX_CAPTURED_OUTPUT);
      const instructions = parseLoginInstructions(provider, session.output);
      if (instructions.authorizationUrl || instructions.requiresInput) session.status = 'waiting';
      session.message = sessionMessage(provider, session.status, instructions);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    child.once('error', (error) =>
      this.fail(
        session,
        `${provider === 'claude' ? 'Claude Code' : 'Codex'} CLI login failed to start. Verify the executable path and permissions.`
      )
    );
    child.once('close', (code) => this.finish(session, code));
    session.timeout = setTimeout(() => {
      if (session.settled) return;
      session.status = 'failed';
      session.message = 'Login expired. Start a new login and try again.';
      session.child?.kill('SIGTERM');
    }, this.timeoutMs);
    session.timeout.unref?.();
    return publicSession(session);
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw loginError('Login session not found.', 404);
    return publicSession(session);
  }

  submit(id, code) {
    const session = this.sessions.get(id);
    if (!session) throw loginError('Login session not found.', 404);
    if (session.provider !== 'claude') throw loginError('Only Claude login accepts a callback code.');
    if (session.status !== 'waiting' || !session.child?.stdin?.writable) {
      throw loginError('This login is not waiting for a callback code.', 409);
    }
    if (typeof code !== 'string' || !code.trim() || code.length > 4096 || /[\r\n]/.test(code)) {
      throw loginError('Paste the single-line callback code from Claude.');
    }
    session.child.stdin.write(`${code.trim()}\n`);
    session.message = 'Verifying the Claude login…';
    return publicSession(session);
  }

  cancel(id) {
    const session = this.sessions.get(id);
    if (!session) throw loginError('Login session not found.', 404);
    if (!session.settled) {
      session.status = 'canceled';
      session.message = 'Login canceled.';
      session.child?.kill('SIGTERM');
    }
    return publicSession(session);
  }

  async startWeeklyUsage(accountId) {
    let home;
    if (accountId === 'primary') {
      home = this.codexPrimaryHome;
    } else {
      if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) {
        throw loginError('Codex account not found.', 404);
      }
      const accountsRoot = resolve(this.codexAccountsRoot);
      const accountDirectory = resolve(accountsRoot, accountId);
      if (dirname(accountDirectory) !== accountsRoot) throw loginError('Codex account not found.', 404);
      try {
        const entry = await lstat(accountDirectory);
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw loginError('Codex account not found.', 404);
      } catch (error) {
        if (error?.statusCode) throw error;
        if (error?.code === 'ENOENT') throw loginError('Codex account not found.', 404);
        throw error;
      }
      home = join(accountDirectory, '.codex');
    }

    const authPath = join(home, 'auth.json');
    let original;
    try {
      original = await stat(authPath);
      if (!original.isFile()) throw loginError('Codex account not found.', 404);
    } catch (error) {
      if (error?.statusCode) throw error;
      if (error?.code === 'ENOENT') throw loginError('Codex account not found.', 404);
      throw error;
    }

    const cli = providerCliStatus('codex');
    if (!cli?.found) throw loginError('Codex CLI is not installed or not found in PATH.', 503);
    const env = providerCliEnv('codex', {
      PATH: process.env.PATH || '',
      HOME: '/tmp',
      CODEX_HOME: home,
      NO_COLOR: '1',
      TERM: 'dumb',
      ...(process.env.NODE_EXTRA_CA_CERTS ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS } : {}),
      ...(process.env.SSL_CERT_FILE ? { SSL_CERT_FILE: process.env.SSL_CERT_FILE } : {}),
    });
    const prompt = randomBytes(50).toString('hex');
    try {
      await new Promise((resolvePromise, rejectPromise) => {
        let child;
        try {
          child = this.spawnProcess(
            cli.path,
            [
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
              prompt,
            ],
            { cwd: '/tmp', env, stdio: 'ignore' }
          );
        } catch {
          rejectPromise(loginError('Could not start Codex weekly usage.', 503));
          return;
        }
        child.once('error', () => rejectPromise(loginError('Could not start Codex weekly usage.', 503)));
        child.once('close', (code) =>
          code === 0 ? resolvePromise() : rejectPromise(loginError('Codex could not start weekly usage.', 502))
        );
      });
    } finally {
      await Promise.allSettled([chown(authPath, original.uid, original.gid), chmod(authPath, original.mode & 0o7777)]);
    }
    return { accountId, started: true };
  }

  async removeAccount(provider, accountId) {
    if (!LOGIN_PROVIDERS.has(provider)) throw loginError('Choose a Codex or Claude account.', 404);
    const activeForProvider = [...this.sessions.values()].some(
      (session) => session.provider === provider && ['starting', 'waiting'].includes(session.status)
    );
    if (activeForProvider) throw loginError(`Finish or cancel the ${provider} login before removing an account.`, 409);

    if (provider === 'claude') {
      if (accountId !== 'default') throw loginError('Claude account not found.', 404);
      const removed = await withClaudeCredentialLock(this.claudeHome, async () => {
        let found = false;
        for (const name of CLAUDE_CREDENTIAL_FILENAMES) {
          try {
            await rm(join(this.claudeHome, name));
            found = true;
          } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
          }
        }
        return found;
      });
      if (!removed) throw loginError('Claude account not found.', 404);
      return { provider, accountId, removed: true };
    }

    if (accountId === 'primary') {
      const configured = await removeCodexRuntimeHome(this.codexRuntimePrimaryHome, {
        runtimeConfigPath: this.runtimeConfigPath,
        environmentFilePath: this.environmentFilePath,
      });
      if (!configured) throw loginError('Codex account not found.', 404);
      await rm(join(this.codexPrimaryHome, 'auth.json'), { force: true });
      return { provider, accountId, removed: true };
    }

    if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) {
      throw loginError('Codex account not found.', 404);
    }
    const accountsRoot = resolve(this.codexAccountsRoot);
    const accountDirectory = resolve(accountsRoot, accountId);
    if (dirname(accountDirectory) !== accountsRoot) throw loginError('Codex account not found.', 404);
    try {
      const entry = await lstat(accountDirectory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw loginError('Codex account not found.', 404);
    } catch (error) {
      if (error?.statusCode) throw error;
      if (error?.code === 'ENOENT') throw loginError('Codex account not found.', 404);
      throw error;
    }
    const runtimeHome = runtimePathJoin(this.codexRuntimeAccountsRoot, accountId, '.codex');
    const configured = await removeCodexRuntimeHome(runtimeHome, {
      runtimeConfigPath: this.runtimeConfigPath,
      environmentFilePath: this.environmentFilePath,
    });
    if (!configured) throw loginError('Codex account not found.', 404);
    await rm(accountDirectory, { recursive: true });
    return { provider, accountId, removed: true };
  }

  async refreshProvider(provider) {
    if (!LOGIN_PROVIDERS.has(provider)) throw loginError('Choose a Codex or Claude account.', 404);
    const cli = providerCliStatus(provider);
    if (!cli?.found) throw loginError(cli?.message || `${provider} CLI is not installed or not found in PATH.`, 503);
    return { provider, executable: cli.path, refreshed: true };
  }

  fail(session, message) {
    if (session.settled) return;
    session.settled = true;
    clearTimeout(session.timeout);
    session.status = 'failed';
    session.message = message;
    session.child = null;
    if (session.codexDirectory) void rm(session.codexDirectory, { recursive: true, force: true });
    if (session.claudeLoginHome) void rm(session.claudeLoginHome, { recursive: true, force: true });
  }

  async finish(session, code) {
    if (session.settled) return;
    if (session.status === 'canceled') {
      session.settled = true;
      clearTimeout(session.timeout);
      session.child = null;
      if (session.codexDirectory) await rm(session.codexDirectory, { recursive: true, force: true });
      if (session.claudeLoginHome) await rm(session.claudeLoginHome, { recursive: true, force: true });
      return;
    }
    if (code !== 0) {
      this.fail(
        session,
        session.message === 'Login expired. Start a new login and try again.'
          ? session.message
          : sessionMessage(session.provider, 'failed', {})
      );
      return;
    }

    try {
      const usable =
        session.provider === 'codex'
          ? await usableJsonFile(join(session.codexHome, 'auth.json'))
          : await promoteClaudeCredential(session.claudeLoginHome, this.claudeHome);
      if (!usable) throw new Error('The provider finished without saving usable login credentials.');
      if (session.provider === 'codex') {
        if (!(await usableJsonFile(join(this.codexPrimaryHome, 'auth.json')))) {
          await removeCodexRuntimeHome(this.codexRuntimePrimaryHome, {
            runtimeConfigPath: this.runtimeConfigPath,
            environmentFilePath: this.environmentFilePath,
          });
        }
        await addCodexRuntimeHome(session.codexRuntimeHome, {
          runtimeConfigPath: this.runtimeConfigPath,
          environmentFilePath: this.environmentFilePath,
        });
      }
      session.status = 'completed';
      session.message = sessionMessage(session.provider, 'completed', {});
    } catch (error) {
      session.status = 'failed';
      session.message = error.message;
      if (session.codexDirectory) await rm(session.codexDirectory, { recursive: true, force: true });
    } finally {
      if (session.claudeLoginHome) await rm(session.claudeLoginHome, { recursive: true, force: true });
      session.settled = true;
      clearTimeout(session.timeout);
      session.child = null;
    }
  }
}

export const accountLoginManager = new AccountLoginManager();

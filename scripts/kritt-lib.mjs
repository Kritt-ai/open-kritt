import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

export const PROVIDER_KEYS = ['CODEX_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'];
export const CODEX_LOGIN_STATUS_KEY = 'CODEX_LOGIN_CONFIGURED';
const MANAGED_PROVIDER_LABELS = {
  openrouter: 'OpenRouter API key',
};
const CODEX_LOGIN_CONTAINER_USER_HOME = '/open-kritt-login';
const CODEX_LOGIN_CONTAINER_HOME = `${CODEX_LOGIN_CONTAINER_USER_HOME}/.codex`;
const CODEX_LOGIN_CONTAINER_BOOTSTRAP =
  'umask 077; mkdir -p "$HOME" "$CODEX_HOME" && chmod 700 "$HOME" "$CODEX_HOME" && exec codex "$@"';

export const ENVIRONMENT_ITEMS = [
  {
    key: 'CODEX_API_KEY',
    label: 'Codex API key',
    info: 'Used by the Codex harness. It is an alternative to signing in to Codex through this CLI.',
  },
  {
    key: 'OPENAI_API_KEY',
    label: 'OpenAI API key',
    info: 'Used as a Codex API key when CODEX_API_KEY is not set.',
  },
  {
    key: 'ANTHROPIC_API_KEY',
    label: 'Anthropic API key',
    info: 'Used by the Claude Code harness as an alternative to the guided Claude subscription login.',
  },
  {
    key: 'OPENROUTER_API_KEY',
    label: 'OpenRouter API key',
    info: 'Used for supported OpenRouter-compatible model and harness selections.',
  },
  {
    key: 'GITHUB_TOKEN',
    label: 'GitHub token',
    info: 'Optional. It lets the engine clone private GitHub repositories and dependencies. Public and local scans do not need it.',
  },
];

export const CODEX_LOGIN = {
  label: 'Codex login',
  info: 'A persisted Codex login is used when no Codex API key is set. The guided flow uses Codex device authentication, so it does not rely on a container localhost callback.',
};

export const CLAUDE_LOGIN = {
  label: 'Claude login',
  info: 'A persisted Claude subscription login is shared by setup, the Accounts tab, and future Claude Code jobs.',
};

export class UserCancelledError extends Error {
  constructor(signal = 'SIGINT') {
    super('Cancelled.');
    this.exitCode = signal === 'SIGTERM' ? 143 : 130;
    this.signal = signal;
  }
}

class CommandError extends Error {
  constructor(command, cause) {
    super(`Could not run ${command}: ${cause.message}`);
    this.cause = cause;
  }
}

function defaultIo() {
  return { input: process.stdin, output: process.stdout, error: process.stderr };
}

function write(io, message = '') {
  io.output.write(`${message}\n`);
}

function writeError(io, message) {
  io.error.write(`${message}\n`);
}

async function pathExists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function inspectCodexAuthFile(filePath) {
  let fileStatus;
  try {
    fileStatus = await stat(filePath);
  } catch (error) {
    return {
      issue: error?.code === 'EACCES' || error?.code === 'EPERM' ? 'permission' : 'missing',
      usable: false,
    };
  }
  if (!fileStatus.isFile()) return { issue: 'invalid', usable: false };

  let content;
  try {
    content = await readFile(filePath, 'utf8');
  } catch (error) {
    return {
      issue: error?.code === 'EACCES' || error?.code === 'EPERM' ? 'permission' : 'unreadable',
      usable: false,
    };
  }

  try {
    const auth = JSON.parse(content);
    if (!auth || typeof auth !== 'object' || Array.isArray(auth) || Object.keys(auth).length === 0) {
      return { issue: 'invalid', usable: false };
    }
    return { auth, content, issue: null, usable: true };
  } catch {
    return { issue: 'invalid', usable: false };
  }
}

async function usableJsonObjectFile(filePath) {
  return (await inspectCodexAuthFile(filePath)).usable;
}

async function usableClaudeLogin(home) {
  return (
    await Promise.all(['.credentials.json', 'credentials.json'].map((name) => usableJsonObjectFile(join(home, name))))
  ).some(Boolean);
}

async function managedProviderState(filePath) {
  try {
    const file = await stat(filePath);
    if (!file.isFile() || file.size > 1024 * 1024) return { credentials: {}, disabledEnvironmentProviders: [] };
    const payload = JSON.parse(await readFile(filePath, 'utf8'));
    const credentials = payload?.credentials;
    const normalizedCredentials = {};
    if (credentials && typeof credentials === 'object' && !Array.isArray(credentials)) {
      for (const provider of Object.keys(MANAGED_PROVIDER_LABELS)) {
        if (typeof credentials[provider] === 'string' && credentials[provider].trim()) {
          normalizedCredentials[provider] = credentials[provider].trim();
        }
      }
    }
    const disabledEnvironmentProviders = Array.isArray(payload?.disabledEnvironmentProviders)
      ? [...new Set(payload.disabledEnvironmentProviders.filter((provider) => provider in MANAGED_PROVIDER_LABELS))]
      : [];
    return { credentials: normalizedCredentials, disabledEnvironmentProviders };
  } catch {
    return { credentials: {}, disabledEnvironmentProviders: [] };
  }
}

async function writeManagedProviderState(filePath, state) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFileAtomically(filePath, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`);
}

export async function saveManagedProviderCredential(filePath, provider, credential) {
  if (!(provider in MANAGED_PROVIDER_LABELS) || typeof credential !== 'string' || !credential.trim()) {
    throw new Error('Enter a supported provider credential.');
  }
  const state = await managedProviderState(filePath);
  state.credentials[provider] = credential.trim();
  state.disabledEnvironmentProviders = state.disabledEnvironmentProviders.filter((candidate) => candidate !== provider);
  await writeManagedProviderState(filePath, state);
}

export async function disableManagedProviderCredential(filePath, provider) {
  if (!(provider in MANAGED_PROVIDER_LABELS)) return false;
  const state = await managedProviderState(filePath);
  const existed = Object.hasOwn(state.credentials, provider);
  delete state.credentials[provider];
  if (!state.disabledEnvironmentProviders.includes(provider)) state.disabledEnvironmentProviders.push(provider);
  await writeManagedProviderState(filePath, state);
  return existed;
}

function successfulAuthResult(message = 'Codex login saved for open-kritt.') {
  return { code: 'ok', message, ok: true };
}

function failedAuthResult(code, message) {
  return { code, message, ok: false };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function nearestExistingDirectory(filePath) {
  let candidate = resolve(filePath);
  while (true) {
    try {
      const candidateStatus = await stat(candidate);
      if (candidateStatus.isDirectory()) return candidate;
    } catch {
      // Continue toward a parent that the current user can inspect.
    }
    const parent = dirname(candidate);
    if (parent === candidate) return null;
    candidate = parent;
  }
}

async function codexHomePermissionMessage(codexHome, rootDir) {
  const quotedHome = shellQuote(codexHome);
  const quotedAuth = shellQuote(join(codexHome, 'auth.json'));
  const prefix =
    `The Codex login directory is not writable by your user: ${codexHome}. ` +
    'This is usually left by an older Docker login or by running open-kritt with sudo. ';

  try {
    if ((await stat(codexHome)).isDirectory()) {
      return (
        prefix +
        `Repair it with: sudo chown -R "$(id -u):$(id -g)" ${quotedHome} && chmod 700 ${quotedHome} ` +
        `&& { [ ! -e ${quotedAuth} ] || chmod 600 ${quotedAuth}; }`
      );
    }
  } catch {
    // The configured directory is absent or cannot be inspected through its parent.
  }

  const existingParent = await nearestExistingDirectory(dirname(codexHome));
  if (existingParent && rootDir && isWithinProject(rootDir, existingParent)) {
    const quotedParent = shellQuote(existingParent);
    return (
      prefix +
      `The directory does not exist yet. Run this command to repair only its nearest existing project parent, ` +
      `then run ./kritt setup again: sudo chown "$(id -u):$(id -g)" ${quotedParent} && chmod u+rwx ${quotedParent}`
    );
  }

  return (
    prefix +
    'The directory does not exist yet. Ask its owner or an administrator to make its nearest existing parent ' +
    'traversable and writable by your user, then run ./kritt setup again.'
  );
}

function authInspectionFailure(filePath, inspection, sourceLabel = 'Codex login') {
  if (inspection.issue === 'missing') {
    return failedAuthResult('missing', `No auth.json was found at ${filePath}.`);
  }
  if (inspection.issue === 'permission') {
    return failedAuthResult(
      'permission',
      `${sourceLabel} is not readable by your user: ${filePath}. Check its ownership and set its mode to 600.`
    );
  }
  if (inspection.issue === 'invalid') {
    return failedAuthResult('invalid', `The auth.json at ${filePath} is empty or invalid. Sign in to Codex again.`);
  }
  return failedAuthResult('unreadable', `Could not read auth.json at ${filePath}. Check the file and try again.`);
}

function decodeEnvValue(rawValue) {
  const value = rawValue.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/\\'/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  }
  return value;
}

export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (match) values[match[1]] = decodeEnvValue(match[2]);
  }
  return values;
}

function encodeEnvValue(value) {
  if (!value) return '';
  if (value.includes('\n') || value.includes('\r')) {
    throw new Error('Environment values must be a single line.');
  }
  return `'${value.replace(/'/g, "\\'")}'`;
}

export function updateEnvText(text, key, value) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = text.endsWith('\n');
  const lines = text.split(/\r?\n/);
  if (hasTrailingNewline) lines.pop();

  const assignment = `${key}=${encodeEnvValue(value)}`;
  const keyPattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
  let replaced = false;
  const updated = [];

  for (const line of lines) {
    if (!keyPattern.test(line)) {
      updated.push(line);
      continue;
    }
    if (!replaced) updated.push(assignment);
    replaced = true;
  }

  if (!replaced) updated.push(assignment);
  return `${updated.join(newline)}${hasTrailingNewline ? newline : ''}`;
}

async function writeFileAtomically(filePath, content) {
  const tempPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(tempPath, content, { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, filePath);
  await chmod(filePath, 0o600);
}

export async function ensureEnvFile({ envFile, templateFile }) {
  if (await pathExists(envFile)) return false;
  await mkdir(dirname(envFile), { recursive: true });
  await copyFile(templateFile, envFile);
  await chmod(envFile, 0o600);
  return true;
}

export async function setEnvValue(envFile, key, value) {
  const text = await readFile(envFile, 'utf8');
  await writeFileAtomically(envFile, updateEnvText(text, key, value));
}

function runtimeEnvValue(text, key) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^export\s+/, '');
    if (line.startsWith(`${key}=`)) return decodeEnvValue(line.slice(key.length + 1));
  }
  return '';
}

function splitConfiguredHomes(value) {
  const text = String(value || '').trim();
  if (!text) return [];
  return text
    .split(text.includes(',') ? ',' : ':')
    .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

export async function updateRuntimeCodexHome(runtimeConfigPath, home, present, initialHomes = []) {
  let text = '';
  try {
    text = await readFile(runtimeConfigPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    if (initialHomes.length) text = `ENGINE_CODEX_HOME=${initialHomes.join(',')}\n`;
  }
  const homes = splitConfiguredHomes(runtimeEnvValue(text, 'ENGINE_CODEX_HOME'));
  const nextHomes = present
    ? homes.includes(home)
      ? homes
      : [...homes, home]
    : homes.filter((candidate) => candidate !== home);
  if (nextHomes.length === homes.length && nextHomes.every((candidate, index) => candidate === homes[index])) {
    return false;
  }
  const line = `ENGINE_CODEX_HOME=${nextHomes.join(',')}`;
  const pattern = /^\s*(?:export\s+)?ENGINE_CODEX_HOME=.*$/m;
  const updated = pattern.test(text)
    ? text.replace(pattern, line)
    : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`;
  await mkdir(dirname(runtimeConfigPath), { recursive: true, mode: 0o700 });
  await writeFileAtomically(runtimeConfigPath, updated);
  return true;
}

async function readRuntimeCodexHomes(runtimeConfigPath) {
  try {
    const text = await readFile(runtimeConfigPath, 'utf8');
    return { exists: true, homes: splitConfiguredHomes(runtimeEnvValue(text, 'ENGINE_CODEX_HOME')) };
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, homes: [] };
    throw error;
  }
}

export function resolveProjectPath(rootDir, configuredPath, homeDir = homedir()) {
  const rawPath = (configuredPath || './.data/codex').trim();
  const expandedPath = rawPath === '~' || rawPath.startsWith('~/') ? join(homeDir, rawPath.slice(2)) : rawPath;
  return isAbsolute(expandedPath) ? resolve(expandedPath) : resolve(rootDir, expandedPath);
}

function configuredCodexHomes(rootDir, values, homeDir) {
  const primary = resolveProjectPath(rootDir, values.ENGINE_CODEX_HOME_HOST, homeDir);
  const accountsRoot = resolveProjectPath(
    rootDir,
    values.ENGINE_CODEX_ACCOUNTS_HOST || './.data/codex-accounts',
    homeDir
  );
  const sourceRoot = resolveProjectPath(
    rootDir,
    values.ENGINE_CODEX_HOME_SOURCE_HOST || './.data/codex-home-source',
    homeDir
  );
  const homes = [primary];
  const rawHomes = (values.ENGINE_CODEX_HOME || '/root/.codex')
    .split(values.ENGINE_CODEX_HOME?.includes(';') ? ';' : ',')
    .map((value) => value.trim())
    .filter(Boolean);

  for (const configured of rawHomes) {
    let hostPath = null;
    if (configured === '/root/.codex') hostPath = primary;
    else if (configured === '/codex-accounts') hostPath = accountsRoot;
    else if (configured.startsWith('/codex-accounts/')) {
      hostPath = resolve(accountsRoot, configured.slice('/codex-accounts/'.length));
    } else if (configured === '/codex-home-source') hostPath = sourceRoot;
    else if (configured.startsWith('/codex-home-source/')) {
      hostPath = resolve(sourceRoot, configured.slice('/codex-home-source/'.length));
    }
    if (hostPath && !homes.includes(hostPath)) homes.push(hostPath);
  }
  return homes;
}

export function resolveHomePath(configuredPath, homeDir = homedir()) {
  const rawPath = configuredPath.trim();
  if (rawPath === '~' || rawPath.startsWith('~/')) return resolve(join(homeDir, rawPath.slice(2)));
  return resolve(rawPath);
}

export function isWithinProject(rootDir, targetPath) {
  const distance = relative(resolve(rootDir), resolve(targetPath));
  return distance === '' || (!distance.startsWith('..') && !isAbsolute(distance));
}

export async function getSetupStatus({ rootDir, envFile = join(rootDir, '.env'), homeDir = homedir() }) {
  const envExists = await pathExists(envFile);
  const envText = envExists ? await readFile(envFile, 'utf8') : '';
  const values = parseEnv(envText);
  const codexPrimaryHome = resolveProjectPath(rootDir, values.ENGINE_CODEX_HOME_HOST, homeDir);
  const codexAccountsRoot = resolveProjectPath(
    rootDir,
    values.ENGINE_CODEX_ACCOUNTS_HOST || './.data/codex-accounts',
    homeDir
  );
  const codexHome = join(codexAccountsRoot, 'cli', '.codex');
  const engineDataDirectory = resolveProjectPath(rootDir, values.ENGINE_DATA_DIR_HOST || './.data/engine', homeDir);
  const runtimeConfigPath = join(
    engineDataDirectory,
    basename(values.ENGINE_RUNTIME_CONFIG_PATH || 'engine-runtime.env')
  );
  const runtimeRegistry = await readRuntimeCodexHomes(runtimeConfigPath);
  const configuredValues = runtimeRegistry.exists
    ? { ...values, ENGINE_CODEX_HOME: runtimeRegistry.homes.join(',') }
    : values;
  const codexHomes = configuredCodexHomes(rootDir, configuredValues, homeDir);
  if (!codexHomes.includes(codexHome)) codexHomes.push(codexHome);
  const runtimeCodexHomes = runtimeRegistry.exists
    ? runtimeRegistry.homes
    : splitConfiguredHomes(values.ENGINE_CODEX_HOME || '/root/.codex');
  const claudeHome = resolveProjectPath(rootDir, values.ENGINE_CLAUDE_HOME || './.data/claude', homeDir);
  const credentialsDirectory = resolveProjectPath(
    rootDir,
    values.ENGINE_CREDENTIALS_HOST || './.data/engine/credentials',
    homeDir
  );
  const credentialsPath = join(credentialsDirectory, 'providers.json');
  const managedState = await managedProviderState(credentialsPath);
  const disabledProviders = managedState.disabledEnvironmentProviders;
  const valuesPresent = Object.fromEntries(
    ENVIRONMENT_ITEMS.map(({ key }) => [
      key,
      Boolean(values[key]) && !(key === 'OPENROUTER_API_KEY' && disabledProviders.includes('openrouter')),
    ])
  );
  const codexAuthInspections = await Promise.all(
    codexHomes.map((home) => inspectCodexAuthFile(join(home, 'auth.json')))
  );
  const primaryCodexLoginPresent = codexAuthInspections[0]?.usable || false;
  const codexLoginPresent = codexAuthInspections.some((inspection) => inspection.usable);
  const codexLoginIssue = codexLoginPresent
    ? null
    : codexAuthInspections.find((inspection) => inspection.issue !== 'missing')?.issue || null;
  const claudeLoginPresent = await usableClaudeLogin(claudeHome);
  const managedProviders = Object.keys(managedState.credentials);
  const providerPresent =
    PROVIDER_KEYS.some((key) => valuesPresent[key]) ||
    codexLoginPresent ||
    claudeLoginPresent ||
    managedProviders.length > 0;

  return {
    codexHome,
    codexPrimaryHome,
    codexAccountsRoot,
    codexRuntimeHome: '/codex-accounts/cli/.codex',
    codexHomes,
    codexLoginIssue,
    codexLoginPresent,
    primaryCodexLoginPresent,
    claudeHome,
    claudeLoginPresent,
    credentialsPath,
    runtimeConfigPath,
    runtimeCodexHomes,
    runtimeRegistryExists: runtimeRegistry.exists,
    disabledProviders,
    envExists,
    managedProviders,
    providerPresent,
    values,
    valuesPresent,
  };
}

// Keep the legacy non-secret marker aligned for older Compose consumers. Login
// availability is determined from the managed credential files, never this marker.
export async function syncCodexLoginStatus({
  rootDir = process.cwd(),
  envFile = join(rootDir, '.env'),
  homeDir = homedir(),
} = {}) {
  let status = await getSetupStatus({ rootDir, envFile, homeDir });
  if (!status.envExists) return status;

  if (status.primaryCodexLoginPresent) {
    let targetHome = status.codexHome;
    if (await usableJsonObjectFile(join(targetHome, 'auth.json'))) {
      let suffix = 1;
      do {
        targetHome = join(
          status.codexAccountsRoot,
          suffix === 1 ? 'bootstrap-primary' : `bootstrap-primary-${suffix}`,
          '.codex'
        );
        suffix += 1;
      } while (await usableJsonObjectFile(join(targetHome, 'auth.json')));
    }
    await mkdir(targetHome, { recursive: true, mode: 0o700 });
    await copyFile(join(status.codexPrimaryHome, 'auth.json'), join(targetHome, 'auth.json'));
    await chmod(join(targetHome, 'auth.json'), 0o600);
    await rm(join(status.codexPrimaryHome, 'auth.json'), { force: true });
    await updateRuntimeCodexHome(status.runtimeConfigPath, '/root/.codex', false, status.runtimeCodexHomes);
    const relativeHome = relative(status.codexAccountsRoot, targetHome).split('\\').join('/');
    await updateRuntimeCodexHome(
      status.runtimeConfigPath,
      `/codex-accounts/${relativeHome}`,
      true,
      status.runtimeCodexHomes
    );
    status = await getSetupStatus({ rootDir, envFile, homeDir });
  } else if (
    status.runtimeRegistryExists &&
    status.codexLoginIssue !== 'permission' &&
    status.runtimeCodexHomes.includes('/root/.codex')
  ) {
    await updateRuntimeCodexHome(status.runtimeConfigPath, '/root/.codex', false, status.runtimeCodexHomes);
    status = await getSetupStatus({ rootDir, envFile, homeDir });
  }

  await updateRuntimeCodexHome(
    status.runtimeConfigPath,
    status.codexRuntimeHome,
    await usableJsonObjectFile(join(status.codexHome, 'auth.json')),
    status.runtimeCodexHomes
  );

  status = await getSetupStatus({ rootDir, envFile, homeDir });
  const expectedHomes = status.runtimeCodexHomes.join(',');
  let envChanged = false;
  if ((status.values.ENGINE_CODEX_HOME || '') !== expectedHomes) {
    await setEnvValue(envFile, 'ENGINE_CODEX_HOME', expectedHomes);
    envChanged = true;
  }
  const expectedValue = status.codexLoginPresent ? '1' : '';
  if ((status.values[CODEX_LOGIN_STATUS_KEY] || '') !== expectedValue) {
    await setEnvValue(envFile, CODEX_LOGIN_STATUS_KEY, expectedValue);
    envChanged = true;
  }
  return envChanged ? getSetupStatus({ rootDir, envFile, homeDir }) : status;
}

function renderStatus(status, io) {
  write(io, '\nCredential status');
  const codexStatus = status.codexLoginPresent
    ? '✓ Codex login present (recommended)'
    : status.codexLoginIssue === 'permission'
      ? '! Codex login unreadable (fix file ownership)'
      : status.codexLoginIssue
        ? '! Codex login invalid (sign in again)'
        : '○ Codex login not set (recommended)';
  write(io, codexStatus);
  write(
    io,
    `${status.claudeLoginPresent ? '✓' : '○'} Claude login ${status.claudeLoginPresent ? 'present' : 'not set'}`
  );
  for (const item of ENVIRONMENT_ITEMS.slice(0, 4)) {
    const present = status.valuesPresent[item.key];
    write(io, `${present ? '✓' : '○'} ${item.label} ${present ? 'present' : 'not set'}`);
  }
  for (const provider of status.managedProviders) {
    write(io, `✓ ${MANAGED_PROVIDER_LABELS[provider]} present (managed from Accounts)`);
  }
  const githubPresent = status.valuesPresent.GITHUB_TOKEN;
  write(io, `${githubPresent ? '✓' : '○'} GitHub token ${githubPresent ? 'present' : 'not set'}`);
  write(io, `Codex login location: ${status.codexHome}`);
  write(
    io,
    status.providerPresent
      ? 'Model access is configured. Model and harness compatibility is selected when creating a scan.'
      : 'Model access is not configured. Choose a provider key, Codex login, or Claude login before starting the stack.'
  );
}

async function askLine(question, io) {
  const readline = createInterface({ input: io.input, output: io.output });
  try {
    return (await readline.question(question)).trim();
  } finally {
    readline.close();
  }
}

async function askSecret(question, io) {
  if (!io.input.isTTY || typeof io.input.setRawMode !== 'function') {
    throw new Error('Secret entry requires an interactive terminal.');
  }

  io.output.write(question);
  io.input.resume();
  io.input.setRawMode(true);

  return new Promise((resolveSecret, rejectSecret) => {
    let value = '';
    const finish = (result, error) => {
      io.input.off('data', onData);
      io.input.setRawMode(false);
      io.output.write('\n');
      if (error) rejectSecret(error);
      else resolveSecret(result);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\u0003') {
          finish('', new UserCancelledError());
          return;
        }
        if (character === '\r' || character === '\n') {
          finish(value);
          return;
        }
        if (character === '\b' || character === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        if (character >= ' ') value += character;
      }
    };
    io.input.on('data', onData);
  });
}

function createPrompter(io) {
  return {
    ask: (question) => askLine(question, io),
    secret: (question) => askSecret(question, io),
    async confirm(question) {
      const answer = await askLine(`${question} [y/N] `, io);
      return /^(y|yes)$/i.test(answer);
    },
  };
}

export async function runCommand(command, args, options = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: options.stdio || 'inherit' });
    const abortSignal = options.signal;
    const removeAbortListener = () => abortSignal?.removeEventListener('abort', onAbort);
    const onAbort = () => {
      const requestedSignal = abortSignal.reason?.signal;
      child.kill(requestedSignal === 'SIGINT' || requestedSignal === 'SIGTERM' ? requestedSignal : 'SIGTERM');
    };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted) onAbort();
    child.once('error', (error) => {
      removeAbortListener();
      rejectCommand(new CommandError(command, error));
    });
    child.once('close', (code, signal) => {
      removeAbortListener();
      resolveCommand({ code: code ?? 1, signal });
    });
  });
}

function itemInfo(item) {
  return `${item.label}: ${item.info}`;
}

async function manageEnvironmentItem(context, item) {
  const { envFile, io, prompter } = context;
  write(io, `\n${item.label}`);
  write(io, '1) Set or replace');
  write(io, '2) Unset');
  write(io, '3) What is this?');
  write(io, '4) Back');
  const action = await prompter.ask('Choose an action: ');

  if (action === '1') {
    const value = await prompter.secret(`Enter ${item.label} (input is hidden): `);
    if (!value) {
      write(io, 'Nothing changed.');
      return;
    }
    if (item.key === 'OPENROUTER_API_KEY') {
      const status = await getSetupStatus(context);
      await saveManagedProviderCredential(status.credentialsPath, 'openrouter', value);
    }
    await setEnvValue(envFile, item.key, value);
    write(io, `${item.label} saved.`);
  } else if (action === '2') {
    if (await prompter.confirm(`Unset ${item.label}?`)) {
      if (item.key === 'OPENROUTER_API_KEY') {
        const status = await getSetupStatus(context);
        await disableManagedProviderCredential(status.credentialsPath, 'openrouter');
      }
      await setEnvValue(envFile, item.key, '');
      write(io, `${item.label} unset.`);
    }
  } else if (action === '3') {
    write(io, itemInfo(item));
  } else if (action !== '4') {
    write(io, 'Choose a listed action.');
  }
}

async function confirmExternalDestination(context, targetPath) {
  if (isWithinProject(context.rootDir, targetPath)) return true;
  write(context.io, `The configured Codex login directory is outside this project: ${targetPath}`);
  return context.prompter.confirm('Save credentials there?');
}

async function ensureCodexHomeDirectory(codexHome, rootDir) {
  try {
    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const directoryStatus = await stat(codexHome);
    if (!directoryStatus.isDirectory()) {
      return failedAuthResult(
        'destination_invalid',
        `The configured Codex login path is not a directory: ${codexHome}`
      );
    }
    await chmod(codexHome, 0o700);
    await access(codexHome, constants.R_OK | constants.W_OK | constants.X_OK);
    return successfulAuthResult();
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return failedAuthResult('destination_permission', await codexHomePermissionMessage(codexHome, rootDir));
    }
    return failedAuthResult('destination_unavailable', `Could not prepare the Codex login directory: ${codexHome}`);
  }
}

async function installCodexAuth({ rootDir, sourcePath, targetPath }) {
  const sourceInspection = await inspectCodexAuthFile(sourcePath);
  if (!sourceInspection.usable) return authInspectionFailure(sourcePath, sourceInspection, 'The source Codex login');

  const codexHome = dirname(targetPath);
  const directoryResult = await ensureCodexHomeDirectory(codexHome, rootDir);
  if (!directoryResult.ok) return directoryResult;

  if (resolve(sourcePath) === resolve(targetPath)) {
    try {
      await chmod(targetPath, 0o600);
      return successfulAuthResult('That Codex login is already in the configured project location.');
    } catch (error) {
      if (error?.code === 'EACCES' || error?.code === 'EPERM') {
        return failedAuthResult('destination_permission', await codexHomePermissionMessage(codexHome, rootDir));
      }
      return failedAuthResult('destination_unavailable', `Could not secure the Codex login at ${targetPath}.`);
    }
  }

  const tempPath = join(codexHome, `.auth.json.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(tempPath, sourceInspection.content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, targetPath);
    await chmod(targetPath, 0o600);
  } catch (error) {
    if (error?.code === 'EACCES' || error?.code === 'EPERM') {
      return failedAuthResult('destination_permission', await codexHomePermissionMessage(codexHome, rootDir));
    }
    return failedAuthResult('destination_unavailable', `Could not save the Codex login at ${targetPath}.`);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }

  const installedInspection = await inspectCodexAuthFile(targetPath);
  if (!installedInspection.usable) {
    return authInspectionFailure(targetPath, installedInspection, 'The saved Codex login');
  }
  return successfulAuthResult();
}

export async function importCodexAuth({ rootDir, sourcePath, targetPath, io }) {
  const result = await installCodexAuth({ rootDir, sourcePath, targetPath });
  if (result.ok) write(io, result.message);
  else writeError(io, result.message);
  return result;
}

export async function removeClaudeAuth(home) {
  await Promise.all(['.credentials.json', 'credentials.json'].map((name) => rm(join(home, name), { force: true })));
}

export async function removeCodexAuth(targetPath, rootDir) {
  try {
    await rm(targetPath, { force: true });
    return successfulAuthResult('Saved Codex login removed.');
  } catch (error) {
    const result =
      error?.code === 'EACCES' || error?.code === 'EPERM'
        ? failedAuthResult('destination_permission', await codexHomePermissionMessage(dirname(targetPath), rootDir))
        : failedAuthResult('remove_failed', `Could not remove the saved Codex login at ${targetPath}.`);
    return result;
  }
}

async function removeLoginContainer(runner, rootDir, containerName, io) {
  let result;
  try {
    result = await runner('docker', ['rm', '--force', containerName], { cwd: rootDir, stdio: 'ignore' });
  } catch {
    result = null;
  }
  if (!result || result.code !== 0) {
    writeError(
      io,
      `Could not confirm cleanup of the temporary Codex login container. If it exists, remove it with: docker rm --force ${containerName}`
    );
  }
}

export async function saveDockerCodexLogin({ io, rootDir, runner = runCommand, signalSource = process, targetPath }) {
  const directoryResult = await ensureCodexHomeDirectory(dirname(targetPath), rootDir);
  if (!directoryResult.ok) {
    writeError(io, directoryResult.message);
    return directoryResult;
  }

  let stagingDirectory;
  try {
    stagingDirectory = await mkdtemp(join(tmpdir(), 'open-kritt-codex-login-'));
    await chmod(stagingDirectory, 0o700);
  } catch {
    const result = failedAuthResult(
      'staging_failed',
      'Could not create a private temporary directory for Codex login.'
    );
    writeError(io, result.message);
    return result;
  }

  const stagedAuthPath = join(stagingDirectory, 'auth.json');
  const containerName = `open-kritt-codex-login-${process.pid}-${randomUUID()}`;
  const abortController = new AbortController();
  let interruptedSignal = null;
  const interrupt = (signal) => {
    if (interruptedSignal) return;
    interruptedSignal = signal;
    abortController.abort({ signal });
  };
  const onSigint = () => interrupt('SIGINT');
  const onSigterm = () => interrupt('SIGTERM');
  signalSource.on('SIGINT', onSigint);
  signalSource.on('SIGTERM', onSigterm);
  const throwIfInterrupted = () => {
    if (interruptedSignal) throw new UserCancelledError(interruptedSignal);
  };

  write(io, 'Opening Codex device login in a temporary engine container. Follow the URL and one-time code it prints.');
  let result;
  try {
    const loginResult = await runner(
      'docker',
      [
        'compose',
        'run',
        '--name',
        containerName,
        '--no-deps',
        '--build',
        '--env',
        `HOME=${CODEX_LOGIN_CONTAINER_USER_HOME}`,
        '--env',
        `CODEX_HOME=${CODEX_LOGIN_CONTAINER_HOME}`,
        '--entrypoint',
        'sh',
        'engine',
        '-c',
        CODEX_LOGIN_CONTAINER_BOOTSTRAP,
        'codex',
        'login',
        '-c',
        'cli_auth_credentials_store="file"',
        '--device-auth',
      ],
      { cwd: rootDir, signal: abortController.signal, stdio: 'inherit' }
    );
    throwIfInterrupted();
    if (loginResult.code !== 0) {
      result = failedAuthResult('login_failed', `Codex login exited with status ${loginResult.code}.`);
      writeError(io, result.message);
    } else {
      const copyResult = await runner(
        'docker',
        ['cp', `${containerName}:${CODEX_LOGIN_CONTAINER_HOME}/auth.json`, stagedAuthPath],
        { cwd: rootDir, signal: abortController.signal, stdio: 'inherit' }
      );
      throwIfInterrupted();
      if (copyResult.code !== 0) {
        result = failedAuthResult(
          'copy_failed',
          'Codex authentication succeeded, but Docker could not copy auth.json back to the host.'
        );
        writeError(io, result.message);
      } else {
        result = await installCodexAuth({ rootDir, sourcePath: stagedAuthPath, targetPath });
        throwIfInterrupted();
        if (result.ok) write(io, 'Codex login saved for open-kritt.');
        else writeError(io, result.message);
      }
    }
  } catch (error) {
    if (error instanceof UserCancelledError || interruptedSignal) {
      throw error instanceof UserCancelledError ? error : new UserCancelledError(interruptedSignal);
    }
    result = failedAuthResult('docker_failed', `${error.message}. Install and start Docker, then try again.`);
    writeError(io, result.message);
  } finally {
    await removeLoginContainer(runner, rootDir, containerName, io);
    await rm(stagingDirectory, { recursive: true, force: true }).catch(() => {});
    signalSource.off('SIGINT', onSigint);
    signalSource.off('SIGTERM', onSigterm);
  }
  throwIfInterrupted();
  return result;
}

export async function saveDockerClaudeLogin({ io, rootDir, runner = runCommand, home }) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  write(
    io,
    'Opening Claude login in a temporary engine container. Complete the browser flow and paste the callback code when prompted.'
  );
  try {
    const result = await runner(
      'docker',
      [
        'compose',
        'run',
        '--rm',
        '--no-deps',
        '--build',
        '--entrypoint',
        'claude',
        'engine',
        'auth',
        'login',
        '--claudeai',
      ],
      { cwd: rootDir, stdio: 'inherit' }
    );
    if (result.code !== 0) {
      writeError(io, `Claude login exited with status ${result.code}.`);
      return false;
    }
  } catch (error) {
    writeError(io, `${error.message}. Install and start Docker Desktop, then try again.`);
    return false;
  }

  if (await usableClaudeLogin(home)) write(io, 'Claude login saved for open-kritt.');
  else writeError(io, `Claude login finished, but no usable credentials were found in ${home}.`);
  return usableClaudeLogin(home);
}

async function runDockerCodexLogin(context, targetPath, runtimeHome) {
  if (!(await confirmExternalDestination(context, dirname(targetPath)))) return false;
  return saveDockerCodexLogin({
    io: context.io,
    rootDir: context.rootDir,
    runner: context.runner,
    targetPath,
    runtimeHome,
  });
}

async function manageCodexLogin(context) {
  const { homeDir, io, prompter } = context;
  const status = await syncCodexLoginStatus(context);
  const targetPath = join(status.codexHome, 'auth.json');
  const defaultSource = join(homeDir, '.codex', 'auth.json');

  write(io, '\nCodex login');
  write(io, '1) Sign in with Docker (recommended)');
  write(io, '2) Import an existing local Codex login');
  write(io, '3) Remove the saved project login');
  write(io, '4) What is this?');
  write(io, '5) Back');
  const action = await prompter.ask('Choose an action: ');

  if (action === '1') {
    await runDockerCodexLogin(context, targetPath, status.codexRuntimeHome);
    await syncCodexLoginStatus(context);
  } else if (action === '2') {
    const sourceInput = await prompter.ask(`auth.json path [${defaultSource}]: `);
    if (!(await confirmExternalDestination(context, dirname(targetPath)))) return;
    const imported = await importCodexAuth({
      rootDir: context.rootDir,
      sourcePath: resolveHomePath(sourceInput || defaultSource, homeDir),
      targetPath,
      io,
    });
    if (imported.ok) await syncCodexLoginStatus(context);
  } else if (action === '3') {
    if (await prompter.confirm('Remove the saved Codex login for this project?')) {
      const result = await removeCodexAuth(targetPath, context.rootDir);
      if (result.ok) {
        await syncCodexLoginStatus(context);
        write(io, result.message);
      }
      else writeError(io, result.message);
    }
  } else if (action === '4') {
    write(io, itemInfo(CODEX_LOGIN));
  } else if (action !== '5') {
    write(io, 'Choose a listed action.');
  }
}

async function manageClaudeLogin(context) {
  const { io, prompter } = context;
  const status = await getSetupStatus(context);
  write(io, '\nClaude login');
  write(io, '1) Sign in with Docker');
  write(io, '2) Remove the saved login');
  write(io, '3) What is this?');
  write(io, '4) Back');
  const action = await prompter.ask('Choose an action: ');

  if (action === '1') {
    await saveDockerClaudeLogin({
      io,
      rootDir: context.rootDir,
      runner: context.runner,
      home: status.claudeHome,
    });
  } else if (action === '2') {
    if (await prompter.confirm('Remove the saved Claude login for this project?')) {
      await removeClaudeAuth(status.claudeHome);
      write(io, 'Saved Claude login removed.');
    }
  } else if (action === '3') {
    write(io, itemInfo(CLAUDE_LOGIN));
  } else if (action !== '4') {
    write(io, 'Choose a listed action.');
  }
}

function setupContext(options = {}) {
  const rootDir = options.rootDir || process.cwd();
  const io = options.io || defaultIo();
  return {
    rootDir,
    envFile: options.envFile || join(rootDir, '.env'),
    templateFile: options.templateFile || join(rootDir, '.env.example'),
    homeDir: options.homeDir || homedir(),
    io,
    prompter: options.prompter || createPrompter(io),
    runner: options.runner || runCommand,
  };
}

export async function runSetup(options = {}) {
  const context = setupContext(options);
  const created = await ensureEnvFile(context);
  if (created) write(context.io, 'Created .env from .env.example.');

  while (true) {
    const status = await getSetupStatus(context);
    renderStatus(status, context.io);
    write(context.io, '\n1) Codex login (recommended)');
    write(context.io, '2) Claude login');
    write(context.io, '3) Codex API key');
    write(context.io, '4) OpenAI API key');
    write(context.io, '5) Anthropic API key');
    write(context.io, '6) OpenRouter API key');
    write(context.io, '7) GitHub token');
    write(context.io, '8) Finish setup');
    const choice = (await context.prompter.ask('Choose an item: ')).toLowerCase();

    if (choice === '8' || choice === 'q' || choice === 'quit') break;
    if (choice === '1') {
      await manageCodexLogin(context);
      continue;
    }
    if (choice === '2') {
      await manageClaudeLogin(context);
      continue;
    }
    const item = ENVIRONMENT_ITEMS[Number(choice) - 3] || (choice === '7' ? ENVIRONMENT_ITEMS[4] : null);
    if (!item) {
      write(context.io, 'Choose a listed item.');
      continue;
    }
    await manageEnvironmentItem(context, item);
  }

  const status = await syncCodexLoginStatus(context);
  if (status.providerPresent) write(context.io, 'Setup complete. Run ./kritt start when you are ready.');
  else write(context.io, 'Setup saved. Add one provider key or a Codex or Claude login before running ./kritt start.');
  return 0;
}

export async function runStart(options = {}) {
  const context = setupContext(options);
  if (!(await pathExists(context.envFile))) {
    writeError(context.io, 'No .env file found. Run ./kritt setup first.');
    return 1;
  }

  const status = await syncCodexLoginStatus(context);
  if (!status.providerPresent) {
    if (status.codexLoginIssue === 'permission') {
      writeError(context.io, await codexHomePermissionMessage(status.codexHome, context.rootDir));
      return 1;
    }
    if (status.codexLoginIssue) {
      writeError(context.io, `The saved Codex auth.json in ${status.codexHome} is invalid. Sign in to Codex again.`);
      return 1;
    }
    writeError(context.io, 'No model provider credential or Codex login is configured. Run ./kritt setup first.');
    return 1;
  }

  const directoryResult = await ensureCodexHomeDirectory(status.codexHome, context.rootDir);
  if (!directoryResult.ok) {
    writeError(context.io, directoryResult.message);
    return 1;
  }

  write(context.io, 'Starting open-kritt. Press Ctrl+C to stop the stack.');
  try {
    const result = await context.runner('docker', ['compose', 'up', '--build'], {
      cwd: context.rootDir,
      stdio: 'inherit',
    });
    return result.code;
  } catch (error) {
    writeError(context.io, `${error.message}. Install and start Docker, then try again.`);
    return 1;
  }
}

const HELP = {
  general: `open-kritt CLI

Usage:
  ./kritt setup              Configure model access and optional GitHub access
  ./kritt start              Start the Docker Compose stack
  ./kritt help [subcommand]  Show command help

Run ./kritt setup first. It creates .env when needed and never prints credential values.`,
  setup: `Usage: ./kritt setup

Creates .env from .env.example when it does not exist, shows credential status, and lets you set, unset, or learn about each credential.

Configure one model provider key or a saved Codex or Claude login. GITHUB_TOKEN is optional and only needed for private GitHub repositories.

The Codex and Claude login flows use temporary engine containers and persist their provider credentials in the same homes monitored by Accounts. OpenRouter keys are saved in .env and mirrored to the managed credential store used by running services.

The recommended Codex flow uses device authentication (no localhost callback) and saves auth.json with host-user ownership and private permissions.

Run ./kritt as your normal user, not with sudo. Use Import local login instead of copying auth.json by hand.`,
  start: `Usage: ./kritt start

Checks that .env and at least one model provider credential or Codex login are configured, then runs:

  docker compose up --build

The process stays attached to Compose; press Ctrl+C to stop the stack.`,
};

export function showHelp(command, io = defaultIo()) {
  const text = command ? HELP[command] : HELP.general;
  if (!text) {
    writeError(io, `Unknown help topic: ${command}`);
    write(io, HELP.general);
    return 1;
  }
  write(io, text);
  return 0;
}

export async function runCli(argv, options = {}) {
  const io = options.io || defaultIo();
  const [command = 'help', ...args] = argv;
  try {
    if (command === 'help' || command === '--help' || command === '-h') return showHelp(args[0], io);
    if (command === 'setup')
      return args.includes('--help') || args.includes('-h') ? showHelp('setup', io) : runSetup({ ...options, io });
    if (command === 'start')
      return args.includes('--help') || args.includes('-h') ? showHelp('start', io) : runStart({ ...options, io });
    writeError(io, `Unknown command: ${command}`);
    return showHelp(undefined, io) || 1;
  } catch (error) {
    if (error instanceof UserCancelledError) {
      writeError(io, 'Cancelled.');
      return error.exitCode;
    }
    writeError(io, error.message);
    return 1;
  }
}

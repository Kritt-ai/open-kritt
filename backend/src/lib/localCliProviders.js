import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

import { PROJECT_ENV_FILE_PATH, updateEnvironmentFile } from './environmentFile.js';

const WINDOWS_EXTENSIONS = ['', '.cmd', '.exe', '.bat', '.ps1'];
const PROVIDER_SETTINGS = {
  codex: {
    label: 'ChatGPT Codex',
    names: ['codex'],
    envKeys: ['OPEN_KRITT_CODEX_BIN', 'CODEX_BIN', 'CODEX_CLI_PATH'],
  },
  claude: {
    label: 'Claude Code',
    names: ['claude'],
    envKeys: ['OPEN_KRITT_CLAUDE_BIN', 'CLAUDE_BIN', 'CLAUDE_CLI_PATH'],
  },
};

function safeStat(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function isExecutableFile(path) {
  const stat = safeStat(path);
  return Boolean(stat?.isFile());
}

function splitPath(value) {
  return String(value || '')
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function npmGlobalBins(env = process.env) {
  const result = [];
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const bin = execFileSync(npm, ['bin', '-g'], { env, encoding: 'utf8', timeout: 3000 }).trim();
    if (bin) result.push(bin);
  } catch {
    // npm is optional; PATH and common install locations are still checked.
  }
  try {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const prefix = execFileSync(npm, ['prefix', '-g'], { env, encoding: 'utf8', timeout: 3000 }).trim();
    if (prefix) result.push(process.platform === 'win32' ? prefix : join(prefix, 'bin'));
  } catch {
    // npm is optional.
  }
  return result;
}

function commonCliDirs(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  const dirs = [
    ...splitPath(env.PATH || env.Path),
    ...npmGlobalBins(env),
    join(home, '.local', 'bin'),
    join(home, 'bin'),
  ];
  if (process.platform === 'win32') {
    dirs.push(
      join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'npm'),
      join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs'),
      join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs', 'OpenAI', 'Codex', 'bin'),
      join(env.ProgramFiles || 'C:\\Program Files', 'nodejs'),
      join(env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'nodejs'),
      join(env.SystemRoot || 'C:\\Windows', 'System32')
    );
  } else {
    dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/snap/bin');
    if (existsSync('/mnt/c/Users')) {
      const user = basename(home);
      dirs.push(
        `/mnt/c/Users/${user}/AppData/Roaming/npm`,
        `/mnt/c/Users/${user}/AppData/Local/Programs/OpenAI/Codex/bin`,
        '/mnt/c/Program Files/nodejs',
        '/mnt/c/Program Files (x86)/nodejs'
      );
    }
  }
  return [...new Set(dirs.map((dir) => resolve(dir)))];
}

function executableCandidates(name, dirs, env = process.env) {
  if (isAbsolute(name) || name.includes('/') || name.includes('\\')) return [name];
  const extensions = process.platform === 'win32' && !/\.[a-z0-9]+$/i.test(name) ? WINDOWS_EXTENSIONS : [''];
  return dirs.flatMap((dir) => extensions.map((extension) => join(dir, `${name}${extension}`)));
}

export function discoverCliExecutable(names, { env = process.env } = {}) {
  for (const key of ['OPEN_KRITT_CODEX_BIN', 'CODEX_BIN', 'CODEX_CLI_PATH', 'OPEN_KRITT_CLAUDE_BIN', 'CLAUDE_BIN', 'CLAUDE_CLI_PATH']) {
    const configured = String(env[key] || '').trim();
    if (configured && names.some((name) => basename(configured).toLowerCase().startsWith(name))) {
      const resolved = resolve(configured);
      if (existsSync(resolved) && isExecutableFile(resolved)) return { found: true, path: resolved, source: key };
    }
  }
  const dirs = commonCliDirs(env);
  for (const name of names) {
    for (const candidate of executableCandidates(name, dirs, env)) {
      if (existsSync(candidate) && isExecutableFile(candidate)) {
        return { found: true, path: resolve(candidate), source: dirs.includes(resolve(dirname(candidate))) ? 'discovered' : 'configured' };
      }
    }
  }
  return {
    found: false,
    path: null,
    source: null,
    searched: dirs,
    message: `${names[0][0].toUpperCase()}${names[0].slice(1)} CLI is not installed or not found in PATH.`,
  };
}

export function providerCliStatus(provider, options = {}) {
  const setting = PROVIDER_SETTINGS[provider];
  if (!setting) return null;
  const env = options.env || process.env;
  for (const key of setting.envKeys) {
    const configured = String(env[key] || '').trim();
    if (configured) {
      const resolved = resolve(configured);
      if (existsSync(resolved) && isExecutableFile(resolved)) {
        return { found: true, path: resolved, source: key, label: setting.label };
      }
      return {
        found: false,
        path: null,
        source: key,
        label: setting.label,
        message: `${setting.label} executable path is saved but does not exist: ${configured}`,
      };
    }
  }
  const discovered = discoverCliExecutable(setting.names, options);
  return { ...discovered, label: setting.label };
}

export function codexCliStatus(options = {}) {
  return providerCliStatus('codex', options);
}

export function claudeCliStatus(options = {}) {
  return providerCliStatus('claude', options);
}

export function providerCliEnv(provider, env = process.env) {
  const status = providerCliStatus(provider, { env });
  if (!status?.found) return { ...env };
  return {
    ...env,
    [provider === 'claude' ? 'OPEN_KRITT_CLAUDE_BIN' : 'OPEN_KRITT_CODEX_BIN']: status.path,
  };
}

export async function saveProviderCliExecutable(provider, executablePath, { environmentFilePath = PROJECT_ENV_FILE_PATH } = {}) {
  const setting = PROVIDER_SETTINGS[provider];
  if (!setting) throw Object.assign(new Error('Unknown local CLI provider.'), { statusCode: 404 });
  const resolved = resolve(String(executablePath || '').trim());
  if (!resolved || !existsSync(resolved) || !isExecutableFile(resolved)) {
    throw Object.assign(new Error(`${setting.label} executable was not found at that path.`), { statusCode: 422 });
  }
  const key = setting.envKeys[0];
  await updateEnvironmentFile({ [key]: resolved }, { environmentFilePath });
  process.env[key] = resolved;
  return providerCliStatus(provider);
}

export function cliRuntimeStatus(provider, authStatus, executableStatus) {
  const label = provider === 'claude' ? 'Claude Code' : 'Codex';
  const executableFound = Boolean(executableStatus?.found);
  const authenticated = Boolean(authStatus);
  const setupMessage = !executableFound
    ? `${label} CLI is not installed or not found in PATH. Install it, then refresh Providers.`
    : !authenticated
      ? `${label} CLI found but no authenticated session exists. Run ${provider === 'claude' ? '`claude`' : '`codex`'} and sign in.`
      : null;
  return {
    kind: 'local_cli',
    executableFound,
    executablePath: executableStatus?.path || null,
    authenticated,
    status: executableFound && authenticated ? 'connected' : executableFound ? 'login_required' : 'missing_executable',
    setupMessage,
  };
}

import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, chown, lstat, mkdir, mkdtemp, open, readFile, rename, rmdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE_CREDENTIAL_FILENAMES = ['.credentials.json', 'credentials.json'];
export const CLAUDE_ACCOUNT_PROFILE_FILENAME = '.open-kritt-account.json';
export const CLAUDE_AUTH_LOCK_NAME = '.open-kritt-auth.lock';

const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const CLAUDE_PROFILE_FILENAMES = ['.claude.json', 'claude.json'];
const LOCK_WAIT_MS = 30_000;
const STALE_LOCK_MS = 30 * 60 * 1000;
const CLAUDE_REFRESH_TIMEOUT_MS = 120_000;
const CLAUDE_REFRESH_ENVIRONMENT_OVERRIDES = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_MODEL_PROVIDER',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
];

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireClaudeCredentialLock(home) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lockPath = join(home, CLAUDE_AUTH_LOCK_NAME);
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      return async () => {
        try {
          await rmdir(lockPath);
        } catch {
          // A best-effort release is safe; stale empty locks are recovered below.
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      let lock;
      try {
        lock = await lstat(lockPath);
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
      if (lock.isSymbolicLink() || !lock.isDirectory()) {
        throw new Error('Claude credential lock is not a private directory.', { cause: error });
      }
      if (Date.now() - lock.mtimeMs > STALE_LOCK_MS) {
        try {
          await rmdir(lockPath);
          continue;
        } catch {
          // Another process either owns or already recovered it.
        }
      }
      if (Date.now() >= deadline) {
        throw new Error('Claude credentials are being updated. Try again shortly.', { cause: error });
      }
      await delay(50);
    }
  }
}

export async function withClaudeCredentialLock(home, operation) {
  const release = await acquireClaudeCredentialLock(home);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function readClaudeCredential(home) {
  for (const name of CLAUDE_CREDENTIAL_FILENAMES) {
    const path = join(home, name);
    try {
      const file = await lstat(path);
      if (file.isSymbolicLink() || !file.isFile() || file.size > MAX_CREDENTIAL_BYTES) continue;
      const content = await readFile(path);
      const payload = JSON.parse(content.toString('utf8'));
      const oauth = payload?.claudeAiOauth;
      const expiresAt = Number(oauth?.expiresAt);
      if (
        typeof oauth?.accessToken !== 'string' ||
        !oauth.accessToken.trim() ||
        typeof oauth?.refreshToken !== 'string' ||
        !oauth.refreshToken.trim() ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= 0
      ) {
        continue;
      }
      return {
        name,
        content,
        accessToken: oauth.accessToken.trim(),
        expiresAt,
        mode: file.mode & 0o7777,
        uid: file.uid,
        gid: file.gid,
      };
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return null;
}

async function replaceClaudeCredential(home, credential) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const targetPath = join(home, credential.name);
  const temporaryPath = join(home, `.${credential.name}.${process.pid}.${randomUUID()}.tmp`);
  let temporary;
  try {
    temporary = await open(temporaryPath, 'wx', 0o600);
    await temporary.writeFile(credential.content);
    await temporary.sync();
    await temporary.close();
    temporary = null;
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, credential.mode || 0o600);
    if (Number.isInteger(credential.uid) && Number.isInteger(credential.gid)) {
      await chown(targetPath, credential.uid, credential.gid).catch((error) => {
        if (error?.code !== 'EPERM') throw error;
      });
    }
    for (const name of CLAUDE_CREDENTIAL_FILENAMES) {
      if (name !== credential.name) await rm(join(home, name), { force: true });
    }
  } finally {
    await temporary?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function runClaudeCredentialProbe(home, { spawnProcess = spawn, timeoutMs = CLAUDE_REFRESH_TIMEOUT_MS } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-claude-refresh-'));
  const env = {
    ...process.env,
    HOME: home,
    CLAUDE_HOME: home,
    CLAUDE_CONFIG_DIR: home,
    NO_COLOR: '1',
    TERM: 'dumb',
  };
  for (const name of CLAUDE_REFRESH_ENVIRONMENT_OVERRIDES) delete env[name];

  try {
    return await new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnProcess(
          'claude',
          [
            '-p',
            '--safe-mode',
            '--disable-slash-commands',
            '--tools',
            '',
            '--permission-mode',
            'dontAsk',
            '--strict-mcp-config',
            '--mcp-config',
            '{"mcpServers":{}}',
            '--setting-sources',
            '',
            '--settings',
            '{}',
            '--no-session-persistence',
            '--output-format',
            'json',
          ],
          { cwd: directory, env, stdio: ['pipe', 'ignore', 'ignore'] }
        );
      } catch (error) {
        reject(error);
        return;
      }

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      timer.unref();
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error('Claude credential refresh timed out.'));
        } else {
          resolve(code);
        }
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end('Reply with OK.');
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function renewClaudeCredential(home, { now = Date.now, runProbe = runClaudeCredentialProbe } = {}) {
  return withClaudeCredentialLock(home, async () => {
    const original = await readClaudeCredential(home);
    if (!original) return false;

    try {
      await runProbe(home);
    } catch {
      // Claude may rotate OAuth credentials before a quota-limited probe exits.
      // Validate the credential file below before deciding whether renewal failed.
    }

    const refreshed = await readClaudeCredential(home);
    const nowMs = Number(now());
    const renewed =
      refreshed &&
      refreshed.expiresAt > nowMs &&
      (refreshed.expiresAt > original.expiresAt || refreshed.accessToken !== original.accessToken);
    if (renewed) {
      await chmod(join(home, refreshed.name), 0o600);
      return true;
    }

    await replaceClaudeCredential(home, original);
    return false;
  });
}

function firstProfileValue(value, keys, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  for (const [key, candidate] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (keys.has(normalizedKey) && (typeof candidate === 'string' || typeof candidate === 'number')) {
      const text = String(candidate).trim();
      if (text) return text;
    }
  }
  for (const candidate of Object.values(value)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const found = firstProfileValue(candidate, keys, seen);
    if (found) return found;
  }
  return null;
}

async function readClaudeAccountProfile(home) {
  for (const name of CLAUDE_PROFILE_FILENAMES) {
    const path = join(home, name);
    try {
      const file = await lstat(path);
      if (file.isSymbolicLink() || !file.isFile() || file.size > MAX_CREDENTIAL_BYTES) continue;
      const payload = JSON.parse(await readFile(path, 'utf8'));
      const profile = {
        provider: 'claude',
        accountId: firstProfileValue(payload, new Set(['accountid', 'accountuuid', 'userid', 'useruuid'])),
        email: firstProfileValue(payload, new Set(['email', 'emailaddress', 'useremail', 'accountemail'])),
        name: firstProfileValue(payload, new Set(['name', 'username', 'displayname'])),
        organization: firstProfileValue(
          payload,
          new Set(['organization', 'organizationname', 'organizationid', 'organizationuuid', 'orgid'])
        ),
      };
      if (profile.accountId || profile.email || profile.name || profile.organization) return profile;
    } catch (error) {
      if (error?.code === 'ENOENT' || error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return null;
}

async function writeClaudeAccountProfile(home, profile) {
  if (!profile) return;
  const targetPath = join(home, CLAUDE_ACCOUNT_PROFILE_FILENAME);
  const temporaryPath = join(home, `.${CLAUDE_ACCOUNT_PROFILE_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  let temporary;
  try {
    temporary = await open(temporaryPath, 'wx', 0o600);
    await temporary.writeFile(`${JSON.stringify(profile, null, 2)}\n`);
    await temporary.sync();
    await temporary.close();
    temporary = null;
    await rename(temporaryPath, targetPath);
    await chmod(targetPath, 0o600);
  } finally {
    await temporary?.close().catch(() => {});
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

export async function promoteClaudeCredential(sourceHome, targetHome) {
  const credential = await readClaudeCredential(sourceHome);
  if (!credential) throw new Error('The provider finished without saving usable login credentials.');
  const accountProfile = await readClaudeAccountProfile(sourceHome);

  return withClaudeCredentialLock(targetHome, async () => {
    const targetName = CLAUDE_CREDENTIAL_FILENAMES[0];
    const targetPath = join(targetHome, targetName);
    const temporaryPath = join(targetHome, `.${targetName}.${process.pid}.${randomUUID()}.tmp`);
    let temporary;
    try {
      temporary = await open(temporaryPath, 'wx', 0o600);
      await temporary.writeFile(credential.content);
      await temporary.sync();
      await temporary.close();
      temporary = null;
      await rename(temporaryPath, targetPath);
      await chmod(targetPath, 0o600);
      for (const name of CLAUDE_CREDENTIAL_FILENAMES) {
        if (name !== targetName) await rm(join(targetHome, name), { force: true });
      }
      await writeClaudeAccountProfile(targetHome, accountProfile);
      return targetPath;
    } finally {
      await temporary?.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  });
}

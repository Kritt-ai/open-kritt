import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rmdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const CLAUDE_CREDENTIAL_FILENAMES = ['.credentials.json', 'credentials.json'];
export const CLAUDE_AUTH_LOCK_NAME = '.open-kritt-auth.lock';

const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const LOCK_WAIT_MS = 30_000;
const STALE_LOCK_MS = 30 * 60 * 1000;

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
      return { name, content };
    } catch (error) {
      if (['ENOENT', 'EISDIR', 'EACCES', 'EPERM'].includes(error?.code) || error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return null;
}

export async function promoteClaudeCredential(sourceHome, targetHome) {
  const credential = await readClaudeCredential(sourceHome);
  if (!credential) throw new Error('The provider finished without saving usable login credentials.');

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
      return targetPath;
    } finally {
      await temporary?.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  });
}

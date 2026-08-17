import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const PROJECT_ENV_FILE_PATH = process.env.OPEN_KRITT_ENV_FILE_PATH || '';

let writeQueue = Promise.resolve();

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

export function parseEnvironmentText(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (match) values[match[1]] = decodeEnvValue(match[2]);
  }
  return values;
}

function encodeEnvValue(value) {
  const normalized = String(value ?? '');
  if (/\r|\n/.test(normalized)) throw new Error('Environment values must be a single line.');
  if (!normalized) return '';
  if (/^[A-Za-z0-9_./,:@+-]+$/.test(normalized)) return normalized;
  return `'${normalized.replace(/'/g, "\\'")}'`;
}

function updateEnvironmentText(text, updates) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const hasTrailingNewline = text.endsWith('\n');
  const entries = Object.entries(updates);
  const pending = new Map(entries);
  const seen = new Set();
  const lines = text ? text.split(/\r?\n/) : [];
  if (hasTrailingNewline) lines.pop();

  const updated = [];
  for (const line of lines) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    const key = match?.[1];
    if (!key || !pending.has(key)) {
      updated.push(line);
      continue;
    }
    if (!seen.has(key) && pending.get(key) !== null) {
      updated.push(`${key}=${encodeEnvValue(pending.get(key))}`);
    }
    seen.add(key);
  }
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid environment key: ${key}`);
    if (!seen.has(key) && value !== null) updated.push(`${key}=${encodeEnvValue(value)}`);
  }
  return `${updated.join(newline)}${hasTrailingNewline || updated.length ? newline : ''}`;
}

async function replaceEnvironmentFile(filePath, content, renameFile = rename) {
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const temporaryPath = join(dirname(filePath), `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
  try {
    await renameFile(temporaryPath, filePath);
  } catch (error) {
    // Docker bind-mounted files cannot be atomically replaced on Linux. Keep the
    // inode mounted into the container and update its contents in place instead.
    if (!['EBUSY', 'EXDEV', 'EPERM'].includes(error?.code)) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    let handle;
    try {
      handle = await open(filePath, 'r+');
      const buffer = Buffer.from(content, 'utf8');
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, offset);
        if (!bytesWritten) throw new Error('Could not persist the environment file.', { cause: error });
        offset += bytesWritten;
      }
      await handle.truncate(buffer.length);
      await handle.sync();
    } finally {
      await handle?.close();
      await rm(temporaryPath, { force: true });
    }
  }
  await chmod(filePath, 0o600);
}

export async function mutateEnvironmentFile(
  mutator,
  { environmentFilePath = PROJECT_ENV_FILE_PATH, renameFile = rename } = {}
) {
  if (!environmentFilePath) return null;
  if (typeof mutator !== 'function') throw new TypeError('Environment mutation must be a function.');
  const operation = async () => {
    let text = '';
    try {
      text = await readFile(environmentFilePath, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const previousValues = parseEnvironmentText(text);
    const updates = await mutator({ ...previousValues });
    if (!updates || Object.keys(updates).length === 0) {
      return { changed: false, previous: {}, values: previousValues };
    }
    const updated = updateEnvironmentText(text, updates);
    if (updated !== text) await replaceEnvironmentFile(environmentFilePath, updated, renameFile);
    return {
      changed: updated !== text,
      previous: Object.fromEntries(
        Object.keys(updates).map((key) => [
          key,
          Object.prototype.hasOwnProperty.call(previousValues, key) ? previousValues[key] : null,
        ])
      ),
      values: parseEnvironmentText(updated),
    };
  };
  const pending = writeQueue.then(operation);
  writeQueue = pending.catch(() => {});
  return pending;
}

export async function updateEnvironmentFile(
  updates,
  { environmentFilePath = PROJECT_ENV_FILE_PATH, renameFile = rename } = {}
) {
  return mutateEnvironmentFile(() => updates, { environmentFilePath, renameFile });
}

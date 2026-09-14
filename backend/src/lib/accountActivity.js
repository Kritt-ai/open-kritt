import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PROVIDER_CREDENTIALS_PATH } from './providerCredentials.js';

export const ACCOUNT_ACTIVITY_PATH = join(dirname(PROVIDER_CREDENTIALS_PATH), 'account-activity.json');
let writeQueue = Promise.resolve();

export function accountActivityId(path) {
  return createHash('sha256').update(path).digest('hex');
}

export function readAccountActivity(path = ACCOUNT_ACTIVITY_PATH) {
  try {
    const state = JSON.parse(readFileSync(path, 'utf8'));
    if (
      state?.version !== 1 ||
      !Array.isArray(state.accounts) ||
      state.accounts.some(
        (entry) =>
          !entry ||
          typeof entry.provider !== 'string' ||
          typeof entry.path !== 'string' ||
          typeof entry.active !== 'boolean'
      )
    )
      throw new Error('Invalid account preferences');
    return state.accounts;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw Object.assign(
      new Error('Account preferences could not be read. Restore account-activity.json before assigning accounts.'),
      { statusCode: 503 }
    );
  }
}

export function accountIsActive(provider, accountPath, entries = readAccountActivity()) {
  return entries.find((entry) => entry.provider === provider && entry.path === accountPath)?.active !== false;
}

export function saveAccountActivity(provider, accountPath, active, path = ACCOUNT_ACTIVITY_PATH) {
  const pending = writeQueue.then(async () => {
    const entries = readAccountActivity(path);
    const next = entries.filter((entry) => entry.provider !== provider || entry.path !== accountPath);
    next.push({ provider, path: accountPath, active });
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(path), `.account-activity.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify({ version: 1, accounts: next }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, path);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
    return { activityId: accountActivityId(accountPath), active };
  });
  writeQueue = pending.catch(() => {});
  return pending;
}

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseEnvironmentText, updateEnvironmentFile } from '../src/lib/environmentFile.js';

test('environment file updates preserve unrelated values and replace duplicates', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-environment-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environmentFilePath = join(directory, '.env');
  await writeFile(
    environmentFilePath,
    '# Keep this comment\nENGINE_CODEX_HOME=/root/.codex\nKEEP=value\nENGINE_CODEX_HOME=duplicate\n'
  );

  await updateEnvironmentFile(
    {
      ENGINE_CODEX_HOME: '/codex-accounts/one/.codex,/codex-accounts/two/.codex',
      CODEX_LOGIN_CONFIGURED: '1',
    },
    { environmentFilePath }
  );

  const text = await readFile(environmentFilePath, 'utf8');
  const values = parseEnvironmentText(text);
  assert.equal(values.KEEP, 'value');
  assert.equal(values.ENGINE_CODEX_HOME, '/codex-accounts/one/.codex,/codex-accounts/two/.codex');
  assert.equal(values.CODEX_LOGIN_CONFIGURED, '1');
  assert.equal((text.match(/^ENGINE_CODEX_HOME=/gm) || []).length, 1);
  assert.match(text, /^# Keep this comment$/m);
  assert.equal((await stat(environmentFilePath)).mode & 0o777, 0o600);
});

test('concurrent environment updates do not overwrite each other', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-environment-queue-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environmentFilePath = join(directory, '.env');
  await writeFile(environmentFilePath, 'KEEP=value\n');

  await Promise.all([
    updateEnvironmentFile({ OPENROUTER_API_KEY: "secret'value" }, { environmentFilePath }),
    updateEnvironmentFile({ CODEX_LOGIN_CONFIGURED: '1' }, { environmentFilePath }),
  ]);

  assert.deepEqual(parseEnvironmentText(await readFile(environmentFilePath, 'utf8')), {
    KEEP: 'value',
    OPENROUTER_API_KEY: "secret'value",
    CODEX_LOGIN_CONFIGURED: '1',
  });
});

test('environment updates preserve a Docker bind-mounted file inode', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-environment-bind-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environmentFilePath = join(directory, '.env');
  await writeFile(environmentFilePath, 'ENGINE_CODEX_HOME=/root/.codex\n');
  const before = await stat(environmentFilePath);
  const renameFile = async () => {
    const error = new Error('Device or resource busy');
    error.code = 'EBUSY';
    throw error;
  };

  await updateEnvironmentFile({ ENGINE_CODEX_HOME: '/codex-accounts/new/.codex' }, { environmentFilePath, renameFile });

  const after = await stat(environmentFilePath);
  assert.equal(after.ino, before.ino);
  assert.equal(
    parseEnvironmentText(await readFile(environmentFilePath, 'utf8')).ENGINE_CODEX_HOME,
    '/codex-accounts/new/.codex'
  );
});

test('new environment files use bare values when quoting is unnecessary', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-environment-new-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environmentFilePath = join(directory, '.env');

  await updateEnvironmentFile(
    {
      ENGINE_WORKER_COUNT: '4',
      ENGINE_CODEX_HOME: '/root/.codex,/codex-accounts/reviewer/.codex',
    },
    { environmentFilePath }
  );

  assert.equal(
    await readFile(environmentFilePath, 'utf8'),
    'ENGINE_WORKER_COUNT=4\nENGINE_CODEX_HOME=/root/.codex,/codex-accounts/reviewer/.codex\n'
  );
});

test('null removes an environment key without disturbing surrounding content', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-environment-remove-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const environmentFilePath = join(directory, '.env');
  await writeFile(environmentFilePath, '# keep\nREMOVE=old\nKEEP=value\nREMOVE=duplicate\n');

  const result = await updateEnvironmentFile({ REMOVE: null }, { environmentFilePath });

  assert.equal(await readFile(environmentFilePath, 'utf8'), '# keep\nKEEP=value\n');
  assert.equal(result.previous.REMOVE, 'duplicate');
});

test('a directory at the environment path is skipped instead of throwing EISDIR', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-environment-dir-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Reproduces the fresh-checkout failure: `docker compose up` creates the
  // missing bind-mount source .env as a *directory*, so reading/writing it as
  // a file would throw EISDIR and surface as a 500 on every Settings/Accounts
  // save. The mirror must be skipped gracefully instead.
  const environmentFilePath = join(directory, '.env');
  await mkdir(environmentFilePath);

  const result = await updateEnvironmentFile({ ENGINE_WORKER_COUNT: '4' }, { environmentFilePath });

  assert.equal(result, null);
  assert.equal((await stat(environmentFilePath)).isDirectory(), true);
});
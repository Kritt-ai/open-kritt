import assert from 'node:assert/strict';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { updateRuntimeSettings } from '../src/lib/runtimeSettings.js';
import { parseEnvironmentText } from '../src/lib/environmentFile.js';

test('failed concurrent save cannot roll back a successful safeguard update', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kritt-benign-settings-proof-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeConfigPath = join(root, 'runtime.env');
  const environmentFilePath = join(root, 'project.env');
  await writeFile(runtimeConfigPath, 'ENGINE_MIN_FREE_STORAGE_GB=20\n');
  await writeFile(environmentFilePath, 'ENGINE_MIN_FREE_STORAGE_GB=20\n');
  const renameOriginal = fsPromises.rename;
  let injected = false;
  fsPromises.rename = async (source, destination) => {
    if (destination === environmentFilePath && !injected) {
      injected = true;
      throw Object.assign(new Error('Synthetic one-shot disk persistence error'), { code: 'EIO' });
    }
    return renameOriginal(source, destination);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsPromises.rename = renameOriginal;
    syncBuiltinESMExports();
  });
  const [failed, success] = await Promise.allSettled([
    updateRuntimeSettings({ minFreeStorageGb: 30 }, { runtimeConfigPath, environmentFilePath, env: {} }),
    updateRuntimeSettings({ minFreeStorageGb: 40 }, { runtimeConfigPath, environmentFilePath, env: {} }),
  ]);
  assert.equal(failed.status, 'rejected');
  assert.equal(success.status, 'fulfilled');
  assert.equal(parseEnvironmentText(await readFile(environmentFilePath, 'utf8')).ENGINE_MIN_FREE_STORAGE_GB, '40');
  assert.equal(parseEnvironmentText(await readFile(runtimeConfigPath, 'utf8')).ENGINE_MIN_FREE_STORAGE_GB, '40');
});

test('concurrent successful saves preserve each update and unrelated settings', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'kritt-settings-concurrency-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtimeConfigPath = join(root, 'runtime.env');
  const environmentFilePath = join(root, 'project.env');
  const original = 'ENGINE_MIN_FREE_STORAGE_GB=20\nENGINE_MEMORY_RESERVE_GB=2\nKEEP=value\n';
  await writeFile(runtimeConfigPath, original);
  await writeFile(environmentFilePath, original);
  await Promise.all([
    updateRuntimeSettings({ minFreeStorageGb: 30 }, { runtimeConfigPath, environmentFilePath, env: {} }),
    updateRuntimeSettings({ memoryReserveGb: 4 }, { runtimeConfigPath, environmentFilePath, env: {} }),
  ]);
  const expected = { ENGINE_MIN_FREE_STORAGE_GB: '30', ENGINE_MEMORY_RESERVE_GB: '4', KEEP: 'value' };
  assert.deepEqual(parseEnvironmentText(await readFile(runtimeConfigPath, 'utf8')), expected);
  assert.deepEqual(parseEnvironmentText(await readFile(environmentFilePath, 'utf8')), expected);
});

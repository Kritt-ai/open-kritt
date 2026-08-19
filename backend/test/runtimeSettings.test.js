import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { parseEnvironmentText } from '../src/lib/environmentFile.js';
import {
  readRuntimeSettings,
  updateRuntimeSettings,
  validateRuntimeSettingsPatch,
} from '../src/lib/runtimeSettings.js';
import { ValidationError } from '../src/lib/validation.js';

async function settingsFiles(t) {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-runtime-settings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return {
    runtimeConfigPath: join(directory, 'engine-runtime.env'),
    environmentFilePath: join(directory, '.env'),
  };
}

test('settings API exposes the whitelisted runtime settings', async () => {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/settings`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body.settings), [
      'workerCount',
      'maxConcurrentScans',
      'maxWorkersPerScan',
      'workersPerAccount',
      'autoscaleScanWorkersOnProviderCapacity',
      'codexMaxSubagentsPerSession',
      'minFreeStorageGb',
      'ignoreLowStorage',
      'memoryReserveGb',
      'scanRunnerMemoryMb',
      'scanRunnerMemoryReservationMb',
      'workspaceSetupConcurrency',
      'retryCount',
      'cyberSafetyRetryCount',
      'harnessTimeoutSeconds',
    ]);
    assert.equal(body.capabilities.dedicatedScanConcurrency.available, true);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('runtime settings expose only whitelisted effective values and their sources', async (t) => {
  const paths = await settingsFiles(t);
  await writeFile(
    paths.runtimeConfigPath,
    'ENGINE_WORKER_COUNT=6\nENGINE_CODEX_HOME=/secret/account\nOPENROUTER_API_KEY=must-not-leak\n'
  );
  await writeFile(paths.environmentFilePath, 'ENGINE_RETRY_COUNT=3\nGITHUB_TOKEN=must-not-leak\n');

  const result = await readRuntimeSettings({
    ...paths,
    env: {
      ENGINE_HARNESS_TIMEOUT_SECONDS: '3600',
      ENGINE_MIN_FREE_STORAGE_GB: '23.5',
    },
  });

  assert.equal(result.settings.workerCount.value, 6);
  assert.equal(result.settings.workerCount.source, 'runtime_config');
  assert.equal(result.settings.retryCount.value, 3);
  assert.equal(result.settings.retryCount.source, 'project_environment');
  assert.equal(result.settings.cyberSafetyRetryCount.value, 0);
  assert.equal(result.settings.cyberSafetyRetryCount.source, 'default');
  assert.equal(result.settings.harnessTimeoutSeconds.value, 3600);
  assert.equal(result.settings.harnessTimeoutSeconds.source, 'process_environment');
  assert.equal(result.settings.workspaceSetupConcurrency.value, 2);
  assert.equal(result.settings.workspaceSetupConcurrency.source, 'default');
  assert.equal(result.settings.maxConcurrentScans.value, 1);
  assert.equal(result.settings.maxWorkersPerScan.value, 0);
  assert.equal(result.settings.workersPerAccount.value, 15);
  assert.equal(result.settings.autoscaleScanWorkersOnProviderCapacity.value, true);
  assert.equal(result.settings.autoscaleScanWorkersOnProviderCapacity.source, 'default');
  assert.equal(result.settings.codexMaxSubagentsPerSession.value, 5);
  assert.equal(result.settings.minFreeStorageGb.value, 23.5);
  assert.equal(result.settings.minFreeStorageGb.source, 'process_environment');
  assert.equal(result.settings.minFreeStorageGb.type, 'number');
  assert.equal(result.settings.minFreeStorageGb.step, 0.1);
  assert.equal(result.settings.ignoreLowStorage.value, false);
  assert.equal(result.settings.ignoreLowStorage.source, 'default');
  assert.equal(result.settings.ignoreLowStorage.type, 'boolean');
  assert.equal(result.settings.memoryReserveGb.value, 2);
  assert.equal(result.settings.scanRunnerMemoryMb.value, 1536);
  assert.equal(result.settings.scanRunnerMemoryReservationMb.value, 1536);
  assert.equal(result.capabilities.perScanConcurrency.available, true);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|secret\/account|GITHUB_TOKEN|OPENROUTER_API_KEY/);
});

test('runtime setting updates apply live and persist without overwriting unrelated values', async (t) => {
  const paths = await settingsFiles(t);
  await writeFile(paths.runtimeConfigPath, '# live settings\nENGINE_WORKER_COUNT=2\nENGINE_CODEX_HOME=/account\n');
  await writeFile(paths.environmentFilePath, '# project settings\nENGINE_WORKER_COUNT=2\nKEEP=value\n');

  const result = await updateRuntimeSettings(
    {
      workerCount: 5,
      workersPerAccount: 12,
      retryCount: 4,
      cyberSafetyRetryCount: 3,
      autoscaleScanWorkersOnProviderCapacity: false,
      codexMaxSubagentsPerSession: 5,
      minFreeStorageGb: 18.5,
      ignoreLowStorage: true,
      memoryReserveGb: 2.5,
      scanRunnerMemoryMb: 1792,
      scanRunnerMemoryReservationMb: 768,
    },
    {
      ...paths,
      env: {},
    }
  );

  const runtimeText = await readFile(paths.runtimeConfigPath, 'utf8');
  const projectText = await readFile(paths.environmentFilePath, 'utf8');
  const runtimeValues = parseEnvironmentText(runtimeText);
  const projectValues = parseEnvironmentText(projectText);
  assert.equal(runtimeValues.ENGINE_WORKER_COUNT, '5');
  assert.equal(runtimeValues.ENGINE_WORKERS_PER_ACCOUNT, '12');
  assert.equal(runtimeValues.ENGINE_RETRY_COUNT, '4');
  assert.equal(runtimeValues.ENGINE_CYBER_SAFETY_RETRY_COUNT, '3');
  assert.equal(runtimeValues.ENGINE_AUTOSCALE_SCAN_WORKERS_ON_PROVIDER_CAPACITY, 'false');
  assert.equal(runtimeValues.ENGINE_CODEX_MAX_SUBAGENTS_PER_SESSION, '5');
  assert.equal(runtimeValues.ENGINE_MIN_FREE_STORAGE_GB, '18.5');
  assert.equal(runtimeValues.ENGINE_IGNORE_LOW_STORAGE, 'true');
  assert.equal(runtimeValues.ENGINE_MEMORY_RESERVE_GB, '2.5');
  assert.equal(runtimeValues.ENGINE_SCAN_RUNNER_MEMORY_MB, '1792');
  assert.equal(runtimeValues.ENGINE_SCAN_RUNNER_MEMORY_RESERVATION_MB, '768');
  assert.equal(runtimeValues.ENGINE_CODEX_HOME, '/account');
  assert.equal(projectValues.ENGINE_WORKER_COUNT, '5');
  assert.equal(projectValues.ENGINE_WORKERS_PER_ACCOUNT, '12');
  assert.equal(projectValues.ENGINE_RETRY_COUNT, '4');
  assert.equal(projectValues.ENGINE_CYBER_SAFETY_RETRY_COUNT, '3');
  assert.equal(projectValues.ENGINE_AUTOSCALE_SCAN_WORKERS_ON_PROVIDER_CAPACITY, 'false');
  assert.equal(projectValues.ENGINE_CODEX_MAX_SUBAGENTS_PER_SESSION, '5');
  assert.equal(projectValues.ENGINE_MIN_FREE_STORAGE_GB, '18.5');
  assert.equal(projectValues.ENGINE_IGNORE_LOW_STORAGE, 'true');
  assert.equal(projectValues.ENGINE_MEMORY_RESERVE_GB, '2.5');
  assert.equal(projectValues.ENGINE_SCAN_RUNNER_MEMORY_MB, '1792');
  assert.equal(projectValues.ENGINE_SCAN_RUNNER_MEMORY_RESERVATION_MB, '768');
  assert.equal(projectValues.KEEP, 'value');
  assert.match(runtimeText, /^# live settings$/m);
  assert.match(projectText, /^# project settings$/m);
  assert.equal(result.settings.workerCount.value, 5);
  assert.equal(result.settings.workersPerAccount.value, 12);
  assert.equal(result.settings.workerCount.source, 'runtime_config');
  assert.equal(result.settings.retryCount.value, 4);
  assert.equal(result.settings.cyberSafetyRetryCount.value, 3);
  assert.equal(result.settings.autoscaleScanWorkersOnProviderCapacity.value, false);
  assert.equal(result.settings.codexMaxSubagentsPerSession.value, 5);
  assert.equal(result.settings.minFreeStorageGb.value, 18.5);
  assert.equal(result.settings.ignoreLowStorage.value, true);
  assert.equal(result.settings.memoryReserveGb.value, 2.5);
  assert.equal(result.settings.scanRunnerMemoryMb.value, 1792);
  assert.equal(result.settings.scanRunnerMemoryReservationMb.value, 768);
});

test('runtime setting validation rejects unknown, fractional, and out-of-range values', () => {
  assert.throws(
    () =>
      validateRuntimeSettingsPatch({
        workerCount: 1.5,
        retryCount: 11,
        cyberSafetyRetryCount: 11,
        secret: 'value',
      }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.deepEqual(
        error.errors.map((item) => item.field),
        ['workerCount', 'retryCount', 'cyberSafetyRetryCount', 'secret']
      );
      return true;
    }
  );
  assert.throws(() => validateRuntimeSettingsPatch({}), ValidationError);
  assert.deepEqual(
    validateRuntimeSettingsPatch({
      workerCount: '0',
      cyberSafetyRetryCount: 3,
      harnessTimeoutSeconds: 60,
    }),
    {
      workerCount: 0,
      cyberSafetyRetryCount: 3,
      harnessTimeoutSeconds: 60,
    }
  );
  assert.deepEqual(
    validateRuntimeSettingsPatch({
      autoscaleScanWorkersOnProviderCapacity: true,
    }),
    {
      autoscaleScanWorkersOnProviderCapacity: true,
    }
  );
  assert.throws(
    () =>
      validateRuntimeSettingsPatch({
        autoscaleScanWorkersOnProviderCapacity: 'true',
      }),
    ValidationError
  );
  assert.deepEqual(validateRuntimeSettingsPatch({ codexMaxSubagentsPerSession: 5 }), {
    codexMaxSubagentsPerSession: 5,
  });
  assert.throws(() => validateRuntimeSettingsPatch({ codexMaxSubagentsPerSession: 6 }), ValidationError);
  assert.deepEqual(validateRuntimeSettingsPatch({ workersPerAccount: 15 }), {
    workersPerAccount: 15,
  });
  assert.throws(() => validateRuntimeSettingsPatch({ workersPerAccount: 0 }), ValidationError);
  assert.deepEqual(validateRuntimeSettingsPatch({ minFreeStorageGb: '17.5' }), {
    minFreeStorageGb: 17.5,
  });
  assert.deepEqual(validateRuntimeSettingsPatch({ ignoreLowStorage: true }), {
    ignoreLowStorage: true,
  });
  assert.throws(() => validateRuntimeSettingsPatch({ ignoreLowStorage: 'true' }), ValidationError);
  assert.throws(() => validateRuntimeSettingsPatch({ minFreeStorageGb: 'not-a-number' }), ValidationError);
  assert.throws(() => validateRuntimeSettingsPatch({ minFreeStorageGb: 1025 }), ValidationError);
  assert.deepEqual(
    validateRuntimeSettingsPatch({
      memoryReserveGb: '2.5',
      scanRunnerMemoryMb: 1536,
      scanRunnerMemoryReservationMb: 768,
    }),
    {
      memoryReserveGb: 2.5,
      scanRunnerMemoryMb: 1536,
      scanRunnerMemoryReservationMb: 768,
    }
  );
  assert.throws(() => validateRuntimeSettingsPatch({ memoryReserveGb: -1 }), ValidationError);
  assert.throws(() => validateRuntimeSettingsPatch({ scanRunnerMemoryMb: 1.5 }), ValidationError);
  assert.throws(() => validateRuntimeSettingsPatch({ scanRunnerMemoryReservationMb: 1.5 }), ValidationError);
});

test('invalid persisted values fall back safely and are flagged', async (t) => {
  const paths = await settingsFiles(t);
  await writeFile(
    paths.runtimeConfigPath,
    'ENGINE_WORKER_COUNT=too-many\nENGINE_RETRY_COUNT=99\nENGINE_CYBER_SAFETY_RETRY_COUNT=-1\n'
  );

  const result = await readRuntimeSettings({ ...paths, env: {} });

  assert.equal(result.settings.workerCount.value, 2);
  assert.equal(result.settings.workerCount.valid, false);
  assert.equal(result.settings.retryCount.value, 2);
  assert.equal(result.settings.retryCount.valid, false);
  assert.equal(result.settings.cyberSafetyRetryCount.value, 0);
  assert.equal(result.settings.cyberSafetyRetryCount.valid, false);
});

test('failed project persistence rolls back newly added live settings', async (t) => {
  const paths = await settingsFiles(t);
  const invalidParent = join(paths.environmentFilePath, 'blocked');
  await writeFile(paths.runtimeConfigPath, 'ENGINE_WORKER_COUNT=2\n');
  await writeFile(paths.environmentFilePath, 'not a directory');

  await assert.rejects(
    updateRuntimeSettings(
      { retryCount: 4 },
      {
        runtimeConfigPath: paths.runtimeConfigPath,
        environmentFilePath: invalidParent,
        env: {},
      }
    )
  );

  assert.deepEqual(parseEnvironmentText(await readFile(paths.runtimeConfigPath, 'utf8')), {
    ENGINE_WORKER_COUNT: '2',
  });
});

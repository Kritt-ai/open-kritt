import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('settings API exposes the whitelisted runtime settings', async (t) => {
  const paths = await settingsFiles(t);
  await writeFile(paths.runtimeConfigPath, '');
  await writeFile(paths.environmentFilePath, '');
  const server = createApp({ runtimeSettingsOptions: { ...paths, env: {} } }).listen(0, '127.0.0.1');
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
      'autoscaleScanWorkersOnProviderCapacity',
      'workspaceSetupConcurrency',
      'retryCount',
      'harnessTimeoutSeconds',
    ]);
    assert.equal(body.capabilities.dedicatedScanConcurrency.available, true);
    assert.deepEqual(body.warnings, []);
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
    env: { ENGINE_HARNESS_TIMEOUT_SECONDS: '3600' },
  });

  assert.equal(result.settings.workerCount.value, 6);
  assert.equal(result.settings.workerCount.source, 'runtime_config');
  assert.equal(result.settings.retryCount.value, 3);
  assert.equal(result.settings.retryCount.source, 'project_environment');
  assert.equal(result.settings.harnessTimeoutSeconds.value, 3600);
  assert.equal(result.settings.harnessTimeoutSeconds.source, 'process_environment');
  assert.equal(result.settings.workspaceSetupConcurrency.value, 2);
  assert.equal(result.settings.workspaceSetupConcurrency.source, 'default');
  assert.equal(result.settings.maxConcurrentScans.value, 1);
  assert.equal(result.settings.maxWorkersPerScan.value, 0);
  assert.equal(result.settings.autoscaleScanWorkersOnProviderCapacity.value, true);
  assert.equal(result.settings.autoscaleScanWorkersOnProviderCapacity.source, 'default');
  assert.equal(result.capabilities.perScanConcurrency.available, true);
  assert.deepEqual(result.warnings, []);
  assert.doesNotMatch(JSON.stringify(result), /must-not-leak|secret\/account|GITHUB_TOKEN|OPENROUTER_API_KEY/);
});

test('runtime setting updates apply live and persist without overwriting unrelated values', async (t) => {
  const paths = await settingsFiles(t);
  await writeFile(paths.runtimeConfigPath, '# live settings\nENGINE_WORKER_COUNT=2\nENGINE_CODEX_HOME=/account\n');
  await writeFile(paths.environmentFilePath, '# project settings\nENGINE_WORKER_COUNT=2\nKEEP=value\n');

  const result = await updateRuntimeSettings(
    { workerCount: 5, retryCount: 4, autoscaleScanWorkersOnProviderCapacity: false },
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
  assert.equal(runtimeValues.ENGINE_RETRY_COUNT, '4');
  assert.equal(runtimeValues.ENGINE_AUTOSCALE_SCAN_WORKERS_ON_PROVIDER_CAPACITY, 'false');
  assert.equal(runtimeValues.ENGINE_CODEX_HOME, '/account');
  assert.equal(projectValues.ENGINE_WORKER_COUNT, '5');
  assert.equal(projectValues.ENGINE_RETRY_COUNT, '4');
  assert.equal(projectValues.ENGINE_AUTOSCALE_SCAN_WORKERS_ON_PROVIDER_CAPACITY, 'false');
  assert.equal(projectValues.KEEP, 'value');
  assert.match(runtimeText, /^# live settings$/m);
  assert.match(projectText, /^# project settings$/m);
  assert.equal(result.settings.workerCount.value, 5);
  assert.equal(result.settings.workerCount.source, 'runtime_config');
  assert.equal(result.settings.retryCount.value, 4);
  assert.equal(result.settings.autoscaleScanWorkersOnProviderCapacity.value, false);
});

test('runtime setting validation rejects unknown, fractional, and out-of-range values', () => {
  assert.throws(
    () => validateRuntimeSettingsPatch({ workerCount: 1.5, retryCount: 11, secret: 'value' }),
    (error) => {
      assert.ok(error instanceof ValidationError);
      assert.deepEqual(
        error.errors.map((item) => item.field),
        ['workerCount', 'retryCount', 'secret']
      );
      return true;
    }
  );
  assert.throws(() => validateRuntimeSettingsPatch({}), ValidationError);
  assert.deepEqual(validateRuntimeSettingsPatch({ workerCount: '0', harnessTimeoutSeconds: 60 }), {
    workerCount: 0,
    harnessTimeoutSeconds: 60,
  });
  assert.deepEqual(validateRuntimeSettingsPatch({ autoscaleScanWorkersOnProviderCapacity: true }), {
    autoscaleScanWorkersOnProviderCapacity: true,
  });
  assert.throws(
    () => validateRuntimeSettingsPatch({ autoscaleScanWorkersOnProviderCapacity: 'true' }),
    ValidationError
  );
});

test('invalid persisted values fall back safely and are flagged', async (t) => {
  const paths = await settingsFiles(t);
  await writeFile(paths.runtimeConfigPath, 'ENGINE_WORKER_COUNT=too-many\nENGINE_RETRY_COUNT=99\n');

  const result = await readRuntimeSettings({ ...paths, env: {} });

  assert.equal(result.settings.workerCount.value, 2);
  assert.equal(result.settings.workerCount.valid, false);
  assert.equal(result.settings.retryCount.value, 2);
  assert.equal(result.settings.retryCount.valid, false);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['missing']);
});

test('settings read tolerates a project environment path mounted as a directory', async (t) => {
  const paths = await settingsFiles(t);
  const projectEnvironmentDirectory = join(paths.environmentFilePath, 'directory');
  await mkdir(projectEnvironmentDirectory, { recursive: true });
  await writeFile(paths.runtimeConfigPath, 'ENGINE_WORKER_COUNT=6\n');

  const result = await readRuntimeSettings({
    runtimeConfigPath: paths.runtimeConfigPath,
    environmentFilePath: projectEnvironmentDirectory,
    env: {},
  });

  assert.equal(result.settings.workerCount.value, 6);
  assert.equal(result.settings.workerCount.source, 'runtime_config');
  assert.equal(result.settings.retryCount.value, 2);
  assert.equal(result.settings.retryCount.source, 'default');
  assert.equal(result.persistence.projectEnvironment, false);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['directory']);
});

test('settings read tolerates a missing project environment file', async (t) => {
  const paths = await settingsFiles(t);
  await writeFile(paths.runtimeConfigPath, 'ENGINE_WORKER_COUNT=6\n');

  const result = await readRuntimeSettings({
    runtimeConfigPath: paths.runtimeConfigPath,
    environmentFilePath: paths.environmentFilePath,
    env: {},
  });

  assert.equal(result.settings.workerCount.value, 6);
  assert.equal(result.persistence.projectEnvironment, false);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['missing']);
});

test('settings read tolerates an unreadable project environment file', async (t) => {
  const paths = await settingsFiles(t);
  await writeFile(paths.runtimeConfigPath, 'ENGINE_WORKER_COUNT=6\n');

  const result = await readRuntimeSettings({
    runtimeConfigPath: paths.runtimeConfigPath,
    environmentFilePath: paths.environmentFilePath,
    env: {},
    readText: async (path) => {
      if (path === paths.environmentFilePath) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return readFile(path, 'utf8');
    },
  });

  assert.equal(result.settings.workerCount.value, 6);
  assert.equal(result.persistence.projectEnvironment, false);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['unreadable']);
});

test('settings read tolerates malformed env files and keeps valid entries', async (t) => {
  const paths = await settingsFiles(t);
  await writeFile(paths.runtimeConfigPath, 'ENGINE_WORKER_COUNT=6\nBROKEN LINE\n');
  await writeFile(paths.environmentFilePath, 'ENGINE_RETRY_COUNT=4\nmissing equals\n');

  const result = await readRuntimeSettings({
    ...paths,
    env: {},
  });

  assert.equal(result.settings.workerCount.value, 6);
  assert.equal(result.settings.retryCount.value, 4);
  assert.deepEqual(
    result.warnings.map((warning) => warning.code).sort(),
    ['malformed', 'malformed']
  );
});

test('settings read tolerates empty env files', async (t) => {
  const paths = await settingsFiles(t);
  await writeFile(paths.runtimeConfigPath, '');
  await writeFile(paths.environmentFilePath, '');

  const result = await readRuntimeSettings({
    ...paths,
    env: {},
  });

  assert.equal(result.settings.workerCount.value, 2);
  assert.equal(result.persistence.runtimeConfig, true);
  assert.equal(result.persistence.projectEnvironment, true);
  assert.deepEqual(result.warnings, []);
});

test('settings read tolerates a missing runtime config file', async (t) => {
  const paths = await settingsFiles(t);
  await writeFile(paths.environmentFilePath, 'ENGINE_RETRY_COUNT=4\n');

  const result = await readRuntimeSettings({
    ...paths,
    env: {},
  });

  assert.equal(result.settings.retryCount.value, 4);
  assert.equal(result.settings.retryCount.source, 'project_environment');
  assert.equal(result.persistence.runtimeConfig, false);
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['missing']);
});

test('settings API returns 200 with partial data when config files degrade', async () => {
  const server = createApp({
    runtimeSettingsOptions: {
      runtimeConfigPath: '/runtime.env',
      environmentFilePath: '/project.env',
      env: {},
      readText: async (path) => {
        if (path === '/runtime.env') return 'ENGINE_WORKER_COUNT=7\ninvalid runtime line\n';
        const error = new Error('permission denied');
        error.code = 'EPERM';
        throw error;
      },
    },
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/settings`);
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.settings.workerCount.value, 7);
    assert.equal(body.settings.retryCount.value, 2);
    assert.deepEqual(
      body.warnings.map((warning) => warning.code).sort(),
      ['malformed', 'unreadable']
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
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

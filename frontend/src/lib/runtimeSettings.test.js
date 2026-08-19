import { describe, expect, it } from 'vitest';

import { runtimeSettingsDraft, runtimeSettingsIssues, runtimeSettingsPatch } from './runtimeSettings.js';

const payload = {
  settings: {
    workerCount: { value: 2, min: 0, max: 128 },
    maxConcurrentScans: { value: 1, min: 1, max: 128 },
    maxWorkersPerScan: { value: 0, min: 0, max: 128 },
    workersPerAccount: { value: 15, min: 1, max: 128 },
    autoscaleScanWorkersOnProviderCapacity: { value: true, type: 'boolean' },
    codexMaxSubagentsPerSession: { value: 5, min: 1, max: 5 },
    minFreeStorageGb: { value: 20, min: 0, max: 1024, step: 0.1, type: 'number' },
    ignoreLowStorage: { value: false, type: 'boolean', defaultValue: false },
    memoryReserveGb: { value: 2, min: 0, max: 1024, step: 0.1, type: 'number' },
    scanRunnerMemoryMb: { value: 1536, min: 0, max: 1048576 },
    scanRunnerMemoryReservationMb: { value: 1536, min: 0, max: 1048576 },
    workspaceSetupConcurrency: { value: 2, min: 1, max: 32 },
    retryCount: { value: 2, min: 0, max: 10 },
    cyberSafetyRetryCount: { value: 0, min: 0, max: 10 },
    harnessTimeoutSeconds: { value: 7200, min: 60, max: 86400 },
  },
};

describe('runtime settings form helpers', () => {
  it('creates string drafts from API values', () => {
    expect(runtimeSettingsDraft(payload)).toEqual({
      workerCount: '2',
      maxConcurrentScans: '1',
      maxWorkersPerScan: '0',
      workersPerAccount: '15',
      autoscaleScanWorkersOnProviderCapacity: true,
      codexMaxSubagentsPerSession: '5',
      minFreeStorageGb: '20',
      ignoreLowStorage: false,
      memoryReserveGb: '2',
      scanRunnerMemoryMb: '1536',
      scanRunnerMemoryReservationMb: '1536',
      workspaceSetupConcurrency: '2',
      retryCount: '2',
      cyberSafetyRetryCount: '0',
      harnessTimeoutSeconds: '7200',
    });
  });

  it('returns only changed numeric settings', () => {
    expect(
      runtimeSettingsPatch(payload, {
        ...runtimeSettingsDraft(payload),
        workerCount: '04',
        retryCount: '0',
        cyberSafetyRetryCount: '3',
      })
    ).toEqual({ workerCount: 4, retryCount: 0, cyberSafetyRetryCount: 3 });
  });

  it('returns a changed provider-capacity autoscale toggle', () => {
    expect(
      runtimeSettingsPatch(payload, {
        ...runtimeSettingsDraft(payload),
        autoscaleScanWorkersOnProviderCapacity: false,
      })
    ).toEqual({ autoscaleScanWorkersOnProviderCapacity: false });
  });

  it('accepts a fractional minimum-free-storage threshold', () => {
    expect(
      runtimeSettingsPatch(payload, {
        ...runtimeSettingsDraft(payload),
        minFreeStorageGb: '17.5',
        memoryReserveGb: '2.5',
      })
    ).toEqual({ minFreeStorageGb: 17.5, memoryReserveGb: 2.5 });
  });

  it('returns a changed low-storage safeguard override', () => {
    expect(
      runtimeSettingsPatch(payload, {
        ...runtimeSettingsDraft(payload),
        ignoreLowStorage: true,
      })
    ).toEqual({ ignoreLowStorage: true });
  });

  it('rejects empty, fractional, and out-of-range values before saving', () => {
    const draft = {
      ...runtimeSettingsDraft(payload),
      workerCount: '',
      minFreeStorageGb: 'not-a-number',
      workspaceSetupConcurrency: '1.5',
      retryCount: '11',
      cyberSafetyRetryCount: '-1',
    };
    expect(runtimeSettingsIssues(payload, draft)).toEqual({
      workerCount: 'Enter a whole number.',
      minFreeStorageGb: 'Enter a number.',
      workspaceSetupConcurrency: 'Enter a whole number.',
      retryCount: 'Enter a value from 0 to 10.',
      cyberSafetyRetryCount: 'Enter a value from 0 to 10.',
    });
    expect(runtimeSettingsPatch(payload, draft)).toEqual({});
  });

  it('offers to replace an invalid stored value with the safe value shown', () => {
    const invalidPayload = {
      ...payload,
      settings: {
        ...payload.settings,
        retryCount: { ...payload.settings.retryCount, valid: false },
      },
    };

    expect(runtimeSettingsPatch(invalidPayload, runtimeSettingsDraft(invalidPayload))).toEqual({ retryCount: 2 });
  });
});

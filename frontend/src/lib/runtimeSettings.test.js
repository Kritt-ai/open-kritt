import { describe, expect, it } from 'vitest';

import { runtimeSettingsDraft, runtimeSettingsIssues, runtimeSettingsPatch } from './runtimeSettings.js';

const payload = {
  settings: {
    workerCount: { value: 2, min: 0, max: 128 },
    maxConcurrentScans: { value: 1, min: 1, max: 128 },
    maxWorkersPerScan: { value: 0, min: 0, max: 128 },
    autoscaleScanWorkersOnProviderCapacity: { value: true, type: 'boolean' },
    workspaceSetupConcurrency: { value: 2, min: 1, max: 32 },
    retryCount: { value: 2, min: 0, max: 10 },
    harnessTimeoutSeconds: { value: 7200, min: 60, max: 86400 },
  },
};

describe('runtime settings form helpers', () => {
  it('creates string drafts from API values', () => {
    expect(runtimeSettingsDraft(payload)).toEqual({
      workerCount: '2',
      maxConcurrentScans: '1',
      maxWorkersPerScan: '0',
      autoscaleScanWorkersOnProviderCapacity: true,
      workspaceSetupConcurrency: '2',
      retryCount: '2',
      harnessTimeoutSeconds: '7200',
    });
  });

  it('returns only changed numeric settings', () => {
    expect(
      runtimeSettingsPatch(payload, {
        ...runtimeSettingsDraft(payload),
        workerCount: '04',
        retryCount: '0',
      })
    ).toEqual({ workerCount: 4, retryCount: 0 });
  });

  it('returns a changed provider-capacity autoscale toggle', () => {
    expect(
      runtimeSettingsPatch(payload, {
        ...runtimeSettingsDraft(payload),
        autoscaleScanWorkersOnProviderCapacity: false,
      })
    ).toEqual({ autoscaleScanWorkersOnProviderCapacity: false });
  });

  it('rejects empty, fractional, and out-of-range values before saving', () => {
    const draft = {
      ...runtimeSettingsDraft(payload),
      workerCount: '',
      workspaceSetupConcurrency: '1.5',
      retryCount: '11',
    };
    expect(runtimeSettingsIssues(payload, draft)).toEqual({
      workerCount: 'Enter a whole number.',
      workspaceSetupConcurrency: 'Enter a whole number.',
      retryCount: 'Enter a value from 0 to 10.',
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

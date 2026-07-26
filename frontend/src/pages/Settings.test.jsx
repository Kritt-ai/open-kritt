import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../api/client.js', () => ({
  api: {},
  apiErrorMessages: (error) => [error?.message || 'Request failed.'],
}));

vi.mock('../lib/useFetch.js', () => ({
  useFetch: () => ({
    data: {
      generatedAt: '2026-07-23T09:32:36.330Z',
      settings: {
        workerCount: { value: 2, type: 'integer', min: 0, max: 128, recommendedMax: 10, valid: true, source: 'runtime_config', envKey: 'ENGINE_WORKER_COUNT', apply: 'live' },
        maxConcurrentScans: { value: 1, type: 'integer', min: 1, max: 128, recommendedMax: 4, valid: true, source: 'runtime_config', envKey: 'ENGINE_MAX_CONCURRENT_SCANS', apply: 'live' },
        maxWorkersPerScan: { value: 0, type: 'integer', min: 0, max: 128, recommendedMax: 10, valid: true, source: 'runtime_config', envKey: 'ENGINE_MAX_WORKERS_PER_SCAN', apply: 'live' },
        autoscaleScanWorkersOnProviderCapacity: { value: true, type: 'boolean', valid: true, source: 'runtime_config', envKey: 'ENGINE_AUTOSCALE_SCAN_WORKERS_ON_PROVIDER_CAPACITY', apply: 'live' },
        workspaceSetupConcurrency: { value: 2, type: 'integer', min: 1, max: 32, recommendedMax: 4, valid: true, source: 'runtime_config', envKey: 'ENGINE_WORKSPACE_SETUP_CONCURRENCY', apply: 'restart' },
        retryCount: { value: 2, type: 'integer', min: 0, max: 10, recommendedMax: 2, valid: true, source: 'runtime_config', envKey: 'ENGINE_RETRY_COUNT', apply: 'live' },
        harnessTimeoutSeconds: { value: 7200, type: 'integer', min: 60, max: 86400, recommendedMax: 7200, valid: true, source: 'runtime_config', envKey: 'ENGINE_HARNESS_TIMEOUT_SECONDS', apply: 'live' },
      },
      persistence: { runtimeConfig: true, projectEnvironment: false },
      warnings: [
        {
          source: 'project_environment',
          code: 'directory',
          severity: 'warning',
          message:
            'C:/Users/DELL/Documents/opencode/kritt-ai/open-kritt/.env is a directory, not a file. Built-in defaults remain active until the mount is corrected.',
        },
      ],
      capabilities: {
        dedicatedScanConcurrency: { available: true },
        perScanConcurrency: { available: true },
        automaticScanResume: { available: false, trackedBy: 'RETRY-01' },
      },
    },
    loading: false,
    error: null,
    reload: () => {},
    setData: () => {},
  }),
}));

vi.mock('../context/ui.jsx', () => ({
  usePageChrome: () => {},
}));

vi.mock('../lib/useUnsavedChangesPrompt.js', () => ({
  useUnsavedChangesPrompt: () => {},
}));

import Settings from './Settings.jsx';

describe('Settings page warnings', () => {
  it('renders backend warnings without the fatal error state', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Settings />
      </MemoryRouter>
    );

    expect(html).toContain('Built-in defaults remain active until the mount is corrected.');
    expect(html).not.toContain('Something went wrong');
  });
});

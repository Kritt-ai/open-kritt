import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { configuredModelCatalog } from '../lib/modelProviders.js';

import {
  activeJobDepthSummary,
  activeJobWorkflowDepth,
  formatActiveJobElapsed,
  loadModelReferences,
  mergeRunSettingsDraft,
  runSettingsDraft,
  runSettingsPayload,
  scanActions,
  scanFindingExportAvailability,
  supplementalFindingRunSummary,
  supplementalPostScriptAvailability,
  supplementalRunModelConfiguration,
  SupplementalPostScriptControls,
  ScanStatusPanel,
} from './ScanDetail.jsx';

const supplementalModelReferences = {
  providers: ['codex'],
  catalog: configuredModelCatalog({
    providers: [
      {
        provider: 'codex',
        input: 'select',
        status: 'ready',
        defaultModel: 'gpt-5-codex',
        models: [{ id: 'gpt-5-codex', thinkingEfforts: ['high'] }],
      },
    ],
  }),
  catalogError: null,
};
const supplementalModel = {
  model: 'gpt-5-codex',
  model_provider: 'codex',
  harness: 'codex',
  thinking_effort: 'high',
};

describe('supplemental post-script runs', () => {
  it('is available only for non-running scans with findings', () => {
    expect(supplementalPostScriptAvailability({ status: 'completed' }, [{ id: '1' }]).ready).toBe(true);
    expect(supplementalPostScriptAvailability({ status: 'paused' }, [{ id: '1' }]).ready).toBe(true);
    expect(supplementalPostScriptAvailability({ status: 'running' }, [{ id: '1' }]).ready).toBe(false);
    expect(supplementalPostScriptAvailability({ status: 'completed' }, []).ready).toBe(false);
  });

  it('preserves multiple run indicators and does not double-count a persisted enrichment', () => {
    expect(
      supplementalFindingRunSummary({ id: '31', enrichments: [{ supplementalRunId: '41' }] }, [
        { id: '41', targets: [{ vulnerabilityId: '31', status: 'completed' }] },
        { id: '42', targets: [{ vulnerabilityId: '31', status: 'running' }] },
        { id: '43', targets: [{ vulnerabilityId: '31', status: 'failed' }] },
      ])
    ).toEqual({ count: 3, active: 1, failed: 1 });
  });

  it('prefills a supplemental run from the scan post-processing model', () => {
    expect(
      supplementalRunModelConfiguration({
        model: 'workflow-model',
        modelProvider: 'openrouter',
        harness: 'codex',
        thinkingEffort: 'medium',
        postProcessingModel: 'gpt-5-codex',
        postProcessingModelProvider: 'codex',
        postProcessingHarness: 'codex',
        postProcessingThinkingEffort: 'high',
      })
    ).toEqual(supplementalModel);
  });

  it('renders required extra fields and live additive progress', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(SupplementalPostScriptControls, {
          availability: { ready: true, message: 'Ready' },
          mode: true,
          onBegin: () => {},
          onCancel: () => {},
          selectedCount: 2,
          totalCount: 3,
          allSelected: false,
          onToggleAll: () => {},
          postScripts: [{ id: '5', name: 'Report creator' }],
          postScriptsLoading: false,
          postScriptsError: null,
          onRetryPostScripts: () => {},
          selectedPostScriptId: '5',
          onSelectPostScript: () => {},
          requiredExtraKeys: ['network'],
          extra: { network: 'mainnet' },
          onExtraChange: () => {},
          model: supplementalModel,
          onModelChange: () => {},
          modelReferences: supplementalModelReferences,
          modelReferencesLoading: false,
          modelReferencesError: null,
          submitting: false,
          error: null,
          onSubmit: () => {},
          runs: [
            {
              id: '41',
              status: 'running',
              postScriptName: 'Report creator',
              model: 'gpt-5-codex',
              modelProvider: 'codex',
              harness: 'codex',
              thinkingEffort: 'high',
              targetCount: 4,
              completedCount: 2,
              failedCount: 0,
            },
          ],
          runsError: null,
          findings: [],
          retry: null,
        })
      )
    );

    expect(html).toContain('extra.network');
    expect(html).toContain('value="mainnet"');
    expect(html).toContain('Queue for 2 findings');
    expect(html).toContain('2/4 · 50%');
    expect(html).toContain('EXECUTION MODEL');
    expect(html).toContain('gpt-5-codex');
  });

  it('shows finding-level errors and a configurable failed-target retry', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(SupplementalPostScriptControls, {
          availability: { ready: true, message: 'Ready' },
          mode: false,
          runsError: null,
          runs: [
            {
              id: '41',
              status: 'completed_with_errors',
              postScriptName: 'Report creator',
              model: 'gpt-5-codex',
              modelProvider: 'codex',
              harness: 'codex',
              thinkingEffort: 'high',
              targetCount: 2,
              completedCount: 1,
              failedCount: 1,
              targets: [{ id: '51', vulnerabilityId: '31', status: 'failed', error: 'Model timed out.' }],
            },
          ],
          findings: [{ id: '31', rank: 2, summary: 'Unsafe call' }],
          scanId: '9',
          retry: { runId: '41', model: supplementalModel },
          onRetryModelChange: () => {},
          onCancelRetry: () => {},
          onSubmitRetry: () => {},
          retrySubmitting: false,
          retryError: null,
          modelReferences: supplementalModelReferences,
        })
      )
    );

    expect(html).toContain('View 1 error');
    expect(html).toContain('Finding #2: Unsafe call');
    expect(html).toContain('Model timed out.');
    expect(html).toContain('original script and extra values are reused');
    expect(html).toContain('Queue retry for 1');
  });
});

describe('scan model references', () => {
  it('keeps OpenRouter exact-ID editing available when catalog discovery fails', async () => {
    const catalogError = new Error('catalog unavailable');
    const references = await loadModelReferences(
      async () => ({ providers: ['openrouter'] }),
      async () => {
        throw catalogError;
      }
    );

    expect(references).toEqual({ providers: ['openrouter'], catalog: {}, catalogError });
  });

  it('still treats provider discovery failure as blocking', async () => {
    await expect(
      loadModelReferences(
        async () => {
          throw new Error('providers unavailable');
        },
        async () => ({ providers: [] })
      )
    ).rejects.toThrow('providers unavailable');
  });
});

describe('scan run settings', () => {
  const current = {
    model: 'gpt-5-codex',
    model_provider: 'codex',
    thinking_effort: 'medium',
    post_processing_model_override: false,
    post_processing_model: 'gpt-5-codex',
    post_processing_model_provider: 'codex',
    post_processing_harness: 'codex',
    post_processing_thinking_effort: 'low',
    harness: 'codex',
    model_overrides: {},
    job_limit: '250',
  };

  it('preserves the job limit when catalog normalization returns only model fields', () => {
    const catalogDraft = {
      model: 'gpt-5-codex',
      model_provider: 'codex',
      thinking_effort: 'medium',
      post_processing_model_override: false,
      post_processing_model: 'gpt-5-codex',
      post_processing_model_provider: 'codex',
      post_processing_harness: 'codex',
      post_processing_thinking_effort: 'low',
      harness: 'codex',
    };

    expect(mergeRunSettingsDraft(current, catalogDraft)).toEqual(current);
    expect(runSettingsPayload(catalogDraft, current)).toEqual({});
  });

  it('normalizes older scan records into complete string-valued drafts', () => {
    expect(runSettingsDraft({ model: 'legacy-model' })).toEqual({
      model: 'legacy-model',
      model_provider: 'openrouter',
      thinking_effort: 'medium',
      post_processing_model_override: false,
      post_processing_model: 'legacy-model',
      post_processing_model_provider: 'openrouter',
      post_processing_harness: 'codex',
      post_processing_thinking_effort: 'medium',
      harness: 'codex',
      model_overrides: {},
      job_limit: '',
    });
  });

  it('treats fields missing from a partial draft as unchanged', () => {
    expect(runSettingsPayload({ model: ' replacement-model ' }, current)).toEqual({ model: 'replacement-model' });
  });

  it('still supports setting and clearing a job limit', () => {
    expect(runSettingsPayload({ job_limit: ' 25 ' }, { ...current, job_limit: '' })).toEqual({ jobLimit: 25 });
    expect(runSettingsPayload({ job_limit: '' }, current)).toEqual({ jobLimit: null });
  });

  it('updates post-processing effort independently', () => {
    expect(runSettingsPayload({ post_processing_thinking_effort: 'medium' }, current)).toEqual({
      post_processing_thinking_effort: 'medium',
    });
  });

  it('sets and clears an independent post-processing model selection', () => {
    expect(
      runSettingsPayload(
        {
          post_processing_model_override: true,
          post_processing_model: 'claude-sonnet',
          post_processing_model_provider: 'claude',
          post_processing_harness: 'claude-code',
          post_processing_thinking_effort: 'high',
        },
        current
      )
    ).toEqual({
      post_processing_model: 'claude-sonnet',
      post_processing_model_provider: 'claude',
      post_processing_harness: 'claude-code',
      post_processing_thinking_effort: 'high',
    });

    expect(
      runSettingsPayload(
        { post_processing_model_override: false },
        {
          ...current,
          post_processing_model_override: true,
          post_processing_model: 'claude-sonnet',
          post_processing_model_provider: 'claude',
          post_processing_harness: 'claude-code',
        }
      )
    ).toEqual({
      post_processing_model: null,
      post_processing_model_provider: null,
      post_processing_harness: null,
    });
  });

  it('replaces or clears normalized workflow-depth model overrides', () => {
    const override = {
      1: {
        model: 'claude-sonnet',
        modelProvider: 'claude',
        harness: 'claude-code',
        thinkingEffort: 'high',
      },
    };
    expect(runSettingsPayload({ model_overrides: override }, current)).toEqual({
      model_overrides: {
        1: {
          model: 'claude-sonnet',
          model_provider: 'claude',
          harness: 'claude-code',
          thinking_effort: 'high',
        },
      },
    });
    expect(
      runSettingsPayload(
        { model_overrides: {} },
        {
          ...current,
          model_overrides: override,
        }
      )
    ).toEqual({ model_overrides: {} });
  });
});

describe('scan lifecycle actions', () => {
  it('offers stop controls without allowing active deletion', () => {
    expect(scanActions('running')).toMatchObject({
      canPause: true,
      canStop: true,
      canDelete: false,
    });
    expect(scanActions('queued')).toMatchObject({
      canStop: true,
      stopLabel: 'Cancel',
      canDelete: false,
    });
    expect(scanActions('rate_limited')).toMatchObject({
      canStop: true,
      stopLabel: 'Stop retrying',
    });
  });

  it('allows safe terminal and paused deletion', () => {
    expect(scanActions('paused')).toMatchObject({
      canResume: true,
      canStop: true,
      canDelete: true,
    });
    expect(scanActions('failed')).toMatchObject({
      canResume: true,
      canDelete: true,
    });
    expect(scanActions('stopped')).toMatchObject({
      canResume: true,
      canDelete: true,
    });
    expect(scanActions('completed')).toMatchObject({
      canResume: false,
      canDelete: true,
    });
  });

  it('exports completed findings and marks stopped or failed scans as partial', () => {
    expect(scanFindingExportAvailability({ status: 'completed', findings: 2 })).toMatchObject({
      ready: true,
      message: expect.stringMatching(/share-safe.*untrusted/),
    });
    expect(scanFindingExportAvailability({ status: 'stopped', findings: 2 })).toMatchObject({
      ready: true,
      message: expect.stringMatching(/partial export.*stopped/),
    });
    expect(scanFindingExportAvailability({ status: 'failed', findings: 2 })).toMatchObject({
      ready: true,
      message: expect.stringMatching(/partial export.*failed/),
    });
    expect(scanFindingExportAvailability({ status: 'post_processing', findings: 2 })).toMatchObject({
      ready: false,
      message: expect.stringContaining('stops'),
    });
    expect(scanFindingExportAvailability({ status: 'stopped', findings: 0 })).toMatchObject({
      ready: false,
      message: expect.stringContaining('no findings'),
    });
  });
});

describe('active worker presentation', () => {
  it('derives workflow depth explicitly and from legacy active-worker titles', () => {
    expect(activeJobWorkflowDepth({ depth: 3, title: '1 · ignored fallback' })).toBe(3);
    expect(activeJobWorkflowDepth({ title: '2 · Derive concrete exploit candidates' })).toBe(2);
    expect(activeJobWorkflowDepth({ kind: 'post_script', depth: 4, title: '4 · ignored' })).toBeNull();
    expect(activeJobWorkflowDepth({ title: 'Post processing' })).toBeNull();
  });

  it('summarizes active workers by depth in stable workflow order', () => {
    expect(
      activeJobDepthSummary([
        { depth: 2 },
        { title: '1 · Trace security-sensitive flows' },
        { depth: 2 },
        { kind: 'post_script', title: 'Report Creator' },
      ])
    ).toEqual([
      { key: 'depth-1', label: 'D1', depth: 1, count: 1 },
      { key: 'depth-2', label: 'D2', depth: 2, count: 2 },
      { key: 'post', label: 'POST', depth: null, count: 1 },
    ]);
  });

  it('formats active harness duration without implying that extended work is stuck', () => {
    expect(formatActiveJobElapsed(0)).toBe('<1s');
    expect(formatActiveJobElapsed(56 * 60 * 1000)).toBe('56m');
    expect(formatActiveJobElapsed((2 * 60 + 7) * 60 * 1000)).toBe('2h 7m');
  });

  it('renders every server-provided active worker', () => {
    const html = renderToStaticMarkup(
      createElement(ScanStatusPanel, {
        scan: {
          status: 'running',
          statusSummary: {
            totalAttempts: 10,
            activeJobs: Array.from({ length: 10 }, (_, index) => ({
              id: `worker-${index + 1}`,
              phaseLabel: 'Running harness',
              title: `Worker ${index + 1}`,
            })),
          },
        },
      })
    );

    expect(html).toContain('Worker 1');
    expect(html).toContain('Worker 10');
  });

  it('renders a complete depth-aware active-worker card', () => {
    const html = renderToStaticMarkup(
      createElement(ScanStatusPanel, {
        scan: {
          status: 'running',
          statusSummary: {
            totalAttempts: 1,
            activeJobs: [
              {
                id: '983',
                depth: 2,
                phaseLabel: 'Running harness',
                title: '2 · Derive concrete exploit candidates',
                elapsedMs: 56 * 60 * 1000,
                model: 'gpt-5.6-luna',
                modelProvider: 'codex',
                harness: 'codex',
                thinkingEffort: 'max',
              },
            ],
          },
        },
      })
    );

    expect(html).toContain('Active workers');
    expect(html).toContain('Depth 2: 1 active worker');
    expect(html).toContain('Workflow depth 2 worker');
    expect(html).toContain('D2');
    expect(html).toContain('longest 56m');
    expect(html).toContain('extended · 56m');
    expect(html).toContain('2 · Derive concrete exploit candidates');
    expect(html).toContain('Model: gpt-5.6-luna; Harness: Codex CLI');
    expect(html).toContain('gpt-5.6-luna');
    expect(html).toContain('Codex CLI');
    expect(html).toContain('white-space:normal');
    expect(html).toContain('overflow-wrap:anywhere');
    expect(html).toContain('The engine reports failures separately below.');
    expect(html).not.toContain('Stuck');
  });
});

describe('resumed scan error history', () => {
  it('keeps previous-run errors visible but muted and out of the current failure count', () => {
    const html = renderToStaticMarkup(
      createElement(ScanStatusPanel, {
        scan: {
          statusSummary: {
            totalAttempts: 1,
            currentFailedAttempts: 0,
            recentErrors: [
              {
                id: 'old-1',
                previousRun: true,
                source: 'Workflow',
                title: 'Step 1',
                phaseLabel: 'Failed',
                message: 'Old provider failure',
                knownError: {
                  title: 'Provider limit',
                  fixLinks: [{ label: 'Fix account', url: 'https://example.com' }],
                },
              },
            ],
          },
        },
      })
    );

    expect(html).toContain('Previous run');
    expect(html).toContain('Old provider failure');
    expect(html).not.toContain('Provider limit');
    expect(html).not.toContain('Fix account');
  });

  it('renders all five server-provided failure causes', () => {
    const html = renderToStaticMarkup(
      createElement(ScanStatusPanel, {
        scan: {
          statusSummary: {
            recentErrors: Array.from({ length: 5 }, (_, index) => ({
              id: `error-${index}`,
              source: 'Workflow',
              title: `Step ${index}`,
              phaseLabel: 'Failed',
              message: `Provider failure ${index}`,
            })),
          },
        },
      })
    );

    expect(html).toContain('Provider failure 4');
  });

  it('links account quota errors to usage and provider limits in Accounts', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ScanStatusPanel, {
          scan: {
            status: 'rate_limited',
            statusSummary: {
              recentErrors: [
                {
                  id: 'quota-1',
                  source: 'Workflow',
                  title: 'Step 54',
                  phaseLabel: 'Interrupted',
                  message: 'Account quota exhausted.',
                  knownError: {
                    title: 'Account quota exhausted',
                    fixLinks: [
                      {
                        label: 'View usage and limits in Accounts',
                        url: '/accounts',
                        internal: true,
                      },
                    ],
                  },
                },
              ],
            },
          },
        })
      )
    );

    expect(html).toContain('href="/accounts"');
    expect(html).toContain('View usage and limits in Accounts');
  });

  it('renders low-storage pause failures with the managed actionable message', () => {
    const html = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(ScanStatusPanel, {
          scan: {
            status: 'failed',
            statusSummary: {
              recentErrors: [
                {
                  id: 'storage-warning-1',
                  source: 'Scan',
                  title: 'Scan failure',
                  phaseLabel: 'Failed',
                  message:
                    'Low-storage pause failed. The engine ran low on disk space, then could not save its automatic pause warning. Free disk space, lower Minimum free storage, or enable Ignore low-storage safeguard in Settings, then resume the scan; completed work is preserved.',
                  knownError: {
                    key: 'storage_warning_persistence_failed',
                    title: 'Low-storage pause failed',
                    fixLinks: [{ label: 'Open Settings', url: '/settings', internal: true }],
                  },
                },
              ],
            },
          },
        })
      )
    );

    expect(html).toContain('Low-storage pause failed');
    expect(html).toContain('enable Ignore low-storage safeguard in Settings');
    expect(html).toContain('href="/settings"');
    expect(html).toContain('Open Settings');
    expect(html).not.toContain('cannot set path in scalar');
  });

  it('shows when each status error occurred', () => {
    const occurredAt = '2026-07-20T10:55:05.000Z';
    const label = new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(new Date(occurredAt));
    const html = renderToStaticMarkup(
      createElement(ScanStatusPanel, {
        scan: {
          statusSummary: {
            recentErrors: [
              {
                id: 'timestamped-error',
                source: 'Workflow',
                title: 'Step 1',
                phaseLabel: 'Failed',
                message: 'Provider failure',
                insertedAt: '2026-07-20T10:54:00.000Z',
                updatedAt: occurredAt,
              },
            ],
          },
        },
      })
    );

    expect(html).toContain(`<time dateTime="${occurredAt}"`);
    expect(html).toContain(label);
  });

  it('presents retained rate-limit attempt errors without a failed-scan label', () => {
    const html = renderToStaticMarkup(
      createElement(ScanStatusPanel, {
        scan: {
          status: 'rate_limited',
          statusSummary: {
            totalAttempts: 3,
            currentFailedAttempts: 3,
            recentErrors: [],
          },
        },
      })
    );

    expect(html).toContain('Attempt errors');
    expect(html).not.toContain('>Failed<');
  });
});

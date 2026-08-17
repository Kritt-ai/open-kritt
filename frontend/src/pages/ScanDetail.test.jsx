import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';

import {
  loadModelReferences,
  mergeRunSettingsDraft,
  runSettingsDraft,
  runSettingsPayload,
  scanActions,
  ScanStatusPanel,
} from './ScanDetail.jsx';

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
    harness: 'codex',
    job_limit: '250',
  };

  it('preserves the job limit when catalog normalization returns only model fields', () => {
    const catalogDraft = {
      model: 'gpt-5-codex',
      model_provider: 'codex',
      thinking_effort: 'medium',
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
      harness: 'codex',
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

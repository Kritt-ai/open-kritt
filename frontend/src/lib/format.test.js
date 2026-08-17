import { describe, expect, it } from 'vitest';

import {
  findingSeverity,
  providerCapacityAutoscalePresentation,
  rateLimitPresentation,
  rateLimitRetryText,
  sevColor,
  storageWarningPresentation,
  statusMeta,
} from './format.js';

describe('rate-limited scans', () => {
  it('has explicit status presentation and a deterministic retry summary', () => {
    expect(statusMeta('queued').label).toBe('Queued');
    expect(statusMeta('rate_limited').label).toBe('Rate limited');
    expect(
      rateLimitRetryText({ retry_count: 2, retry_after: '2026-07-19T12:10:00Z' }, Date.parse('2026-07-19T12:00:00Z'))
    ).toBe('Automatic retry #2 in 10m 00s.');
    expect(
      rateLimitRetryText({ retry_count: 2, retry_after: '2026-07-19T12:10:00Z' }, Date.parse('2026-07-19T12:09:42Z'))
    ).toBe('Automatic retry #2 in 18s.');
  });

  it('distinguishes provider capacity throttling from account quota exhaustion', () => {
    expect(statusMeta('rate_limited', { limit_kind: 'provider_throttled' }).label).toBe('Provider busy');
    expect(rateLimitPresentation({ limit_kind: 'provider_throttled' })).toMatchObject({
      accountRelated: false,
      label: 'Provider busy',
    });
    expect(statusMeta('rate_limited', { limit_kind: 'account_quota_limited' }).label).toBe('Quota exhausted');
    expect(rateLimitPresentation({ limit_kind: 'account_quota_limited' })).toMatchObject({
      accountRelated: true,
      label: 'Quota exhausted',
    });
  });

  it('summarizes a scan-specific provider capacity reduction', () => {
    expect(
      providerCapacityAutoscalePresentation({
        provider_capacity_autoscale_enabled: true,
        provider_capacity_initial_worker_cap: 20,
        provider_capacity_worker_cap: 18,
        provider_capacity_autoscale_events: 2,
      })
    ).toMatchObject({
      initialCap: 20,
      workerCap: 18,
      reductions: 2,
      compact: 'Provider-capacity autoscale: 20 → 18 workers',
    });
  });
});

describe('scan storage warning', () => {
  it('presents the persisted low-storage guard details', () => {
    expect(
      storageWarningPresentation({
        storage_warning: {
          code: 'low_storage',
          free_bytes: 12 * 1024 ** 3,
          required_bytes: 20 * 1024 ** 3,
        },
      })
    ).toMatchObject({
      code: 'low_storage',
      freeGiB: 12,
      requiredGiB: 20,
    });
  });

  it('returns no warning when the scan has no storage guard state', () => {
    expect(storageWarningPresentation(null)).toBeNull();
  });
});

describe('findingSeverity', () => {
  it('uses the ranker impact level when no post-script severity exists', () => {
    expect(findingSeverity({ bountyRank: { impactLevel: 'informational' } })).toBe('informational');
  });

  it('keeps an explicit post-script severity ahead of the ranker fallback', () => {
    expect(
      findingSeverity({
        severity: 'high',
        bountyRank: { impactLevel: 'informational' },
      })
    ).toBe('high');
  });
});

describe('sevColor', () => {
  it('recognizes the ranker informational label', () => {
    expect(sevColor('informational')).toBe('var(--text-3)');
  });
});

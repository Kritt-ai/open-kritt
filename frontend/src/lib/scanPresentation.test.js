import { describe, expect, it } from 'vitest';

import { defaultRankerIds, defaultWorkflowId, isScanDeletable, postOutputSummary } from './scanPresentation.js';

describe('defaultWorkflowId', () => {
  const workflows = [
    { id: '99', name: 'test replay' },
    { id: '2', name: 'external-flow-analysis', isDefault: true },
  ];

  it('uses an explicitly requested workflow', () => {
    expect(defaultWorkflowId(workflows, '99')).toBe('99');
  });

  it('prefers the stable built-in and otherwise requires explicit selection', () => {
    expect(defaultWorkflowId(workflows)).toBe('2');
    expect(defaultWorkflowId([{ id: '99', name: 'test replay' }])).toBe('');
  });
});

describe('postOutputSummary', () => {
  it('surfaces primary output even when no _chip field was emitted', () => {
    expect(postOutputSummary({ postScriptAnswer: { severity: 'Critical', explanation: 'reachable' } })).toEqual({
      label: 'severity',
      value: 'Critical',
    });
  });

  it('falls back to enrichment output', () => {
    expect(postOutputSummary({ enrichments: [{ result: { patched: false } }] })).toEqual({
      label: 'patched',
      value: 'false',
    });
  });
});

describe('defaultRankerIds', () => {
  it('selects API-marked defaults without replacing an existing choice', () => {
    const rankers = [
      { id: '1', isDefault: false },
      { id: '2', isDefault: true },
    ];
    expect(defaultRankerIds(rankers)).toEqual(['2']);
    expect(defaultRankerIds(rankers, ['1'])).toEqual(['1']);
  });
});

describe('isScanDeletable', () => {
  it('allows paused and terminal scans to be deleted', () => {
    expect(['paused', 'failed', 'stopped', 'completed'].every(isScanDeletable)).toBe(true);
  });

  it('keeps active and waiting scans from being deleted', () => {
    expect(
      ['queued', 'pending', 'prewarming_cache', 'running', 'rate_limited', 'post_processing'].some(isScanDeletable)
    ).toBe(false);
  });
});

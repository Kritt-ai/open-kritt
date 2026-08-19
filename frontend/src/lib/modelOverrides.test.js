import { describe, expect, it } from 'vitest';

import {
  enableModelOverrides,
  modelOverridesDraft,
  modelOverridesEqual,
  reconcileModelOverrides,
  resolvedModelConfiguration,
  workflowDepths,
} from './modelOverrides.js';

const fallback = {
  model: 'gpt-5-codex',
  model_provider: 'codex',
  harness: 'codex',
  thinking_effort: 'high',
};

describe('workflow depth model overrides', () => {
  it('normalizes API tuples and resolves a configured depth over the fallback', () => {
    const overrides = modelOverridesDraft({
      1: {
        model: 'claude-sonnet',
        modelProvider: 'claude',
        harness: 'claude-code',
        thinkingEffort: 'medium',
      },
    });

    expect(overrides).toEqual({
      1: {
        model: 'claude-sonnet',
        model_provider: 'claude',
        harness: 'claude-code',
        thinking_effort: 'medium',
      },
    });
    expect(resolvedModelConfiguration({ ...fallback, model_overrides: overrides }, 1)).toEqual(overrides[1]);
    expect(resolvedModelConfiguration({ ...fallback, model_overrides: overrides }, 0)).toEqual(fallback);
  });

  it('enables explicit configurations for every workflow depth', () => {
    const enabled = enableModelOverrides([2, 0, 1], fallback, {
      1: {
        model: 'claude-sonnet',
        model_provider: 'claude',
        harness: 'claude-code',
        thinking_effort: 'medium',
      },
    });

    expect(Object.keys(enabled)).toEqual(['0', '1', '2']);
    expect(enabled[0]).toEqual(fallback);
    expect(enabled[1].model).toBe('claude-sonnet');
    expect(enabled[2]).toEqual(fallback);
  });

  it('preserves custom mode across workflow changes while pruning removed depths', () => {
    const current = enableModelOverrides([0, 1, 2], fallback);
    expect(reconcileModelOverrides(current, [0, 1], fallback)).toEqual({
      0: fallback,
      1: fallback,
    });
    expect(reconcileModelOverrides({}, [0, 1], fallback)).toEqual({});
  });

  it('derives sorted unique depths and compares normalized maps', () => {
    expect(workflowDepths({ steps: [{ depth: 2 }, { depth: 0 }, { depth: 2 }, { depth: -1 }] })).toEqual([0, 2]);
    expect(
      modelOverridesEqual(
        { 1: { model: 'x', modelProvider: 'codex', harness: 'codex', thinkingEffort: 'high' } },
        { 1: { model: 'x', model_provider: 'codex', harness: 'codex', thinking_effort: 'high' } }
      )
    ).toBe(true);
  });
});

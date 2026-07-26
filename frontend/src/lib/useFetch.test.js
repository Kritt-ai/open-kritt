import { describe, expect, it } from 'vitest';
import { createLatestRequestGate } from './useFetch.js';

describe('createLatestRequestGate', () => {
  it('accepts only the newest in-flight request', () => {
    const gate = createLatestRequestGate();
    const initial = gate.begin();
    const poll = gate.begin();

    expect(gate.isCurrent(initial)).toBe(false);
    expect(gate.isCurrent(poll)).toBe(true);
  });

  it('invalidates an in-flight request when its consumer is disposed', () => {
    const gate = createLatestRequestGate();
    const request = gate.begin();

    gate.invalidate();

    expect(gate.isCurrent(request)).toBe(false);
  });

  it('does not start a background poll while the current request is pending', () => {
    const gate = createLatestRequestGate();
    const initial = gate.begin();

    expect(gate.begin({ background: true })).toBe(null);
    expect(gate.isCurrent(initial)).toBe(true);

    gate.finish(initial);
    const poll = gate.begin({ background: true });
    expect(poll).not.toBe(null);
    expect(gate.begin({ background: true })).toBe(null);
  });

  it('allows a foreground reload to supersede a pending poll', () => {
    const gate = createLatestRequestGate();
    const poll = gate.begin({ background: true });
    const reload = gate.begin();

    expect(gate.isCurrent(poll)).toBe(false);
    expect(gate.isCurrent(reload)).toBe(true);
  });
});

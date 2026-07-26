import { describe, it, expect } from 'vitest';
import { combineSeverityRanker, rankerRuleCount, rankerDescOf } from './severityRanker.js';

describe('severityRanker helpers', () => {
  it('combines rankers and custom rules with blank lines', () => {
    expect(combineSeverityRanker(['A', '', 'B'], '  custom  ')).toBe('A\n\nB\n\ncustom');
    expect(combineSeverityRanker([], '')).toBe('');
    expect(combineSeverityRanker(['only'], '')).toBe('only');
  });

  it('counts markdown rule lines', () => {
    expect(rankerRuleCount('# title\n1. a\n- b\n2. c\nplain text')).toBe(3);
    expect(rankerRuleCount('')).toBe(0);
  });

  it('derives a short plain-text description', () => {
    expect(rankerDescOf('# Ranking rules\n\n1. Downgrade.')).toContain('Ranking rules');
  });
});

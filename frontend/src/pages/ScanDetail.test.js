import { describe, expect, it } from 'vitest';
import { sortFindings } from './ScanDetail.jsx';

describe('sortFindings', () => {
  const findings = [
    { id: '1', rank: 1, severity: 'Low', malicious_input_example: '' },
    { id: '2', rank: 2, severity: 'Critical', postScriptAnswer: { _reserved_poc: 'curl …' } },
    { id: '3', rank: 3, severity: 'High', bountyRank: { rank: 9 } },
  ];

  it('sorts by severity and keeps stable order for ties', () => {
    expect(sortFindings(findings, 'severity', 'desc').map((item) => item.id)).toEqual(['2', '3', '1']);
    expect(sortFindings(findings, 'severity', 'asc').map((item) => item.id)).toEqual(['1', '3', '2']);
  });

  it('sorts findings with a PoC before findings without one', () => {
    expect(sortFindings(findings, 'poc', 'desc').map((item) => item.id)).toEqual(['2', '1', '3']);
  });
});

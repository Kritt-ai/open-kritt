import { describe, expect, it } from 'vitest';
import {
  INVESTIGATION_KINDS,
  investigationConfiguration,
  investigationKindRecommendation,
  investigationSummary,
} from './investigationKind.js';

describe('investigation kinds', () => {
  it('lists the five policy kinds with labels and descriptions', () => {
    expect(INVESTIGATION_KINDS.map((kind) => kind.value)).toEqual([
      'public_bounty',
      'audit_competition',
      'private_audit',
      'threat_model_validation',
      'internal_research',
    ]);
    for (const kind of INVESTIGATION_KINDS) {
      expect(kind.label.length).toBeGreaterThan(0);
      expect(kind.description.length).toBeGreaterThan(0);
    }
  });

  it('recommends a public bounty when a bounty URL extra is present', () => {
    const bounty = investigationKindRecommendation({ bug_bounty_url: 'https://example.com/program' });
    expect(bounty.value).toBe('public_bounty');
    expect(bounty.reason).toContain('bug_bounty_url');
    expect(investigationKindRecommendation({ bounty_url: 'x' }).value).toBe('public_bounty');
  });

  it('falls back to internal research otherwise', () => {
    for (const extra of [{}, null, undefined, { bug_bounty_url: '   ' }, { deployment_evidence: 'x' }]) {
      const recommendation = investigationKindRecommendation(extra);
      expect(recommendation.value).toBe('internal_research');
      expect(recommendation.reason.length).toBeGreaterThan(0);
    }
  });

  it('builds the three configuration keys with a user source', () => {
    expect(investigationConfiguration('private_audit', 'v2.7-impact-gate-1')).toEqual({
      investigation_kind: 'private_audit',
      investigation_kind_source: 'user',
      readiness_policy_version: 'v2.7-impact-gate-1',
    });
  });

  it('summarizes a scan configuration for the run settings row', () => {
    expect(
      investigationSummary({
        investigation_kind: 'public_bounty',
        investigation_kind_source: 'user',
        readiness_policy_version: 'v2.7-impact-gate-1',
      }).text
    ).toBe('public bounty · v2.7-impact-gate-1');
    expect(investigationSummary({}).text).toBe('internal research · legacy default');
    expect(investigationSummary(null).text).toBe('internal research · legacy default');
    expect(
      investigationSummary({ investigation_kind: 'private_audit', investigation_kind_source: 'legacy_default' }).text
    ).toBe('private audit · legacy default');
  });
});

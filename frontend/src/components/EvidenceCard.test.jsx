import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import EvidenceCard, { evidenceSummary, isEngineOwnedKey } from './EvidenceCard.jsx';

const scan = { id: '9', configuration: { v27_pipeline: { d3: '31', d4: '32', d5: '33' } } };

const d3 = {
  verdict: 'confirmed',
  scope_status: 'in_scope_verified',
  novelty_status: 'novel_verified',
  impact_objective: {
    claim: 'Anyone can drain the vault',
    source_type: 'bounty_rule',
    source_reference: 'Critical: theft of user funds',
    affected_subject: 'Vault depositors',
    terminal_outcome: 'Attacker balance increases by depositor funds',
    required_evidence: ['balance_before', 'balance_after'],
  },
  evidence_dimensions: [
    { tag: 'balance_before', status: 'required', rationale: '' },
    { tag: 'recipient_control', status: 'not_applicable', rationale: 'Attacker EOA is the recipient' },
  ],
  impact_chain_plan: [
    { id: 'h1', claim: 'Bypass the owner check', status: 'unverified', evidence_paths: [], covers: [], assessment: '' },
    { id: 'h2', claim: 'Withdraw to attacker', status: 'unverified', evidence_paths: [], covers: [], assessment: '' },
  ],
  unverified_assumptions: [
    { id: 'a1', assumption: 'Vault is deployed behind the proxy', kind: 'deployment', material: true, status: 'open' },
  ],
  _engine_lifecycle: { lifecycle_status: 'code_confirmed', policy_version: 'v2.7-impact-gate-1', legacy: false },
};

const d4 = {
  bug_status: 'reproduced',
  impact_status: 'partial',
  observed_terminal_outcome: 'Attacker balance increased by 1 wei',
  impact_chain: [
    {
      id: 'h1',
      claim: 'Bypass the owner check',
      status: 'proven',
      evidence_paths: ['logs/bypass.txt'],
      covers: ['balance_before'],
      assessment: '',
    },
    {
      id: 'h2',
      claim: 'Withdraw to attacker',
      status: 'partial',
      evidence_paths: ['logs/withdraw.txt', 'logs/missing.txt'],
      covers: [],
      assessment: 'Only dust <b>moved</b>',
    },
  ],
  missing_impact_links: ['h2'],
  unverified_assumptions: [
    { id: 'a1', assumption: 'Vault is deployed behind the proxy', kind: 'deployment', material: true, status: 'open' },
    { id: 'a2', assumption: 'Gas price is stable', kind: 'economic', material: false, status: 'open' },
  ],
  negative_control_status: 'passed',
  repeatability_status: 'deterministic',
  remaining_limits: 'Mainnet fork only',
  _engine_evidence: {
    bug_status: 'reproduced',
    impact_status: 'partial',
    artifact_dir: 'poc/9/1',
    captured_paths: ['logs/bypass.txt', 'logs/withdraw.txt'],
    unresolved_paths: ['logs/missing.txt'],
    capture_complete: true,
    lifecycle_status: 'impact_partial',
    policy_version: 'v2.7-impact-gate-1',
    legacy: false,
  },
};

const d5 = {
  submission_ready: true,
  scope_status: 'in_scope_verified',
  novelty_status: 'novel_verified',
  impact_match_status: 'partial',
  impact_evidence_status: 'insufficient',
  impact_mapping: [
    {
      required_outcome: 'Depositor funds move to attacker',
      observed_outcome: 'Dust moved to attacker',
      status: 'missing',
      evidence_paths: ['logs/withdraw.txt'],
    },
  ],
  missing_requirements: ['Full balance drain'],
  report_readiness_reason: 'Impact only partially proven',
  model_readiness_claim: true,
  _chip_lifecycle: 'impact_partial',
  _engine_readiness: {
    ready: false,
    label: 'submission_ready',
    lifecycle_status: 'impact_partial',
    blocking_reasons: ['impact_status is partial, expected proven', 'missing_impact_links is not empty: h2'],
    checks: {
      policy_version_supported: 'pass',
      investigation_kind_explicit: 'pass',
      d3_defined: 'pass',
      d4_bug_and_impact: 'fail',
      chain_complete: 'fail',
      provenance: 'pass',
      dimension_coverage: 'pass',
      d5_match: 'fail',
      scope_and_novelty: 'pass',
    },
    policy: 'public_bounty',
    policy_version: 'v2.7-impact-gate-1',
    evaluated_at: '2026-09-24T10:00:00Z',
    legacy: false,
  },
};

const vulnerability = {
  id: '1',
  readiness: {
    ready: false,
    label: 'submission_ready',
    lifecycleStatus: 'impact_partial',
    policyVersion: 'v2.7-impact-gate-1',
    legacy: false,
    blockingReasons: d5._engine_readiness.blocking_reasons,
    evidence: d4._engine_evidence,
    lifecycle: d3._engine_lifecycle,
    readiness: d5._engine_readiness,
  },
  enrichments: [
    { postScriptId: '31', postScriptName: 'v2.7 D3 Hostile Canonical Verification', result: d3 },
    { postScriptId: '32', postScriptName: 'v2.7 D4 Local PoC and Negative Control', result: d4 },
    { postScriptId: '33', postScriptName: 'v2.7 D5 Scope Severity and Report Readiness', result: d5 },
  ],
};

describe('evidenceSummary', () => {
  const summary = evidenceSummary(vulnerability, scan);

  it('groups enrichment results by the scan pipeline ids', () => {
    expect(summary.stages.d3).toBe(d3);
    expect(summary.stages.d4).toBe(d4);
    expect(summary.stages.d5).toBe(d5);
  });

  it('builds the dimensions row set from engine blocks and stage fields', () => {
    const rows = Object.fromEntries(summary.dimensions.map((row) => [row.label, row.value]));
    expect(rows.Bug).toBe('reproduced');
    expect(rows.Impact).toBe('partial');
    expect(rows['Terminal outcome']).toBe('observed');
    expect(rows.Deployment).toBe('1 open material assumption');
    expect(rows.Scope).toBe('in_scope_verified');
    expect(rows.Novelty).toBe('novel_verified');
    expect(rows.Readiness).toBe('submission_ready: not ready');
    expect(summary.dimensions.find((row) => row.label === 'Readiness').detail).toBe(
      'impact_status is partial, expected proven'
    );
  });

  it('places the required and observed terminal outcomes side by side', () => {
    expect(summary.outcome).toEqual({
      required: 'Attacker balance increases by depositor funds',
      observed: 'Attacker balance increased by 1 wei',
    });
  });

  it('marks chain evidence paths captured or unresolved from the engine evidence block', () => {
    expect(summary.chain.map((hop) => hop.id)).toEqual(['h1', 'h2']);
    expect(summary.chain[1].paths).toEqual([
      { path: 'logs/withdraw.txt', captured: true },
      { path: 'logs/missing.txt', captured: false },
    ]);
    expect(summary.chain[0].covers).toEqual(['balance_before']);
  });

  it('collects missing links, assumptions, the D5 mapping and normalized missing requirements', () => {
    expect(summary.missingLinks).toEqual(['h2']);
    expect(summary.assumptions.map((item) => item.id)).toEqual(['a1', 'a2']);
    expect(summary.mapping).toHaveLength(1);
    expect(summary.mapping[0].paths).toEqual([{ path: 'logs/withdraw.txt', captured: true }]);
    expect(summary.missingRequirements).toEqual(['Full balance drain']);
    expect(summary.reportReadinessReason).toBe('Impact only partially proven');
  });

  it('lists every blocking reason and the failed check names', () => {
    expect(summary.blockingReasons).toEqual(d5._engine_readiness.blocking_reasons);
    expect(summary.failedChecks).toEqual(['d4_bug_and_impact', 'chain_complete', 'd5_match']);
    expect(summary.modelReadinessClaim).toBe(true);
    expect(summary.legacy).toBe(false);
    expect(summary.lifecycleStatus).toBe('impact_partial');
    expect(summary.policyVersion).toBe('v2.7-impact-gate-1');
  });

  it('normalizes a legacy string missing_requirements and flags legacy blocks', () => {
    const legacyD5 = {
      ...d5,
      missing_requirements: 'Need a mainnet reproduction',
      _engine_readiness: { ...d5._engine_readiness, legacy: true },
    };
    const legacy = evidenceSummary(
      {
        ...vulnerability,
        readiness: { ...vulnerability.readiness, legacy: true, readiness: legacyD5._engine_readiness },
        enrichments: [
          vulnerability.enrichments[0],
          vulnerability.enrichments[1],
          { postScriptId: '33', result: legacyD5 },
        ],
      },
      scan
    );
    expect(legacy.missingRequirements).toEqual(['Need a mainnet reproduction']);
    expect(legacy.legacy).toBe(true);
    expect(
      evidenceSummary(
        { ...vulnerability, enrichments: [{ postScriptId: '33', result: { ...d5, missing_requirements: '' } }] },
        scan
      ).missingRequirements
    ).toEqual([]);
  });

  it('falls back to engine block presence when the scan has no pipeline ids', () => {
    const summary = evidenceSummary(
      { ...vulnerability, enrichments: vulnerability.enrichments },
      { configuration: {} }
    );
    expect(summary.stages.d3).toBe(d3);
    expect(summary.stages.d4).toBe(d4);
    expect(summary.stages.d5).toBe(d5);
  });

  it('survives a finding with readiness but no enrichments', () => {
    const summary = evidenceSummary(
      { readiness: { ...vulnerability.readiness, evidence: null, readiness: null } },
      scan
    );
    expect(summary.stages).toEqual({ d3: null, d4: null, d5: null });
    expect(summary.chain).toEqual([]);
    expect(summary.outcome).toEqual({ required: '', observed: '' });
    expect(Object.fromEntries(summary.dimensions.map((row) => [row.label, row.value])).Bug).toBe('—');
    expect(summary.blockingReasons).toEqual(vulnerability.readiness.blockingReasons);
  });
});

describe('EvidenceCard', () => {
  const html = renderToStaticMarkup(<EvidenceCard vulnerability={vulnerability} scan={scan} />);

  it('renders the dimensions, outcomes, chain, assumptions, mapping and blocking reasons', () => {
    expect(html).toContain('Evidence');
    expect(html).toContain('reproduced');
    expect(html).toContain('Attacker balance increases by depositor funds');
    expect(html).toContain('Attacker balance increased by 1 wei');
    expect(html).toContain('Bypass the owner check');
    expect(html).toContain('logs/withdraw.txt');
    expect(html).toContain('captured');
    expect(html).toContain('unresolved');
    expect(html).toContain('Vault is deployed behind the proxy');
    expect(html).toContain('Depositor funds move to attacker');
    expect(html).toContain('Full balance drain');
    expect(html).toContain('missing_impact_links is not empty: h2');
    expect(html).toContain('d4_bug_and_impact');
    expect(html).toContain('chain_complete');
    expect(html).toContain('impact_partial');
    expect(html).not.toContain('>legacy<');
  });

  it('escapes model-authored narrative', () => {
    expect(html).not.toContain('<b>moved</b>');
    expect(html).toContain('&lt;b&gt;moved&lt;/b&gt;');
  });

  it('shows the legacy badge when any used block was synthesized', () => {
    const legacyHtml = renderToStaticMarkup(
      <EvidenceCard
        vulnerability={{ ...vulnerability, readiness: { ...vulnerability.readiness, legacy: true } }}
        scan={scan}
      />
    );
    expect(legacyHtml).toContain('>legacy<');
  });

  it('renders nothing without readiness', () => {
    expect(renderToStaticMarkup(<EvidenceCard vulnerability={{ id: '1', readiness: null }} scan={scan} />)).toBe('');
  });
});

describe('isEngineOwnedKey', () => {
  it('matches engine blocks and the readiness bookkeeping keys only', () => {
    expect(isEngineOwnedKey('_engine_lifecycle')).toBe(true);
    expect(isEngineOwnedKey('_engine_readiness')).toBe(true);
    expect(isEngineOwnedKey('model_readiness_claim')).toBe(true);
    expect(isEngineOwnedKey('_chip_lifecycle')).toBe(true);
    expect(isEngineOwnedKey('_chip_verdict')).toBe(false);
    expect(isEngineOwnedKey('verdict')).toBe(false);
  });
});

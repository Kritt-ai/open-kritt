// Investigation kind — the explicit policy context a gated (v2.7) scan is judged
// under. The UI may recommend a kind from the scan extras but never commits one
// silently; the user must choose before the scan can be created.

import { hasExtraValue } from './scanExtras.js';

export const INVESTIGATION_KINDS = [
  {
    value: 'public_bounty',
    label: 'Public bounty',
    description: 'Findings are judged against a public program’s eligible-impact rules.',
  },
  {
    value: 'audit_competition',
    label: 'Audit competition',
    description: 'Findings are judged against the competition’s audit specification.',
  },
  {
    value: 'private_audit',
    label: 'Private audit',
    description: 'Findings are judged against the engagement scope agreed with the client.',
  },
  {
    value: 'threat_model_validation',
    label: 'Threat model validation',
    description: 'Findings validate or falsify claims from an existing threat model.',
  },
  {
    value: 'internal_research',
    label: 'Internal research',
    description: 'Exploratory research with no external program or submission target.',
  },
];

const BOUNTY_URL_KEY_RE = /bounty.*url|url.*bounty/i;

function bountyUrlExtraKey(extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return null;
  for (const [key, value] of Object.entries(extra)) {
    if (BOUNTY_URL_KEY_RE.test(key) && hasExtraValue(value)) return key;
  }
  return null;
}

// Pure helper: { value, reason }. Public bounty when a bounty URL extra carries a
// value, internal research otherwise.
export function investigationKindRecommendation(extra) {
  const bountyKey = bountyUrlExtraKey(extra);
  if (bountyKey) {
    return {
      value: 'public_bounty',
      reason: `The extra.${bountyKey} value points at a bounty program, so findings would be judged against its rules.`,
    };
  }
  return {
    value: 'internal_research',
    reason: 'No bounty URL extra is set, so no external program rules apply to the findings.',
  };
}

// The three configuration keys the backend snapshots for a gated scan.
export function investigationConfiguration(kind, readinessGate) {
  return {
    investigation_kind: kind,
    investigation_kind_source: 'user',
    readiness_policy_version: readinessGate,
  };
}

const kindText = (kind) => `${kind}`.replace(/_/g, ' ');

// Read-only summary of a scan's investigation settings. A scan created before
// the keys existed is read as internal research under the legacy default.
export function investigationSummary(configuration) {
  const config = configuration && typeof configuration === 'object' ? configuration : {};
  const kind =
    typeof config.investigation_kind === 'string' && config.investigation_kind ? config.investigation_kind : '';
  const source = kind ? config.investigation_kind_source || 'user' : 'legacy_default';
  const policyVersion = kind ? config.readiness_policy_version || '' : '';
  const legacy = source === 'legacy_default';
  const detail = legacy ? 'legacy default' : policyVersion || 'user';
  return {
    kind: kind || 'internal_research',
    source,
    policyVersion,
    legacy,
    text: `${kindText(kind || 'internal_research')} · ${detail}`,
  };
}

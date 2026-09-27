// Investigation kind and readiness-policy snapshot for gated (v2.7) scans.
// The user chooses the kind at creation; the backend records the source and
// the policy version so the engine can dispatch on the exact identifier.

import { ValidationError } from './validation.js';
import { READINESS_POLICY_VERSION } from './v27Pipeline.js';

export const INVESTIGATION_KINDS = [
  'public_bounty',
  'audit_competition',
  'private_audit',
  'threat_model_validation',
  'internal_research',
];
export const INVESTIGATION_KIND_SOURCES = ['user', 'legacy_default'];
export const INVESTIGATION_CONFIGURATION_KEYS = [
  'investigation_kind',
  'investigation_kind_source',
  'readiness_policy_version',
];

const isObjectMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// POST /api/scans: a gated workflow (non-null v27Pipeline) requires an explicit
// investigation kind and snapshots the source and policy version. Non-gated
// workflows leave the configuration untouched; no gate runs for them.
export function investigationKindForScan(configuration, v27Pipeline) {
  const input = isObjectMap(configuration) ? configuration : {};
  if (!v27Pipeline) return { configuration: input, errors: [] };

  const errors = [];
  const kind = input.investigation_kind;
  if (typeof kind !== 'string' || !INVESTIGATION_KINDS.includes(kind)) {
    errors.push({
      field: 'configuration.investigation_kind',
      message: `This workflow enforces a readiness gate; choose an investigation kind: ${INVESTIGATION_KINDS.join(', ')}.`,
    });
  }
  const policyVersion = v27Pipeline.readinessPolicyVersion ?? READINESS_POLICY_VERSION;
  const submittedVersion = input.readiness_policy_version;
  if (submittedVersion !== undefined && submittedVersion !== null && submittedVersion !== policyVersion) {
    errors.push({
      field: 'configuration.readiness_policy_version',
      message: `The selected workflow uses readiness policy "${policyVersion}".`,
    });
  }
  if (errors.length) return { configuration: input, errors };

  return {
    configuration: {
      ...input,
      investigation_kind: kind,
      investigation_kind_source: 'user',
      readiness_policy_version: policyVersion,
    },
    errors,
  };
}

// PATCH /api/scans/:id: the three keys are immutable after creation. They may be
// omitted or resubmitted with their exact existing values; additions, removals,
// and value changes are rejected with a field error.
export function assertImmutableInvestigationKeys(existing, incoming) {
  const current = isObjectMap(existing) ? existing : {};
  const next = isObjectMap(incoming) ? incoming : {};
  const errors = [];
  for (const key of INVESTIGATION_CONFIGURATION_KEYS) {
    if (!Object.hasOwn(next, key)) continue;
    const field = `configuration.${key}`;
    const value = next[key];
    const hasCurrent = Object.hasOwn(current, key) && current[key] !== undefined && current[key] !== null;
    if (value === undefined || value === null) {
      if (hasCurrent) errors.push({ field, message: `"${key}" cannot be removed after the scan is created.` });
      continue;
    }
    if (!hasCurrent) {
      errors.push({ field, message: `"${key}" is set when the scan is created and cannot be added later.` });
    } else if (value !== current[key]) {
      errors.push({ field, message: `"${key}" cannot be changed after the scan is created.` });
    }
  }
  if (errors.length) throw new ValidationError(errors);
}

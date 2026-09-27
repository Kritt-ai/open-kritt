import { ValidationError } from './validation.js';

export const V27_WORKFLOW_NAME = 'Recall-First External Flow Review v2.7';
// Identifier of the deterministic readiness policy the engine applies to
// findings of the v2.7 workflow. Snapshotted into each gated scan's
// configuration; the engine dispatches on the exact string.
export const READINESS_POLICY_VERSION = 'v2.7-impact-gate-1';
export const V27_POST_SCRIPT_NAMES = Object.freeze({
  d3: 'v2.7 D3 Hostile Canonical Verification',
  d4: 'v2.7 D4 Local PoC and Negative Control',
  d5: 'v2.7 D5 Scope Severity and Report Readiness',
});

// A scan snapshots the three immutable post-script IDs. Other workflows keep
// their ordinary post-script configuration and existing scans never change.
export async function resolveV27Pipeline(db, workflowId) {
  const workflow = await db.workflow.findUnique({
    where: { id: BigInt(workflowId) },
    select: { name: true },
  });
  if (workflow?.name !== V27_WORKFLOW_NAME) return null;

  const scripts = await db.postScript.findMany({
    where: { name: { in: Object.values(V27_POST_SCRIPT_NAMES) } },
    orderBy: { id: 'desc' },
    select: { id: true, name: true },
  });
  const ids = {};
  for (const [stage, name] of Object.entries(V27_POST_SCRIPT_NAMES)) {
    const script = scripts.find((candidate) => candidate.name === name);
    if (!script) {
      throw new ValidationError([
        { field: 'workflowId', message: `v2.7 requires post-script "${name}" before a scan can start.` },
      ]);
    }
    ids[stage] = script.id.toString();
  }
  return { ...ids, readinessPolicyVersion: READINESS_POLICY_VERSION };
}

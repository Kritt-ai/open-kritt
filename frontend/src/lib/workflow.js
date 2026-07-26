import { BUILTIN_KEYS, isMultiOutputDepthKey, multiOutputDepthKey } from './keys.js';

// Map of keys available to a step at a given depth: built-ins + every output key
// produced by a STRICTLY earlier depth. A batching consumer replaces all individual
// upstream outputs with multi_output_depth_<e>, while preserving prior batch keys.
// Returns Map(name -> source label).
export function availableKeysForDepth(steps, depth) {
  const map = new Map();
  BUILTIN_KEYS.forEach((k) => map.set(k, 'built-in'));
  const earlierDepths = [...new Set(steps.map((s) => s.depth))].filter((dp) => dp < depth).sort((a, b) => a - b);
  for (const dp of earlierDepths) {
    const consumer = steps.find((s) => s.depth === dp + 1);
    if (consumer && consumer.consumesAll) {
      for (const key of map.keys()) {
        if (!BUILTIN_KEYS.includes(key) && !isMultiOutputDepthKey(key)) map.delete(key);
      }
      map.set(multiOutputDepthKey(dp), `batch d${dp}`);
    } else {
      steps
        .filter((s) => s.depth === dp)
        .forEach((s) => Object.keys(s.outputFormat || {}).forEach((k) => map.set(k, `d${dp}`)));
    }
  }
  return map;
}

// Group a flat step list into ordered depth levels.
export function groupByDepth(steps) {
  const depths = [...new Set(steps.map((s) => s.depth))].sort((a, b) => a - b);
  return depths.map((depth) => {
    const levelSteps = steps.filter((s) => s.depth === depth);
    return {
      depth,
      steps: levelSteps,
      multiOutput: levelSteps[0]?.multiOutput || false,
      consumesAll: levelSteps[0]?.consumesAll || false,
    };
  });
}

// Workflow deletion is intentionally fail-closed. The API remains the source
// of truth and repeats this check under a database lock, but this state keeps
// unavailable actions out of the workflow list and explains them on detail.
export function workflowDeleteState(workflow) {
  if (!workflow || workflow.isDefault !== false) {
    return {
      canDelete: false,
      reason: workflow?.isDefault ? 'Built-in workflows cannot be deleted.' : 'Workflow usage is unavailable.',
    };
  }

  if (workflow.scanCount === 0) return { canDelete: true, reason: '' };

  if (Number.isInteger(workflow.scanCount) && workflow.scanCount > 0) {
    const scans = `${workflow.scanCount} scan${workflow.scanCount === 1 ? '' : 's'}`;
    const verb = workflow.scanCount === 1 ? 'uses' : 'use';
    return {
      canDelete: false,
      reason: `${scans} ${verb} this workflow. Workflows with scans cannot be deleted.`,
    };
  }

  return { canDelete: false, reason: 'Workflow usage is unavailable.' };
}

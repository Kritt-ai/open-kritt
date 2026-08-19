function isObjectMap(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function modelSelectionDraft(value = {}) {
  return {
    model: `${value?.model ?? ''}`,
    model_provider: `${value?.model_provider ?? value?.modelProvider ?? ''}`,
    harness: `${value?.harness ?? ''}`,
    thinking_effort: `${value?.thinking_effort ?? value?.thinkingEffort ?? ''}`,
  };
}

export function modelOverridesDraft(value) {
  if (!isObjectMap(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([depth, configuration]) =>
          /^(?:0|[1-9]\d*)$/.test(depth) && Number.isSafeInteger(Number(depth)) && isObjectMap(configuration)
      )
      .sort(([left], [right]) => Number(left) - Number(right))
      .map(([depth, configuration]) => [depth, modelSelectionDraft(configuration)])
  );
}

export function workflowDepths(workflow) {
  const source = Array.isArray(workflow?.depths)
    ? workflow.depths
    : Array.isArray(workflow?.steps)
      ? workflow.steps.map((step) => step?.depth)
      : [];
  return [...new Set(source.filter((depth) => Number.isSafeInteger(depth) && depth >= 0))].sort(
    (left, right) => left - right
  );
}

export function enableModelOverrides(depths, fallback, current = {}) {
  const existing = modelOverridesDraft(current);
  const fallbackSelection = modelSelectionDraft(fallback);
  return Object.fromEntries(
    [...new Set(depths)]
      .sort((left, right) => left - right)
      .map((depth) => [`${depth}`, existing[`${depth}`] || { ...fallbackSelection }])
  );
}

export function reconcileModelOverrides(current, depths, fallback) {
  const overrides = modelOverridesDraft(current);
  if (Object.keys(overrides).length === 0) return {};
  return enableModelOverrides(depths, fallback, overrides);
}

export function normalizeModelOverrides(current, normalizeSelection) {
  const overrides = modelOverridesDraft(current);
  return Object.fromEntries(
    Object.entries(overrides).map(([depth, configuration]) => [
      depth,
      modelSelectionDraft(normalizeSelection(configuration)),
    ])
  );
}

export function resolvedModelConfiguration(value, depth) {
  const overrides = modelOverridesDraft(value?.model_overrides ?? value?.modelOverrides);
  return overrides[`${depth}`] || modelSelectionDraft(value);
}

export function modelOverridesEqual(left, right) {
  return JSON.stringify(modelOverridesDraft(left)) === JSON.stringify(modelOverridesDraft(right));
}

export function defaultWorkflowId(workflows, requestedId = '') {
  const items = Array.isArray(workflows) ? workflows : [];
  if (requestedId && items.some((workflow) => workflow.id === requestedId)) return requestedId;
  return items.find((workflow) => workflow.isDefault)?.id || '';
}

export function defaultRankerIds(rankers, currentIds = []) {
  if (Array.isArray(currentIds) && currentIds.length) return currentIds;
  return (Array.isArray(rankers) ? rankers : []).filter((ranker) => ranker.isDefault).map((ranker) => ranker.id);
}

const DELETABLE_SCAN_STATUSES = new Set(['paused', 'failed', 'stopped', 'completed']);

export function isScanDeletable(status) {
  return DELETABLE_SCAN_STATUSES.has(status);
}

function resultSources(vulnerability) {
  const sources = [];
  const primary = vulnerability?.postScriptAnswer;
  if (primary && typeof primary === 'object' && Object.keys(primary).length) sources.push(primary);
  for (const enrichment of vulnerability?.enrichments || []) {
    const result = enrichment?.result;
    if (result && typeof result === 'object' && Object.keys(result).length) sources.push(result);
  }
  return sources;
}

export function postOutputSummary(vulnerability) {
  const sources = resultSources(vulnerability);
  const preferred = ['severity', 'ease_of_exploitability', 'patched', 'resource_exhaustion'];
  for (const key of preferred) {
    for (const result of sources) {
      const value = result[key];
      if (['string', 'number', 'boolean'].includes(typeof value)) return { label: key, value: String(value) };
    }
  }
  for (const result of sources) {
    for (const [key, value] of Object.entries(result)) {
      if (key.startsWith('_reserved_') || key.startsWith('_chip_')) continue;
      if (['string', 'number', 'boolean'].includes(typeof value)) return { label: key, value: String(value) };
    }
  }
  return sources.length
    ? { label: 'post-script', value: `${sources.length} output${sources.length === 1 ? '' : 's'}` }
    : null;
}

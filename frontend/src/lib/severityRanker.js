// Shared helpers for severity rankers.

// A short, plain-text blurb derived from a ranker's markdown content. Used as a
// fallback description on cards when none was authored.
export function rankerDescOf(content) {
  return (content || '')
    .replace(/[#*`>_-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

// Number of rule lines (markdown bullets or numbered items) in a ranker.
export function rankerRuleCount(content) {
  return (content || '').split('\n').filter((l) => /^\s*([-*]|\d+\.)\s/.test(l)).length;
}

// Concatenate selected rankers' content (in selection order) followed by any
// per-scan custom rules, joined with blank lines — the final severity_ranker.
export function combineSeverityRanker(rankerContents, customRules) {
  const parts = (rankerContents || []).filter((c) => c && c.trim());
  if (customRules && customRules.trim()) parts.push(customRules.trim());
  return parts.join('\n\n');
}

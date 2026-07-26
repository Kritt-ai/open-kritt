const CONFIGURATION_RELATION_KEYS = ['post_script_ids', 'post_scripts', 'agent_skill_ids', 'agent_skills'];

function uniqueIds(values) {
  return [...new Set(values.map((value) => `${value ?? ''}`.trim()).filter(Boolean))];
}

function postScriptIds(scan) {
  const configured = Array.isArray(scan.postScripts) ? scan.postScripts.map((postScript) => postScript?.id) : [];
  return uniqueIds([scan.postScriptId, ...configured]);
}

function agentSkillIds(scan) {
  if (Array.isArray(scan.agentSkillIds)) return uniqueIds(scan.agentSkillIds);
  if (!Array.isArray(scan.agentSkills)) return [];
  return uniqueIds(scan.agentSkills.map((skill) => skill?.id));
}

function editableConfiguration(configuration) {
  const copy =
    configuration && typeof configuration === 'object' && !Array.isArray(configuration) ? { ...configuration } : {};
  for (const key of CONFIGURATION_RELATION_KEYS) delete copy[key];
  return JSON.stringify(copy, null, 2);
}

function duplicateExtra(extra) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return {};
  return JSON.parse(JSON.stringify(extra));
}

function duplicateDependencies(dependencies) {
  if (!Array.isArray(dependencies)) return [];
  return dependencies.map((dependency) => {
    const kind = dependency?.kind === 'local' ? 'local' : 'remote';
    return {
      kind,
      repo_full: `${dependency?.repoFull ?? dependency?.repo_full ?? ''}`,
      commit_sha: kind === 'local' ? null : `${dependency?.commitSha ?? dependency?.commit_sha ?? ''}`,
    };
  });
}

/**
 * Build an editable new-scan draft from the reusable configuration of an
 * existing scan. The explicit allowlist is intentional: execution state,
 * results, attempts, logs, identifiers, and timestamps must never be copied.
 */
export function scanConfigurationDraft(scan) {
  if (!scan || typeof scan !== 'object') throw new TypeError('A source scan is required.');

  const repoKind = scan.repoKind === 'local' ? 'local' : 'remote';
  const selectedPostScriptIds = postScriptIds(scan);

  return {
    workflowId: `${scan.workflowId ?? ''}`,
    postScriptId: selectedPostScriptIds[0] || '',
    postScriptIds: selectedPostScriptIds,
    agentSkillIds: agentSkillIds(scan),
    repoKind,
    repoUrl: repoKind === 'remote' ? `${scan.repoFull ?? ''}` : '',
    repoLocal: repoKind === 'local' ? `${scan.repoFull ?? ''}` : '',
    commit_sha: repoKind === 'remote' ? `${scan.commitSha ?? ''}` : '',
    repo_scope: `${scan.repoScope ?? ''}`,
    dependencies: duplicateDependencies(scan.dependencies),
    configuration: editableConfiguration(scan.configuration),
    model: `${scan.model ?? ''}`,
    model_provider: `${scan.modelProvider ?? ''}`,
    harness: `${scan.harness ?? ''}`,
    thinking_effort: `${scan.thinkingEffort ?? ''}`,
    extra: duplicateExtra(scan.extra),
    // Scan records store only the effective combined ranker text, not the
    // original ranker ids. Keep that exact ruleset as editable custom rules.
    rankerIds: [],
    rankerExtra: `${scan.severityRanker ?? ''}`,
    jobLimit: scan.jobLimit == null ? '' : `${scan.jobLimit}`,
  };
}

export function duplicateScanPath(scanId) {
  return `/scans/new?from=${encodeURIComponent(`${scanId}`)}`;
}

export function newScanChooserPath() {
  return '/scans?new=1';
}

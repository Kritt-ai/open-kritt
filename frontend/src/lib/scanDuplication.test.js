import { describe, expect, it } from 'vitest';
import { duplicateScanPath, newScanChooserPath, scanConfigurationDraft } from './scanDuplication.js';

describe('scanConfigurationDraft', () => {
  it('copies reusable scan inputs and strips relationship metadata from configuration JSON', () => {
    const source = {
      id: '91',
      workflowId: '11',
      postScriptId: '21',
      postScripts: [
        { id: '22', primary: false },
        { id: '21', primary: true },
      ],
      agentSkillIds: ['31', '32'],
      repoKind: 'remote',
      repoFull: 'open-kritt/example',
      commitSha: 'abc123',
      repoScope: 'src and packages',
      dependencies: [
        { kind: 'remote', repoFull: 'open-kritt/library', commitSha: 'def456' },
        { kind: 'local', repoFull: 'local-library', commitSha: 'LOCAL_SNAPSHOT' },
      ],
      configuration: {
        max_files: 1200,
        include_tests: true,
        post_script_ids: ['21', '22'],
        agent_skill_ids: ['31', '32'],
      },
      model: 'gpt-5.4',
      modelProvider: 'codex',
      harness: 'codex',
      thinkingEffort: 'high',
      extra: { threat_model: { actor: 'anonymous user' } },
      severityRanker: '# Ranking rules',
      status: 'failed',
      findings: 8,
      statusSummary: { stepAttempts: 17 },
      jobLimit: 250,
      insertedAt: '2026-07-15T09:00:00Z',
    };

    const draft = scanConfigurationDraft(source);

    expect(draft).toEqual({
      workflowId: '11',
      postScriptId: '21',
      postScriptIds: ['21', '22'],
      agentSkillIds: ['31', '32'],
      repoKind: 'remote',
      repoUrl: 'open-kritt/example',
      repoLocal: '',
      commit_sha: 'abc123',
      repo_scope: 'src and packages',
      dependencies: [
        { kind: 'remote', repo_full: 'open-kritt/library', commit_sha: 'def456' },
        { kind: 'local', repo_full: 'local-library', commit_sha: null },
      ],
      configuration: JSON.stringify({ max_files: 1200, include_tests: true }, null, 2),
      model: 'gpt-5.4',
      model_provider: 'codex',
      harness: 'codex',
      thinking_effort: 'high',
      extra: { threat_model: { actor: 'anonymous user' } },
      rankerIds: [],
      rankerExtra: '# Ranking rules',
      jobLimit: '250',
    });
    expect(draft).not.toHaveProperty('id');
    expect(draft).not.toHaveProperty('status');
    expect(draft).not.toHaveProperty('findings');
    expect(draft).not.toHaveProperty('statusSummary');
    expect(draft).not.toHaveProperty('insertedAt');

    draft.extra.threat_model.actor = 'changed';
    expect(source.extra.threat_model.actor).toBe('anonymous user');
  });

  it('supports local targets and legacy expanded relationship records', () => {
    const draft = scanConfigurationDraft({
      workflowId: 7,
      postScriptId: 8,
      agentSkills: [{ id: 9 }],
      repoKind: 'local',
      repoFull: 'working-copy',
      repoScope: 'full repository',
      configuration: null,
      dependencies: [{ kind: 'remote', repo_full: 'org/dependency', commit_sha: 'HEAD' }],
    });

    expect(draft.postScriptIds).toEqual(['8']);
    expect(draft.agentSkillIds).toEqual(['9']);
    expect(draft.repoUrl).toBe('');
    expect(draft.repoLocal).toBe('working-copy');
    expect(draft.commit_sha).toBe('');
    expect(draft.configuration).toBe('{}');
    expect(draft.dependencies).toEqual([{ kind: 'remote', repo_full: 'org/dependency', commit_sha: 'HEAD' }]);
  });

  it('requires a source scan', () => {
    expect(() => scanConfigurationDraft(null)).toThrow('A source scan is required.');
  });
});

describe('duplicateScanPath', () => {
  it('builds an encoded review URL', () => {
    expect(duplicateScanPath('91')).toBe('/scans/new?from=91');
    expect(duplicateScanPath('scan id')).toBe('/scans/new?from=scan%20id');
  });
});

describe('newScanChooserPath', () => {
  it('opens the new-scan chooser on the scan list', () => {
    expect(newScanChooserPath()).toBe('/scans?new=1');
  });
});

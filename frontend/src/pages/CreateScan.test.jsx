import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../api/client.js';
import {
  AgentSkillSearchInput,
  InvestigationKindField,
  LocalRepoFilePreflight,
  ScanLaunchDialog,
  createScanBlockedReason,
  scanLaunchChoiceRequired,
} from './CreateScan.jsx';

const readyChecks = {
  hasConfiguredProvider: true,
  modelConfigurationValid: true,
  workflowId: 'wf-1',
  postScriptCount: 1,
  targetValid: true,
  repoKind: 'remote',
  dependenciesValid: true,
  jobLimitValid: true,
  missingExtraCount: 0,
  readinessGate: null,
  investigationKind: '',
  rankerText: 'rank by impact',
};

describe('create scan blocked reason', () => {
  it('returns null when every check passes', () => {
    expect(createScanBlockedReason(readyChecks)).toBeNull();
  });

  it('requires an investigation kind on a gated workflow until one is chosen', () => {
    expect(createScanBlockedReason({ ...readyChecks, readinessGate: 'v2.7-impact-gate-1' })).toBe(
      'Choose the investigation kind'
    );
    expect(
      createScanBlockedReason({
        ...readyChecks,
        readinessGate: 'v2.7-impact-gate-1',
        investigationKind: 'private_audit',
      })
    ).toBeNull();
    expect(createScanBlockedReason({ ...readyChecks, investigationKind: '' })).toBeNull();
  });

  it('keeps the existing ordering of blocking reasons', () => {
    expect(createScanBlockedReason({ ...readyChecks, hasConfiguredProvider: false })).toBe(
      'Add a provider in Accounts'
    );
    expect(createScanBlockedReason({ ...readyChecks, modelConfigurationValid: false })).toBe(
      'Complete the model configuration'
    );
    expect(createScanBlockedReason({ ...readyChecks, workflowId: '' })).toBe('Select a workflow');
    expect(createScanBlockedReason({ ...readyChecks, postScriptCount: 0 })).toBe('Select a post-script');
    expect(createScanBlockedReason({ ...readyChecks, targetValid: false })).toBe('Enter a valid repo');
    expect(createScanBlockedReason({ ...readyChecks, targetValid: false, repoKind: 'local' })).toBe(
      'Select a local repository'
    );
    expect(createScanBlockedReason({ ...readyChecks, dependenciesValid: false })).toBe('Fix dependency rows');
    expect(createScanBlockedReason({ ...readyChecks, jobLimitValid: false })).toBe('Fix maximum model jobs');
    expect(createScanBlockedReason({ ...readyChecks, missingExtraCount: 2 })).toBe('Fill 2 required extra');
    expect(createScanBlockedReason({ ...readyChecks, missingExtraCount: 1, readinessGate: 'v2.7-impact-gate-1' })).toBe(
      'Fill 1 required extra'
    );
    expect(createScanBlockedReason({ ...readyChecks, rankerText: '  ' })).toBe('Add severity ranking rules');
  });
});

describe('investigation kind field', () => {
  it('starts with no value, lists every kind, and shows the recommendation hint', () => {
    const html = renderToStaticMarkup(
      createElement(InvestigationKindField, {
        value: '',
        extra: { bug_bounty_url: 'https://example.com/program' },
        onChange: () => {},
      })
    );
    expect(html).toContain('aria-label="Investigation kind"');
    expect(html).toMatch(/<option value="" (selected="")?[^>]*>Choose the investigation kind<\/option>/);
    expect(html).not.toMatch(/<option value="[a-z_]+" selected/);
    expect(html).toContain('<option value="public_bounty">Public bounty</option>');
    expect(html).toContain('<option value="internal_research">Internal research</option>');
    expect(html).toContain('Recommended: Public bounty');
    expect(html).toContain('extra.bug_bounty_url');
    expect(html).toContain('Choose the investigation kind');
  });

  it('reflects the chosen kind and its description', () => {
    const html = renderToStaticMarkup(
      createElement(InvestigationKindField, { value: 'private_audit', extra: {}, onChange: () => {} })
    );
    expect(html).toMatch(/<option value="private_audit" selected="">Private audit<\/option>/);
    expect(html).toContain('engagement scope');
    expect(html).toContain('Recommended: Internal research');
  });
});

describe('scan launch choice', () => {
  it('recognizes only the structured active-scan conflict', () => {
    expect(
      scanLaunchChoiceRequired(
        new ApiError('Choose a launch policy.', 409, [{ field: 'launchPolicy', message: 'Choose one.' }])
      )
    ).toBe(true);
    expect(scanLaunchChoiceRequired(new ApiError('Conflict.', 409))).toBe(false);
    expect(
      scanLaunchChoiceRequired(
        new ApiError('Choose a launch policy.', 422, [{ field: 'launchPolicy', message: 'Choose one.' }])
      )
    ).toBe(false);
  });

  it('offers concurrent and queued launch choices', () => {
    const html = renderToStaticMarkup(
      createElement(ScanLaunchDialog, {
        onClose: () => {},
        onChoose: () => {},
      })
    );

    expect(html).toContain('A scan is already running');
    expect(html).toContain('Start immediately');
    expect(html).toContain('Queue');
    expect(html).toContain('until capacity is available');
  });
});

describe('local repository file preflight', () => {
  it('shows an advisory comparison when the selected folder exceeds max_files', () => {
    const html = renderToStaticMarkup(
      createElement(LocalRepoFilePreflight, {
        stats: { status: 'ready', fileCount: 4250, complete: true },
        configuration: '{"max_files":4000}',
        onRetry: () => {},
      })
    );

    expect(html).toContain('4,250 / 4,000 files');
    expect(html).toContain('250 files over max_files');
    expect(html).toContain('may fail or skip files');
    expect(html).toContain('snapshot is taken when the scan starts');
  });

  it('keeps a counting error non-blocking and offers retry', () => {
    const html = renderToStaticMarkup(
      createElement(LocalRepoFilePreflight, {
        stats: { status: 'error' },
        configuration: '{}',
        onRetry: () => {},
      })
    );

    expect(html).toContain('You can still create the scan');
    expect(html).toContain('Retry count');
  });

  it('does not flash the previous repository count while a new selection loads', () => {
    const html = renderToStaticMarkup(
      createElement(LocalRepoFilePreflight, {
        stats: { repoName: 'first-repo', status: 'ready', fileCount: 42, complete: true },
        repoName: 'second-repo',
        configuration: '{"max_files":4000}',
        onRetry: () => {},
      })
    );

    expect(html).toContain('Counting snapshot files');
    expect(html).not.toContain('42 / 4,000 files');
  });

  it('does not imply an incomplete lower bound is within max_files', () => {
    const html = renderToStaticMarkup(
      createElement(LocalRepoFilePreflight, {
        stats: { status: 'ready', fileCount: 1000001, complete: false },
        configuration: '{"max_files":2000000}',
        onRetry: () => {},
      })
    );

    expect(html).toContain('cannot confirm');
    expect(html).not.toContain('data-file-count-progress');
  });

  it('warns when the folder currently contains snapshot-incompatible entries', () => {
    const html = renderToStaticMarkup(
      createElement(LocalRepoFilePreflight, {
        stats: {
          status: 'ready',
          fileCount: 12,
          complete: true,
          snapshotIssues: ['invalid_symlink', 'special_file'],
        },
        configuration: '{"max_files":4000}',
        onRetry: () => {},
      })
    );

    expect(html).toContain('absolute or out-of-root symlink');
    expect(html).toContain('unsupported special file');
    expect(html).toContain('scan is expected to fail');
  });
});

describe('agent skill search', () => {
  it('renders an accessible search field and clear action', () => {
    const html = renderToStaticMarkup(
      createElement(AgentSkillSearchInput, {
        value: 'rust',
        onChange: () => {},
        listId: 'skills-list',
      })
    );

    expect(html).toContain('role="searchbox"');
    expect(html).toContain('aria-label="Search agent skills"');
    expect(html).toContain('aria-controls="skills-list"');
    expect(html).toContain('Search by name, slug, description, or license');
    expect(html).toContain('aria-label="Clear agent skill search"');
  });

  it('hides the clear action for an empty query', () => {
    const html = renderToStaticMarkup(
      createElement(AgentSkillSearchInput, {
        value: '',
        onChange: () => {},
        listId: 'skills-list',
      })
    );

    expect(html).not.toContain('Clear agent skill search');
  });
});

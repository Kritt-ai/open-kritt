import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../api/client.js';
import {
  AgentSkillSearchInput,
  LocalRepoFilePreflight,
  ScanLaunchDialog,
  scanLaunchChoiceRequired,
} from './CreateScan.jsx';

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

  it('warns about snapshot-blocking special files', () => {
    const html = renderToStaticMarkup(
      createElement(LocalRepoFilePreflight, {
        stats: {
          status: 'ready',
          fileCount: 12,
          complete: true,
          snapshotIssues: ['special_file'],
        },
        configuration: '{"max_files":4000}',
        onRetry: () => {},
      })
    );

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

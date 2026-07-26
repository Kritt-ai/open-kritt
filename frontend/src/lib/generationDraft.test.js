import { describe, expect, it } from 'vitest';
import {
  postScriptDraftFromGeneration,
  resultFromCompletedGeneration,
  workflowBuilderFromGeneration,
} from './generationDraft.js';

describe('generation drafts', () => {
  it('accepts only a completed generation of the expected kind', () => {
    const result = { name: 'draft' };
    expect(resultFromCompletedGeneration({ status: 'completed', kind: 'workflow', result }, 'workflow')).toBe(result);
    expect(() =>
      resultFromCompletedGeneration({ status: 'failed', kind: 'workflow', error: 'invalid output' }, 'workflow')
    ).toThrow('invalid output');
    expect(() =>
      resultFromCompletedGeneration({ status: 'completed', kind: 'post_script', result }, 'workflow')
    ).toThrow('does not contain a workflow');
  });

  it('converts a workflow generation into editable builder state', () => {
    let id = 0;
    const builder = workflowBuilderFromGeneration(
      {
        name: 'external-impact-research',
        description: 'Find entrypoints, then research impact.',
        levels: [
          {
            depth: 1,
            multiOutput: true,
            consumesAll: false,
            outputFormat: { summary: 'string' },
            steps: [{ name: 'Research impact', content: 'Inspect {{entrypoints}}.' }],
          },
          {
            depth: 0,
            multiOutput: true,
            consumesAll: false,
            outputFormat: { entrypoints: 'array' },
            steps: [{ name: 'Discover entrypoints', content: 'Inspect {{repo_full}}.' }],
          },
        ],
      },
      () => `draft-${++id}`
    );

    expect(builder.name).toBe('external-impact-research');
    expect(builder.levels.map((level) => level.depth)).toEqual([0, 1]);
    expect(builder.levels[0].schema).toEqual([{ key: 'entrypoints', type: 'array' }]);
    expect(builder.levels[0].steps[0].id).toBe('draft-2');
    expect(builder.selStepId).toBe('draft-2');
  });

  it('converts a post-script generation into editor fields', () => {
    expect(
      postScriptDraftFromGeneration({
        name: 'exploitability-grade',
        description: 'Grades exploitability.',
        content: 'Assess {{summary}}.',
        outputFormat: { _chip_exploitable: 'boolean', reasoning: 'string' },
      })
    ).toEqual({
      name: 'exploitability-grade',
      description: 'Grades exploitability.',
      content: 'Assess {{summary}}.',
      rows: [
        { key: '_chip_exploitable', type: 'boolean' },
        { key: 'reasoning', type: 'string' },
      ],
    });
  });
});

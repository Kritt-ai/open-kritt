import { describe, expect, it } from 'vitest';
import { insertWorkflowDepthBefore, removeWorkflowStep, workflowDraftIsDirty } from './WorkflowBuilder.jsx';

const builder = { name: 'copy-of-source', description: '', levels: [] };

describe('workflowDraftIsDirty', () => {
  it('treats a duplicate or generated workflow as an unsaved draft', () => {
    const initial = JSON.stringify(builder);
    expect(workflowDraftIsDirty(builder, initial, true)).toBe(true);
  });

  it('compares ordinary editors with their loaded baseline', () => {
    const initial = JSON.stringify(builder);
    expect(workflowDraftIsDirty(builder, initial)).toBe(false);
    expect(workflowDraftIsDirty({ ...builder, name: 'changed' }, initial)).toBe(true);
  });
});

function linearBuilder() {
  return {
    name: 'linear-workflow',
    description: '',
    schemaMode: 'visual',
    selStepId: 'step-2',
    levels: [
      {
        depth: 0,
        multiOutput: true,
        consumesAll: false,
        schema: [{ key: 'entrypoints', type: 'array' }],
        steps: [{ id: 'step-0', name: 'Step 0', content: 'Map {{repo_full}}.' }],
      },
      {
        depth: 1,
        multiOutput: true,
        consumesAll: true,
        schema: [{ key: 'candidates', type: 'array' }],
        steps: [{ id: 'step-1', name: 'Step 1', content: 'Review {{ multi_output_depth_0 }}.' }],
      },
      {
        depth: 2,
        multiOutput: false,
        consumesAll: true,
        schema: [{ key: 'summary', type: 'string' }],
        steps: [
          {
            id: 'step-2',
            name: 'Step 2',
            content: 'Compare {{multi_output_depth_0}} with {{multi_output_depth_1}}.',
          },
        ],
      },
    ],
  };
}

describe('insertWorkflowDepthBefore', () => {
  it.each([
    [0, ['New step', 'Step 0', 'Step 1', 'Step 2']],
    [1, ['Step 0', 'New step', 'Step 1', 'Step 2']],
  ])('inserts at depth %i and shifts the existing workflow', (depth, expectedNames) => {
    const source = linearBuilder();
    const next = insertWorkflowDepthBefore(source, depth, 'step-3');

    expect(next.levels.map((level) => level.depth)).toEqual([0, 1, 2, 3]);
    expect(next.levels.map((level) => level.steps[0].name)).toEqual(expectedNames);
    expect(next.selStepId).toBe('step-3');
    expect(next.levels[depth]).toMatchObject({
      depth,
      multiOutput: true,
      consumesAll: false,
      schema: [],
      steps: [{ id: 'step-3', name: 'New step', content: '' }],
    });
    expect(source.levels.map((level) => level.depth)).toEqual([0, 1, 2]);
  });

  it('renumbers batch references whose consuming levels move', () => {
    const next = insertWorkflowDepthBefore(linearBuilder(), 1, 'inserted');

    expect(next.levels[2].steps[0].content).toBe('Review {{ multi_output_depth_1 }}.');
    expect(next.levels[3].steps[0].content).toBe('Compare {{multi_output_depth_1}} with {{multi_output_depth_2}}.');
  });

  it('leaves batch references above the insertion point unchanged', () => {
    const next = insertWorkflowDepthBefore(linearBuilder(), 2, 'inserted');

    expect(next.levels[1].steps[0].content).toBe('Review {{ multi_output_depth_0 }}.');
    expect(next.levels[3].steps[0].content).toBe('Compare {{multi_output_depth_0}} with {{multi_output_depth_2}}.');
  });

  it('rejects a depth that does not exist', () => {
    expect(() => insertWorkflowDepthBefore(linearBuilder(), 5, 'inserted')).toThrow(
      'Choose an existing workflow depth.'
    );
  });
});

function fourDepthBuilder() {
  return {
    name: 'four-depth-workflow',
    description: '',
    schemaMode: 'visual',
    selStepId: 'step-1',
    levels: [
      {
        depth: 0,
        multiOutput: true,
        consumesAll: false,
        schema: [{ key: 'roots', type: 'array' }],
        steps: [{ id: 'step-0', name: 'Step 0', content: 'Map {{repo_full}}.' }],
      },
      {
        depth: 1,
        multiOutput: true,
        consumesAll: false,
        schema: [{ key: 'candidates', type: 'array' }],
        steps: [{ id: 'step-1', name: 'Step 1', content: 'Find {{roots}}.' }],
      },
      {
        depth: 2,
        multiOutput: true,
        consumesAll: true,
        schema: [{ key: 'reviews', type: 'array' }],
        steps: [{ id: 'step-2', name: 'Step 2', content: 'Review {{multi_output_depth_1}}.' }],
      },
      {
        depth: 3,
        multiOutput: false,
        consumesAll: true,
        schema: [{ key: 'summary', type: 'string' }],
        steps: [
          {
            id: 'step-3',
            name: 'Step 3',
            content: 'Compare {{multi_output_depth_1}} with {{multi_output_depth_2}}.',
          },
        ],
      },
    ],
  };
}

describe('removeWorkflowStep', () => {
  it('removes an empty depth and shifts every later depth down', () => {
    const source = fourDepthBuilder();
    const next = removeWorkflowStep(source, 'step-1');

    expect(next.levels.map((level) => level.depth)).toEqual([0, 1, 2]);
    expect(next.levels.map((level) => level.steps[0].name)).toEqual(['Step 0', 'Step 2', 'Step 3']);
    expect(next.selStepId).toBe('step-2');
    expect(source.levels.map((level) => level.depth)).toEqual([0, 1, 2, 3]);
  });

  it('renumbers batch variables for every surviving batching boundary', () => {
    const next = removeWorkflowStep(fourDepthBuilder(), 'step-1');

    expect(next.levels[1].steps[0].content).toBe('Review {{multi_output_depth_0}}.');
    expect(next.levels[2].steps[0].content).toBe('Compare {{multi_output_depth_0}} with {{multi_output_depth_1}}.');
  });

  it('removes a sibling without changing any depth numbers', () => {
    const source = fourDepthBuilder();
    source.levels[1].steps.push({ id: 'step-1b', name: 'Step 1b', content: 'Find more {{roots}}.' });

    const next = removeWorkflowStep(source, 'step-1');

    expect(next.levels.map((level) => level.depth)).toEqual([0, 1, 2, 3]);
    expect(next.levels[1].steps.map((step) => step.id)).toEqual(['step-1b']);
    expect(next.selStepId).toBe('step-1b');
    expect(next.levels[2].steps[0].content).toBe('Review {{multi_output_depth_1}}.');
  });

  it('promotes depth 1 to the root without leaving consume-all enabled', () => {
    const source = fourDepthBuilder();
    source.selStepId = 'step-0';
    source.levels[1].consumesAll = true;
    source.levels[1].steps[0].content = 'Batch {{multi_output_depth_0}}.';

    const next = removeWorkflowStep(source, 'step-0');

    expect(next.levels.map((level) => level.depth)).toEqual([0, 1, 2]);
    expect(next.levels[0].consumesAll).toBe(false);
    expect(next.levels[0].steps[0].content).toBe('Batch {{multi_output_depth_0}}.');
    expect(next.levels[1].steps[0].content).toBe('Review {{multi_output_depth_0}}.');
    expect(next.levels[2].steps[0].content).toBe('Compare {{multi_output_depth_0}} with {{multi_output_depth_1}}.');
  });

  it("does not delete the workflow's only step", () => {
    const source = fourDepthBuilder();
    source.levels = [source.levels[0]];
    source.selStepId = 'step-0';

    expect(removeWorkflowStep(source, 'step-0')).toEqual(source);
  });
});

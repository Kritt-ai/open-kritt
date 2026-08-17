import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import {
  builderFromWorkflow,
  insertWorkflowDepthBefore,
  removeWorkflowStep,
  saveWorkflowDraft,
  setWorkflowDepthBinding,
  setWorkflowStepBinding,
  WorkflowDuplicateDialog,
  workflowBindingErrors,
  workflowBindingRouteToken,
  workflowCanShowBindRouting,
  workflowDraftIsDirty,
  workflowDuplicatePrompt,
  workflowNeedsDuplicate,
  workflowStepBindingMarkers,
} from './WorkflowBuilder.jsx';

const builder = {
  name: 'copy-of-source',
  description: '',
  extra: [],
  includeContextFiles: false,
  dedupeStep3: false,
  levels: [],
};

describe('workflowDraftIsDirty', () => {
  it('treats a duplicate or generated workflow as an unsaved draft', () => {
    const initial = JSON.stringify(builder);
    expect(workflowDraftIsDirty(builder, initial, true)).toBe(true);
  });

  it('compares ordinary editors with their loaded baseline', () => {
    const initial = JSON.stringify(builder);
    expect(workflowDraftIsDirty(builder, initial)).toBe(false);
    expect(workflowDraftIsDirty({ ...builder, name: 'changed' }, initial)).toBe(true);
    expect(workflowDraftIsDirty({ ...builder, includeContextFiles: true }, initial)).toBe(true);
    expect(workflowDraftIsDirty({ ...builder, dedupeStep3: true }, initial)).toBe(true);
  });
});

describe('saveWorkflowDraft', () => {
  const payload = { name: 'carefully-edited', levels: [{ depth: 0 }] };
  const conflict = () =>
    new ApiError('Workflow is in use.', 409, [], {
      code: 'workflow_in_use',
      scanCount: 5,
    });

  it('offers to preserve an in-use workflow edit as a duplicate', async () => {
    const updateWorkflow = vi.fn().mockRejectedValue(conflict());
    const createWorkflow = vi.fn().mockResolvedValue({ id: 'new-workflow' });
    const confirmDuplicate = vi.fn().mockReturnValue(true);

    await expect(
      saveWorkflowDraft({ id: 'used-workflow', payload, updateWorkflow, createWorkflow, confirmDuplicate })
    ).resolves.toEqual({ id: 'new-workflow' });

    expect(updateWorkflow).toHaveBeenCalledWith('used-workflow', payload);
    expect(confirmDuplicate).toHaveBeenCalledWith(
      'This workflow cannot be edited because it is used by 5 scans.\n\nSave a duplicate with your changes instead?'
    );
    expect(createWorkflow).toHaveBeenCalledWith(payload);
  });

  it('keeps the unsaved draft in place when duplication is declined', async () => {
    const createWorkflow = vi.fn();

    await expect(
      saveWorkflowDraft({
        id: 'used-workflow',
        payload,
        updateWorkflow: vi.fn().mockRejectedValue(conflict()),
        createWorkflow,
        confirmDuplicate: vi.fn().mockReturnValue(false),
      })
    ).resolves.toBeNull();

    expect(createWorkflow).not.toHaveBeenCalled();
  });

  it('does not turn unrelated conflicts into duplicates', async () => {
    const error = new ApiError('Another conflict.', 409);
    const confirmDuplicate = vi.fn();

    await expect(
      saveWorkflowDraft({
        id: 'used-workflow',
        payload,
        updateWorkflow: vi.fn().mockRejectedValue(error),
        createWorkflow: vi.fn(),
        confirmDuplicate,
      })
    ).rejects.toBe(error);

    expect(workflowNeedsDuplicate(error)).toBe(false);
    expect(confirmDuplicate).not.toHaveBeenCalled();
  });

  it('uses singular scan wording in the confirmation', () => {
    const error = new ApiError('Workflow is in use.', 409, [], { code: 'workflow_in_use', scanCount: 1 });

    expect(workflowDuplicatePrompt(error)).toContain('used by 1 scan');
  });

  it('renders the duplicate choice as an accessible in-app dialog', () => {
    const html = renderToStaticMarkup(
      createElement(WorkflowDuplicateDialog, {
        message: 'This workflow cannot be edited because it is used by 5 scans.',
        saving: false,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      })
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('Workflow already in use');
    expect(html).toContain('Keep editing');
    expect(html).toContain('Save duplicate');
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

  it('turns off step 3 dedupe when removing a depth leaves no depth 2', () => {
    const source = linearBuilder();
    source.dedupeStep3 = true;

    const next = removeWorkflowStep(source, 'step-1');

    expect(next.levels.map((level) => level.depth)).toEqual([0, 1]);
    expect(next.dedupeStep3).toBe(false);
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

function siblingBuilder() {
  return {
    name: 'sibling-workflow',
    description: '',
    schemaMode: 'visual',
    selStepId: 'source-a',
    levels: [
      {
        depth: 0,
        multiOutput: true,
        consumesAll: false,
        bindPrevious: false,
        schema: [{ key: 'candidate', type: 'string' }],
        steps: [
          { id: 'source-a', name: 'Source A', content: 'A', boundSourceStepId: null },
          { id: 'source-b', name: 'Source B', content: 'B', boundSourceStepId: null },
        ],
      },
      {
        depth: 1,
        multiOutput: true,
        consumesAll: true,
        bindPrevious: false,
        schema: [{ key: 'finding', type: 'string' }],
        steps: [
          { id: 'destination-a', name: 'Destination A', content: 'A', boundSourceStepId: null },
          { id: 'destination-b', name: 'Destination B', content: 'B', boundSourceStepId: null },
        ],
      },
    ],
  };
}

describe('bound sibling routing', () => {
  it('enables a complete one-to-one mapping and turns off batching', () => {
    const next = setWorkflowDepthBinding(siblingBuilder(), 0, true);

    expect(next.levels[1].bindPrevious).toBe(true);
    expect(next.levels[1].consumesAll).toBe(false);
    expect(next.levels[1].steps.map((step) => step.boundSourceStepId)).toEqual(['source-a', 'source-b']);
    expect(workflowBindingErrors(next.levels)).toEqual([]);
  });

  it('refuses to enable bind routing until both depths have equal sibling counts', () => {
    const source = siblingBuilder();
    source.levels[1].steps.pop();

    expect(() => setWorkflowDepthBinding(source, 0, true)).toThrow('same number of steps');
  });

  it('swaps occupied sources so manual remapping stays one-to-one', () => {
    const bound = setWorkflowDepthBinding(siblingBuilder(), 0, true);
    const next = setWorkflowStepBinding(bound, 1, 'destination-a', 'source-b');

    expect(next.levels[1].steps.map((step) => step.boundSourceStepId)).toEqual(['source-b', 'source-a']);
    expect(workflowBindingErrors(next.levels)).toEqual([]);
  });

  it('gives both sides of a remapped pair the same visual route marker', () => {
    const bound = setWorkflowDepthBinding(siblingBuilder(), 0, true);
    const remapped = setWorkflowStepBinding(bound, 1, 'destination-a', 'source-b');

    const sourceMarkers = workflowStepBindingMarkers(remapped.levels, 0, 'source-b');
    const destinationMarkers = workflowStepBindingMarkers(remapped.levels, 1, 'destination-a');

    expect(sourceMarkers.outgoing).toMatchObject({ number: 2, peer: { id: 'destination-a' } });
    expect(destinationMarkers.incoming).toMatchObject({ number: 2, peer: { id: 'source-b' } });
    expect(sourceMarkers.outgoing.color).toBe(destinationMarkers.incoming.color);
    expect(sourceMarkers.outgoing.background).toBe(destinationMarkers.incoming.background);
  });

  it('keeps route labels unique when the visual palette repeats', () => {
    expect(workflowBindingRouteToken(0)).toMatchObject({ number: 1, color: 'var(--depth-1)' });
    expect(workflowBindingRouteToken(6)).toMatchObject({ number: 7, color: 'var(--depth-1)' });
  });

  it('turns bind off when a source sibling removal invalidates the mapping', () => {
    const bound = setWorkflowDepthBinding(siblingBuilder(), 0, true);
    const next = removeWorkflowStep(bound, 'source-b');

    expect(next.levels[1].bindPrevious).toBe(false);
    expect(next.levels[1].steps.every((step) => step.boundSourceStepId === null)).toBe(true);
    expect(workflowBindingErrors(next.levels)).toEqual([]);
  });

  it('turns bind off when a destination sibling removal invalidates the mapping', () => {
    const bound = setWorkflowDepthBinding(siblingBuilder(), 0, true);
    const next = removeWorkflowStep(bound, 'destination-b');

    expect(next.levels[1].bindPrevious).toBe(false);
    expect(next.levels[1].steps[0].boundSourceStepId).toBeNull();
    expect(workflowBindingErrors(next.levels)).toEqual([]);
  });

  it('requires at least two siblings on each side of a bound transition', () => {
    const source = siblingBuilder();
    source.levels[0].steps = source.levels[0].steps.slice(0, 1);
    source.levels[1].steps = source.levels[1].steps.slice(0, 1);

    expect(() => setWorkflowDepthBinding(source, 0, true)).toThrow('at least two steps');
    expect(workflowCanShowBindRouting(source.levels[0], source.levels[1])).toBe(false);
    expect(workflowCanShowBindRouting(siblingBuilder().levels[0], siblingBuilder().levels[1])).toBe(true);
  });

  it('clears the mapping when bind routing is turned off', () => {
    const bound = setWorkflowDepthBinding(siblingBuilder(), 0, true);
    const next = setWorkflowDepthBinding(bound, 0, false);

    expect(next.levels[1].bindPrevious).toBe(false);
    expect(next.levels[1].steps.every((step) => step.boundSourceStepId === null)).toBe(true);
  });

  it('remaps bound source IDs when a workflow is duplicated', () => {
    const workflow = {
      name: 'source',
      description: '',
      steps: [
        {
          id: '10',
          depth: 0,
          name: 'Source A',
          content: 'Source A',
          multiOutput: true,
          consumesAll: false,
          outputFormat: { candidate: 'string' },
        },
        {
          id: '11',
          depth: 0,
          name: 'Source B',
          content: 'Source B',
          multiOutput: true,
          consumesAll: false,
          outputFormat: { candidate: 'string' },
        },
        {
          id: '20',
          depth: 1,
          name: 'Destination A',
          content: 'Destination A',
          multiOutput: true,
          consumesAll: false,
          boundSourceStepId: '10',
          outputFormat: { finding: 'string' },
        },
        {
          id: '21',
          depth: 1,
          name: 'Destination B',
          content: 'Destination B',
          multiOutput: true,
          consumesAll: false,
          boundSourceStepId: '11',
          outputFormat: { finding: 'string' },
        },
      ],
    };

    const copy = builderFromWorkflow(workflow, { copy: true });
    const [copiedSourceA, copiedSourceB] = copy.levels[0].steps;
    const [copiedDestinationA, copiedDestinationB] = copy.levels[1].steps;

    expect(copiedSourceA.id).not.toBe('10');
    expect(copiedDestinationA.id).not.toBe('20');
    expect(copiedDestinationA.boundSourceStepId).toBe(copiedSourceA.id);
    expect(copiedDestinationB.boundSourceStepId).toBe(copiedSourceB.id);
    expect(copy.levels[1].bindPrevious).toBe(true);
    expect(workflowBindingErrors(copy.levels)).toEqual([]);
  });
});

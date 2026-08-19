import { describe, expect, it } from 'vitest';
import {
  createWorkflowExport,
  parseWorkflowImport,
  workflowExportFilename,
  workflowPayloadFromImport,
} from './workflowTransfer.js';

const terminalFormat = {
  explanation: 'string',
  file_path: 'string',
  line: 'number',
  malicious_input_example: 'string',
  summary: 'string',
  trigger_flow: 'array',
  vulnerability_type: 'string',
  malicious_actor: 'string',
};

describe('workflow transfer files', () => {
  it('exports only portable workflow configuration grouped by depth', () => {
    const exported = createWorkflowExport({
      id: '701',
      name: 'Endpoint inventory',
      description: 'Map public application endpoints.',
      insertedAt: '2026-07-20T00:00:00Z',
      scanCount: 9,
      steps: [
        {
          id: '703',
          name: 'Summarize',
          depth: 1,
          multiOutput: false,
          consumesAll: true,
          isLast: true,
          outputFormat: terminalFormat,
          outputTable: 'workflows.vulnerabilities',
          content: 'Summarize {{multi_output_depth_0}}.',
        },
        {
          id: '702',
          name: 'Collect',
          depth: 0,
          multiOutput: true,
          consumesAll: false,
          isLast: false,
          outputFormat: { endpoint: 'string' },
          outputTable: 'workflows.step_results',
          content: 'Collect endpoints from {{repo_full}}.',
        },
      ],
    });

    expect(exported).toEqual({
      kind: 'open-kritt-workflow',
      version: 2,
      workflow: {
        name: 'Endpoint inventory',
        description: 'Map public application endpoints.',
        levels: [
          {
            depth: 0,
            multiOutput: true,
            consumesAll: false,
            bindPrevious: false,
            outputFormat: { endpoint: 'string' },
            steps: [{ clientId: 'step-1', name: 'Collect', content: 'Collect endpoints from {{repo_full}}.' }],
          },
          {
            depth: 1,
            multiOutput: false,
            consumesAll: true,
            bindPrevious: false,
            outputFormat: terminalFormat,
            steps: [{ clientId: 'step-2', name: 'Summarize', content: 'Summarize {{multi_output_depth_0}}.' }],
          },
        ],
      },
    });
    expect(JSON.stringify(exported)).not.toContain('workflows.vulnerabilities');
    expect(JSON.stringify(exported)).not.toContain('insertedAt');
  });

  it('imports a versioned export as a clean create-workflow payload', () => {
    const payload = workflowPayloadFromImport({
      kind: 'open-kritt-workflow',
      version: 1,
      workflow: {
        name: '  Imported workflow  ',
        description: 'Portable workflow',
        levels: [
          {
            depth: 0,
            multiOutput: true,
            consumesAll: false,
            outputFormat: terminalFormat,
            steps: [{ name: 'Analyze', content: 'Analyze {{repo_full}}.' }],
          },
        ],
      },
    });

    expect(payload.name).toBe('Imported workflow');
    expect(payload.levels[0]).toMatchObject({
      depth: 0,
      multiOutput: true,
      consumesAll: false,
      bindPrevious: false,
      steps: [{ name: 'Analyze', content: 'Analyze {{repo_full}}.' }],
    });
  });

  it('imports the existing flat API representation and enforces shared depth configuration', () => {
    const payload = workflowPayloadFromImport({
      id: '901',
      name: 'Manual API export',
      steps: [
        {
          id: '902',
          name: 'First sibling',
          depth: 0,
          multiOutput: true,
          consumesAll: false,
          content: 'Inspect {{repo_full}}.',
          outputFormat: terminalFormat,
        },
        {
          id: '903',
          name: 'Second sibling',
          depth: 0,
          multiOutput: true,
          consumesAll: false,
          content: 'Inspect {{repo_scope}}.',
          outputFormat: { ...terminalFormat },
        },
      ],
    });

    expect(payload).toEqual({
      name: 'Manual API export',
      description: '',
      levels: [
        {
          depth: 0,
          multiOutput: true,
          consumesAll: false,
          bindPrevious: false,
          outputFormat: terminalFormat,
          steps: [
            { clientId: '902', name: 'First sibling', content: 'Inspect {{repo_full}}.' },
            { clientId: '903', name: 'Second sibling', content: 'Inspect {{repo_scope}}.' },
          ],
        },
      ],
    });

    expect(() =>
      workflowPayloadFromImport({
        name: 'Mismatched siblings',
        steps: [
          { depth: 0, content: 'One', outputFormat: { result: 'string' }, multiOutput: true },
          { depth: 0, content: 'Two', outputFormat: { other: 'string' }, multiOutput: true },
        ],
      })
    ).toThrow('steps at depth 0 must share one output format');
  });

  it('rejects malformed JSON and unsupported transfer versions', () => {
    expect(() => parseWorkflowImport('{not json')).toThrow('not valid JSON');
    expect(() => workflowPayloadFromImport({ kind: 'open-kritt-workflow', version: 3, workflow: {} })).toThrow(
      'unsupported open-kritt-workflow version "3"'
    );
    expect(() => workflowPayloadFromImport([])).toThrow('JSON root must be an object');
  });

  it('round-trips stable one-to-one bindings in version 2 files', () => {
    const exported = createWorkflowExport({
      name: 'Bound review',
      steps: [
        {
          id: '10',
          name: 'Source A',
          depth: 0,
          multiOutput: true,
          consumesAll: false,
          content: 'Find A in {{repo_full}}.',
          outputFormat: { candidate: 'string' },
        },
        {
          id: '11',
          name: 'Source B',
          depth: 0,
          multiOutput: true,
          consumesAll: false,
          content: 'Find B in {{repo_full}}.',
          outputFormat: { candidate: 'string' },
        },
        {
          id: '20',
          boundSourceStepId: '10',
          name: 'Review A',
          depth: 1,
          multiOutput: true,
          consumesAll: false,
          content: 'Review {{candidate}}.',
          outputFormat: terminalFormat,
        },
        {
          id: '21',
          boundSourceStepId: '11',
          name: 'Review B',
          depth: 1,
          multiOutput: true,
          consumesAll: false,
          content: 'Review {{candidate}}.',
          outputFormat: terminalFormat,
        },
      ],
    });

    expect(exported.workflow.levels[1]).toMatchObject({
      bindPrevious: true,
      steps: [
        { clientId: 'step-3', boundSourceStepId: 'step-1' },
        { clientId: 'step-4', boundSourceStepId: 'step-2' },
      ],
    });
    expect(workflowPayloadFromImport(exported)).toEqual(exported.workflow);
  });

  it('rejects invalid binding maps before sending an imported workflow to the API', () => {
    const invalid = {
      kind: 'open-kritt-workflow',
      version: 2,
      workflow: {
        name: 'Invalid bind',
        levels: [
          {
            depth: 0,
            multiOutput: true,
            outputFormat: { candidate: 'string' },
            steps: [
              { clientId: 'a', content: 'A' },
              { clientId: 'b', content: 'B' },
            ],
          },
          {
            depth: 1,
            multiOutput: true,
            bindPrevious: true,
            outputFormat: terminalFormat,
            steps: [
              { clientId: 'c', boundSourceStepId: 'a', content: 'C' },
              { clientId: 'd', boundSourceStepId: 'a', content: 'D' },
            ],
          },
        ],
      },
    };

    expect(() => workflowPayloadFromImport(invalid)).toThrow('used more than once');
  });

  it('rejects a one-step bind transition', () => {
    const invalid = {
      kind: 'open-kritt-workflow',
      version: 2,
      workflow: {
        name: 'Single pair bind',
        levels: [
          {
            depth: 0,
            multiOutput: true,
            outputFormat: { candidate: 'string' },
            steps: [{ clientId: 'a', content: 'A' }],
          },
          {
            depth: 1,
            multiOutput: true,
            bindPrevious: true,
            outputFormat: terminalFormat,
            steps: [{ clientId: 'b', boundSourceStepId: 'a', content: 'B' }],
          },
        ],
      },
    };

    expect(() => workflowPayloadFromImport(invalid)).toThrow('at least two steps');
  });

  it('creates safe, recognizable export filenames', () => {
    expect(workflowExportFilename('  Endpoint Mapping / API Review  ')).toBe(
      'endpoint-mapping-api-review.workflow.json'
    );
    expect(workflowExportFilename('🔥')).toBe('workflow.workflow.json');
  });
});

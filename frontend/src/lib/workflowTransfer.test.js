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
      version: 1,
      workflow: {
        name: 'Endpoint inventory',
        description: 'Map public application endpoints.',
        levels: [
          {
            depth: 0,
            multiOutput: true,
            consumesAll: false,
            outputFormat: { endpoint: 'string' },
            steps: [{ name: 'Collect', content: 'Collect endpoints from {{repo_full}}.' }],
          },
          {
            depth: 1,
            multiOutput: false,
            consumesAll: true,
            outputFormat: terminalFormat,
            steps: [{ name: 'Summarize', content: 'Summarize {{multi_output_depth_0}}.' }],
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
          outputFormat: terminalFormat,
          steps: [
            { name: 'First sibling', content: 'Inspect {{repo_full}}.' },
            { name: 'Second sibling', content: 'Inspect {{repo_scope}}.' },
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
    expect(() => workflowPayloadFromImport({ kind: 'open-kritt-workflow', version: 2, workflow: {} })).toThrow(
      'unsupported open-kritt-workflow version "2"'
    );
    expect(() => workflowPayloadFromImport([])).toThrow('JSON root must be an object');
  });

  it('creates safe, recognizable export filenames', () => {
    expect(workflowExportFilename('  Endpoint Mapping / API Review  ')).toBe(
      'endpoint-mapping-api-review.workflow.json'
    );
    expect(workflowExportFilename('🔥')).toBe('workflow.workflow.json');
  });
});

import { describe, expect, it } from 'vitest';

import {
  createResourceExport,
  downloadResourceExport,
  parseResourceImport,
  RESOURCE_FILE_VERSION,
  resourceExportFilename,
  resourcePayloadFromImport,
} from './resourceTransfer.js';

const resources = {
  postScript: {
    kind: 'open-kritt-post-script',
    field: 'postScript',
    value: {
      id: '41',
      name: ' Report writer ',
      description: 'Creates a report',
      content: '\nReview {{summary}}\n',
      outputFormat: { _reserved_report: 'string' },
      keys: ['_reserved_report'],
      insertedAt: '2026-01-01',
    },
  },
  agentSkill: {
    kind: 'open-kritt-agent-skill',
    field: 'agentSkill',
    value: {
      id: '42',
      name: ' Taint analysis ',
      slug: 'taint-analysis',
      description: 'Follow data flow',
      content: '\n# Instructions\n',
      sourceUrl: 'https://example.com/skill',
      licenseSpdx: 'MIT',
      attribution: 'Example Author',
      updatedAt: '2026-01-02',
    },
  },
  severityRanker: {
    kind: 'open-kritt-severity-ranker',
    field: 'severityRanker',
    value: {
      id: '43',
      name: ' Production impact ',
      description: 'Prioritize production impact',
      content: '\n- Critical when production is compromised\n',
      isDefault: true,
    },
  },
};

describe.each(Object.entries(resources))('%s resource transfer', (resourceType, fixture) => {
  it('exports a versioned portable document and omits installation metadata', () => {
    const exported = createResourceExport(resourceType, fixture.value);

    expect(exported.kind).toBe(fixture.kind);
    expect(exported.version).toBe(RESOURCE_FILE_VERSION);
    expect(exported[fixture.field].name).toBe(fixture.value.name.trim());
    expect(exported[fixture.field].content).toBe(fixture.value.content);
    expect(exported[fixture.field]).not.toHaveProperty('id');
    expect(exported[fixture.field]).not.toHaveProperty('insertedAt');
    expect(exported[fixture.field]).not.toHaveProperty('updatedAt');
    expect(exported[fixture.field]).not.toHaveProperty('isDefault');
  });

  it('round-trips exported documents and accepts bare API/editor objects', () => {
    const exported = createResourceExport(resourceType, fixture.value);

    expect(parseResourceImport(resourceType, JSON.stringify(exported))).toEqual(exported[fixture.field]);
    expect(resourcePayloadFromImport(resourceType, fixture.value)).toEqual(exported[fixture.field]);
  });

  it('rejects another resource kind and unsupported versions', () => {
    expect(() =>
      resourcePayloadFromImport(resourceType, {
        kind: 'open-kritt-something-else',
        version: RESOURCE_FILE_VERSION,
      })
    ).toThrow(/unsupported file kind/);
    expect(() =>
      resourcePayloadFromImport(resourceType, {
        kind: fixture.kind,
        version: 999,
        [fixture.field]: fixture.value,
      })
    ).toThrow(/unsupported .* version/);
  });
});

it('validates resource-specific field shapes before sending an import', () => {
  expect(() => resourcePayloadFromImport('postScript', { name: 'x', content: 'x', outputFormat: [] })).toThrow(
    /outputFormat must be an object/
  );
  expect(() => resourcePayloadFromImport('agentSkill', { name: 'x', slug: '', content: 'x' })).toThrow(
    /slug is required/
  );
  expect(() => resourcePayloadFromImport('severityRanker', { name: 'x', content: 12 })).toThrow(
    /content must be a string/
  );
  expect(() => parseResourceImport('postScript', '{nope')).toThrow('The selected file is not valid JSON.');
});

it('creates safe resource-specific filenames', () => {
  expect(resourceExportFilename('postScript', 'Report / Writer')).toBe('report-writer.post-script.json');
  expect(resourceExportFilename('agentSkill', '')).toBe('agent-skill.agent-skill.json');
  expect(resourceExportFilename('severityRanker', 'Prod impact')).toBe('prod-impact.severity-ranker.json');
});

it('downloads a portable JSON document through the browser', () => {
  const events = [];
  const link = {
    style: {},
    click: () => events.push('click'),
    remove: () => events.push('remove'),
  };
  const documentRef = {
    createElement: (tag) => {
      expect(tag).toBe('a');
      return link;
    },
    body: { appendChild: (candidate) => events.push(candidate === link ? 'append' : 'wrong') },
  };
  const urlApi = {
    createObjectURL: (blob) => {
      expect(blob.type).toBe('application/json');
      return 'blob:portable-resource';
    },
    revokeObjectURL: (url) => events.push(`revoke:${url}`),
  };

  downloadResourceExport('severityRanker', resources.severityRanker.value, { documentRef, urlApi });

  expect(link.href).toBe('blob:portable-resource');
  expect(link.download).toBe('production-impact.severity-ranker.json');
  expect(events).toEqual(['append', 'click', 'remove', 'revoke:blob:portable-resource']);
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DESCRIPTOR_KEYS,
  FIELD_TYPES,
  MAX_DESCRIPTOR_DEPTH,
  MAX_DESCRIPTOR_FIELDS,
  RESERVED_OUTPUT_KEYS,
  RESERVED_OUTPUT_KEY_PREFIXES,
  displayType,
  fieldTypeName,
  isReservedOutputKey,
  isStructuredDefinition,
  normalizeFieldDefinition,
  normalizeOutputFormat,
  validateFieldDefinition,
} from './fieldDefinitions.js';
import { FIELD_TYPES as KEYS_FIELD_TYPES, objectToRows, rowsToObject } from './keys.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../test-fixtures/output-format-descriptors.json', import.meta.url)), 'utf8')
);

function validateOutputFormat(outputFormat) {
  const normalized = normalizeOutputFormat(outputFormat);
  const errors = [];
  for (const [key, definition] of Object.entries(normalized)) {
    const path = `outputFormat.${key}`;
    if (isReservedOutputKey(key)) errors.push({ field: path, message: 'reserved output key' });
    else errors.push(...validateFieldDefinition(path, definition));
  }
  return errors;
}

describe('shared output-format descriptor fixture', () => {
  for (const testCase of fixture.cases) {
    it(testCase.name, () => {
      const errors = validateOutputFormat(testCase.outputFormat);
      if (testCase.valid) {
        expect(errors).toEqual([]);
      } else {
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0].field).toBe(testCase.errorPath);
        expect(typeof errors[0].message).toBe('string');
        expect(errors[0].message.length).toBeGreaterThan(0);
      }
      if (testCase.normalizedEquals) {
        expect(normalizeOutputFormat(testCase.outputFormat)).toEqual(testCase.normalizedEquals);
      }
    });
  }
});

describe('fieldDefinitions constants', () => {
  it('exposes the five field types and descriptor limits', () => {
    expect(FIELD_TYPES).toEqual(['string', 'number', 'boolean', 'array', 'object']);
    expect(KEYS_FIELD_TYPES).toBe(FIELD_TYPES);
    expect(DESCRIPTOR_KEYS).toEqual(['type', 'items', 'fields', 'required', 'enum']);
    expect(MAX_DESCRIPTOR_DEPTH).toBe(4);
    expect(MAX_DESCRIPTOR_FIELDS).toBe(64);
    expect(RESERVED_OUTPUT_KEY_PREFIXES).toEqual(['_engine_']);
    expect(RESERVED_OUTPUT_KEYS).toEqual(['_chip_lifecycle']);
  });

  it('reserves engine-owned keys but keeps other chips user-declarable', () => {
    expect(isReservedOutputKey('_engine_readiness')).toBe(true);
    expect(isReservedOutputKey('_engine_')).toBe(true);
    expect(isReservedOutputKey('_chip_lifecycle')).toBe(true);
    expect(isReservedOutputKey('_chip_ease_of_exploitability')).toBe(false);
    expect(isReservedOutputKey('summary')).toBe(false);
    expect(isReservedOutputKey(null)).toBe(false);
  });
});

describe('normalizeFieldDefinition', () => {
  it('keeps type names, collapses type-only descriptors, and deep-copies descriptors', () => {
    expect(normalizeFieldDefinition('number')).toBe('number');
    expect(normalizeFieldDefinition({ type: 'array' })).toBe('array');
    expect(normalizeFieldDefinition({ type: 'object' })).toBe('object');
    const source = { type: 'array', items: { type: 'string', enum: ['a'] } };
    const normalized = normalizeFieldDefinition(source);
    expect(normalized).toEqual(source);
    expect(normalized).not.toBe(source);
    expect(normalized.items).not.toBe(source.items);
    expect(normalized.items.enum).not.toBe(source.items.enum);
  });

  it('falls back to string for values that are not definitions', () => {
    expect(normalizeFieldDefinition(undefined)).toBe('string');
    expect(normalizeFieldDefinition(null)).toBe('string');
    expect(normalizeFieldDefinition(42)).toBe('string');
  });

  it('preserves invalid descriptors so validation can report them', () => {
    expect(normalizeFieldDefinition({ type: 'integer' })).toEqual({ type: 'integer' });
    expect(normalizeFieldDefinition({ type: 'string', pattern: '^a' })).toEqual({ type: 'string', pattern: '^a' });
  });
});

describe('normalizeOutputFormat', () => {
  it('accepts an object map, a row list, and a JSON string', () => {
    const chain = { type: 'array', items: { type: 'object', fields: { id: 'string' } } };
    expect(normalizeOutputFormat({ a: 'string', chain })).toEqual({ a: 'string', chain });
    expect(
      normalizeOutputFormat([
        { key: 'a', type: 'string' },
        { key: 'b' },
        { key: 'chain', type: chain },
        { key: 'chain2', definition: chain },
      ])
    ).toEqual({ a: 'string', b: 'string', chain, chain2: chain });
    expect(normalizeOutputFormat(JSON.stringify({ a: 'number', paths: { type: 'array' } }))).toEqual({
      a: 'number',
      paths: 'array',
    });
  });

  it('throws on bad JSON and ignores non-object inputs', () => {
    expect(() => normalizeOutputFormat('{not json')).toThrow();
    expect(normalizeOutputFormat(null)).toEqual({});
    expect(normalizeOutputFormat(undefined)).toEqual({});
  });

  it('keeps meta-property keys as ordinary data so validation can reject them', () => {
    const normalized = normalizeOutputFormat('{"__proto__":"string","constructor":"number"}');
    expect(Object.keys(normalized)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(normalized)).toBe(Object.prototype);
  });
});

describe('validateFieldDefinition', () => {
  it('rejects unknown bare type names and non-definition values at the key path', () => {
    expect(validateFieldDefinition('outputFormat.x', 'integer')[0].field).toBe('outputFormat.x');
    expect(validateFieldDefinition('outputFormat.x', 42)[0].field).toBe('outputFormat.x');
    expect(validateFieldDefinition('outputFormat.x', ['string'])[0].field).toBe('outputFormat.x');
  });

  it('rejects a missing type, malformed required lists, and invalid field keys', () => {
    expect(validateFieldDefinition('outputFormat.x', { items: 'string' })[0].field).toBe('outputFormat.x.type');
    expect(
      validateFieldDefinition('outputFormat.x', { type: 'object', fields: { a: 'string' }, required: 'a' })[0].field
    ).toBe('outputFormat.x.required');
    expect(
      validateFieldDefinition('outputFormat.x', { type: 'object', fields: { a: 'string' }, required: ['a', 'a'] })[0]
        .field
    ).toBe('outputFormat.x.required');
    expect(
      validateFieldDefinition('outputFormat.x', { type: 'object', fields: { 'bad key': 'string' } })[0].field
    ).toBe('outputFormat.x.fields.bad key');
    expect(validateFieldDefinition('outputFormat.x', { type: 'object', fields: ['a'] })[0].field).toBe(
      'outputFormat.x.fields'
    );
  });

  it('rejects enum entries that are not strings', () => {
    expect(validateFieldDefinition('outputFormat.x', { type: 'string', enum: ['a', 1] })[0].field).toBe(
      'outputFormat.x.enum'
    );
  });

  it('caps the total field count over the whole descriptor', () => {
    const fields = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, 'string']));
    const nested = { type: 'object', fields: { ...fields, inner: { type: 'object', fields: { ...fields } } } };
    expect(validateFieldDefinition('outputFormat.x', nested).map((e) => e.field)).toEqual(['outputFormat.x']);
    const okFields = Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`f${i}`, 'string']));
    expect(validateFieldDefinition('outputFormat.x', { type: 'object', fields: okFields })).toEqual([]);
  });

  it('accepts exactly four descriptor levels', () => {
    const four = {
      type: 'array',
      items: { type: 'array', items: { type: 'array', items: { type: 'array', items: 'string' } } },
    };
    expect(validateFieldDefinition('outputFormat.deep', four)).toEqual([]);
  });
});

describe('display helpers', () => {
  it('reports the top-level type name for names and descriptors', () => {
    expect(fieldTypeName('array')).toBe('array');
    expect(fieldTypeName({ type: 'object', fields: { a: 'string' } })).toBe('object');
    expect(fieldTypeName({ type: 'integer' })).toBe('integer');
    expect(fieldTypeName(null)).toBe('');
  });

  it('marks descriptors with items, fields, or enum as structured', () => {
    expect(isStructuredDefinition('array')).toBe(false);
    expect(isStructuredDefinition({ type: 'array' })).toBe(false);
    expect(isStructuredDefinition({ type: 'array', items: 'string' })).toBe(true);
    expect(isStructuredDefinition({ type: 'object', fields: { a: 'string' } })).toBe(true);
    expect(isStructuredDefinition({ type: 'string', enum: ['a'] })).toBe(true);
  });

  it('renders a compact display type', () => {
    expect(displayType('number')).toBe('number');
    expect(displayType({ type: 'array' })).toBe('array');
    expect(displayType({ type: 'array', items: 'string' })).toBe('array<string>');
    expect(displayType({ type: 'array', items: { type: 'object', fields: { a: 'string', b: 'string' } } })).toBe(
      'array<object>'
    );
    expect(displayType({ type: 'string', enum: ['a', 'b'] })).toBe('string(enum)');
    expect(displayType({ type: 'object', fields: { a: 'string', b: 'string', c: 'number' } })).toBe('object{3}');
    expect(displayType({ type: 'array', items: { type: 'string', enum: ['a'] } })).toBe('array<string>');
  });
});

describe('schema rows', () => {
  const chain = {
    type: 'array',
    items: { type: 'object', fields: { id: 'string', status: { type: 'string', enum: ['proven'] } } },
  };

  it('marks structured rows with a display type and keeps the definition', () => {
    const rows = objectToRows({ summary: 'string', paths: { type: 'array' }, chain, weird: 7 });
    expect(rows).toEqual([
      { key: 'summary', type: 'string', definition: 'string', structured: false },
      { key: 'paths', type: 'array', definition: 'array', structured: false },
      { key: 'chain', type: 'array<object>', definition: chain, structured: true },
      { key: 'weird', type: 'string', definition: 'string', structured: false },
    ]);
  });

  it('round-trips structured definitions and plain rows back to an object', () => {
    const rows = objectToRows({ summary: 'string', chain });
    expect(rowsToObject(rows)).toEqual({ summary: 'string', chain });
    expect(rowsToObject([{ key: 'a', type: 'number' }, { key: '' }, { key: 'b', type: 'boolean' }])).toEqual({
      a: 'number',
      b: 'boolean',
    });
    const retyped = rows.map((row) => (row.key === 'chain' ? { ...row, type: 'string', structured: false } : row));
    expect(rowsToObject(retyped)).toEqual({ summary: 'string', chain: 'string' });
  });
});

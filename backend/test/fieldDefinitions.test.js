import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
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
} from '../src/lib/fieldDefinitions.js';
import { normalizeOutputFormat as constantsNormalizeOutputFormat } from '../src/lib/constants.js';

const fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../test-fixtures/output-format-descriptors.json', import.meta.url)), 'utf8')
);

// Mirrors how the validators apply the module: reserved keys are checked at the
// key path, then each definition is walked recursively.
function outputFormatErrors(outputFormat) {
  const errors = [];
  for (const [key, definition] of Object.entries(normalizeOutputFormat(outputFormat))) {
    const path = `outputFormat.${key}`;
    if (isReservedOutputKey(key)) errors.push({ field: path, message: `"${key}" is reserved.` });
    errors.push(...validateFieldDefinition(path, definition));
  }
  return errors;
}

test('shared fixture: every case agrees with the backend validator', () => {
  assert.ok(fixture.cases.length >= 15);
  for (const item of fixture.cases) {
    const errors = outputFormatErrors(item.outputFormat);
    if (item.valid) {
      assert.deepEqual(errors, [], `${item.name}: expected no errors`);
    } else {
      assert.ok(errors.length > 0, `${item.name}: expected errors`);
      assert.equal(errors[0].field, item.errorPath, `${item.name}: first error path`);
      for (const error of errors) {
        assert.equal(typeof error.field, 'string');
        assert.equal(typeof error.message, 'string');
        assert.ok(error.message.length > 0);
      }
    }
    if (item.normalizedEquals) {
      assert.deepEqual(normalizeOutputFormat(item.outputFormat), item.normalizedEquals, `${item.name}: normalized`);
    }
  }
});

test('constants re-exports the descriptor-preserving normalizer', () => {
  assert.equal(constantsNormalizeOutputFormat, normalizeOutputFormat);
});

test('module constants match the shared contract', () => {
  assert.deepEqual(FIELD_TYPES, ['string', 'number', 'boolean', 'array', 'object']);
  assert.deepEqual(DESCRIPTOR_KEYS, ['type', 'items', 'fields', 'required', 'enum']);
  assert.equal(MAX_DESCRIPTOR_DEPTH, 4);
  assert.equal(MAX_DESCRIPTOR_FIELDS, 64);
  assert.deepEqual(RESERVED_OUTPUT_KEY_PREFIXES, ['_engine_']);
  assert.deepEqual(RESERVED_OUTPUT_KEYS, ['_chip_lifecycle']);
});

test('isReservedOutputKey reserves engine-owned keys but keeps other chips declarable', () => {
  assert.equal(isReservedOutputKey('_engine_readiness'), true);
  assert.equal(isReservedOutputKey('_engine_'), true);
  assert.equal(isReservedOutputKey('_chip_lifecycle'), true);
  assert.equal(isReservedOutputKey('_chip_lifecycle_extra'), false);
  assert.equal(isReservedOutputKey('_chip_severity'), false);
  assert.equal(isReservedOutputKey('engine_readiness'), false);
  assert.equal(isReservedOutputKey(''), false);
  assert.equal(isReservedOutputKey(null), false);
});

test('normalizeFieldDefinition collapses type-only descriptors and deep-copies structured ones', () => {
  assert.equal(normalizeFieldDefinition('array'), 'array');
  assert.equal(normalizeFieldDefinition({ type: 'array' }), 'array');
  assert.equal(normalizeFieldDefinition({ type: 'object' }), 'object');
  assert.equal(normalizeFieldDefinition({ type: 'boolean' }), 'boolean');
  // Legacy inputs keep their historical meaning.
  assert.equal(normalizeFieldDefinition(['a']), 'array');
  assert.equal(normalizeFieldDefinition({}), 'object');
  assert.equal(normalizeFieldDefinition({ nested: 'value' }), 'object');

  const source = {
    type: 'array',
    items: { type: 'object', fields: { status: { type: 'string', enum: ['a'] } }, required: ['status'] },
  };
  const normalized = normalizeFieldDefinition(source);
  assert.deepEqual(normalized, source);
  assert.notEqual(normalized, source);
  assert.notEqual(normalized.items, source.items);
  assert.notEqual(normalized.items.fields, source.items.fields);
  assert.notEqual(normalized.items.required, source.items.required);
  assert.notEqual(normalized.items.fields.status.enum, source.items.fields.status.enum);
  source.items.fields.status.enum.push('b');
  assert.deepEqual(normalized.items.fields.status.enum, ['a']);
});

test('normalizeOutputFormat accepts object maps, {key,type} rows, and JSON strings', () => {
  const descriptor = { type: 'array', items: 'string' };
  assert.deepEqual(normalizeOutputFormat({ paths: descriptor, name: 'string' }), { paths: descriptor, name: 'string' });
  assert.deepEqual(
    normalizeOutputFormat([{ key: 'name', type: 'string' }, { key: 'paths', type: descriptor }, { key: 'untyped' }]),
    { name: 'string', paths: descriptor, untyped: 'string' }
  );
  assert.deepEqual(normalizeOutputFormat(JSON.stringify({ paths: descriptor })), { paths: descriptor });
  assert.deepEqual(normalizeOutputFormat(JSON.stringify([{ key: 'paths', type: descriptor }])), {
    paths: descriptor,
  });
  assert.deepEqual(normalizeOutputFormat({}), {});
  assert.deepEqual(normalizeOutputFormat(null), {});
  assert.throws(() => normalizeOutputFormat('{not json'), SyntaxError);
});

test('normalizeOutputFormat keeps unsafe object keys as ordinary data for validation', () => {
  const rows = [{ key: '__proto__', type: 'string' }];
  const normalized = normalizeOutputFormat(rows);
  assert.deepEqual(Object.keys(normalized), ['__proto__']);
  assert.equal(Object.getPrototypeOf(normalized), Object.prototype);
});

test('fieldTypeName reports the top-level type of names and descriptors', () => {
  assert.equal(fieldTypeName('number'), 'number');
  assert.equal(fieldTypeName({ type: 'array', items: 'string' }), 'array');
  assert.equal(fieldTypeName({ type: 'integer' }), 'integer');
  assert.equal(fieldTypeName({ items: 'string' }), undefined);
  assert.equal(fieldTypeName(null), undefined);
});

test('isStructuredDefinition and displayType describe descriptors', () => {
  assert.equal(isStructuredDefinition('array'), false);
  assert.equal(isStructuredDefinition({ type: 'array' }), false);
  assert.equal(isStructuredDefinition({ type: 'array', items: 'string' }), true);
  assert.equal(isStructuredDefinition({ type: 'object', fields: { a: 'string' } }), true);
  assert.equal(isStructuredDefinition({ type: 'string', enum: ['a'] }), true);
  assert.equal(isStructuredDefinition(null), false);

  assert.equal(displayType('string'), 'string');
  assert.equal(displayType({ type: 'array' }), 'array');
  assert.equal(displayType({ type: 'array', items: 'string' }), 'array<string>');
  assert.equal(displayType({ type: 'array', items: { type: 'object', fields: { a: 'string' } } }), 'array<object>');
  assert.equal(displayType({ type: 'string', enum: ['a', 'b'] }), 'string(enum)');
  assert.equal(displayType({ type: 'object', fields: { a: 'string', b: 'number', c: 'boolean' } }), 'object{3}');
});

test('validateFieldDefinition reports unsupported type names at the field path', () => {
  assert.deepEqual(
    validateFieldDefinition('outputFormat.x', 'integer').map((e) => e.field),
    ['outputFormat.x']
  );
  assert.deepEqual(validateFieldDefinition('outputFormat.x', 'string'), []);
  assert.equal(validateFieldDefinition('outputFormat.x', null)[0].field, 'outputFormat.x');
  assert.equal(validateFieldDefinition('outputFormat.x', 42)[0].field, 'outputFormat.x');
});

test('validateFieldDefinition rejects descriptors without a type and malformed nested fields', () => {
  assert.equal(validateFieldDefinition('outputFormat.x', { items: 'string' })[0].field, 'outputFormat.x.type');
  assert.equal(
    validateFieldDefinition('outputFormat.x', { type: 'object', fields: ['a'] })[0].field,
    'outputFormat.x.fields'
  );
  assert.equal(
    validateFieldDefinition('outputFormat.x', { type: 'object', fields: { 'bad-key': 'string' } })[0].field,
    'outputFormat.x.fields.bad-key'
  );
  assert.equal(
    validateFieldDefinition('outputFormat.x', { type: 'object', fields: { a: 'string' }, required: 'a' })[0].field,
    'outputFormat.x.required'
  );
  assert.equal(
    validateFieldDefinition('outputFormat.x', { type: 'string', enum: ['a', 1] })[0].field,
    'outputFormat.x.enum'
  );
  assert.equal(
    validateFieldDefinition('outputFormat.x', { type: 'array', items: { type: 'string', enum: [] } })[0].field,
    'outputFormat.x.items.enum'
  );
  assert.equal(
    validateFieldDefinition('outputFormat.x', { type: 'array', items: 'integer' })[0].field,
    'outputFormat.x.items'
  );
});

test('validateFieldDefinition caps the total field count across the whole descriptor', () => {
  const fields = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, 'string']));
  const ok = { type: 'object', fields: { a: { type: 'object', fields }, b: { type: 'object', fields } } };
  // 2 + 33 + 33 = 68 fields in total, over the cap.
  const errors = validateFieldDefinition('outputFormat.big', ok);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].field, 'outputFormat.big');
  assert.match(errors[0].message, /64/);

  const smaller = Object.fromEntries(Array.from({ length: 62 }, (_, i) => [`f${i}`, 'string']));
  assert.deepEqual(
    validateFieldDefinition('outputFormat.big', { type: 'object', fields: { a: { type: 'object', fields: smaller } } }),
    []
  );
});

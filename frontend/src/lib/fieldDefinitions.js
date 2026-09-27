// Output-format field definitions — a field is either a bare type name or a
// nested descriptor `{ type, items, fields, required, enum }`. This mirrors the
// backend module of the same name; both are checked against
// test-fixtures/output-format-descriptors.json so the layers agree.

export const FIELD_TYPES = ['string', 'number', 'boolean', 'array', 'object'];
export const DESCRIPTOR_KEYS = ['type', 'items', 'fields', 'required', 'enum'];
export const MAX_DESCRIPTOR_DEPTH = 4;
export const MAX_DESCRIPTOR_FIELDS = 64;
export const RESERVED_OUTPUT_KEY_PREFIXES = ['_engine_'];
export const RESERVED_OUTPUT_KEYS = ['_chip_lifecycle'];

const ALLOWED_KEYS_BY_TYPE = {
  string: ['type', 'enum'],
  number: ['type'],
  boolean: ['type'],
  array: ['type', 'items'],
  object: ['type', 'fields', 'required'],
};

const FIELD_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const UNSAFE_FIELD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function isReservedOutputKey(key) {
  if (typeof key !== 'string') return false;
  if (RESERVED_OUTPUT_KEYS.includes(key)) return true;
  return RESERVED_OUTPUT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function copyDescriptor(value) {
  if (Array.isArray(value)) return value.map(copyDescriptor);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      Object.defineProperty(out, key, {
        value: copyDescriptor(entry),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return out;
  }
  return value;
}

// A bare type name stays a string; a type-only descriptor collapses to its
// type name (legacy meaning); any other descriptor is deep-copied unchanged so
// validation can report problems with full paths.
export function normalizeFieldDefinition(value) {
  if (typeof value === 'string') return value;
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 1 && keys[0] === 'type' && FIELD_TYPES.includes(value.type)) return value.type;
    return copyDescriptor(value);
  }
  return 'string';
}

// Accepts an object map, a `[{ key, type }]` row list, or a JSON string.
// Throws on malformed JSON — callers catch.
export function normalizeOutputFormat(input) {
  let value = input;
  if (typeof value === 'string') value = JSON.parse(value);
  const out = {};
  const setField = (key, definition) => {
    // defineProperty keeps keys such as `__proto__` as ordinary data so
    // validation can reject them instead of silently mutating the object.
    Object.defineProperty(out, key, {
      value: normalizeFieldDefinition(definition),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  };
  if (Array.isArray(value)) {
    for (const row of value) {
      if (!isPlainObject(row) || !('key' in row)) continue;
      setField(row.key, row.definition ?? row.type ?? 'string');
    }
  } else if (isPlainObject(value)) {
    for (const [key, definition] of Object.entries(value)) setField(key, definition);
  }
  return out;
}

function validateFieldKey(key) {
  return typeof key === 'string' && FIELD_KEY_RE.test(key) && !UNSAFE_FIELD_KEYS.has(key);
}

function countFields(definition) {
  if (!isPlainObject(definition)) return 0;
  let total = 0;
  if (isPlainObject(definition.fields)) {
    for (const entry of Object.values(definition.fields)) total += 1 + countFields(entry);
  }
  if (definition.items !== undefined) total += countFields(definition.items);
  return total;
}

function walkDefinition(path, value, depth, errors) {
  const fail = (field, message) => errors.push({ field, message });

  if (typeof value === 'string') {
    if (!FIELD_TYPES.includes(value)) fail(path, `unknown field type "${value}"; use one of ${FIELD_TYPES.join(', ')}`);
    return;
  }
  if (!isPlainObject(value)) {
    fail(path, 'field definition must be a type name or a descriptor object');
    return;
  }
  if (depth > MAX_DESCRIPTOR_DEPTH) {
    fail(path, `descriptor nesting exceeds the depth cap of ${MAX_DESCRIPTOR_DEPTH}`);
    return;
  }

  const type = value.type;
  if (typeof type !== 'string' || !FIELD_TYPES.includes(type)) {
    fail(`${path}.type`, `descriptor type must be one of ${FIELD_TYPES.join(', ')}`);
    return;
  }

  if (type === 'array' && value.items === undefined) {
    fail(`${path}.items`, 'array descriptors must declare items');
    return;
  }

  const allowed = ALLOWED_KEYS_BY_TYPE[type];
  for (const key of Object.keys(value)) {
    if (!DESCRIPTOR_KEYS.includes(key)) {
      fail(`${path}.${key}`, `unknown descriptor key "${key}"`);
      return;
    }
    if (!allowed.includes(key)) {
      fail(`${path}.${key}`, `"${key}" is not allowed under type ${type}`);
      return;
    }
  }

  if (type === 'array') {
    walkDefinition(`${path}.items`, value.items, depth + 1, errors);
    return;
  }

  if (type === 'object') {
    const fields = value.fields;
    if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
      fail(`${path}.fields`, 'object descriptors must declare a non-empty fields map');
      return;
    }
    for (const [key, entry] of Object.entries(fields)) {
      if (!validateFieldKey(key)) {
        fail(`${path}.fields.${key}`, 'field keys must match ^[a-zA-Z_][a-zA-Z0-9_]*$');
        return;
      }
      const before = errors.length;
      walkDefinition(`${path}.fields.${key}`, entry, depth + 1, errors);
      if (errors.length > before) return;
    }
    if (value.required !== undefined) {
      const required = value.required;
      const valid =
        Array.isArray(required) &&
        required.every((entry) => typeof entry === 'string' && Object.prototype.hasOwnProperty.call(fields, entry)) &&
        new Set(required).size === required.length;
      if (!valid) fail(`${path}.required`, 'required must list unique keys declared in fields');
    }
    return;
  }

  if (type === 'string' && value.enum !== undefined) {
    const values = value.enum;
    const valid =
      Array.isArray(values) &&
      values.length > 0 &&
      values.every((entry) => typeof entry === 'string') &&
      new Set(values).size === values.length;
    if (!valid) fail(`${path}.enum`, 'enum must be a non-empty array of unique strings');
  }
}

// Returns [{ field, message }] with the full descriptor path, e.g.
// `outputFormat.impact_chain.items.fields.status.enum`. Empty when valid.
export function validateFieldDefinition(path, value) {
  const errors = [];
  walkDefinition(path, value, 1, errors);
  if (errors.length === 0 && countFields(value) > MAX_DESCRIPTOR_FIELDS) {
    errors.push({ field: path, message: `descriptor declares more than ${MAX_DESCRIPTOR_FIELDS} fields in total` });
  }
  return errors;
}

export function fieldTypeName(definition) {
  if (typeof definition === 'string') return definition;
  if (isPlainObject(definition) && typeof definition.type === 'string') return definition.type;
  return '';
}

export function isStructuredDefinition(definition) {
  return (
    isPlainObject(definition) &&
    (definition.items !== undefined || definition.fields !== undefined || definition.enum !== undefined)
  );
}

// Compact label for structured rows: `array<object>`, `string(enum)`, `object{3}`.
export function displayType(definition) {
  const type = fieldTypeName(definition);
  if (!isStructuredDefinition(definition)) return type;
  if (type === 'array') return `array<${fieldTypeName(definition.items)}>`;
  if (type === 'object')
    return `object{${isPlainObject(definition.fields) ? Object.keys(definition.fields).length : 0}}`;
  if (type === 'string') return 'string(enum)';
  return type;
}

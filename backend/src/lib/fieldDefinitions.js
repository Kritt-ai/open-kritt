// Output-format field definitions: the five legacy type names plus nested
// descriptors ({ type, items, fields, required, enum }). The frontend and engine
// carry equivalent implementations; all three are checked against the shared
// fixture in test-fixtures/output-format-descriptors.json.

export const FIELD_TYPES = ['string', 'number', 'boolean', 'array', 'object'];
export const DESCRIPTOR_KEYS = ['type', 'items', 'fields', 'required', 'enum'];
export const MAX_DESCRIPTOR_DEPTH = 4;
export const MAX_DESCRIPTOR_FIELDS = 64;
export const RESERVED_OUTPUT_KEY_PREFIXES = ['_engine_'];
export const RESERVED_OUTPUT_KEYS = ['_chip_lifecycle'];

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// Assigning these on a plain object changes its behavior instead of adding a
// field, so nested definitions are copied with defineProperty and rejected.
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isValidFieldKey = (key) => typeof key === 'string' && IDENTIFIER_RE.test(key) && !UNSAFE_OBJECT_KEYS.has(key);

function defineField(target, key, value) {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

export function isReservedOutputKey(key) {
  if (typeof key !== 'string') return false;
  return RESERVED_OUTPUT_KEYS.includes(key) || RESERVED_OUTPUT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

const hasStructureKey = (value) =>
  isPlainObject(value) && DESCRIPTOR_KEYS.some((key) => key !== 'type' && Object.hasOwn(value, key));

// Returns a type name (legacy meaning) or a deep-copied descriptor. Unknown
// descriptor keys and malformed values are preserved so validation can report
// them with a precise path.
export function normalizeFieldDefinition(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return 'array';
  if (!isPlainObject(value)) return typeof value;
  if (!Object.hasOwn(value, 'type')) {
    // Legacy: a free-form object value meant "object". A descriptor that
    // declares structure but forgets its type is kept for validation.
    return hasStructureKey(value) ? copyDescriptor(value) : 'object';
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && typeof value.type === 'string' && FIELD_TYPES.includes(value.type)) return value.type;
  return copyDescriptor(value);
}

function copyDescriptor(value) {
  const out = {};
  for (const key of Object.keys(value)) {
    const entry = value[key];
    if (key === 'items') defineField(out, key, normalizeFieldDefinition(entry));
    else if (key === 'fields' && isPlainObject(entry)) {
      const fields = {};
      for (const fieldKey of Object.keys(entry))
        defineField(fields, fieldKey, normalizeFieldDefinition(entry[fieldKey]));
      defineField(out, key, fields);
    } else if (Array.isArray(entry)) defineField(out, key, [...entry]);
    else if (isPlainObject(entry)) defineField(out, key, structuredClone(entry));
    else defineField(out, key, entry);
  }
  return out;
}

// Normalize an output-format value (object map, array of {key,type}, or a JSON
// string of either) into a plain { key: definition } object. Throws on malformed JSON.
export function normalizeOutputFormat(input) {
  let value = input;
  if (typeof value === 'string') {
    value = JSON.parse(value); // may throw — caller catches
  }
  const out = {};
  if (Array.isArray(value)) {
    for (const f of value) {
      if (f && typeof f === 'object' && 'key' in f) {
        defineField(out, f.key, normalizeFieldDefinition(f.definition ?? f.type ?? 'string'));
      }
    }
  } else if (value && typeof value === 'object') {
    for (const k of Object.keys(value)) defineField(out, k, normalizeFieldDefinition(value[k]));
  }
  return out;
}

export function fieldTypeName(definition) {
  if (typeof definition === 'string') return definition;
  if (isPlainObject(definition) && typeof definition.type === 'string') return definition.type;
  return undefined;
}

export function isStructuredDefinition(definition) {
  return hasStructureKey(definition);
}

export function displayType(definition) {
  const type = fieldTypeName(definition);
  if (!isStructuredDefinition(definition)) return type;
  if (type === 'array' && Object.hasOwn(definition, 'items')) return `array<${fieldTypeName(definition.items) ?? '?'}>`;
  if (type === 'object' && isPlainObject(definition.fields)) return `object{${Object.keys(definition.fields).length}}`;
  if (type === 'string' && Object.hasOwn(definition, 'enum')) return 'string(enum)';
  return type;
}

// Recursively validate one field definition. `path` is the descriptor path of
// the definition (for example "outputFormat.impact_chain"); nested errors extend
// it ("outputFormat.impact_chain.items.fields.status.enum").
export function validateFieldDefinition(path, value) {
  const errors = [];
  const push = (field, message) => errors.push({ field, message });
  const counter = { fields: 0 };
  walkDefinition(path, value, 1, counter, push);
  if (counter.fields > MAX_DESCRIPTOR_FIELDS) {
    push(path, `Declares ${counter.fields} fields in total; the maximum is ${MAX_DESCRIPTOR_FIELDS}.`);
  }
  return errors;
}

function walkDefinition(path, value, depth, counter, push) {
  const label = path.split('.').pop();
  if (typeof value === 'string') {
    if (!FIELD_TYPES.includes(value)) push(path, `"${label}" has an unsupported type "${value}".`);
    return;
  }
  // Only descriptor objects count towards the depth cap; a leaf type name does not.
  if (depth > MAX_DESCRIPTOR_DEPTH) {
    push(path, `Exceeds the maximum nesting depth of ${MAX_DESCRIPTOR_DEPTH}.`);
    return;
  }
  if (!isPlainObject(value)) {
    push(path, `"${label}" must be a type name or a field descriptor object.`);
    return;
  }

  const type = value.type;
  if (!Object.hasOwn(value, 'type')) {
    push(`${path}.type`, 'A field descriptor must declare its type.');
    return;
  }
  if (typeof type !== 'string' || !FIELD_TYPES.includes(type)) {
    push(`${path}.type`, `Type must be one of: ${FIELD_TYPES.join(', ')}.`);
    return;
  }

  const allowed = new Set(['type']);
  if (type === 'array') allowed.add('items');
  if (type === 'object') allowed.add('fields').add('required');
  if (type === 'string') allowed.add('enum');

  const keys = Object.keys(value);
  const structured = keys.some((key) => key !== 'type');
  // A bare { type } keeps its legacy meaning; structured descriptors must be complete.
  if (structured && type === 'array' && !Object.hasOwn(value, 'items')) {
    push(`${path}.items`, 'An array descriptor must declare "items".');
  }
  if (structured && type === 'object' && !Object.hasOwn(value, 'fields')) {
    push(`${path}.fields`, 'An object descriptor must declare a non-empty "fields" map.');
  }
  for (const key of keys) {
    if (allowed.has(key)) continue;
    if (DESCRIPTOR_KEYS.includes(key)) push(`${path}.${key}`, `"${key}" is not allowed under type "${type}".`);
    else push(`${path}.${key}`, `"${key}" is not a supported descriptor key.`);
  }

  if (type === 'array' && Object.hasOwn(value, 'items')) {
    walkDefinition(`${path}.items`, value.items, depth + 1, counter, push);
  }

  if (type === 'object' && Object.hasOwn(value, 'fields')) {
    const fields = value.fields;
    if (!isPlainObject(fields) || Object.keys(fields).length === 0) {
      push(`${path}.fields`, 'An object descriptor must declare a non-empty "fields" map.');
    } else {
      const fieldKeys = Object.keys(fields);
      counter.fields += fieldKeys.length;
      for (const fieldKey of fieldKeys) {
        const fieldPath = `${path}.fields.${fieldKey}`;
        if (!isValidFieldKey(fieldKey)) push(fieldPath, `"${fieldKey}" is not a valid field name.`);
        walkDefinition(fieldPath, fields[fieldKey], depth + 1, counter, push);
      }
      if (Object.hasOwn(value, 'required')) {
        const required = value.required;
        if (!Array.isArray(required) || required.some((entry) => typeof entry !== 'string')) {
          push(`${path}.required`, '"required" must be an array of field names.');
        } else {
          if (new Set(required).size !== required.length) {
            push(`${path}.required`, '"required" lists the same field more than once.');
          }
          const unknown = required.filter((entry) => !Object.hasOwn(fields, entry));
          if (unknown.length) {
            push(`${path}.required`, `"required" names undeclared field(s): ${unknown.join(', ')}.`);
          }
        }
      }
    }
  }

  if (type === 'string' && Object.hasOwn(value, 'enum')) {
    const options = value.enum;
    if (!Array.isArray(options) || options.length === 0) {
      push(`${path}.enum`, '"enum" must be a non-empty array of strings.');
    } else if (options.some((entry) => typeof entry !== 'string')) {
      push(`${path}.enum`, '"enum" must contain strings only.');
    } else if (new Set(options).size !== options.length) {
      push(`${path}.enum`, '"enum" values must be unique.');
    }
  }
}

// Key/type constants and helpers — mirror the backend rules so the UI can
// validate live before submitting.

export const BUILTIN_KEYS = [
  'repo_full',
  'commit_sha',
  'repo_scope',
  'dependencies',
  'configuration',
  'workspace_root',
  'workspace_layout',
  'workspace_manifest_json',
];

// The dynamic built-in context key, used as {{extra.<sub_key>}} in prompts.
export const EXTRA_KEY = 'extra';

export const REQUIRED_VULN_KEYS = [
  'explanation',
  'file_path',
  'line',
  'malicious_input_example',
  'summary',
  'trigger_flow',
  'vulnerability_type',
  'malicious_actor',
];

export const OPTIONAL_VULN_KEYS = ['exploitable'];

export const RESERVED_POST_SCRIPT_KEYS = [...BUILTIN_KEYS, EXTRA_KEY, ...REQUIRED_VULN_KEYS, ...OPTIONAL_VULN_KEYS];

export const POST_SCRIPT_MARKDOWN_OUTPUT_KEYS = ['_reserved_report', '_reserved_poc'];
export const POST_SCRIPT_CHIP_PREFIX = '_chip_';

export const FIELD_TYPES = ['string', 'number', 'boolean', 'array'];

// The collapsed array key a step gets when it batch-consumes a whole previous depth.
export const multiOutputDepthKey = (depth) => `multi_output_depth_${depth}`;
export const isMultiOutputDepthKey = (k) => /^multi_output_depth_\d+$/.test(k || '');

export const REQUIRED_KEY_TYPES = {
  explanation: 'string',
  file_path: 'string',
  line: 'number',
  malicious_input_example: 'string',
  summary: 'string',
  trigger_flow: 'array',
  vulnerability_type: 'string',
  exploitable: 'boolean',
  malicious_actor: 'string',
};

const TEMPLATE_REF_RE = /^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/;
const TEMPLATE_REF_MALFORMED_LIMIT = 25;

function scanTemplateRefs(content, { collectRefs, collectMalformed, stopOnMalformed }) {
  const text = typeof content === 'string' ? content : '';
  const refs = [];
  const malformed = [];
  let malformedFound = false;
  let openStart = -1;
  let cursor = 0;

  const recordMalformed = (start, end, literal = null) => {
    malformedFound = true;
    if (collectMalformed && malformed.length < TEMPLATE_REF_MALFORMED_LIMIT) {
      malformed.push(literal ?? text.slice(start, Math.min(end, start + 200)));
    }
    return stopOnMalformed;
  };

  while (cursor + 1 < text.length) {
    const pair = text.slice(cursor, cursor + 2);
    if (openStart === -1) {
      if (pair === '{{') {
        openStart = cursor;
        cursor += 2;
      } else if (pair === '}}') {
        if (recordMalformed(cursor, cursor + 2, '}}')) return { refs, malformed, malformedFound };
        cursor += 2;
      } else cursor += 1;
      continue;
    }

    if (pair === '{{') {
      if (recordMalformed(openStart, text.length)) return { refs, malformed, malformedFound };
      openStart = cursor;
      cursor += 2;
      continue;
    }
    if (pair === '}}') {
      const ref = text.slice(openStart + 2, cursor).trim();
      if (TEMPLATE_REF_RE.test(ref)) {
        if (collectRefs) refs.push(ref);
      } else if (recordMalformed(openStart, cursor + 2)) return { refs, malformed, malformedFound };
      openStart = -1;
      cursor += 2;
      continue;
    }
    cursor += 1;
  }

  if (openStart !== -1) recordMalformed(openStart, text.length);
  return { refs, malformed, malformedFound };
}

export function parseTemplateRefs(content) {
  const { refs, malformed } = scanTemplateRefs(content, {
    collectRefs: true,
    collectMalformed: true,
    stopOnMalformed: false,
  });
  return { refs, malformed };
}

export function parseRefs(content) {
  return scanTemplateRefs(content, {
    collectRefs: true,
    collectMalformed: false,
    stopOnMalformed: false,
  }).refs;
}

export function hasMalformedTemplateRefs(content) {
  return scanTemplateRefs(content, {
    collectRefs: false,
    collectMalformed: false,
    stopOnMalformed: true,
  }).malformedFound;
}

// Is this reference the dynamic extra context? Matches `extra` or `extra.<key>`.
export function isExtraRef(ref) {
  if (ref === EXTRA_KEY) return true;
  const match = /^extra\.([a-zA-Z0-9_]+)$/.exec(ref || '');
  return Boolean(match && isValidKey(match[1]));
}

// Sub-key of an `extra.<key>` reference, or null otherwise.
export function extraSubKey(ref) {
  const m = /^extra\.([a-zA-Z0-9_]+)$/.exec(ref);
  return m && isValidKey(m[1]) ? m[1] : null;
}

// Distinct extra sub-keys referenced in content.
export function extractExtraKeys(content) {
  const keys = new Set();
  for (const ref of parseRefs(content)) {
    const sub = extraSubKey(ref);
    if (sub) keys.add(sub);
  }
  return [...keys];
}

// Does a reference resolve against an availability map? When allowExtra is true,
// any `extra` / `extra.<key>` reference resolves.
export function refResolves(ref, available, allowExtra = false) {
  if (available && typeof available.has === 'function' && available.has(ref)) return true;
  return allowExtra && isExtraRef(ref);
}

const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const isValidKey = (k) =>
  typeof k === 'string' && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(k) && !UNSAFE_OBJECT_KEYS.has(k);

// schema rows ([{key,type}]) -> { key: type } object
export function rowsToObject(rows) {
  const o = {};
  rows.forEach((r) => {
    if (r.key) o[r.key] = r.type;
  });
  return o;
}

// { key: type } object -> schema rows
export function objectToRows(obj) {
  return Object.entries(obj || {}).map(([key, type]) => ({ key, type: typeof type === 'string' ? type : 'string' }));
}

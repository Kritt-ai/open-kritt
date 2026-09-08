// Shared key/type constants and the rules that govern workflows & post-scripts.

// Built-in context keys available to every step's prompt content.
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

// Dynamic per-scan context, referenced as {{extra}} or {{extra.<key>}}.
export const EXTRA_KEY = 'extra';

// The 8 keys a terminal (last-depth) step MUST emit into workflows.vulnerabilities.
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

// A post-script may only reference these keys (scan context + finding fields).
// It must NOT define output keys that collide with any of them.
export const RESERVED_POST_SCRIPT_KEYS = [...BUILTIN_KEYS, EXTRA_KEY, ...REQUIRED_VULN_KEYS, ...OPTIONAL_VULN_KEYS];

export const POST_SCRIPT_MARKDOWN_OUTPUT_KEYS = ['_reserved_report', '_reserved_poc'];
export const POST_SCRIPT_CHIP_PREFIX = '_chip_';

// Allowed JSON-schema field types in the simplified output-format editor.
export const FIELD_TYPES = ['string', 'number', 'boolean', 'array', 'object'];

// Default suggested types for known vulnerability keys.
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

export const SCAN_STATUSES = [
  'queued',
  'pending',
  'prewarming_cache',
  'running',
  'rate_limited',
  'post_processing',
  'paused',
  'completed',
  'stopped',
  'failed',
];

// Reasoning / thinking effort options for a scan's model.
// This is the union accepted by the supported provider/harness combinations.
// The model catalog narrows it to the values exposed by a particular model.
export const THINKING_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const DEFAULT_THINKING_EFFORT = 'medium';

export const MODEL_PROVIDERS = ['codex', 'claude', 'openrouter', 'xai'];
export const DEFAULT_MODEL_PROVIDER = 'openrouter';

export const HARNESSES = ['codex', 'claude-code', 'cursor', 'grok-build'];
export const HARNESS_ALIASES = {
  'codex-cli': 'codex',
  'cursor-agent': 'cursor',
  'cursor-cli': 'cursor',
  grok: 'grok-build',
};
export const MODEL_PROVIDER_HARNESSES = {
  codex: ['codex'],
  claude: ['claude-code'],
  openrouter: ['codex', 'claude-code'],
  xai: ['grok-build'],
};
export const HARNESS_THINKING_EFFORTS = {
  codex: ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'claude-code': ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
  'grok-build': ['low', 'medium', 'high', 'xhigh'],
};

export const GENERATION_KINDS = ['workflow', 'post_script'];
export const GENERATION_STATUSES = ['pending', 'running', 'completed', 'failed'];
export const GENERATION_REQUEST_MAX_LENGTH = 20_000;
export const MODEL_ID_MAX_LENGTH = 200;

export function isModelProviderHarnessCompatible(modelProvider, harness) {
  return MODEL_PROVIDER_HARNESSES[modelProvider]?.includes(harness) || false;
}

// A scan target / dependency is either a remote GitHub repo or a local repo folder.
export const REPO_KINDS = ['remote', 'local'];
export const LOCAL_SNAPSHOT_REVISION = 'LOCAL_SNAPSHOT';

// A GitHub repo id like org/repo, with an optional .git suffix on repo.
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/;

export function normalizeGithubRepo(input) {
  const raw = (input ?? '').toString().trim();
  if (!raw) return '';
  if (GITHUB_REPO_RE.test(raw)) return raw.replace(/\.git$/, '');
  const ssh = /^git@github\.com:([^/]+)\/([^/#?]+?)(?:\.git)?$/.exec(raw);
  if (ssh) return `${ssh[1]}/${ssh[2]}`;
  try {
    const withProtocol = raw.startsWith('github.com/') ? `https://${raw}` : raw;
    const u = new URL(withProtocol);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;
    if (u.hostname !== 'github.com') return raw;
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length < 2) return raw;
    return `${segs[0]}/${segs[1].replace(/\.git$/, '')}`;
  } catch {
    return raw;
  }
}

export function isValidGithubRepoInput(input) {
  return GITHUB_REPO_RE.test(normalizeGithubRepo(input));
}

export const VULNERABILITIES_TABLE = 'workflows.vulnerabilities';
export const STEP_RESULTS_TABLE = 'workflows.step_results';

const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// These names have special behavior on normal JavaScript objects. In particular,
// assigning `__proto__` can silently drop the field during output-format
// normalization, so accepting one would make the engine and API see different
// artifact schemas.
const UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
export const isValidKey = (k) => typeof k === 'string' && IDENTIFIER_RE.test(k) && !UNSAFE_OBJECT_KEYS.has(k);

// The collapsed key a step gets when it batch-consumes a whole previous depth:
// the full array of that depth's outputs.
export const multiOutputDepthKey = (depth) => `multi_output_depth_${depth}`;
export const isMultiOutputDepthKey = (k) => /^multi_output_depth_\d+$/.test(k || '');

const TEMPLATE_REF_RE = /^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/;
export const TEMPLATE_REF_MALFORMED_SAMPLE_LIMIT = 25;
const TEMPLATE_REF_MALFORMED_SAMPLE_LENGTH = 200;

function scanTemplateRefs(content, { collectRefs, collectMalformed, stopOnMalformed }) {
  const text = typeof content === 'string' ? content : '';
  const refs = [];
  const malformed = [];
  let malformedFound = false;
  let openStart = -1;
  let cursor = 0;

  const recordMalformed = (start, end, literal = null) => {
    malformedFound = true;
    if (collectMalformed && malformed.length < TEMPLATE_REF_MALFORMED_SAMPLE_LIMIT) {
      malformed.push(literal ?? text.slice(start, Math.min(end, start + TEMPLATE_REF_MALFORMED_SAMPLE_LENGTH)));
    }
    return stopOnMalformed;
  };

  while (cursor + 1 < text.length) {
    const pair = text.slice(cursor, cursor + 2);

    if (openStart === -1) {
      if (pair === '{{') {
        openStart = cursor;
        cursor += 2;
        continue;
      }
      if (pair === '}}') {
        if (recordMalformed(cursor, cursor + 2, '}}')) return { refs, malformed, malformedFound };
        cursor += 2;
        continue;
      }
      cursor += 1;
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
      } else if (recordMalformed(openStart, cursor + 2)) {
        return { refs, malformed, malformedFound };
      }
      openStart = -1;
      cursor += 2;
      continue;
    }
    cursor += 1;
  }

  if (openStart !== -1) recordMalformed(openStart, text.length);
  return { refs, malformed, malformedFound };
}

// Parse every double-brace token in one pass. Malformed samples are retained
// only for diagnostics; their bounded list cannot grow with a hostile request.
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

// The sub-key of an `extra.<key>` reference, or null for bare `extra`/non-extra refs.
export function extraSubKey(ref) {
  const m = /^extra\.([a-zA-Z0-9_]+)$/.exec(ref);
  return m && isValidKey(m[1]) ? m[1] : null;
}

// Distinct extra sub-keys referenced in workflow or post-script prompt content.
export function extractExtraKeys(content) {
  const keys = new Set();
  for (const ref of parseRefs(content)) {
    const sub = extraSubKey(ref);
    if (sub) keys.add(sub);
  }
  return [...keys];
}

// Does a reference resolve given an availability map (built-ins + earlier keys)?
// When allowExtra is true, any `extra` / `extra.<key>` reference resolves.
export function refResolves(ref, available, allowExtra = false) {
  if (available && typeof available.has === 'function' && available.has(ref)) return true;
  return allowExtra && isExtraRef(ref);
}

// Normalize an output-format value (object map, array of {key,type}, or a JSON
// string of either) into a plain { key: type } object. Throws on malformed JSON.
export function normalizeOutputFormat(input) {
  let value = input;
  if (typeof value === 'string') {
    value = JSON.parse(value); // may throw — caller catches
  }
  const out = {};
  const setField = (key, type) => {
    // defineProperty preserves keys such as `__proto__` as ordinary data so
    // validation can reject them instead of silently changing the object.
    Object.defineProperty(out, key, { value: type, enumerable: true, configurable: true, writable: true });
  };
  if (Array.isArray(value)) {
    for (const f of value) {
      if (f && typeof f === 'object' && 'key' in f) setField(f.key, f.type ?? 'string');
    }
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (v && typeof v === 'object' && 'type' in v) setField(k, v.type);
      else if (typeof v === 'string') setField(k, v);
      else if (Array.isArray(v)) setField(k, 'array');
      else setField(k, typeof v);
    }
  }
  return out;
}

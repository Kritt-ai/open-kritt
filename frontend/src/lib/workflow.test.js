import { describe, expect, it } from 'vitest';
import {
  BUILTIN_KEYS,
  EXTRA_KEY,
  FIELD_TYPES,
  OPTIONAL_VULN_KEYS,
  REQUIRED_VULN_KEYS,
  RESERVED_POST_SCRIPT_KEYS,
  hasMalformedTemplateRefs,
  isExtraRef,
  isValidKey,
  parseTemplateRefs,
} from './keys.js';
import { availableKeysForDepth, workflowDeleteState } from './workflow.js';

describe('availableKeysForDepth', () => {
  it('clears individual upstream keys at a consumes-all boundary', () => {
    const steps = [
      { depth: 0, consumesAll: false, outputFormat: { entrypoint: 'string' } },
      { depth: 1, consumesAll: false, outputFormat: { flow: 'string' } },
      { depth: 2, consumesAll: true, outputFormat: { finding: 'string' } },
    ];

    const available = availableKeysForDepth(steps, 2);
    expect([...available.keys()]).toEqual([...BUILTIN_KEYS, 'multi_output_depth_1']);
    expect(available.has('entrypoint')).toBe(false);
    expect(available.has('flow')).toBe(false);
  });

  it('preserves earlier batch keys across a later consumes-all boundary', () => {
    const steps = [
      { depth: 0, consumesAll: false, outputFormat: { entrypoint: 'string' } },
      { depth: 1, consumesAll: true, outputFormat: { flow: 'string' } },
      { depth: 2, consumesAll: false, outputFormat: { impact: 'string' } },
      { depth: 3, consumesAll: true, outputFormat: { finding: 'string' } },
    ];

    const available = availableKeysForDepth(steps, 3);
    expect(available.has('multi_output_depth_0')).toBe(true);
    expect(available.has('multi_output_depth_2')).toBe(true);
    expect(available.has('entrypoint')).toBe(false);
    expect(available.has('flow')).toBe(false);
    expect(available.has('impact')).toBe(false);
  });
});

describe('workflowDeleteState', () => {
  it('allows an unused custom workflow to be deleted', () => {
    expect(workflowDeleteState({ isDefault: false, scanCount: 0 })).toEqual({ canDelete: true, reason: '' });
  });

  it('blocks custom workflows that have scans and explains why', () => {
    expect(workflowDeleteState({ isDefault: false, scanCount: 1 })).toEqual({
      canDelete: false,
      reason: '1 scan uses this workflow. Workflows with scans cannot be deleted.',
    });
    expect(workflowDeleteState({ isDefault: false, scanCount: 3 }).reason).toContain('3 scans');
  });

  it('blocks built-in workflows and fails closed without usage metadata', () => {
    expect(workflowDeleteState({ isDefault: true, scanCount: 0 })).toEqual({
      canDelete: false,
      reason: 'Built-in workflows cannot be deleted.',
    });
    expect(workflowDeleteState({ isDefault: false }).canDelete).toBe(false);
    expect(workflowDeleteState({ scanCount: 0 }).canDelete).toBe(false);
  });
});

describe('output key validation', () => {
  it('offers only supported workflow and post-script output field types', () => {
    expect(FIELD_TYPES).toEqual(['string', 'number', 'boolean', 'array']);
    expect(FIELD_TYPES).not.toContain('object');
  });

  it('rejects JavaScript object meta-properties that cannot round-trip safely', () => {
    expect(isValidKey('entrypoint')).toBe(true);
    expect(isValidKey('__proto__')).toBe(false);
    expect(isValidKey('constructor')).toBe(false);
    expect(isValidKey('prototype')).toBe(false);
    expect(isExtraRef('extra.impact')).toBe(true);
    expect(isExtraRef('extra.__proto__')).toBe(false);
  });

  it('limits post-script inputs to scan context and finding fields', () => {
    expect(RESERVED_POST_SCRIPT_KEYS).toEqual([
      ...BUILTIN_KEYS,
      EXTRA_KEY,
      ...REQUIRED_VULN_KEYS,
      ...OPTIONAL_VULN_KEYS,
    ]);
  });
});

describe('template reference parsing', () => {
  it('accepts valid spaced and dotted references', () => {
    expect(parseTemplateRefs('Use {{ repo_full }} and {{ extra.impact_1 }}.')).toEqual({
      refs: ['repo_full', 'extra.impact_1'],
      malformed: [],
    });
    expect(hasMalformedTemplateRefs('{{repo_full}}')).toBe(false);
  });

  it('reports invalid and unbalanced double-brace tokens', () => {
    for (const content of ['{{entry-point}}', '{{extra[impact]}}', '{{}}', '{{   }}', '{{repo_full', 'repo_full}}']) {
      expect(hasMalformedTemplateRefs(content), content).toBe(true);
      expect(parseTemplateRefs(content).malformed.length, content).toBeGreaterThan(0);
    }
  });

  it('bounds diagnostics for large nested and unmatched input', () => {
    const parsed = parseTemplateRefs(`${'{{'.repeat(50_000)}}}{{repo_full}}`);
    expect(parsed.refs).toContain('repo_full');
    expect(parsed.malformed).toHaveLength(25);
    expect(parsed.malformed.every((sample) => sample.length <= 200)).toBe(true);
  });
});

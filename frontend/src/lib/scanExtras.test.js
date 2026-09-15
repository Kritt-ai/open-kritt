import { describe, expect, it } from 'vitest';
import { extraInputText, hasExtraValue, requiredScanExtraKeys } from './scanExtras.js';

describe('extra input values', () => {
  it.each([undefined, null, '', ' \n\t '])('treats %j as missing', (value) => {
    expect(hasExtraValue(value)).toBe(false);
  });

  it.each(['note', '  note  ', 0, 23, false, true, [], {}, ['a', 'b'], { label: 'sample' }].map((value) => [value]))(
    'accepts the supplied JSON value %j',
    (value) => {
      expect(hasExtraValue(value)).toBe(true);
    }
  );

  it.each([
    [undefined, ''],
    [null, ''],
    ['', ''],
    ['  note\n', '  note\n'],
    [0, '0'],
    [false, 'false'],
    [true, 'true'],
    [[], '[]'],
    [{}, '{}'],
    [['a', 'b'], '[\n  "a",\n  "b"\n]'],
    [{ label: 'sample' }, '{\n  "label": "sample"\n}'],
  ])('displays %j as editable text', (value, expected) => {
    expect(extraInputText(value)).toBe(expected);
  });

  it('leaves structured values unchanged when validating and displaying them', () => {
    const value = Object.freeze({ label: 'sample', items: Object.freeze(['a', 'b']) });

    expect(hasExtraValue(value)).toBe(true);
    expect(JSON.parse(extraInputText(value))).toEqual(value);
  });
});

describe('requiredScanExtraKeys', () => {
  it('unions workflow extras with references from every selected post-script', () => {
    const keys = requiredScanExtraKeys(
      { extra: ['workflow_key', 'shared_key'] },
      [
        { id: '10', content: '{{extra.primary_key}} {{extra.shared_key}}' },
        { id: '11', content: '{{extra.secondary_key}}' },
        { id: '12', content: '{{extra.unselected_key}}' },
      ],
      ['10', '11']
    );

    expect(keys).toEqual(['workflow_key', 'shared_key', 'primary_key', 'secondary_key']);
  });

  it('ignores unselected, missing, bare, and malformed post-script extra references', () => {
    const keys = requiredScanExtraKeys(
      null,
      [
        { id: 1, content: '{{extra}} {{extra.valid_key}} {{extra.too.deep}} {{extra.missing' },
        { id: 2, content: '{{extra.unselected_key}}' },
      ],
      ['1', '404']
    );

    expect(keys).toEqual(['valid_key']);
  });
});

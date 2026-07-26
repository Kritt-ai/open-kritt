import { describe, expect, it } from 'vitest';
import { requiredScanExtraKeys } from './scanExtras.js';

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

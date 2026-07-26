import { describe, expect, it } from 'vitest';
import { searchSelectOptions } from './SearchSelect.jsx';

const items = [
  { id: 'z-ai/glm-5.2', label: 'Z.ai: GLM 5.2' },
  { id: 'moonshotai/kimi-code', label: 'Moonshot: Kimi Code' },
];
const filter = (model, query) =>
  !query || model.id.toLowerCase().includes(query) || model.label.toLowerCase().includes(query);

describe('searchSelectOptions', () => {
  it('turns an unlisted exact ID into a selectable custom option', () => {
    expect(
      searchSelectOptions(items, '  vendor/custom-model  ', filter, {
        allowCustomValue: true,
        customValueMaxLength: 200,
      })
    ).toEqual([{ id: 'vendor/custom-model', label: 'vendor/custom-model', isCustomValue: true }]);
  });

  it('does not duplicate an exact catalog match with a custom option', () => {
    expect(
      searchSelectOptions(items, '  z-ai/glm-5.2  ', filter, {
        allowCustomValue: true,
        customValueMaxLength: 200,
      })
    ).toEqual([items[0]]);
  });

  it('puts exact and custom IDs before fuzzy matches so Enter chooses what was typed', () => {
    const overlappingItems = [
      { id: 'vendor/model-new-extended', label: 'Extended' },
      { id: 'vendor/model', label: 'Exact' },
    ];

    expect(
      searchSelectOptions(overlappingItems, 'vendor/model', filter, {
        allowCustomValue: true,
        customValueMaxLength: 200,
      })
    ).toEqual([overlappingItems[1], overlappingItems[0]]);
    expect(
      searchSelectOptions(overlappingItems, 'vendor/model-new', filter, {
        allowCustomValue: true,
        customValueMaxLength: 200,
      })
    ).toEqual([{ id: 'vendor/model-new', label: 'vendor/model-new', isCustomValue: true }, overlappingItems[0]]);
  });

  it('keeps custom values disabled for closed catalogs and enforces their length limit', () => {
    expect(searchSelectOptions(items, 'vendor/custom-model', filter)).toEqual([]);
    expect(
      searchSelectOptions(items, 'x'.repeat(201), filter, {
        allowCustomValue: true,
        customValueMaxLength: 200,
      })
    ).toEqual([]);
  });
});

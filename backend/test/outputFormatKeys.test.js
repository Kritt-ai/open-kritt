import assert from 'node:assert/strict';
import test from 'node:test';
import { duplicateOutputFormatKeys, normalizeOutputFormat } from '../src/lib/constants.js';

test('duplicate detection uses the same field names as output normalization', () => {
  for (const key of [null, false]) {
    const fields = [
      { key, type: 'string' },
      { key: String(key), type: 'number' },
    ];
    for (const input of [fields, JSON.stringify(fields)]) {
      assert.deepEqual(Object.keys(normalizeOutputFormat(input)), [String(key)]);
      assert.deepEqual(duplicateOutputFormatKeys(input), [String(key)]);
    }
  }
});

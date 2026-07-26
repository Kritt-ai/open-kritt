import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  DEFAULT_SEVERITY_RANKERS,
  ensureDefaultSeverityRankers,
  isDefaultSeverityRankerName,
} from '../src/lib/defaultSeverityRankers.js';
import { serializeSeverityRanker } from '../src/lib/serialize.js';
import { validateSeverityRanker } from '../src/lib/validation.js';

test('ships one valid conservative default severity ranker', () => {
  assert.equal(DEFAULT_SEVERITY_RANKERS.length, 1);
  const ranker = validateSeverityRanker(DEFAULT_SEVERITY_RANKERS[0]);
  assert.equal(ranker.name, 'Blockchain security triage');
  assert.match(ranker.content, /Critical:/);
  assert.match(ranker.content, /false positives last/i);
  assert.equal(isDefaultSeverityRankerName(ranker.name), true);
  assert.equal(
    serializeSeverityRanker({ id: 1n, ...ranker }, { isDefault: isDefaultSeverityRankerName(ranker.name) }).isDefault,
    true
  );
});

test('default severity ranker installation is idempotent', async () => {
  const rows = [];
  const tx = {
    $executeRaw: async () => undefined,
    severityRanker: {
      findFirst: async ({ where }) => rows.find((row) => row.name === where.name) || null,
      create: async ({ data }) => {
        const row = { id: BigInt(rows.length + 1), ...data };
        rows.push(row);
        return row;
      },
    },
  };
  const client = { $transaction: async (callback) => callback(tx) };

  assert.deepEqual(await ensureDefaultSeverityRankers(client), ['Blockchain security triage']);
  assert.deepEqual(await ensureDefaultSeverityRankers(client), []);
  assert.equal(rows.length, 1);
});

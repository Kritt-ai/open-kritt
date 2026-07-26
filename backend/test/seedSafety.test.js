import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../prisma/seed.js', import.meta.url), 'utf8');

test('demo seed is additive and contains no destructive table wipes', () => {
  assert.doesNotMatch(source, /\.deleteMany\s*\(/);
  assert.doesNotMatch(source, /\bTRUNCATE\b|\bDROP\s+TABLE\b/i);
  assert.match(source, /existing data is preserved/i);
  assert.match(source, /findFirst/);
});

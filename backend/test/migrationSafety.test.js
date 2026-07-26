import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationDir = path.resolve(here, '../../database/init');

test('database init migrations do not drop columns or tables', () => {
  for (const filename of fs.readdirSync(migrationDir).filter((name) => name.endsWith('.sql'))) {
    const sql = fs.readFileSync(path.join(migrationDir, filename), 'utf8');
    assert.doesNotMatch(sql, /\bDROP\s+(?:COLUMN|TABLE)\b/i, `${filename} must remain forward-only`);
  }
});

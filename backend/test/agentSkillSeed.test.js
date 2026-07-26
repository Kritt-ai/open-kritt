import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const seedSql = fs.readFileSync(new URL('../../database/init/014_seed_agent_skills.sql', import.meta.url), 'utf8');

test('agent skill seed declares every bundled skill idempotently', () => {
  const slugs = [...seedSql.matchAll(/INSERT INTO public\.agent_skills[\s\S]*?\nSELECT\s*\n\s*'([^']+)'/g)].map(
    (match) => match[1]
  );
  const guards = seedSql.match(/WHERE NOT EXISTS \(SELECT 1 FROM public\.agent_skills WHERE slug = '[^']+'\);/g) || [];

  assert.equal(slugs.length, 30);
  assert.equal(new Set(slugs).size, 30);
  assert.equal(guards.length, slugs.length);
  assert.ok(slugs.includes('cloudflare-security-audit'));
  assert.ok(slugs.includes('trail-of-bits-solana-scanner'));
  assert.ok(slugs.includes('trail-of-bits-zeroize-audit'));
});

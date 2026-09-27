import assert from 'node:assert/strict';
import test from 'node:test';
import { prismaDatasourceUrl } from '../src/lib/prismaDatasource.js';

test('backend PostgreSQL pools stay below the shared database connection ceiling', () => {
  const result = new URL(prismaDatasourceUrl('postgresql://user:pass@db:5432/open_kritt?schema=public', {}));
  assert.equal(result.searchParams.get('schema'), 'public');
  assert.equal(result.searchParams.get('connection_limit'), '5');
  assert.equal(result.searchParams.get('pool_timeout'), '10');
});

test('explicit Prisma pool settings are preserved', () => {
  const result = new URL(
    prismaDatasourceUrl(
      'postgresql://user:pass@db:5432/open_kritt?connection_limit=3&pool_timeout=20',
      { BACKEND_DB_CONNECTION_LIMIT: '7', BACKEND_DB_POOL_TIMEOUT_SECONDS: '30' }
    )
  );
  assert.equal(result.searchParams.get('connection_limit'), '3');
  assert.equal(result.searchParams.get('pool_timeout'), '20');
});

test('invalid backend pool overrides fall back safely', () => {
  const result = new URL(
    prismaDatasourceUrl('postgresql://user:pass@db:5432/open_kritt', {
      BACKEND_DB_CONNECTION_LIMIT: '500',
      BACKEND_DB_POOL_TIMEOUT_SECONDS: '0',
    })
  );
  assert.equal(result.searchParams.get('connection_limit'), '5');
  assert.equal(result.searchParams.get('pool_timeout'), '10');
});

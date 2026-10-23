import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { createApp } from '../src/app.js';
import { prisma } from '../src/db.js';

async function withServer(operation) {
  const server = createApp({ env: {} }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('malformed JSON returns a sanitized client error before route handling', async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/unknown-fixture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"privateFixture":',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Malformed JSON body.' });
  });
});

test('valid JSON and health requests retain their normal responses', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
    const response = await fetch(`${base}/api/unknown-fixture`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 404);
  });
});

test('an unexpected application SyntaxError remains a sanitized server error', async (t) => {
  const original = prisma.scan.findUnique;
  prisma.scan.findUnique = async () => {
    throw new SyntaxError('Internal synthetic detail');
  };
  t.after(() => {
    prisma.scan.findUnique = original;
  });
  await withServer(async (base) => {
    const response = await fetch(`${base}/api/scans/1`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Internal server error.' });
  });
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { createApp, JSON_BODY_LIMIT_BYTES } from '../src/app.js';

async function postScan(body) {
  const server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    return await fetch(`http://127.0.0.1:${port}/api/scans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('scan requests larger than the previous 2 MB ceiling reach validation', async () => {
  const response = await postScan({ extra: { context: 'x'.repeat(4 * 1024 * 1024) } });

  assert.equal(response.status, 422);
  const body = await response.json();
  assert.equal(body.error, 'Validation failed.');
  assert.ok(body.errors.some((error) => error.field === 'workflowId'));
});

test('scan requests above the bounded JSON ceiling return a clear 413 response', async () => {
  const response = await postScan({ extra: { context: 'x'.repeat(JSON_BODY_LIMIT_BYTES) } });

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { error: 'Request body exceeds the 8 MB limit.' });
});

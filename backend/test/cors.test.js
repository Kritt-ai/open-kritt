import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';

import { createApp, corsOptions } from '../src/app.js';

async function requestHealth(env, origin) {
  const server = createApp({ env }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    return await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: origin ? { Origin: origin } : {},
    });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('CORS is disabled by default for the same-origin frontend proxy', async () => {
  assert.deepEqual(corsOptions({}), { origin: false });

  const response = await requestHealth({}, 'https://untrusted.example');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('CORS allows only explicitly configured browser origins', async () => {
  const env = { BACKEND_CORS_ORIGINS: 'https://app.example, http://localhost:5173' };

  const allowed = await requestHealth(env, 'https://app.example');
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example');

  const denied = await requestHealth(env, 'https://untrusted.example');
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
});

test('CORS wildcard requires an explicit operator opt-in', async () => {
  const response = await requestHealth({ BACKEND_CORS_ORIGINS: '*' }, 'https://app.example');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
});

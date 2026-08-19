import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { renewClaudeCredential } from '../src/lib/claudeCredentials.js';

async function claudeHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'open-kritt-claude-credential-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}

function credential(accessToken, expiresAt) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken,
      refreshToken: 'unit-test-refresh-token',
      expiresAt,
    },
  });
}

test('Claude credential renewal accepts a rotated future access token', async (t) => {
  const home = await claudeHome(t);
  const path = join(home, '.credentials.json');
  await writeFile(path, credential('expired-access', 1));

  const renewed = await renewClaudeCredential(home, {
    now: () => 10_000,
    runProbe: async () => {
      await writeFile(path, credential('renewed-access', 20_000));
    },
  });

  assert.equal(renewed, true);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).claudeAiOauth.accessToken, 'renewed-access');
});

test('Claude credential renewal preserves rotation when a quota-limited probe fails', async (t) => {
  const home = await claudeHome(t);
  const path = join(home, '.credentials.json');
  await writeFile(path, credential('expired-access', 1));

  const renewed = await renewClaudeCredential(home, {
    now: () => 10_000,
    runProbe: async () => {
      await writeFile(path, credential('rotated-before-limit', 20_000));
      throw new Error('provider quota reached');
    },
  });

  assert.equal(renewed, true);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).claudeAiOauth.accessToken, 'rotated-before-limit');
});

test('Claude credential renewal restores the original credential after an invalid probe write', async (t) => {
  const home = await claudeHome(t);
  const path = join(home, '.credentials.json');
  const original = credential('expired-access', 1);
  await writeFile(path, original);

  const renewed = await renewClaudeCredential(home, {
    now: () => 10_000,
    runProbe: async () => {
      await writeFile(path, '{"claudeAiOauth":');
      throw new Error('refresh failed');
    },
  });

  assert.equal(renewed, false);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), JSON.parse(original));
});

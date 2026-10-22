import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  CLAUDE_ACCOUNT_PROFILE_FILENAME,
  promoteClaudeCredential,
  renewClaudeCredential,
} from '../src/lib/claudeCredentials.js';

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

test('credential promotion with no new profile invalidates the old managed identity', async (t) => {
  const root = await claudeHome(t);
  const source = join(root, 'source');
  const target = join(root, 'target');
  await mkdir(source);
  await mkdir(target);
  await writeFile(join(source, '.credentials.json'), credential('new-access', 20_000));
  await writeFile(join(target, '.credentials.json'), credential('old-access', 10_000));
  await writeFile(join(target, CLAUDE_ACCOUNT_PROFILE_FILENAME), JSON.stringify({ email: 'old@example.test' }));
  await writeFile(join(target, '.claude.json'), JSON.stringify({ email: 'old-fallback@example.test' }));

  await promoteClaudeCredential(source, target);

  assert.equal(JSON.parse(await readFile(join(target, '.credentials.json'))).claudeAiOauth.accessToken, 'new-access');
  assert.deepEqual(JSON.parse(await readFile(join(target, CLAUDE_ACCOUNT_PROFILE_FILENAME)), 'utf8'), {
    provider: 'claude',
    identityKnown: false,
  });
  assert.equal(JSON.parse(await readFile(join(target, '.claude.json'))).email, 'old-fallback@example.test');
});

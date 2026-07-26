import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { cliRuntimeStatus, discoverCliExecutable, providerCliStatus } from '../src/lib/localCliProviders.js';

test('local CLI discovery resolves executables from PATH before subprocess use', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-cli-discovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, process.platform === 'win32' ? 'codex.cmd' : 'codex');
  await writeFile(bin, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
  await chmod(bin, 0o755);

  const status = discoverCliExecutable(['codex'], { env: { PATH: directory } });

  assert.equal(status.found, true);
  assert.equal(status.path, bin);
});

test('local CLI status reports saved missing paths without ENOENT crashes', async () => {
  const status = providerCliStatus('claude', {
    env: {
      OPEN_KRITT_CLAUDE_BIN: join(tmpdir(), 'definitely-missing-claude'),
      PATH: '',
    },
  });

  assert.equal(status.found, false);
  assert.match(status.message, /saved but does not exist/);
});

test('CLI runtime status distinguishes missing, unauthenticated, and connected sessions', () => {
  assert.equal(cliRuntimeStatus('codex', null, { found: false }).status, 'missing_executable');
  assert.equal(cliRuntimeStatus('codex', null, { found: true, path: '/bin/codex' }).status, 'login_required');
  assert.equal(
    cliRuntimeStatus('claude', { email: 'claude@example.com' }, { found: true, path: '/bin/claude' }).status,
    'connected'
  );
});

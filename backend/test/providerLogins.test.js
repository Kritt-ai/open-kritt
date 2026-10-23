import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { codexLoginIsConfigured } from '../src/lib/providerLogins.js';

test('account status uses the final value of a duplicated runtime setting', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'open-kritt-login-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const primaryHome = join(directory, 'codex');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  await mkdir(primaryHome);
  await writeFile(join(primaryHome, 'auth.json'), '{"fixture":"synthetic"}');
  await writeFile(runtimeConfigPath, 'ENGINE_CODEX_HOME=/root/.codex\nENGINE_CODEX_HOME=\n');

  assert.equal(codexLoginIsConfigured({ primaryHome, runtimeConfigPath }), false);
});

test('account status decodes an apostrophe in the configured home', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "open-kritt-O'Brien-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const primaryHome = join(directory, 'codex');
  const runtimeConfigPath = join(directory, 'engine-runtime.env');
  await mkdir(primaryHome);
  await writeFile(join(primaryHome, 'auth.json'), '{"fixture":"synthetic"}');
  await writeFile(runtimeConfigPath, `ENGINE_CODEX_HOME='${primaryHome.replace(/'/g, "\\'")}'\n`);

  assert.equal(codexLoginIsConfigured({ primaryHome, runtimePrimaryHome: primaryHome, runtimeConfigPath }), true);
});

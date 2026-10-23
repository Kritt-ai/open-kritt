import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  addCodexRuntimeHome,
  addGrokRuntimeHome,
  removeCodexRuntimeHome,
  removeGrokRuntimeHome,
} from '../src/lib/accountLogins.js';
import { parseEnvironmentText } from '../src/lib/environmentFile.js';

for (const [provider, add, remove] of [
  ['codex', addCodexRuntimeHome, removeCodexRuntimeHome],
  ['grok', addGrokRuntimeHome, removeGrokRuntimeHome],
]) {
  for (const explicitEmpty of [false, true]) {
    test(`${provider} account updates distinguish an empty runtime list from a missing key (${explicitEmpty})`, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'open-kritt-home-precedence-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      const runtimeConfigPath = join(root, 'runtime.env');
      const environmentFilePath = join(root, 'project.env');
      const options = { runtimeConfigPath, environmentFilePath };
      const key = `ENGINE_${provider.toUpperCase()}_HOME`;
      const oldHome = `/synthetic/old/.${provider}`;
      const newHome = `/synthetic/new/.${provider}`;
      const initialRuntime = `ENGINE_WORKER_COUNT=0\n${explicitEmpty ? `${key}=\n` : ''}`;
      await writeFile(environmentFilePath, `${key}=${oldHome}\n`);
      await writeFile(runtimeConfigPath, initialRuntime);

      assert.equal(await remove(oldHome, options), !explicitEmpty);
      if (explicitEmpty) assert.equal(await readFile(runtimeConfigPath, 'utf8'), initialRuntime);

      await writeFile(environmentFilePath, `${key}=${oldHome}\n`);
      await writeFile(runtimeConfigPath, initialRuntime);
      const expected = explicitEmpty ? [newHome] : [oldHome, newHome];
      assert.deepEqual(await add(newHome, options), expected);
      assert.deepEqual(await add(newHome, options), expected);
      const runtime = parseEnvironmentText(await readFile(runtimeConfigPath, 'utf8'));
      assert.equal(runtime[key], expected.join(','));
      assert.equal(runtime.ENGINE_WORKER_COUNT, '0');
      assert.equal(parseEnvironmentText(await readFile(environmentFilePath, 'utf8'))[key], expected.join(','));
    });
  }
}

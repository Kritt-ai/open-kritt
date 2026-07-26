#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { runCli, runStart } from './kritt-lib.mjs';
import { isInteractiveTerminal, runInteractiveCli } from './kritt-ui.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opensInteractiveUi = isInteractiveTerminal() && (argv.length === 0 || (argv[0] === 'setup' && argv.length === 1));

let exitCode;
if (opensInteractiveUi) {
  const result = await runInteractiveCli({ rootDir, initialView: argv[0] === 'setup' ? 'setup' : 'home' });
  exitCode = result.launchStart ? await runStart({ rootDir }) : result.code;
} else {
  exitCode = await runCli(argv, { rootDir });
}

process.exitCode = exitCode;

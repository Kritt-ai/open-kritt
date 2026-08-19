#!/usr/bin/env node

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHeadlessCli } from './kritt-headless-lib.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.exitCode = await runHeadlessCli(process.argv.slice(2), { rootDir });

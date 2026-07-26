#!/usr/bin/env node
/**
 * Single-source versioning for the open-kritt monorepo.
 *
 * The repo-root `VERSION` file is the ONE source of truth for day-to-day work.
 * This script propagates it into every place that needs to know the version:
 *   - VERSION                                  (semver + release-please annotation)
 *   - frontend/package.json                    (json "version")
 *   - backend/package.json                     (json "version")
 *   - engine/open_kritt_engine/__init__.py     (__version__)
 *
 * VERSION carries an `x-release-please-version` marker so release-please bumps it on
 * every release (alongside the package.json files + engine), keeping everything in
 * lockstep automatically. This script tolerates that trailing marker.
 *
 * Usage:
 *   node scripts/sync-version.mjs                       # propagate VERSION -> everything
 *   node scripts/sync-version.mjs --check               # CI: exit 1 if anything drifts
 *   node scripts/sync-version.mjs --from backend/package.json
 *                                                       # release: take the bumped
 *                                                       # package version as the lead
 *                                                       # and write it back into VERSION
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const CHECK = argv.includes('--check');
const fromIdx = argv.indexOf('--from');
const FROM = fromIdx !== -1 ? argv[fromIdx + 1] : null;

const SEMVER = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

function readJson(rel) {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
}

// Extract the semver from a string (ignores the trailing release-please marker).
function extractSemver(text) {
  return String(text).match(SEMVER)?.[0] ?? '';
}

// Determine the lead version.
const leadRaw = FROM ? readJson(FROM).version : readFileSync(join(ROOT, 'VERSION'), 'utf8');
const version = extractSemver(leadRaw);
if (!version) {
  console.error(`✗ could not find a semver (e.g. 1.2.3) in: "${String(leadRaw).trim()}"`);
  process.exit(1);
}

const drift = [];

function patchPlain(rel) {
  const path = join(ROOT, rel);
  const current = extractSemver(readFileSync(path, 'utf8'));
  if (current === version) return;
  drift.push(`${rel} (${current} → ${version})`);
  // Preserve the release-please marker so future releases keep bumping VERSION.
  if (!CHECK) writeFileSync(path, `${version} # x-release-please-version\n`);
}

function patchJsonVersion(rel) {
  const path = join(ROOT, rel);
  const json = JSON.parse(readFileSync(path, 'utf8'));
  if (json.version === version) return;
  drift.push(`${rel} (${json.version} → ${version})`);
  if (!CHECK) {
    json.version = version;
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`);
  }
}

function patchPyVersion(rel) {
  const path = join(ROOT, rel);
  const src = readFileSync(path, 'utf8');
  const next = src.replace(/__version__\s*=\s*["'][^"']*["']/, `__version__ = "${version}"`);
  if (next === src) return;
  const current = src.match(/__version__\s*=\s*["']([^"']*)["']/)?.[1] ?? '?';
  drift.push(`${rel} (${current} → ${version})`);
  if (!CHECK) writeFileSync(path, next);
}

// VERSION is a target only when the lead came from elsewhere (a release bump).
if (FROM) patchPlain('VERSION');
patchJsonVersion('frontend/package.json');
patchJsonVersion('backend/package.json');
patchPyVersion('engine/open_kritt_engine/__init__.py');

if (CHECK) {
  if (drift.length) {
    console.error(`✗ version drift from VERSION=${version}:`);
    drift.forEach((d) => console.error(`    ${d}`));
    console.error('  run: node scripts/sync-version.mjs');
    process.exit(1);
  }
  console.log(`✓ all components in sync at ${version}`);
} else {
  console.log(`open-kritt version ${version}${FROM ? ` (lead: ${FROM})` : ''}`);
  console.log(drift.length ? `  updated: ${drift.join(', ')}` : '  already in sync');
}

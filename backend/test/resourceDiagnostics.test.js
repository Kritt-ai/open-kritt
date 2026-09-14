import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';

import { readResourceDiagnostics, resourceFailure, resourceWaitingNotice } from '../src/lib/resourceDiagnostics.js';
import { createGenerationsRouter } from '../src/routes/generations.js';

const GIB = 1024 ** 3;
const now = Date.parse('2026-01-01T12:00:00Z');
const sample = (overrides = {}) => ({
  version: 1,
  observedAt: new Date(now).toISOString(),
  memory: {
    scope: 'engine_linux_system',
    totalBytes: 8 * GIB,
    availableBytes: 1.5 * GIB,
    reserveBytes: GIB,
    runnerBytes: GIB,
    configuredWorkers: 4,
    effectiveWorkers: 4,
    ...overrides,
  },
});

test('memory waiting explains the reservation sum and actual measurement scope', () => {
  const notice = resourceWaitingNotice('pending', sample());
  assert.equal(notice.title, 'Waiting for memory');
  assert.match(notice.message, /require 2 GiB.*1 GiB Docker memory reserve \+ 1 GiB Runner memory reservation/);
  assert.match(notice.message, /Linux system visible to the engine reports 1.5 GiB available/);
  assert.match(notice.remedy, /does not reduce actual memory use/);
  assert.equal(notice.fixLinks[0].url, '/settings#setting-scanRunnerMemoryReservationMb');
  assert.equal(resourceWaitingNotice('running', sample()).title, 'Waiting for memory');
});

test('zero memory capacity uses total RAM and includes generation waiting', () => {
  const snapshot = sample({ totalBytes: 1.5 * GIB, effectiveWorkers: 0, availableBytes: null });
  assert.match(resourceWaitingNotice('pending', snapshot).message, /1.5 GiB total memory/);
  assert.equal(resourceWaitingNotice('pending', snapshot, { generation: true }).title, 'Waiting for memory');
  assert.match(
    resourceWaitingNotice('pending', snapshot, { generation: true }).detail,
    /shared engine capacity is zero/
  );
  assert.notEqual(resourceWaitingNotice('pending', sample(), { generation: true }).title, 'Waiting for memory');
});

test('the exact comparison remains available when rounded GiB values look equal', () => {
  const notice = resourceWaitingNotice('pending', sample({ availableBytes: 2 * GIB - 1024 }));
  assert.equal(notice.title, 'Waiting for memory');
  assert.match(notice.detail, /2147482624 bytes available versus 2147483648 bytes required/);
});

test('paused slots, unknown measurements, and terminal states are distinguished', () => {
  assert.equal(
    resourceWaitingNotice('pending', sample({ configuredWorkers: 0, effectiveWorkers: 0 })).title,
    'New work is paused'
  );
  assert.match(resourceWaitingNotice('pending', null).message, /unavailable.*unknown/);
  assert.match(
    resourceWaitingNotice('pending', sample({ availableBytes: null, totalBytes: null })).message,
    /incomplete/
  );
  assert.equal(resourceWaitingNotice('running', sample({ availableBytes: 2 * GIB })), null);
  for (const status of ['queued', 'paused', 'failed', 'completed', 'stopped', 'rate_limited']) {
    assert.equal(resourceWaitingNotice(status, sample()), null);
  }
});

test('only fresh, valid snapshots are exposed and arbitrary fields are dropped', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'resource-diagnostics-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'snapshot.json');
  assert.equal(await readResourceDiagnostics({ path, now }), null);
  for (const snapshot of [
    { ...sample(), observedAt: new Date(now - 60_001).toISOString() },
    { ...sample(), observedAt: new Date(now + 5001).toISOString() },
    { ...sample(), version: 2 },
    sample({ availableBytes: -1 }),
    sample({ availableBytes: '0' }),
    sample({ availableBytes: undefined }),
    sample({ effectiveWorkers: 10 }),
    sample({ scope: 'host' }),
  ]) {
    await writeFile(path, JSON.stringify(snapshot));
    assert.equal(await readResourceDiagnostics({ path, now }), null);
  }
  await writeFile(path, '{');
  assert.equal(await readResourceDiagnostics({ path, now }), null);
  const snapshot = sample({ unrelated: 'must not be returned' });
  await writeFile(path, JSON.stringify({ ...snapshot, unrelated: 'discard' }));
  const read = await readResourceDiagnostics({ path, now });
  assert.equal(read.memory.availableBytes, 1.5 * GIB);
  assert.equal(read.unrelated, undefined);
  assert.equal(read.memory.unrelated, undefined);
});

test('failures distinguish disk, memory, CPU and unexplained termination', () => {
  assert.equal(resourceFailure('write: ENOSPC').key, 'engine_storage_full');
  assert.match(resourceFailure('Cannot allocate memory').message, /were not recorded/);
  assert.equal(resourceFailure('OOMKilled: true').key, 'memory_exhausted');
  assert.equal(resourceFailure('OOMKilled: false'), null);
  assert.equal(resourceFailure('Diagnostic: runner_resource_limited.').key, 'runner_terminated');
  assert.equal(resourceFailure('Runner stopped (exit 137)').key, 'runner_terminated');
  const cpu = resourceFailure('Range of CPUs is from 0.01 to 4, as there are only 4 CPUs available');
  assert.match(cpu.message, /4 CPUs available; the requested CPU value was not recorded/);
  assert.equal(cpu.fixLinks[0].url, '/settings#setting-scanRunnerCpus');
  for (const text of [
    'connection timeout',
    'cannot set path in scalar',
    'provider at capacity',
    'Requested CPUs are not available - requested 8, available: 0-3',
    'remote ENOSPC. Diagnostic: provider_rejected.',
    'DNS failed. Diagnostic: network_error.',
  ]) {
    assert.equal(resourceFailure(text), null);
  }
});

test('generation polling attaches waits only to pending work and remedies only to failures', async (t) => {
  const row = { id: 7n, kind: 'post_script', status: 'pending' };
  let reads = 0;
  const app = express();
  app.use(
    createGenerationsRouter({
      prismaClient: { generation: { findUnique: async () => row } },
      readResources: async () => {
        reads += 1;
        return sample({ totalBytes: 1.5 * GIB, effectiveWorkers: 0 });
      },
    })
  );
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const get = async () => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/7`);
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await get()).resourceNotice.title, 'Waiting for memory');
  row.status = 'running';
  assert.equal((await get()).resourceNotice, null);
  row.status = 'failed';
  row.error = 'Resource diagnostic: storage_exhausted. Diagnostic: start_failed.';
  const failed = await get();
  assert.equal(failed.resourceNotice, null);
  assert.equal(failed.resourceFailure.key, 'engine_storage_full');
  assert.equal(failed.resourceFailure.fixLinks, undefined);
  row.error = 'Resource diagnostic: memory_exhausted. Diagnostic: start_failed.';
  const memoryFailure = (await get()).resourceFailure;
  assert.match(memoryFailure.message, /does not cap generation calls/);
  assert.equal(memoryFailure.fixLinks, undefined);
  assert.equal(reads, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { scanDiscoveryStatus } from '../src/lib/adaptiveDiscovery.js';

const configuration = {
  adaptive_discovery: { enabled: true, step_id: 4, max_paths: 20, wall_time_seconds: 600 },
};

function snapshotDb(tables) {
  return {
    $transaction: async (read, options) => {
      assert.deepEqual(options, { isolationLevel: 'RepeatableRead' });
      return read(tables);
    },
  };
}

test('disabled discovery status makes no frontier database queries', async () => {
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error('Unexpected query');
      },
    }
  );
  for (const option of [{}, { adaptive_discovery: false }, { adaptive_discovery: { enabled: false } }]) {
    assert.deepEqual(await scanDiscoveryStatus(db, { id: 7n, configuration: option }), {
      enabled: false,
      frontier: null,
      paths: [],
    });
  }
});

test('uninitialized enabled discovery is not reported as exhausted', async () => {
  const db = snapshotDb({
    discoveryFrontier: { findUnique: async () => null },
    discoveryPath: { findMany: async () => [] },
  });
  assert.deepEqual(await scanDiscoveryStatus(db, { id: 7n, configuration }), {
    enabled: true,
    state_source: 'persisted',
    configuration: configuration.adaptive_discovery,
    frontier: null,
    paths: [],
  });
});

test('status exposes persisted exploration records separately and preserves their dispositions', async () => {
  const queries = [];
  const frontier = {
    scanId: 7n,
    stepId: 4n,
    status: 'budget_stopped',
    reason: 'Discovery deadline',
    deadlineAt: new Date('2026-10-07T09:00:00Z'),
  };
  const paths = [
    {
      id: 11n,
      scanId: 7n,
      scope: '.',
      question: 'Inspect caller',
      status: 'completed',
      proposals: [{ disposition: 'duplicate', path_id: 11 }],
    },
    { id: 12n, scanId: 7n, parentPathId: 11n, status: 'budget_stopped' },
  ];
  const db = snapshotDb({
    discoveryFrontier: {
      findUnique: async (query) => {
        queries.push(query);
        return frontier;
      },
    },
    discoveryPath: {
      findMany: async (query) => {
        queries.push(query);
        return paths;
      },
    },
  });
  const result = await scanDiscoveryStatus(db, { id: 7n, configuration });
  assert.deepEqual(queries, [{ where: { scanId: 7n } }, { where: { scanId: 7n }, orderBy: { id: 'asc' } }]);
  assert.equal(result.state_source, 'persisted');
  assert.equal(result.frontier.status, 'budget_stopped');
  assert.equal(result.frontier.deadlineAt, '2026-10-07T09:00:00.000Z');
  assert.equal(result.paths[0].id, '11');
  assert.equal(result.paths[1].parentPathId, '11');
  assert.deepEqual(result.paths[0].proposals, paths[0].proposals);
  assert.equal(Object.hasOwn(result, 'findings'), false);
  assert.equal(frontier.scanId, 7n);
  assert.equal(paths[0].id, 11n);
});

test('discovery storage errors propagate instead of reporting false exhaustion', async () => {
  const error = new Error('Database unavailable');
  const db = snapshotDb({
    discoveryFrontier: {
      findUnique: async () => {
        throw error;
      },
    },
    discoveryPath: { findMany: async () => [] },
  });
  await assert.rejects(scanDiscoveryStatus(db, { id: 7n, configuration }), (actual) => actual === error);
});

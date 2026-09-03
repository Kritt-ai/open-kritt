import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import express from 'express';

import { countLocalRepoSnapshotFiles, localRepoStats } from '../src/lib/localRepos.js';
import localReposRouter, { localRepoStatsErrorResponse } from '../src/routes/localRepos.js';

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'open-kritt-local-repos-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

async function requestRouter(urlPath) {
  const app = express();
  app.use('/api/local-repos', localReposRouter);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();

  try {
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`);
    return {
      status: response.status,
      cacheControl: response.headers.get('cache-control'),
      body: await response.json(),
    };
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('snapshot file counting includes hidden and symlink entries without following links', async (t) => {
  const repo = await temporaryDirectory(t);
  await fs.mkdir(path.join(repo, 'nested', '.git'), { recursive: true });
  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.writeFile(path.join(repo, 'tracked.js'), '');
  await fs.writeFile(path.join(repo, '.ignored-by-git'), '');
  await fs.writeFile(path.join(repo, 'nested', 'untracked.txt'), '');
  await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main');
  await fs.writeFile(path.join(repo, 'nested', '.git', 'secret'), '');
  await fs.symlink('nested', path.join(repo, 'linked-directory'));

  assert.deepEqual(await countLocalRepoSnapshotFiles(repo), {
    fileCount: 4,
    complete: true,
    snapshotIssues: [],
  });
});

test('snapshot file counting stops after its traversal ceiling and returns a lower bound', async (t) => {
  const repo = await temporaryDirectory(t);
  await Promise.all(['a', 'b', 'c'].map((name) => fs.writeFile(path.join(repo, name), '')));

  assert.deepEqual(await countLocalRepoSnapshotFiles(repo, { ceiling: 2 }), {
    fileCount: 3,
    complete: false,
    snapshotIssues: [],
  });
  await assert.rejects(() => countLocalRepoSnapshotFiles(repo, { ceiling: 0 }), /positive safe integer/);
  await assert.rejects(
    () => countLocalRepoSnapshotFiles(repo, { ceiling: Number.MAX_SAFE_INTEGER }),
    /below Number.MAX_SAFE_INTEGER/
  );
});

test('snapshot file counting bounds directory-heavy trees and supports cancellation', async (t) => {
  const repo = await temporaryDirectory(t);
  await Promise.all(['one', 'two', 'three'].map((name) => fs.mkdir(path.join(repo, name))));

  assert.deepEqual(await countLocalRepoSnapshotFiles(repo, { ceiling: 10, entryCeiling: 2 }), {
    fileCount: 0,
    complete: false,
    snapshotIssues: [],
  });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => countLocalRepoSnapshotFiles(repo, { signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('snapshot file counting omits links the engine safely skips', async (t) => {
  const repo = await temporaryDirectory(t);
  const outside = await temporaryDirectory(t);
  await fs.symlink(outside, path.join(repo, 'outside-link'));

  assert.deepEqual(await countLocalRepoSnapshotFiles(repo), {
    fileCount: 0,
    complete: true,
    snapshotIssues: [],
  });
});

test('snapshot file counting flags unsupported special files', async (t) => {
  const repo = await temporaryDirectory(t);
  const socketPath = path.join(repo, 'service.sock');
  const server = net.createServer();
  server.listen(socketPath);
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));

  assert.deepEqual(await countLocalRepoSnapshotFiles(repo), {
    fileCount: 1,
    complete: true,
    snapshotIssues: ['special_file'],
  });
});

test('local repository stats use the immediate-child allowlist', async (t) => {
  const root = await temporaryDirectory(t);
  const previousRoot = process.env.LOCAL_REPOS_PATH;
  t.after(() => {
    if (previousRoot === undefined) delete process.env.LOCAL_REPOS_PATH;
    else process.env.LOCAL_REPOS_PATH = previousRoot;
  });
  process.env.LOCAL_REPOS_PATH = root;

  const repo = path.join(root, 'working tree #1');
  await fs.mkdir(repo);
  await fs.writeFile(path.join(repo, 'source.go'), '');

  assert.deepEqual(await localRepoStats('working tree #1'), {
    name: 'working tree #1',
    fileCount: 1,
    complete: true,
    snapshotIssues: [],
  });
  assert.equal(await localRepoStats('../working tree #1'), null);
  assert.equal(await localRepoStats('missing'), null);

  const found = await requestRouter('/api/local-repos/working%20tree%20%231/stats');
  assert.deepEqual(found, {
    status: 200,
    cacheControl: 'no-store',
    body: { name: 'working tree #1', fileCount: 1, complete: true, snapshotIssues: [] },
  });
  const missing = await requestRouter('/api/local-repos/missing/stats');
  assert.deepEqual(missing, {
    status: 404,
    cacheControl: 'no-store',
    body: { error: 'Local repository not found.' },
  });
  const traversal = await requestRouter('/api/local-repos/..%2Fworking%20tree%20%231/stats');
  assert.deepEqual(traversal, {
    status: 404,
    cacheControl: 'no-store',
    body: { error: 'Local repository not found.' },
  });
});

test('local repository stats map expected filesystem failures to nonfatal API responses', () => {
  assert.deepEqual(localRepoStatsErrorResponse({ code: 'ENOENT' }), {
    status: 404,
    error: 'Local repository not found.',
  });
  assert.deepEqual(localRepoStatsErrorResponse({ code: 'ESTALE' }), {
    status: 409,
    error: 'Local repository changed while it was being counted. Retry the count.',
  });
  assert.deepEqual(localRepoStatsErrorResponse({ code: 'EACCES' }), {
    status: 503,
    error: 'Local repository file count is unavailable.',
  });
  assert.equal(localRepoStatsErrorResponse(new Error('unexpected')), null);
});

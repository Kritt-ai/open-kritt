// Lists the local repositories available to scan. These live under the directory
// bind-mounted into the container at LOCAL_REPOS_PATH (default /local_repos).
// Each immediate sub-directory is treated as a repo; git info is best-effort.

import fs from 'node:fs';
import path from 'node:path';

export const LOCAL_REPO_FILE_COUNT_CEILING = 1_000_000;
const MAX_SAFE_COUNT_CEILING = Number.MAX_SAFE_INTEGER - 1;

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  const error = new Error('Local repository file counting was cancelled.');
  error.name = 'AbortError';
  throw error;
}

function changedDuringCount(message) {
  const error = new Error(message);
  error.code = 'ESTALE';
  return error;
}

function pathIsWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

async function resolveAllowingMissing(candidate) {
  let cursor = path.resolve(candidate);
  const missingTail = [];

  while (true) {
    try {
      const resolved = await fs.promises.realpath(cursor);
      return path.resolve(resolved, ...missingTail);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) return null;
      const parent = path.dirname(cursor);
      if (parent === cursor) return null;
      missingTail.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function symlinkStaysWithinRoot(linkPath, root) {
  const target = await fs.promises.readlink(linkPath);
  if (path.isAbsolute(target)) return false;
  const resolvedTarget = await resolveAllowingMissing(path.resolve(path.dirname(linkPath), target));
  return resolvedTarget !== null && pathIsWithin(root, resolvedTarget);
}

export function localReposRoot() {
  return process.env.LOCAL_REPOS_PATH || '/local_repos';
}

// Best-effort: read the checked-out branch + short commit straight from .git,
// without shelling out to git. Returns { branch, commit } (either may be null).
function gitInfo(repoDir) {
  try {
    const headPath = path.join(repoDir, '.git', 'HEAD');
    if (!fs.existsSync(headPath)) return { branch: null, commit: null };
    const head = fs.readFileSync(headPath, 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim(); // e.g. refs/heads/main
      const branch = ref.replace(/^refs\/heads\//, '');
      let commit = null;
      const looseRef = path.join(repoDir, '.git', ref);
      if (fs.existsSync(looseRef)) {
        commit = fs.readFileSync(looseRef, 'utf8').trim();
      } else {
        const packed = path.join(repoDir, '.git', 'packed-refs');
        if (fs.existsSync(packed)) {
          const line = fs
            .readFileSync(packed, 'utf8')
            .split('\n')
            .find((l) => l.trim().endsWith(' ' + ref));
          if (line) commit = line.trim().split(/\s+/)[0];
        }
      }
      return { branch, commit: commit ? commit.slice(0, 7) : null };
    }
    // Detached HEAD — head is the commit hash itself.
    return { branch: null, commit: head.slice(0, 7) };
  } catch {
    return { branch: null, commit: null };
  }
}

// Returns [{ name, path, isGit, branch, commit }] sorted by name.
export function listLocalRepos() {
  const root = localReposRoot();
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return []; // root missing / unreadable — no local repos available
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => {
      const dir = path.join(root, e.name);
      const isGit = fs.existsSync(path.join(dir, '.git'));
      const { branch, commit } = isGit ? gitInfo(dir) : { branch: null, commit: null };
      return { name: e.name, path: dir, isGit, branch, commit };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function localRepoNames() {
  return new Set(listLocalRepos().map((r) => r.name));
}

// Count the file-like entries that a local scan snapshot would inspect. This
// deliberately does not use Git metadata or .gitignore: local snapshots include
// ignored and untracked files. Symlinks count as one entry and are never followed.
export async function countLocalRepoSnapshotFiles(
  repoDir,
  {
    ceiling = LOCAL_REPO_FILE_COUNT_CEILING,
    entryCeiling = LOCAL_REPO_FILE_COUNT_CEILING,
    signal,
    allowedRoot = null,
  } = {}
) {
  if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > MAX_SAFE_COUNT_CEILING) {
    throw new TypeError('ceiling must be a positive safe integer below Number.MAX_SAFE_INTEGER');
  }
  if (!Number.isSafeInteger(entryCeiling) || entryCeiling < 1 || entryCeiling > MAX_SAFE_COUNT_CEILING) {
    throw new TypeError('entryCeiling must be a positive safe integer below Number.MAX_SAFE_INTEGER');
  }

  throwIfAborted(signal);
  const repoRoot = await fs.promises.realpath(repoDir);
  if (allowedRoot && path.dirname(repoRoot) !== allowedRoot) {
    throw changedDuringCount('Local repository moved outside its configured root while it was being counted.');
  }

  let fileCount = 0;
  let entryCount = 0;
  const snapshotIssues = new Set();
  const directories = [repoRoot];
  const result = (complete) => ({ fileCount, complete, snapshotIssues: [...snapshotIssues] });

  while (directories.length > 0) {
    throwIfAborted(signal);
    const directory = directories.pop();
    const before = await fs.promises.lstat(directory);
    if (!before.isDirectory()) {
      throw changedDuringCount('Local repository directory changed while it was being counted.');
    }
    const resolvedDirectory = await fs.promises.realpath(directory);
    if (!pathIsWithin(repoRoot, resolvedDirectory)) {
      throw changedDuringCount('Local repository directory moved outside its root while it was being counted.');
    }
    const entries = await fs.promises.opendir(directory);

    for await (const entry of entries) {
      throwIfAborted(signal);
      entryCount += 1;
      if (entryCount > entryCeiling) return result(false);
      if (entry.name === '.git') continue;
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        directories.push(entryPath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        if (!(await symlinkStaysWithinRoot(entryPath, repoRoot))) continue;
      } else if (!entry.isFile()) {
        snapshotIssues.add('special_file');
      }
      fileCount += 1;
      if (fileCount > ceiling) return result(false);
    }

    const after = await fs.promises.lstat(directory);
    if (
      !after.isDirectory() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw changedDuringCount('Local repository directory changed while it was being counted.');
    }
  }

  return result(true);
}

// Resolve a repository from the same immediate-child allowlist used by scan
// creation, then count it lazily so listing repositories stays inexpensive.
export async function localRepoStats(name, options) {
  if (typeof name !== 'string' || !name) return null;
  const repo = listLocalRepos().find((candidate) => candidate.name === name);
  if (!repo) return null;

  const root = await fs.promises.realpath(localReposRoot());
  const count = await countLocalRepoSnapshotFiles(repo.path, { ...options, allowedRoot: root });
  return { name: repo.name, ...count };
}

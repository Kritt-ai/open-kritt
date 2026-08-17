// Lists the local repositories available to scan. These live under the directory
// bind-mounted into the container at LOCAL_REPOS_PATH (default /local_repos).
// Each immediate sub-directory is treated as a repo; git info is best-effort.

import fs from 'node:fs';
import path from 'node:path';

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

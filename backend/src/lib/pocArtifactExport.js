import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const MAX_ARTIFACT_FILES_PER_FINDING = 13;
const MAX_ARTIFACT_BYTES_PER_FINDING = 9 * 1024 * 1024;
const SAFE_FILE = /^[A-Za-z0-9._-]{1,120}$/;

export async function loadPocArtifacts(scanId, findings, dataDir = '/engine-data') {
  const artifacts = new Map();
  for (const finding of findings) {
    const enrichment = (finding.enrichments || []).find(
      (item) => item?.result?.poc_status === 'reproduced' && item?.result?.poc_artifact_dir
    );
    if (!enrichment) continue;
    const relative = enrichment.result.poc_artifact_dir;
    const expected = new RegExp(`^poc-artifacts/scan-${scanId}/finding-${finding.id}/metadata-[0-9]+$`);
    if (!expected.test(relative)) throw new Error('PoC artifact directory does not match its scan and finding.');
    const directory = path.join(dataDir, relative);
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
      throw new Error('PoC artifact directory is unavailable or unsafe.');
    }
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.length > MAX_ARTIFACT_FILES_PER_FINDING) throw new Error('Too many PoC artifacts for one finding.');
    const files = [];
    let bytes = 0;
    for (const entry of entries) {
      if (!entry.isFile() || !SAFE_FILE.test(entry.name)) throw new Error('Unsafe PoC artifact file.');
      const filePath = path.join(directory, entry.name);
      const stat = await lstat(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe PoC artifact file.');
      bytes += stat.size;
      if (bytes > MAX_ARTIFACT_BYTES_PER_FINDING) throw new Error('PoC artifacts exceed the export limit.');
      files.push({ name: entry.name, content: await readFile(filePath) });
    }
    artifacts.set(String(finding.id), files);
  }
  return artifacts;
}

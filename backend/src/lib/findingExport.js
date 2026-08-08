const REPORT_KEY = '_reserved_report';
const POC_KEY = '_reserved_poc';
const EXPORT_FORMAT_VERSION = 1;
export const MAX_FINDING_EXPORT_BYTES = 64 * 1024 * 1024;

export class FindingExportTooLargeError extends Error {
  constructor(limitBytes) {
    const limitLabel =
      limitBytes >= 1024 * 1024 ? `${Math.floor(limitBytes / (1024 * 1024))} MiB` : `${limitBytes} bytes`;
    super(`This findings export exceeds the ${limitLabel} uncompressed size limit.`);
    this.name = 'FindingExportTooLargeError';
    this.limitBytes = limitBytes;
  }
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function json(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function text(value, fallback = 'Not provided.') {
  if (typeof value === 'string') return value.trim() || fallback;
  if (value === null || value === undefined) return fallback;
  return JSON.stringify(value, null, 2);
}

function markdownTableValue(value) {
  return text(value, '—').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|');
}

function fencedJson(value) {
  const body = JSON.stringify(value, null, 2);
  const longestRun = Math.max(0, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}json\n${body}\n${fence}`;
}

function markdownSection(title, value) {
  return `## ${title}\n\n${text(value)}\n`;
}

function triggerFlowMarkdown(value) {
  if (!Array.isArray(value)) return text(value);
  if (!value.length) return 'Not provided.';
  return value
    .map((step, index) => {
      const rendered = typeof step === 'string' ? step : `\n${fencedJson(step)}`;
      return `${index + 1}. ${rendered}`;
    })
    .join('\n');
}

function primaryPostScriptSource(vulnerability, primaryPostScriptName) {
  const result = record(vulnerability.postScriptAnswer);
  if (!result || !Object.keys(result).length) return null;
  return {
    name: primaryPostScriptName || 'Primary post-script',
    result,
    stub: false,
    stubExplanation: null,
  };
}

export function findingPostScriptSources(vulnerability, primaryPostScriptName) {
  const sources = [];
  const primary = primaryPostScriptSource(vulnerability, primaryPostScriptName);
  if (primary) sources.push(primary);
  for (const enrichment of vulnerability.enrichments || []) {
    const result = record(enrichment?.result);
    if (!result) continue;
    sources.push({
      name: enrichment.postScriptName || 'Post-script',
      result,
      stub: Boolean(enrichment.stub),
      stubExplanation: enrichment.stubExplanation ?? null,
    });
  }
  return sources;
}

export function reservedFindingMarkdown(sources, key) {
  for (const source of sources) {
    const value = source.result?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

export function exportSlug(value, fallback = 'export', maxLength = 80) {
  const slug = `${value ?? ''}`
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
  return slug || fallback;
}

function findingSeverity(vulnerability) {
  if (typeof vulnerability.severity === 'string' && vulnerability.severity.trim()) return vulnerability.severity;
  for (const source of findingPostScriptSources(vulnerability)) {
    const severity = source.result?.severity;
    if (typeof severity === 'string' && severity.trim()) return severity;
  }
  return vulnerability.bountyRank?.impactLevel || vulnerability.jsonAnswer?.verdict_target_severity || 'Unrated';
}

function findingMarkdown(vulnerability, ordinal) {
  const summary = text(vulnerability.summary, `Finding ${ordinal}`);
  const location = [vulnerability.file_path, vulnerability.line]
    .filter((value) => value !== null && value !== undefined && value !== '')
    .join(':');
  const metadata = [
    ['Finding ID', vulnerability.id],
    ['Rank', vulnerability.rank ?? ordinal],
    ['Severity', findingSeverity(vulnerability)],
    ['Location', location || '—'],
    ['Vulnerability type', vulnerability.vulnerability_type],
    ['Malicious actor', vulnerability.malicious_actor],
    ['Exploitable', vulnerability.exploitable],
    [
      'Review',
      vulnerability.interesting === 1
        ? 'Interesting'
        : vulnerability.interesting === 0
          ? 'Not interesting'
          : 'Unmarked',
    ],
  ];
  const lines = [
    `# ${summary}`,
    '',
    '| Field | Value |',
    '| --- | --- |',
    ...metadata.map(([label, value]) => `| ${label} | ${markdownTableValue(value)} |`),
    '',
    markdownSection('Explanation', vulnerability.explanation),
    '## Trigger flow',
    '',
    triggerFlowMarkdown(vulnerability.trigger_flow),
    '',
    markdownSection('Malicious input example', vulnerability.malicious_input_example),
  ];
  if (typeof vulnerability.comments === 'string' && vulnerability.comments.trim()) {
    lines.push(markdownSection('Review comments', vulnerability.comments));
  }
  lines.push('## Complete workflow result', '', fencedJson(vulnerability.jsonAnswer || {}), '');
  return `${lines.join('\n').trim()}\n`;
}

function scanManifest(scan) {
  return {
    id: scan.id,
    status: scan.status,
    repository: {
      full: scan.repoFull,
      display: scan.repoDisplay,
      kind: scan.repoKind,
      commitSha: scan.commitSha,
      scope: scan.repoScope,
      dependencies: scan.dependencies || [],
    },
    workflow: {
      id: scan.workflowId,
      name: scan.workflowName,
    },
    runtime: {
      model: scan.model,
      modelProvider: scan.modelProvider,
      harness: scan.harness,
      thinkingEffort: scan.thinkingEffort,
      postProcessingThinkingEffort: scan.postProcessingThinkingEffort,
      modelOverrides: scan.modelOverrides || {},
    },
    postScripts: scan.postScripts || [],
    agentSkills: scan.agentSkills || [],
    configuration: scan.configuration || {},
    extra: scan.extra || {},
    scopes: scan.scopes || {},
    severityRanker: scan.severityRanker || '',
    counts: {
      findings: scan.findings,
      rawCandidates: scan.rawCandidates,
      duplicates: scan.duplicateFindings,
      exploitable: scan.exploitable,
    },
    insertedAt: scan.insertedAt,
    updatedAt: scan.updatedAt,
  };
}

function readmeMarkdown(scan, findings, findingDirectories) {
  const lines = [
    `# ${text(scan.repoDisplay || scan.repoFull, 'Scan')} findings`,
    '',
    `Export of ${findings.length} canonical finding${findings.length === 1 ? '' : 's'} from completed scan ${scan.id}.`,
    '',
    '| Rank | Severity | Finding | Report | PoC |',
    '| ---: | --- | --- | :---: | :---: |',
  ];

  findings.forEach((vulnerability, index) => {
    const sources = findingPostScriptSources(vulnerability, scan.postScriptName);
    const hasReport = Boolean(reservedFindingMarkdown(sources, REPORT_KEY));
    const hasPoc = Boolean(reservedFindingMarkdown(sources, POC_KEY));
    const directory = findingDirectories[index];
    lines.push(
      `| ${vulnerability.rank ?? index + 1} | ${markdownTableValue(findingSeverity(vulnerability))} | [${markdownTableValue(
        vulnerability.summary || `Finding ${index + 1}`
      )}](${directory}/finding.md) | ${hasReport ? `[yes](${directory}/report.md)` : '—'} | ${
        hasPoc ? `[yes](${directory}/poc.md)` : '—'
      } |`
    );
  });

  lines.push(
    '',
    'Each finding directory contains the readable overview, the complete structured finding, every post-processing result, and the generated report/PoC when present.',
    '',
    '`manifest.json` is the lossless machine-readable index for this export.',
    ''
  );
  return lines.join('\n');
}

export function createFindingExport(
  scan,
  findings,
  { exportedAt = new Date(), maxBytes = MAX_FINDING_EXPORT_BYTES } = {}
) {
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : MAX_FINDING_EXPORT_BYTES;
  const ordered = [...findings].sort(
    (left, right) =>
      (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER) ||
      Number(left.id) - Number(right.id)
  );
  const repoSlug = exportSlug(scan.repoDisplay || scan.repoFull, 'scan');
  const root = `${repoSlug}-scan-${exportSlug(scan.id, 'unknown')}-findings`;
  const findingDirectories = ordered.map((vulnerability, index) => {
    const ordinal = `${index + 1}`.padStart(Math.max(2, `${ordered.length}`.length), '0');
    return `finding-${ordinal}-${exportSlug(vulnerability.summary, `id-${vulnerability.id}`, 72)}`;
  });
  const files = [];
  let totalBytes = 0;
  const addFile = (path, content) => {
    totalBytes += Buffer.byteLength(content, 'utf8');
    if (totalBytes > byteLimit) throw new FindingExportTooLargeError(byteLimit);
    files.push({ path, content });
  };

  const manifest = {
    formatVersion: EXPORT_FORMAT_VERSION,
    exportedAt: new Date(exportedAt).toISOString(),
    scan: scanManifest(scan),
    findings: ordered,
  };
  addFile('README.md', readmeMarkdown(scan, ordered, findingDirectories));
  addFile('manifest.json', json(manifest));

  ordered.forEach((vulnerability, index) => {
    const directory = findingDirectories[index];
    const sources = findingPostScriptSources(vulnerability, scan.postScriptName);
    const report = reservedFindingMarkdown(sources, REPORT_KEY);
    const poc = reservedFindingMarkdown(sources, POC_KEY);
    const postProcessing = {
      primary: primaryPostScriptSource(vulnerability, scan.postScriptName),
      enrichments: vulnerability.enrichments || [],
    };
    addFile(`${directory}/finding.md`, findingMarkdown(vulnerability, index + 1));
    addFile(`${directory}/finding.json`, json(vulnerability));
    addFile(`${directory}/post-processing.json`, json(postProcessing));
    if (report) addFile(`${directory}/report.md`, report.endsWith('\n') ? report : `${report}\n`);
    if (poc) addFile(`${directory}/poc.md`, poc.endsWith('\n') ? poc : `${poc}\n`);
  });

  return {
    filename: `${root}.zip`,
    root,
    files,
    uncompressedBytes: totalBytes,
  };
}

export function findingExportAvailability(scan, findingCount) {
  if (scan.status !== 'completed') {
    return {
      ready: false,
      message: 'Findings can be exported after the scan and post-processing are complete.',
    };
  }
  if (!findingCount) {
    return { ready: false, message: 'This scan has no canonical findings to export.' };
  }
  return { ready: true, message: null };
}

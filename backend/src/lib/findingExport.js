const REPORT_KEY = '_reserved_report';
const POC_KEY = '_reserved_poc';
const EXPORT_FORMAT_VERSION = 2;
export const FINDING_EXPORT_STATUSES = Object.freeze(['completed', 'stopped', 'failed']);
export const MAX_FINDING_EXPORT_BYTES = 64 * 1024 * 1024;
export const MAX_FINDING_EXPORT_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_FINDING_EXPORT_SOURCE_BYTES = 32 * 1024 * 1024;
export const MAX_FINDING_EXPORT_SOURCE_RECORD_BYTES = 8 * 1024 * 1024;
export const MAX_FINDING_EXPORT_FINDINGS = 500;
export const MAX_FINDING_EXPORT_RELATED_RECORDS = 5000;
export const MAX_CONCURRENT_FINDING_EXPORTS = 2;

export class FindingExportTooLargeError extends Error {
  constructor(limitBytes, path = null) {
    const limitLabel =
      limitBytes >= 1024 * 1024 ? `${Math.floor(limitBytes / (1024 * 1024))} MiB` : `${limitBytes} bytes`;
    super(
      path
        ? `The export file ${path} exceeds the ${limitLabel} per-file size limit.`
        : `This findings export exceeds the ${limitLabel} uncompressed size limit.`
    );
    this.name = 'FindingExportTooLargeError';
    this.limitBytes = limitBytes;
    this.path = path;
  }
}

export class FindingExportTooManyFindingsError extends Error {
  constructor(limit) {
    super(`This scan has more than the ${limit} findings export limit.`);
    this.name = 'FindingExportTooManyFindingsError';
    this.limit = limit;
  }
}

export class FindingExportSourceTooLargeError extends Error {
  constructor(limitBytes, scope) {
    const limitLabel = `${Math.floor(limitBytes / (1024 * 1024))} MiB`;
    super(`The stored ${scope} exceeds the ${limitLabel} findings export source limit.`);
    this.name = 'FindingExportSourceTooLargeError';
    this.limitBytes = limitBytes;
    this.scope = scope;
  }
}

export class FindingExportTooManyRelatedRecordsError extends Error {
  constructor(limit, recordType) {
    super(`This scan has more than the ${limit} ${recordType} export limit.`);
    this.name = 'FindingExportTooManyRelatedRecordsError';
    this.limit = limit;
    this.recordType = recordType;
  }
}

export class FindingExportBusyError extends Error {
  constructor(retryAfterSeconds = 5) {
    super('The server is already generating the maximum number of findings exports. Try again shortly.');
    this.name = 'FindingExportBusyError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function createFindingExportLimiter(maxConcurrent = MAX_CONCURRENT_FINDING_EXPORTS) {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new TypeError('The findings export concurrency limit must be a positive integer.');
  }
  let active = 0;
  return async (operation) => {
    if (active >= maxConcurrent) throw new FindingExportBusyError();
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
    }
  };
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

// Scan output is attacker-influenced. Keep it as visible text in generated
// Markdown instead of allowing it to introduce links, images, HTML, or layout
// controls. Raw report and PoC text is exported separately as .txt.
function visibleText(value) {
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0);
      const hiddenControl =
        (code < 32 && ![9, 10].includes(code)) ||
        (code >= 127 && code <= 159) ||
        (code >= 0x202a && code <= 0x202e) ||
        (code >= 0x2066 && code <= 0x2069);
      return hiddenControl ? `\\u${code.toString(16).padStart(4, '0')}` : character;
    })
    .join('');
}

function markdownText(value, fallback = 'Not provided.') {
  return visibleText(text(value, fallback).replace(/\r\n?/g, '\n'))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]{}()#+\-.!|/:?@])/g, '\\$1');
}

function markdownTableValue(value) {
  return markdownText(value, '—').replace(/\n/g, '<br>');
}

function fencedJson(value) {
  const body = visibleText(JSON.stringify(value, null, 2));
  const longestRun = Math.max(0, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}json\n${body}\n${fence}`;
}

function markdownSection(title, value) {
  return `## ${title}\n\n${markdownText(value)}\n`;
}

function triggerFlowMarkdown(value) {
  if (!Array.isArray(value)) return markdownText(value);
  if (!value.length) return 'Not provided.';
  return value
    .map((step, index) => {
      const rendered = typeof step === 'string' ? markdownText(step) : `\n${fencedJson(step)}`;
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

function shareSafeRepositoryDisplay(scan) {
  if (scan.repoKind === 'local') return 'Local repository';
  const display = `${scan.repoDisplay || ''}`.trim();
  return /^[a-z0-9._-]+(?:\/[a-z0-9._-]+)+$/i.test(display) ? display : 'Remote repository';
}

function findingReadinessSummary(vulnerability) {
  return record(vulnerability.readiness);
}

// Latest result per v2.7 stage from serialized enrichments (`stage` is set by
// the finding serializer; results already carry their engine blocks).
function findingStageResults(vulnerability) {
  const stages = {};
  for (const enrichment of vulnerability.enrichments || []) {
    const result = record(enrichment?.result);
    if (!result || enrichment.stub) continue;
    if (['d3', 'd4', 'd5'].includes(enrichment.stage)) stages[enrichment.stage] = result;
  }
  return stages;
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function markdownTable(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map((cell) => markdownTableValue(cell)).join(' | ')} |`),
  ];
}

function evidencePathsMarkdown(paths, evidence) {
  const captured = new Set(list(evidence?.captured_paths));
  const entries = list(paths).filter((path) => typeof path === 'string' && path);
  if (!entries.length) return '—';
  return entries
    .map((path) => `${markdownText(path)} (${captured.has(path) ? 'captured' : 'unresolved'})`)
    .join('<br>');
}

function openMaterialAssumptions(...sources) {
  const seen = new Map();
  for (const assumptions of sources) {
    for (const assumption of list(assumptions)) {
      if (!record(assumption)) continue;
      seen.set(`${assumption.id ?? seen.size}`, assumption);
    }
  }
  const open = [...seen.values()].filter((assumption) => assumption.material === true && assumption.status === 'open');
  return { all: [...seen.values()], open };
}

// Spec 8: the "Readiness" chapter of finding.md. Rendered only for findings
// with a v2.7 pipeline stage.
function readinessMarkdown(vulnerability) {
  const summary = findingReadinessSummary(vulnerability);
  if (!summary) return [];
  const { d3 = {}, d4 = {}, d5 = {} } = findingStageResults(vulnerability);
  const evidence = record(d4._engine_evidence);
  const decision = record(d5._engine_readiness);
  const objective = record(d3.impact_objective) || {};
  const assumptions = openMaterialAssumptions(d3.unverified_assumptions, d4.unverified_assumptions);
  const readyLabel = summary.ready ? 'ready' : 'not ready';
  const reasons = list(summary.blockingReasons).filter((reason) => typeof reason === 'string' && reason);
  const dimensions = [
    ['Bug', evidence?.bug_status ?? d4.bug_status ?? '—'],
    ['Impact', evidence?.impact_status ?? d4.impact_status ?? '—'],
    ['Terminal outcome', d4.observed_terminal_outcome || '—'],
    [
      'Deployment',
      assumptions.open.length
        ? `${assumptions.open.length} open material assumption${assumptions.open.length === 1 ? '' : 's'}`
        : 'no open material assumptions',
    ],
    ['Scope', d5.scope_status ?? d3.scope_status ?? '—'],
    ['Novelty', d5.novelty_status ?? d3.novelty_status ?? '—'],
    ['Readiness', [summary.label, readyLabel, reasons[0]].filter(Boolean).join(' — ')],
  ];
  const lines = ['## Readiness', '', ...markdownTable(['Dimension', 'Status'], dimensions), ''];

  lines.push(
    '### Required versus observed outcome',
    '',
    ...markdownTable(
      ['Required', 'Observed'],
      [[objective.terminal_outcome || '—', d4.observed_terminal_outcome || '—']]
    ),
    ''
  );

  const chain = list(d4.impact_chain).length ? list(d4.impact_chain) : list(d3.impact_chain_plan);
  lines.push('### Evidence chain', '');
  if (chain.length) {
    lines.push(
      `| Hop | Claim | Status | Covers | Assessment | Evidence |`,
      `| --- | --- | --- | --- | --- | --- |`,
      ...chain.map((hop) => {
        const row = record(hop) || {};
        return `| ${[row.id, row.claim, row.status, list(row.covers).join(', '), row.assessment]
          .map((cell) => markdownTableValue(cell || null))
          .join(' | ')} | ${evidencePathsMarkdown(row.evidence_paths, evidence)} |`;
      })
    );
  } else {
    lines.push('Not provided.');
  }
  lines.push(
    '',
    `Negative control: ${markdownText(d4.negative_control_status, '—')}`,
    '',
    `Repeatability: ${markdownText(d4.repeatability_status, '—')}`,
    ''
  );

  lines.push('### Assumptions', '');
  if (assumptions.all.length) {
    lines.push(
      ...markdownTable(
        ['ID', 'Assumption', 'Kind', 'Material', 'Status'],
        assumptions.all.map((assumption) => [
          assumption.id,
          assumption.assumption,
          assumption.kind,
          assumption.material === true ? 'yes' : 'no',
          assumption.status,
        ])
      )
    );
  } else {
    lines.push('None recorded.');
  }
  lines.push('');

  const missingLinks = list(d4.missing_impact_links).filter((link) => typeof link === 'string' && link);
  lines.push('### Missing links', '');
  lines.push(...(missingLinks.length ? missingLinks.map((link) => `- ${markdownText(link)}`) : ['None.']), '');

  const mapping = list(d5.impact_mapping).filter(record);
  const missingRequirements = list(d5.missing_requirements).filter((entry) => typeof entry === 'string' && entry);
  if (mapping.length || missingRequirements.length) {
    lines.push('### Impact mapping', '');
    if (mapping.length) {
      lines.push(
        `| Required | Observed | Status | Evidence |`,
        `| --- | --- | --- | --- |`,
        ...mapping.map(
          (entry) =>
            `| ${[entry.required_outcome, entry.observed_outcome, entry.status]
              .map((cell) => markdownTableValue(cell || null))
              .join(' | ')} | ${evidencePathsMarkdown(entry.evidence_paths, evidence)} |`
        ),
        ''
      );
    }
    if (missingRequirements.length) {
      lines.push('Missing requirements:', '', ...missingRequirements.map((entry) => `- ${markdownText(entry)}`), '');
    }
  }

  lines.push('### Limitations', '', markdownText(d4.remaining_limits, 'None recorded.'), '');

  lines.push(
    '### Readiness decision',
    '',
    `**${summary.ready ? 'READY' : 'NOT READY'}** (${markdownText(summary.label, '—')}) — lifecycle ${markdownText(
      summary.lifecycleStatus,
      '—'
    )}`,
    '',
    `Policy version: ${markdownText(summary.policyVersion, '—')}`,
    '',
    `Legacy decision: ${summary.legacy ? 'yes' : 'no'}`,
    ''
  );
  if (decision) {
    const claim = d5.model_readiness_claim === true || d5.submission_ready === true;
    const checks = Object.entries(record(decision.checks) || {});
    lines.push(`Model claimed readiness: ${claim ? 'yes' : 'no'}`, '');
    if (checks.length) {
      lines.push(
        `Checks: ${checks.map(([name, status]) => `${markdownText(name)} ${markdownText(status)}`).join(', ')}`,
        ''
      );
    }
  }
  lines.push('Blocking reasons:', '');
  lines.push(...(reasons.length ? reasons.map((reason) => `- ${markdownText(reason)}`) : ['- None.']), '');
  return lines;
}

// Spec 8: report.txt keeps the model's prose but is prefixed with the engine
// decision so a reader cannot mistake a bounded report for a ready one.
function reportHeader(vulnerability) {
  const summary = findingReadinessSummary(vulnerability);
  if (!summary) return '';
  const plain = (value) =>
    visibleText(`${value ?? ''}`)
      .replace(/\s*\n\s*/g, ' ')
      .trim();
  const body = summary.ready
    ? `READY under ${plain(summary.policyVersion) || 'unknown policy'}`
    : `NOT READY — ${plain(summary.label) || 'unknown'} — ${plain(summary.lifecycleStatus) || 'unknown'} — reasons: ${
        list(summary.blockingReasons).map(plain).filter(Boolean).join('; ') || 'none recorded'
      }`;
  return `\`\`\`\n${body}\n\`\`\`\n\n`;
}

function manifestReadiness(vulnerability) {
  const summary = findingReadinessSummary(vulnerability);
  if (!summary) return null;
  return {
    ready: summary.ready === true,
    label: summary.label ?? null,
    lifecycleStatus: summary.lifecycleStatus ?? null,
    policyVersion: summary.policyVersion ?? null,
    legacy: summary.legacy === true,
  };
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
    `# ${markdownText(summary)}`,
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
  lines.push(...readinessMarkdown(vulnerability));
  lines.push('## Complete workflow result', '', fencedJson(vulnerability.jsonAnswer || {}), '');
  return `${lines.join('\n').trim()}\n`;
}

function scanManifest(scan) {
  return {
    id: scan.id,
    status: scan.status,
    completeness: scan.status === 'completed' ? 'complete' : 'partial',
    repository: {
      display: shareSafeRepositoryDisplay(scan),
      kind: scan.repoKind,
    },
    workflow: {
      id: scan.workflowId,
      name: scan.workflowName,
    },
    counts: {
      findings: scan.findings,
    },
    insertedAt: scan.insertedAt,
    updatedAt: scan.updatedAt,
  };
}

function readmeMarkdown(scan, findings, findingDirectories) {
  const partial = scan.status !== 'completed';
  const lines = [
    `# ${markdownText(shareSafeRepositoryDisplay(scan), 'Scan')} findings`,
    '',
    `Export of ${findings.length} canonical finding${findings.length === 1 ? '' : 's'} from ${scan.status} scan ${scan.id}.`,
    '',
    ...(partial
      ? [
          '> [!CAUTION]',
          `> This is a partial export from a ${scan.status} scan. Findings and post-processing artifacts may be incomplete or missing.`,
          '',
        ]
      : []),
    '> [!WARNING]',
    '> Findings are derived from untrusted repository and model output. Review all `.txt` and `.json` files before opening, executing, or sharing their contents.',
    '',
    '| Rank | Severity | Finding | Report | Lifecycle |',
    '| ---: | --- | --- | :---: | --- |',
  ];

  const lifecycleCounts = new Map();
  let ungated = 0;
  findings.forEach((vulnerability, index) => {
    const sources = findingPostScriptSources(vulnerability, scan.postScriptName);
    const hasReport = Boolean(reservedFindingMarkdown(sources, REPORT_KEY));
    const readiness = findingReadinessSummary(vulnerability);
    const directory = findingDirectories[index];
    let lifecycle = '—';
    if (readiness) {
      const status =
        typeof readiness.lifecycleStatus === 'string' && readiness.lifecycleStatus
          ? readiness.lifecycleStatus
          : 'unknown';
      lifecycleCounts.set(status, (lifecycleCounts.get(status) || 0) + 1);
      lifecycle = `${markdownTableValue(status)} (${readiness.ready ? 'ready' : 'not ready'})`;
    } else {
      ungated += 1;
    }
    lines.push(
      `| ${vulnerability.rank ?? index + 1} | ${markdownTableValue(findingSeverity(vulnerability))} | [${markdownTableValue(
        vulnerability.summary || `Finding ${index + 1}`
      )}](${directory}/finding.md) | ${hasReport ? `[yes](${directory}/report.txt)` : '—'} | ${lifecycle} |`
    );
  });

  const lifecycleSummary = [
    ...[...lifecycleCounts].map(([status, count]) => `${markdownText(status)} ${count}`),
    ...(ungated ? [`not gated ${ungated}`] : []),
  ];
  lines.push(
    '',
    `Findings per lifecycle status: ${lifecycleSummary.join(', ') || 'none'}.`,
    '',
    'Each finding directory contains the readable overview, the complete structured finding, every post-processing result, and the generated report/PoC when present.',
    '',
    '`manifest.json` is a share-safe index. It intentionally omits repository source locations, scan configuration, custom extras, scopes, prompts, and model settings.',
    ''
  );
  return lines.join('\n');
}

function findingManifest(scan, ordered, findingDirectories, pocArtifacts = new Map()) {
  return {
    formatVersion: EXPORT_FORMAT_VERSION,
    privacyProfile: 'share-safe',
    scan: scanManifest(scan),
    findings: ordered.map((vulnerability, index) => {
      const directory = findingDirectories[index];
      const sources = findingPostScriptSources(vulnerability, scan.postScriptName);
      const hasReport = Boolean(reservedFindingMarkdown(sources, REPORT_KEY));
      const hasPoc = Boolean(reservedFindingMarkdown(sources, POC_KEY));
      return {
        id: vulnerability.id,
        rank: vulnerability.rank ?? index + 1,
        severity: findingSeverity(vulnerability),
        readiness: manifestReadiness(vulnerability),
        files: {
          finding: `${directory}/finding.md`,
          structuredFinding: `${directory}/finding.json`,
          postProcessing: `${directory}/post-processing.json`,
          report: hasReport ? `${directory}/report.txt` : null,
          poc: hasPoc ? `${directory}/poc.txt` : null,
          ...((pocArtifacts.get(String(vulnerability.id)) || []).length
            ? {
                pocArtifacts: pocArtifacts
                  .get(String(vulnerability.id))
                  .map((file) => `${directory}/poc-artifacts/${file.name}`),
              }
            : {}),
        },
      };
    }),
    omittedScanFields: [
      'repository.full',
      'repository.commitSha',
      'repository.scope',
      'repository.dependencies',
      'runtime',
      'postScripts',
      'agentSkills',
      'configuration',
      'extra',
      'scopes',
      'severityRanker',
    ],
  };
}

function findingExportFiles(scan, ordered, findingDirectories, exportedAt, pocArtifacts = new Map()) {
  const manifest = {
    ...findingManifest(scan, ordered, findingDirectories, pocArtifacts),
    exportedAt: new Date(exportedAt).toISOString(),
  };
  const files = [
    { path: 'README.md', content: () => readmeMarkdown(scan, ordered, findingDirectories) },
    { path: 'manifest.json', content: () => json(manifest) },
  ];

  ordered.forEach((vulnerability, index) => {
    const directory = findingDirectories[index];
    const sources = findingPostScriptSources(vulnerability, scan.postScriptName);
    const report = reservedFindingMarkdown(sources, REPORT_KEY);
    const poc = reservedFindingMarkdown(sources, POC_KEY);
    const postProcessing = {
      primary: primaryPostScriptSource(vulnerability, scan.postScriptName),
      enrichments: vulnerability.enrichments || [],
    };
    files.push(
      { path: `${directory}/finding.md`, content: () => findingMarkdown(vulnerability, index + 1) },
      { path: `${directory}/finding.json`, content: () => json(vulnerability) },
      { path: `${directory}/post-processing.json`, content: () => json(postProcessing) }
    );
    if (report) {
      files.push({
        path: `${directory}/report.txt`,
        content: () => `${reportHeader(vulnerability)}${report.endsWith('\n') ? report : `${report}\n`}`,
      });
    }
    if (poc) files.push({ path: `${directory}/poc.txt`, content: () => (poc.endsWith('\n') ? poc : `${poc}\n`) });
    for (const artifact of pocArtifacts.get(String(vulnerability.id)) || []) {
      files.push({ path: `${directory}/poc-artifacts/${artifact.name}`, content: () => artifact.content });
    }
  });
  return files;
}

export function createFindingExport(
  scan,
  findings,
  {
    exportedAt = new Date(),
    maxBytes = MAX_FINDING_EXPORT_BYTES,
    maxFileBytes = MAX_FINDING_EXPORT_FILE_BYTES,
    maxFindings = MAX_FINDING_EXPORT_FINDINGS,
    pocArtifacts = new Map(),
  } = {}
) {
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : MAX_FINDING_EXPORT_BYTES;
  const fileByteLimit =
    Number.isSafeInteger(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : MAX_FINDING_EXPORT_FILE_BYTES;
  const findingLimit = Number.isSafeInteger(maxFindings) && maxFindings > 0 ? maxFindings : MAX_FINDING_EXPORT_FINDINGS;
  const ordered = [...findings].sort(
    (left, right) =>
      (left.rank ?? Number.MAX_SAFE_INTEGER) - (right.rank ?? Number.MAX_SAFE_INTEGER) ||
      Number(left.id) - Number(right.id)
  );
  if (ordered.length > findingLimit) throw new FindingExportTooManyFindingsError(findingLimit);
  const repoSlug = exportSlug(shareSafeRepositoryDisplay(scan), 'scan');
  const partialSuffix = scan.status === 'completed' ? '' : '-partial';
  const root = `${repoSlug}-scan-${exportSlug(scan.id, 'unknown')}-findings${partialSuffix}`;
  const findingDirectories = ordered.map((vulnerability, index) => {
    const ordinal = `${index + 1}`.padStart(Math.max(2, `${ordered.length}`.length), '0');
    return `finding-${ordinal}-${exportSlug(vulnerability.summary, `id-${vulnerability.id}`, 72)}`;
  });
  const exportTime = new Date(exportedAt);
  const files = findingExportFiles(scan, ordered, findingDirectories, exportTime, pocArtifacts);
  let totalBytes = 0;
  for (const file of files) {
    // Content is generated one file at a time for preflight and discarded. The
    // route invokes these factories lazily while archiver consumes each entry.
    const contentBytes = Buffer.byteLength(file.content(), 'utf8');
    if (contentBytes > fileByteLimit) throw new FindingExportTooLargeError(fileByteLimit, file.path);
    totalBytes += contentBytes;
    if (totalBytes > byteLimit) throw new FindingExportTooLargeError(byteLimit);
  }

  return {
    filename: `${root}.zip`,
    root,
    files,
    uncompressedBytes: totalBytes,
  };
}

export function findingExportAvailability(scan, findingCount) {
  if (!FINDING_EXPORT_STATUSES.includes(scan.status)) {
    return {
      ready: false,
      message: 'Findings can be exported after the scan completes, stops, or fails.',
    };
  }
  if (!findingCount) {
    return { ready: false, message: 'This scan has no canonical findings to export.' };
  }
  return { ready: true, message: null };
}

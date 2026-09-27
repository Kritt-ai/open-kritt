// Evidence card for a finding produced by the v2.7 evidence-to-impact pipeline.
// It reads the engine-owned blocks (`_engine_lifecycle`, `_engine_evidence`,
// `_engine_readiness`) plus the D3/D4/D5 stage fields and shows bug reproduction
// separately from impact proof. `evidenceSummary` is a pure view-model builder
// so the grouping and normalization can be unit tested without rendering.
// Everything is rendered through React text nodes; no raw HTML is injected.

import Markdown from './Markdown.jsx';

export const ENGINE_KEY_PREFIX = '_engine_';
export const ENGINE_OWNED_KEYS = ['model_readiness_claim', '_chip_lifecycle'];
const STAGES = ['d3', 'd4', 'd5'];

// Keys the generic post-script card must not list: engine blocks and the
// readiness bookkeeping the engine writes beside the model's D5 fields.
export function isEngineOwnedKey(key) {
  const name = String(key ?? '');
  return name.startsWith(ENGINE_KEY_PREFIX) || ENGINE_OWNED_KEYS.includes(name);
}

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const list = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (typeof value === 'string' ? value.trim() : value == null ? '' : String(value));
const stringList = (value) => list(value).map(text).filter(Boolean);

// Legacy D5 results stored `missing_requirements` as a string; v2.7 stores an array.
export function normalizeMissingRequirements(value) {
  if (Array.isArray(value)) return stringList(value);
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  return [];
}

// Which stage wrote a result, judged from the engine block it carries (D5 results
// carry `_engine_readiness`, D4 `_engine_evidence`, D3 `_engine_lifecycle`).
function stageOfResult(result) {
  if (isObject(result?._engine_readiness)) return 'd5';
  if (isObject(result?._engine_evidence)) return 'd4';
  if (isObject(result?._engine_lifecycle)) return 'd3';
  return null;
}

// Latest non-stub enrichment per stage: matched by the post-script ids the scan
// snapshotted in `configuration.v27_pipeline`, else by engine block presence.
function stageResults(vulnerability, scan) {
  const pipeline = isObject(scan?.configuration?.v27_pipeline) ? scan.configuration.v27_pipeline : {};
  const enrichments = list(vulnerability?.enrichments).filter((enrichment) => isObject(enrichment?.result));
  const newestFirst = [...enrichments].reverse();
  const pick = (predicate) => newestFirst.find((e) => !e.stub && predicate(e)) || newestFirst.find(predicate);
  const stages = { d3: null, d4: null, d5: null };
  for (const stage of STAGES) {
    const id = pipeline[stage] == null ? '' : String(pipeline[stage]);
    const match =
      (id && pick((e) => String(e.postScriptId ?? '') === id)) || pick((e) => stageOfResult(e.result) === stage);
    stages[stage] = match ? match.result : null;
  }
  return stages;
}

const OK_STATUSES = new Set([
  'reproduced',
  'proven',
  'passed',
  'deterministic',
  'in_scope_verified',
  'novel_verified',
  'exact',
  'verified',
  'observed',
  'resolved',
  'ready',
  'report_ready',
  'impact_proven',
  'defined',
]);
const FAIL_STATUSES = new Set([
  'falsified',
  'not_reproduced',
  'failed',
  'contradicted',
  'contradictory',
  'none',
  'missing',
  'false_positive',
  'bug_falsified',
  'impact_falsified',
  'not ready',
]);

// Colour hint for an enum-ish status: ok, fail, or pending for anything in between.
export function statusTone(value) {
  const key = text(value).toLowerCase();
  if (!key || key === '—') return null;
  if (OK_STATUSES.has(key)) return 'ok';
  if (FAIL_STATUSES.has(key)) return 'fail';
  return 'pend';
}

function withCapture(paths, captured) {
  return stringList(paths).map((path) => ({ path, captured: captured.has(path) }));
}

function hopView(hop, captured) {
  return {
    id: text(hop?.id),
    claim: text(hop?.claim),
    status: text(hop?.status) || 'unverified',
    covers: stringList(hop?.covers),
    assessment: text(hop?.assessment),
    paths: withCapture(hop?.evidence_paths, captured),
  };
}

function assumptionView(item) {
  return {
    id: text(item?.id),
    assumption: text(item?.assumption),
    kind: text(item?.kind) || 'other',
    material: item?.material === true,
    status: text(item?.status) || 'open',
  };
}

// Pure view model: `vulnerability.readiness` (backend summary) + the D3/D4/D5
// enrichment results grouped by the scan's pipeline ids.
export function evidenceSummary(vulnerability, scan) {
  const readiness = isObject(vulnerability?.readiness) ? vulnerability.readiness : {};
  const stages = stageResults(vulnerability, scan);
  const { d3, d4, d5 } = stages;

  const lifecycle = isObject(readiness.lifecycle)
    ? readiness.lifecycle
    : isObject(d3?._engine_lifecycle)
      ? d3._engine_lifecycle
      : null;
  const evidence = isObject(readiness.evidence)
    ? readiness.evidence
    : isObject(d4?._engine_evidence)
      ? d4._engine_evidence
      : null;
  const gate = isObject(readiness.readiness)
    ? readiness.readiness
    : isObject(d5?._engine_readiness)
      ? d5._engine_readiness
      : null;
  const legacy = [readiness, lifecycle, evidence, gate].some((block) => block?.legacy === true);

  const captured = new Set(stringList(evidence?.captured_paths));
  const objective = isObject(d3?.impact_objective) ? d3.impact_objective : {};
  const required = text(objective.terminal_outcome);
  const observed = text(d4?.observed_terminal_outcome);

  const assumptionsById = new Map();
  for (const item of [...list(d3?.unverified_assumptions), ...list(d4?.unverified_assumptions)]) {
    const view = assumptionView(item);
    assumptionsById.set(view.id || `#${assumptionsById.size}`, view);
  }
  const assumptions = [...assumptionsById.values()];
  const openMaterial = assumptions.filter((item) => item.material && item.status === 'open').length;

  const chainSource = list(d4?.impact_chain).length ? d4.impact_chain : list(d3?.impact_chain_plan);
  const chain = chainSource.map((hop) => hopView(hop, captured));
  const mapping = list(d5?.impact_mapping).map((entry) => ({
    required: text(entry?.required_outcome),
    observed: text(entry?.observed_outcome),
    status: text(entry?.status) || 'missing',
    paths: withCapture(entry?.evidence_paths, captured),
  }));

  const blockingReasons = stringList(readiness.blockingReasons).length
    ? stringList(readiness.blockingReasons)
    : stringList(gate?.blocking_reasons);
  const checks = isObject(gate?.checks) ? gate.checks : {};
  const failedChecks = Object.keys(checks).filter((name) => checks[name] === 'fail');
  const ready = typeof readiness.ready === 'boolean' ? readiness.ready : gate?.ready === true;
  const label = text(readiness.label) || text(gate?.label) || 'readiness';
  const lifecycleStatus =
    text(readiness.lifecycleStatus) ||
    text(gate?.lifecycle_status) ||
    text(evidence?.lifecycle_status) ||
    text(lifecycle?.lifecycle_status);
  const policyVersion =
    text(readiness.policyVersion) ||
    text(gate?.policy_version) ||
    text(evidence?.policy_version) ||
    text(lifecycle?.policy_version);

  const bug = text(evidence?.bug_status) || text(d4?.bug_status) || '—';
  const impact = text(evidence?.impact_status) || text(d4?.impact_status) || '—';
  const terminal = observed ? 'observed' : required ? 'not observed' : '—';
  const dimensions = [
    { label: 'Bug', value: bug, tone: statusTone(bug) },
    { label: 'Impact', value: impact, tone: statusTone(impact) },
    { label: 'Terminal outcome', value: terminal, tone: statusTone(terminal), detail: observed || required },
    {
      label: 'Deployment',
      value: openMaterial
        ? `${openMaterial} open material assumption${openMaterial === 1 ? '' : 's'}`
        : assumptions.length
          ? 'no open material assumptions'
          : '—',
      tone: openMaterial ? 'pend' : assumptions.length ? 'ok' : null,
    },
    { label: 'Scope', value: text(d5?.scope_status) || text(d3?.scope_status) || '—' },
    { label: 'Novelty', value: text(d5?.novelty_status) || text(d3?.novelty_status) || '—' },
    {
      label: 'Readiness',
      value: `${label}: ${ready ? 'ready' : 'not ready'}`,
      tone: ready ? 'ok' : 'fail',
      detail: blockingReasons[0] || '',
    },
  ].map((row) => ({ ...row, tone: row.tone === undefined ? statusTone(row.value) : row.tone }));

  return {
    stages,
    legacy,
    lifecycleStatus,
    policyVersion,
    policy: text(gate?.policy),
    evaluatedAt: text(gate?.evaluated_at),
    ready,
    label,
    dimensions,
    objective: {
      claim: text(objective.claim),
      sourceType: text(objective.source_type),
      sourceReference: text(objective.source_reference),
      affectedSubject: text(objective.affected_subject),
      requiredEvidence: stringList(objective.required_evidence),
    },
    outcome: { required, observed },
    evidenceDimensions: list(d3?.evidence_dimensions).map((item) => ({
      tag: text(item?.tag),
      status: text(item?.status) || 'required',
      rationale: text(item?.rationale),
    })),
    chain,
    missingLinks: stringList(d4?.missing_impact_links),
    assumptions,
    proof: {
      negativeControl: text(d4?.negative_control_status),
      repeatability: text(d4?.repeatability_status),
      remainingLimits: text(d4?.remaining_limits),
      artifactDir: text(evidence?.artifact_dir),
      captureComplete: evidence ? evidence.capture_complete === true : null,
      unresolvedPaths: stringList(evidence?.unresolved_paths),
    },
    match: { impact: text(d5?.impact_match_status), evidence: text(d5?.impact_evidence_status) },
    mapping,
    missingRequirements: normalizeMissingRequirements(d5?.missing_requirements),
    reportReadinessReason: text(d5?.report_readiness_reason),
    modelReadinessClaim: typeof d5?.model_readiness_claim === 'boolean' ? d5.model_readiness_claim : null,
    blockingReasons,
    failedChecks,
    checks,
  };
}

const TONE_COLOR = { ok: 'var(--ok)', fail: 'var(--fail)', pend: 'var(--pend)' };

function StatusPill({ value, tone = statusTone(value) }) {
  const color = TONE_COLOR[tone] || 'var(--text-2)';
  return (
    <span
      className="mono"
      style={{
        fontSize: 11,
        padding: '1px 7px',
        borderRadius: 5,
        background: 'var(--surface-2)',
        color,
        whiteSpace: 'nowrap',
      }}
    >
      {value || '—'}
    </span>
  );
}

function Badge({ children, color = 'var(--text-3)', title }) {
  return (
    <span
      className="mono"
      title={title}
      style={{ fontSize: 10, color, background: 'var(--surface-2)', padding: '2px 6px', borderRadius: 5 }}
    >
      {children}
    </span>
  );
}

function SectionTitle({ children }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 10,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--text-3)',
        margin: '18px 0 8px',
      }}
    >
      {children}
    </div>
  );
}

const cellStyle = {
  padding: '7px 10px',
  borderTop: '1px solid var(--border-2)',
  fontSize: 12.5,
  verticalAlign: 'top',
  wordBreak: 'break-word',
};
const headStyle = {
  ...cellStyle,
  borderTop: 'none',
  fontSize: 10,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  textAlign: 'left',
  fontWeight: 500,
};

function Table({ columns, rows, empty }) {
  if (!rows.length) return <div style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{empty}</div>;
  return (
    <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} className="mono" style={headStyle}>
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={row.key ?? index}>
              {row.cells.map((cell, cellIndex) => (
                <td key={cellIndex} style={cellStyle}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PathList({ paths }) {
  if (!paths.length) return <span style={{ color: 'var(--text-3)' }}>—</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      {paths.map(({ path, captured }) => (
        <span key={path} className="mono" style={{ fontSize: 11.5, display: 'flex', gap: 6, alignItems: 'center' }}>
          <span style={{ wordBreak: 'break-all' }}>{path}</span>
          <Badge color={captured ? 'var(--ok)' : 'var(--pend)'}>{captured ? 'captured' : 'unresolved'}</Badge>
        </span>
      ))}
    </div>
  );
}

function ChipRow({ items, tone }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
      {items.map((item) => (
        <StatusPill key={item} value={item} tone={tone} />
      ))}
    </div>
  );
}

function OutcomeBox({ title, value }) {
  return (
    <div
      style={{
        flex: '1 1 240px',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: '10px 12px',
        background: 'var(--surface-2)',
      }}
    >
      <div
        className="mono"
        style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 5 }}
      >
        {title}
      </div>
      <div style={{ fontSize: 13, lineHeight: 1.5, color: value ? 'var(--text)' : 'var(--text-3)' }}>
        {value || '—'}
      </div>
    </div>
  );
}

export default function EvidenceCard({ vulnerability, scan }) {
  if (!vulnerability?.readiness) return null;
  const summary = evidenceSummary(vulnerability, scan);
  const { proof, match, objective } = summary;
  const hasReasons = summary.blockingReasons.length > 0 || summary.failedChecks.length > 0;

  return (
    <div
      data-testid="evidence-card"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--surface)',
        padding: '16px 18px 18px',
        marginBottom: 28,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ fontWeight: 600, fontSize: 15 }}>Evidence</span>
        {summary.lifecycleStatus && <StatusPill value={summary.lifecycleStatus} />}
        {summary.policyVersion && <Badge title="Readiness policy version">{summary.policyVersion}</Badge>}
        {summary.policy && <Badge title="Investigation kind">{summary.policy}</Badge>}
        {summary.legacy && (
          <Badge color="var(--pend)" title="Engine blocks were synthesized at read time from a pre-v2.7 result">
            legacy
          </Badge>
        )}
      </div>

      <SectionTitle>Dimensions</SectionTitle>
      <div style={{ border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden' }}>
        {summary.dimensions.map((row, index) => (
          <div
            key={row.label}
            style={{
              display: 'flex',
              gap: 14,
              alignItems: 'flex-start',
              padding: '8px 12px',
              borderTop: index ? '1px solid var(--border-2)' : 'none',
            }}
          >
            <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)', flex: '0 0 130px' }}>
              {row.label}
            </span>
            <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              <StatusPill value={row.value} tone={row.tone} />
              {row.detail && (
                <span style={{ fontSize: 12, color: 'var(--text-2)', wordBreak: 'break-word' }}>{row.detail}</span>
              )}
            </span>
          </div>
        ))}
      </div>

      <SectionTitle>Terminal outcome</SectionTitle>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        <OutcomeBox title="Required" value={summary.outcome.required} />
        <OutcomeBox title="Observed" value={summary.outcome.observed} />
      </div>
      {(objective.claim || objective.sourceType) && (
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 8, lineHeight: 1.5 }}>
          {objective.claim && <span>{objective.claim} </span>}
          {objective.sourceType && (
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
              ({objective.sourceType}
              {objective.sourceReference ? `: ${objective.sourceReference}` : ''})
            </span>
          )}
        </div>
      )}
      {summary.evidenceDimensions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
          {summary.evidenceDimensions.map((dimension) => (
            <Badge
              key={dimension.tag}
              color={dimension.status === 'required' ? 'var(--text-2)' : 'var(--text-3)'}
              title={dimension.rationale || undefined}
            >
              {dimension.tag}
              {dimension.status === 'not_applicable' ? ' · n/a' : ''}
            </Badge>
          ))}
        </div>
      )}

      <SectionTitle>Impact chain</SectionTitle>
      <Table
        columns={['Hop', 'Claim', 'Status', 'Covers', 'Assessment', 'Evidence']}
        empty="No impact chain recorded."
        rows={summary.chain.map((hop, index) => ({
          key: hop.id || index,
          cells: [
            <span key="id" className="mono" style={{ fontSize: 11.5 }}>
              {hop.id || '—'}
            </span>,
            hop.claim || '—',
            <StatusPill key="status" value={hop.status} />,
            hop.covers.length ? <ChipRow key="covers" items={hop.covers} tone={null} /> : '—',
            hop.assessment || '—',
            <PathList key="paths" paths={hop.paths} />,
          ],
        }))}
      />
      {(proof.negativeControl || proof.repeatability || proof.artifactDir || proof.captureComplete !== null) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
          {proof.negativeControl && (
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
              negative control <StatusPill value={proof.negativeControl} />
            </span>
          )}
          {proof.repeatability && (
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
              repeatability <StatusPill value={proof.repeatability} />
            </span>
          )}
          {proof.captureComplete !== null && (
            <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
              capture{' '}
              <StatusPill
                value={proof.captureComplete ? 'complete' : 'incomplete'}
                tone={proof.captureComplete ? 'ok' : 'fail'}
              />
            </span>
          )}
          {proof.artifactDir && (
            <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)', wordBreak: 'break-all' }}>
              {proof.artifactDir}
            </span>
          )}
        </div>
      )}
      {proof.remainingLimits && (
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6 }}>
          Remaining limits: {proof.remainingLimits}
        </div>
      )}

      {summary.missingLinks.length > 0 && (
        <>
          <SectionTitle>Missing links</SectionTitle>
          <ChipRow items={summary.missingLinks} tone="fail" />
        </>
      )}

      {summary.assumptions.length > 0 && (
        <>
          <SectionTitle>Assumptions</SectionTitle>
          <Table
            columns={['Id', 'Assumption', 'Kind', 'Material', 'Status']}
            empty=""
            rows={summary.assumptions.map((item, index) => ({
              key: item.id || index,
              cells: [
                <span key="id" className="mono" style={{ fontSize: 11.5 }}>
                  {item.id || '—'}
                </span>,
                item.assumption || '—',
                item.kind,
                item.material ? 'yes' : 'no',
                <StatusPill key="status" value={item.status} />,
              ],
            }))}
          />
        </>
      )}

      {(summary.mapping.length > 0 || summary.missingRequirements.length > 0 || match.impact || match.evidence) && (
        <>
          <SectionTitle>Required versus observed impact</SectionTitle>
          {(match.impact || match.evidence) && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 8, alignItems: 'center' }}>
              {match.impact && (
                <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                  match <StatusPill value={match.impact} />
                </span>
              )}
              {match.evidence && (
                <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                  evidence <StatusPill value={match.evidence} />
                </span>
              )}
            </div>
          )}
          <Table
            columns={['Required outcome', 'Observed outcome', 'Status', 'Evidence']}
            empty="No impact mapping recorded."
            rows={summary.mapping.map((entry, index) => ({
              key: index,
              cells: [
                entry.required || '—',
                entry.observed || '—',
                <StatusPill key="status" value={entry.status} />,
                <PathList key="paths" paths={entry.paths} />,
              ],
            }))}
          />
          {summary.missingRequirements.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--text-2)' }}>
              {summary.missingRequirements.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
        </>
      )}

      <SectionTitle>Readiness</SectionTitle>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
        <StatusPill
          value={`${summary.label}: ${summary.ready ? 'ready' : 'not ready'}`}
          tone={summary.ready ? 'ok' : 'fail'}
        />
        {summary.modelReadinessClaim !== null && (
          <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
            model claimed {summary.modelReadinessClaim ? 'ready' : 'not ready'}
          </span>
        )}
        {summary.evaluatedAt && (
          <span className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
            {summary.evaluatedAt}
          </span>
        )}
      </div>
      {summary.reportReadinessReason && (
        <div style={{ fontSize: 12.5, marginTop: 8 }}>
          <Markdown source={summary.reportReadinessReason} />
        </div>
      )}
      {hasReasons ? (
        <>
          {summary.failedChecks.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>failed checks</span>
              <ChipRow items={summary.failedChecks} tone="fail" />
            </div>
          )}
          {summary.blockingReasons.length > 0 && (
            <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5 }}>
              {summary.blockingReasons.map((reason, index) => (
                <li key={`${index}-${reason}`}>{reason}</li>
              ))}
            </ul>
          )}
        </>
      ) : (
        summary.ready && (
          <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 8 }}>Every readiness check passed.</div>
        )
      )}
    </div>
  );
}

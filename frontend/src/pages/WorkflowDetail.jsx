import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, Button } from '../components/ui.jsx';
import { PromptHighlight } from '../components/PromptEditor.jsx';
import Drawer from '../components/Drawer.jsx';
import { availableKeysForDepth, groupByDepth, workflowDeleteState } from '../lib/workflow.js';
import { parseTemplateRefs, refResolves } from '../lib/keys.js';
import { downloadWorkflowExport } from '../lib/workflowTransfer.js';

export default function WorkflowDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [selStepId, setSelStepId] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [actionError, setActionError] = useState(null);
  const { data: wf, loading, error, reload } = useFetch(() => api.workflow(id), [id]);

  usePageChrome(
    [
      { label: 'Workflows', to: '/workflows' },
      { label: wf?.name || '…', active: true },
    ],
    { label: '+ New workflow', to: '/workflows?new=1' },
    [wf?.name]
  );

  if (loading)
    return (
      <div style={{ padding: 28 }}>
        <Spinner />
      </div>
    );
  if (error)
    return (
      <div style={{ padding: 28 }}>
        <ErrorState error={error} onRetry={reload} />
      </div>
    );
  if (!wf) return null;

  const levels = groupByDepth(wf.steps);
  const sel = wf.steps.find((s) => s.id === selStepId);
  const deleteState = workflowDeleteState(wf);
  const editWorkflowPath = (stepId) => {
    const stepQuery = stepId ? `?step=${encodeURIComponent(stepId)}` : '';
    return `/workflows/${wf.id}/edit${stepQuery}`;
  };
  const deleteWorkflow = async () => {
    if (!deleteState.canDelete || deleting) return;
    const confirmed = window.confirm(
      `Permanently delete workflow "${wf.name}" and its configured steps? This cannot be undone.`
    );
    if (!confirmed) return;

    setDeleting(true);
    setActionError(null);
    try {
      await api.deleteWorkflow(wf.id);
      navigate('/workflows', { replace: true });
    } catch (deleteError) {
      setActionError(deleteError);
      setDeleting(false);
      if (deleteError instanceof ApiError && deleteError.status === 409) reload();
    }
  };

  return (
    <div style={{ position: 'relative', height: '100%', minHeight: 0, overflow: 'hidden' }}>
      <div style={{ height: '100%', minWidth: 0, overflowY: 'auto', padding: '28px 32px' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 8 }}>
          <div>
            <div className="mono" style={{ fontSize: 24, fontWeight: 600, letterSpacing: '-0.01em' }}>
              {wf.name}
            </div>
            <div style={{ fontSize: 13.5, color: 'var(--text-2)', marginTop: 4, maxWidth: 520 }}>{wf.description}</div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" style={{ height: 32 }} to={`/scans/new?workflow=${wf.id}`} disabled={deleting}>
              Run scan
            </Button>
            <Button
              variant="ghost"
              style={{ height: 32 }}
              disabled={deleting}
              onClick={() => downloadWorkflowExport(wf)}
            >
              Export JSON
            </Button>
            <Button variant="subtle" style={{ height: 32 }} to={editWorkflowPath()} disabled={deleting}>
              Edit
            </Button>
            {!wf.isDefault && (
              <Button
                variant="danger"
                style={{ height: 32 }}
                disabled={!deleteState.canDelete || deleting}
                title={deleteState.canDelete ? 'Delete unused workflow' : deleteState.reason}
                aria-describedby={!deleteState.canDelete ? 'workflow-delete-reason' : undefined}
                onClick={deleteWorkflow}
              >
                {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            )}
          </div>
        </div>

        {!wf.isDefault && !deleteState.canDelete && (
          <div id="workflow-delete-reason" style={{ color: 'var(--text-3)', fontSize: 12, textAlign: 'right' }}>
            {deleteState.reason}
          </div>
        )}

        {actionError && (
          <div role="alert" style={{ marginTop: 18 }}>
            <ErrorState error={actionError} />
          </div>
        )}

        <div
          className="mono"
          style={{
            display: 'flex',
            gap: 18,
            margin: '18px 0 26px',
            fontSize: 12,
            color: 'var(--text-2)',
            flexWrap: 'wrap',
          }}
        >
          <span>{wf.stepCount} steps</span>
          <span style={{ color: 'var(--border)' }}>|</span>
          <span>{wf.depths.length} depth levels</span>
          <span style={{ color: 'var(--border)' }}>|</span>
          <span>{wf.scanCount} scans run</span>
          {wf.extra && wf.extra.length > 0 && (
            <>
              <span style={{ color: 'var(--border)' }}>|</span>
              <span>
                expects extra: <span style={{ color: 'var(--accent)' }}>{wf.extra.join(', ')}</span>
              </span>
            </>
          )}
        </div>

        {/* TREE */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          {levels.map((level, i) => {
            const fanLabel =
              level.steps.length > 1
                ? `· ${level.steps.length} siblings (shared schema)`
                : level.multiOutput
                  ? '· multi-output ⤳'
                  : '';
            return (
              <div
                key={level.depth}
                style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}
              >
                <div
                  className="mono"
                  style={{
                    fontSize: 10,
                    letterSpacing: '0.08em',
                    color: 'var(--text-3)',
                    marginBottom: 10,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <span
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: '50%',
                      border: '1px solid var(--border)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      color: 'var(--text-2)',
                    }}
                  >
                    {level.depth}
                  </span>
                  DEPTH {level.depth} {fanLabel}
                  {level.consumesAll && (
                    <span
                      style={{
                        fontSize: 9.5,
                        color: 'var(--run)',
                        background: 'var(--run-bg)',
                        borderRadius: 5,
                        padding: '2px 7px',
                        letterSpacing: '0.04em',
                      }}
                    >
                      batched
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 18, justifyContent: 'center', flexWrap: 'wrap' }}>
                  {level.steps.map((step) => (
                    <div
                      key={step.id}
                      onClick={() => setSelStepId(step.id)}
                      style={{
                        width: 300,
                        border: `1px solid ${selStepId === step.id ? 'var(--accent)' : 'var(--border)'}`,
                        borderRadius: 11,
                        background: 'var(--surface)',
                        boxShadow: 'var(--shadow)',
                        cursor: 'pointer',
                        overflow: 'hidden',
                      }}
                    >
                      <div style={{ padding: '13px 15px 11px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <span style={{ fontWeight: 600, fontSize: 14 }}>{step.name || 'Untitled step'}</span>
                          {step.multiOutput && (
                            <span
                              className="mono"
                              style={{
                                fontSize: 9.5,
                                color: 'var(--accent)',
                                background: 'var(--accent-subtle)',
                                padding: '2px 6px',
                                borderRadius: 4,
                              }}
                            >
                              MULTI ⤳
                            </span>
                          )}
                        </div>
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--text-2)',
                            marginTop: 6,
                            lineHeight: 1.5,
                            height: 34,
                            overflow: 'hidden',
                          }}
                        >
                          {step.content.replace(/\{\{\s*|\s*\}\}/g, '').slice(0, 90)}…
                        </div>
                      </div>
                      <div
                        className="mono"
                        style={{
                          borderTop: '1px solid var(--border-2)',
                          padding: '9px 15px',
                          display: 'flex',
                          gap: 5,
                          flexWrap: 'wrap',
                          background: 'var(--surface-2)',
                        }}
                      >
                        {Object.keys(step.outputFormat)
                          .slice(0, 4)
                          .map((k) => (
                            <span key={k} style={{ fontSize: 10, color: 'var(--text-2)' }}>
                              {k}
                            </span>
                          ))}
                      </div>
                    </div>
                  ))}
                </div>
                {i < levels.length - 1 && <Connector level={level} next={levels[i + 1]} />}
              </div>
            );
          })}
        </div>
      </div>

      <Drawer open={!!sel} onClose={() => setSelStepId(null)} width={560}>
        {sel && (
          <StepPanel step={sel} steps={wf.steps} editTo={editWorkflowPath(sel.id)} onClose={() => setSelStepId(null)} />
        )}
      </Drawer>
    </div>
  );
}

// The link between two depths. A batched next depth converges every result of
// this depth into a single agent; a multi (multi_output / siblings) depth that
// isn't batched fans out into a separate agent per result.
function Connector({ level, next }) {
  const batched = !!next.consumesAll;
  // const label = batched
  //   ? `⇉ all depth-${level.depth} results → 1 agent`
  //   : prevMulti
  //   ? '⤳ per result → separate agents'
  //   : null;
  const label = null;

  if (!label) {
    return <div style={{ width: 1.5, height: 34, background: 'var(--border)' }} />;
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div style={{ width: 1.5, height: 14, background: 'var(--border)' }} />
      <span
        className="mono"
        title={
          batched
            ? `Batched: one agent receives {{multi_output_depth_${level.depth}}}`
            : 'Fan-out: one agent per result'
        }
        style={{
          fontSize: 9.5,
          letterSpacing: '0.04em',
          padding: '3px 9px',
          borderRadius: 20,
          whiteSpace: 'nowrap',
          color: batched ? 'var(--run)' : 'var(--text-2)',
          background: batched ? 'var(--run-bg)' : 'var(--surface-2)',
          border: `1px solid ${batched ? 'var(--run-bg)' : 'var(--border)'}`,
        }}
      >
        {label}
      </span>
      <div style={{ width: 1.5, height: 14, background: 'var(--border)' }} />
    </div>
  );
}

function StepPanel({ step, steps, editTo, onClose }) {
  const available = availableKeysForDepth(steps, step.depth);
  const parsedRefs = parseTemplateRefs(step.content);
  const refs = [...new Set(parsedRefs.refs)];
  const malformedRefs = [...new Set(parsedRefs.malformed)];
  const bad = malformedRefs.length + refs.filter((k) => !refResolves(k, available, true)).length;

  return (
    <>
      <div
        style={{
          height: 52,
          flex: 'none',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 18px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, minWidth: 0 }}>
          <span
            className="mono"
            style={{
              flex: 'none',
              fontSize: 10,
              color: 'var(--text-3)',
              border: '1px solid var(--border)',
              padding: '2px 6px',
              borderRadius: 5,
            }}
          >
            DEPTH {step.depth}
          </span>
          <span
            style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}
          >
            {step.name || 'Untitled step'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 'none' }}>
          <Button variant="subtle" style={{ height: 30, padding: '0 11px', fontSize: 12.5 }} to={editTo}>
            Edit step
          </Button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close step details"
            title="Close step details"
            style={{
              width: 30,
              height: 30,
              padding: 0,
              border: 'none',
              borderRadius: 6,
              background: 'transparent',
              color: 'var(--text-3)',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 18 }}>
        <div
          className="mono"
          style={{
            display: 'flex',
            gap: 14,
            marginBottom: 18,
            fontSize: 11.5,
            color: 'var(--text-2)',
            flexWrap: 'wrap',
          }}
        >
          <span>
            multi_output:{' '}
            <span style={{ color: step.multiOutput ? 'var(--accent)' : 'var(--text-2)' }}>
              {String(step.multiOutput)}
            </span>
          </span>
          <span>
            consumes_all:{' '}
            <span style={{ color: step.consumesAll ? 'var(--run)' : 'var(--text-2)' }}>
              {String(!!step.consumesAll)}
            </span>
          </span>
          <span>
            output_table: <span style={{ color: 'var(--text)' }}>{step.outputTable}</span>
          </span>
        </div>

        {step.consumesAll && step.depth > 0 && (
          <div
            style={{
              marginBottom: 18,
              fontSize: 11.5,
              color: 'var(--run)',
              background: 'var(--run-bg)',
              borderRadius: 8,
              padding: '9px 12px',
              lineHeight: 1.5,
            }}
          >
            ⇉ Batched input — one agent runs this depth over the full array of depth {step.depth - 1} outputs, available
            as <span className="mono">{`{{multi_output_depth_${step.depth - 1}}}`}</span>. Individual depth-
            {step.depth - 1} keys aren't available here or downstream.
          </div>
        )}

        <SectionTitle>PROMPT CONTENT</SectionTitle>
        <PromptHighlight content={step.content} available={available} allowExtra />

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '18px 0 8px' }}>
          <SectionTitle inline>REFERENCED KEYS</SectionTitle>
          <span className="mono" style={{ fontSize: 10.5, color: bad ? 'var(--fail)' : 'var(--ok)' }}>
            {bad ? `${bad} invalid` : 'all resolved'}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {refs.map((k) => {
            const ok = refResolves(k, available, true);
            return (
              <span
                key={k}
                className="mono"
                style={{
                  fontSize: 11,
                  padding: '3px 9px',
                  borderRadius: 6,
                  color: ok ? 'var(--ok)' : 'var(--fail)',
                  background: ok ? 'var(--ok-bg)' : 'var(--fail-bg)',
                  border: `1px solid ${ok ? 'var(--ok-bg)' : 'var(--fail-bg)'}`,
                }}
              >
                {ok ? '✓' : '✕'} {k}
              </span>
            );
          })}
          {malformedRefs.map((token, index) => (
            <span
              key={`${token}-${index}`}
              className="mono"
              style={{
                fontSize: 11,
                padding: '3px 9px',
                borderRadius: 6,
                color: 'var(--fail)',
                background: 'var(--fail-bg)',
                border: '1px solid var(--fail-bg)',
              }}
            >
              ✕ {token}
            </span>
          ))}
          {refs.length === 0 && malformedRefs.length === 0 && (
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>No references.</span>
          )}
        </div>

        <SectionTitle style={{ margin: '20px 0 8px' }}>
          OUTPUT FORMAT <span style={{ color: 'var(--text-3)' }}>· json schema</span>
        </SectionTitle>
        <div style={{ border: '1px solid var(--border)', borderRadius: 9, overflow: 'hidden' }}>
          {Object.entries(step.outputFormat).map(([key, type]) => (
            <div
              key={key}
              className="mono"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '9px 13px',
                borderBottom: '1px solid var(--border-2)',
                fontSize: 12,
              }}
            >
              <span style={{ color: 'var(--accent)' }}>{key}</span>
              <span style={{ color: 'var(--text-3)' }}>{type}</span>
            </div>
          ))}
        </div>
        {step.isLast && (
          <div
            style={{
              marginTop: 12,
              fontSize: 11.5,
              color: 'var(--ok)',
              background: 'var(--ok-bg)',
              borderRadius: 8,
              padding: '9px 12px',
              lineHeight: 1.5,
            }}
          >
            ✓ Terminal step — emits all 9 required vulnerability keys to workflows.vulnerabilities.
          </div>
        )}

        <SectionTitle style={{ margin: '20px 0 8px' }}>AVAILABLE KEYS HERE</SectionTitle>
        <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
          {[...available.entries()].map(([name, from]) => (
            <span
              key={name}
              className="mono"
              style={{
                fontSize: 10.5,
                padding: '2px 7px',
                borderRadius: 5,
                color: 'var(--text-2)',
                background: 'var(--surface-2)',
                border: '1px solid var(--border-2)',
              }}
            >
              {name}
              <span style={{ color: 'var(--text-3)' }}> · {from}</span>
            </span>
          ))}
          <span
            className="mono"
            style={{
              fontSize: 10.5,
              padding: '2px 7px',
              borderRadius: 5,
              color: 'var(--accent)',
              background: 'var(--accent-subtle)',
              border: '1px solid var(--accent-subtle)',
            }}
          >
            extra.&lt;key&gt;<span style={{ color: 'var(--text-3)' }}> · dynamic</span>
          </span>
        </div>
      </div>
    </>
  );
}

function SectionTitle({ children, style, inline }) {
  return (
    <div
      className="mono"
      style={{ fontSize: 10, letterSpacing: '0.07em', color: 'var(--text-3)', marginBottom: inline ? 0 : 8, ...style }}
    >
      {children}
    </div>
  );
}

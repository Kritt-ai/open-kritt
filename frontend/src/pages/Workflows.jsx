import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, apiErrorMessages } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { CardLinkOverlay, Spinner, ErrorState, EmptyState, Button } from '../components/ui.jsx';
import { useModalDialog } from '../lib/useModalDialog.js';
import { useNewestFirst, usePagination } from '../lib/usePagination.js';
import { downloadWorkflowExport, parseWorkflowImport, WORKFLOW_IMPORT_MAX_BYTES } from '../lib/workflowTransfer.js';
import { workflowDeleteState } from '../lib/workflow.js';
import Pagination from '../components/Pagination.jsx';

export default function Workflows() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const newDialogParam = params.get('new');
  const [dialogOpen, setDialogOpen] = useState(newDialogParam === '1');
  const closeDialog = () => {
    setDialogOpen(false);
    if (params.has('new')) setParams({}, { replace: true });
  };
  useEffect(() => {
    setDialogOpen(newDialogParam === '1');
  }, [newDialogParam]);
  usePageChrome([{ label: 'Workflows', active: true }], { label: '+ New workflow', to: '/workflows?new=1' }, []);
  const { data, loading, error, reload, setData } = useFetch(() => api.workflows(), []);
  const workflows = useNewestFirst(data);
  const workflowPages = usePagination(workflows, { pageSize: 6 });
  const importInputRef = useRef(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [busyWorkflowId, setBusyWorkflowId] = useState(null);
  const [actionError, setActionError] = useState(null);

  const chooseWorkflowFile = () => {
    setImportError('');
    importInputRef.current?.click();
  };
  const importWorkflow = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setImporting(true);
    setImportError('');
    try {
      if (file.size > WORKFLOW_IMPORT_MAX_BYTES) {
        throw new Error('Workflow JSON files must be 2 MB or smaller.');
      }
      const payload = parseWorkflowImport(await file.text());
      const imported = await api.createWorkflow(payload);
      navigate(`/workflows/${imported.id}`);
    } catch (importFailure) {
      const messages =
        importFailure instanceof ApiError
          ? apiErrorMessages(importFailure)
          : [importFailure?.message || 'The workflow could not be imported.'];
      setImportError(messages.join(' '));
    } finally {
      setImporting(false);
    }
  };
  const deleteWorkflow = async (event, workflow) => {
    event.preventDefault();
    event.stopPropagation();
    if (!workflowDeleteState(workflow).canDelete || busyWorkflowId !== null) return;

    const confirmed = window.confirm(
      `Permanently delete workflow "${workflow.name}" and its configured steps? This cannot be undone.`
    );
    if (!confirmed) return;

    setBusyWorkflowId(workflow.id);
    setActionError(null);
    try {
      await api.deleteWorkflow(workflow.id);
      setData((current) => (current || []).filter((item) => item.id !== workflow.id));
    } catch (deleteError) {
      setActionError(deleteError);
      if (deleteError instanceof ApiError && deleteError.status === 409) reload();
    } finally {
      setBusyWorkflowId(null);
    }
  };

  return (
    <div style={{ padding: '30px 32px', maxWidth: 1180 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 22 }}>
        <div>
          <div style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em' }}>Workflows</div>
          <div style={{ fontSize: 14, color: 'var(--text-2)', marginTop: 3 }}>
            Reusable scan blueprints — chains of AI analysis steps.
          </div>
        </div>
        <Button variant="ghost" disabled={importing} onClick={chooseWorkflowFile}>
          {importing ? 'Importing…' : 'Import JSON'}
        </Button>
      </div>
      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        aria-label="Import workflow JSON"
        onChange={importWorkflow}
        style={{ display: 'none' }}
      />

      {importError && (
        <div role="alert" style={{ marginBottom: 18 }}>
          <ErrorState error={{ message: importError }} />
        </div>
      )}

      {dialogOpen && (
        <NewWorkflowDialog
          workflows={workflows}
          onClose={closeDialog}
          onImport={chooseWorkflowFile}
          importing={importing}
          importError={importError}
        />
      )}

      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {actionError && (
        <div role="alert" style={{ marginBottom: 18 }}>
          <ErrorState error={actionError} />
        </div>
      )}
      {data && data.length === 0 && (
        <EmptyState
          title="No workflows yet"
          sub="Workflows are the blueprints the engine runs. Create your first one to start scanning."
          action={<Button to="/workflows?new=1">+ New workflow</Button>}
        />
      )}
      {data && data.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {workflowPages.pageItems.map((w) => (
              <WorkflowCard
                key={w.id}
                workflow={w}
                busy={busyWorkflowId !== null}
                deleting={busyWorkflowId === w.id}
                onDelete={deleteWorkflow}
              />
            ))}
          </div>
          <Pagination {...workflowPages} itemLabel="workflows" />
        </>
      )}
    </div>
  );
}

export function WorkflowCard({ workflow: w, busy, deleting, onDelete }) {
  const deleteState = workflowDeleteState(w);

  return (
    <div
      style={{
        position: 'relative',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: 18,
        background: 'var(--surface)',
        boxShadow: 'var(--shadow)',
        cursor: 'pointer',
      }}
    >
      <CardLinkOverlay to={`/workflows/${w.id}`} label={`Open workflow ${w.name}`} />
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
        <div>
          <div className="mono" style={{ fontWeight: 600, fontSize: 15.5 }}>
            {w.name}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 5, maxWidth: 320 }}>{w.description}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flex: 'none' }}>
          {deleteState.canDelete && (
            <Button
              variant="danger"
              aria-label={`Delete ${w.name}`}
              title="Delete unused workflow"
              disabled={busy}
              onClick={(event) => onDelete(event, w)}
              style={{ position: 'relative', zIndex: 2, height: 27, padding: '0 9px', fontSize: 11.5 }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          )}
          <Button
            variant="ghost"
            aria-label={`Export ${w.name}`}
            title="Export workflow as JSON"
            disabled={deleting}
            onClick={(event) => {
              event.stopPropagation();
              downloadWorkflowExport(w);
            }}
            style={{ position: 'relative', zIndex: 2, height: 27, padding: '0 9px', fontSize: 11.5 }}
          >
            Export
          </Button>
          <span
            className="mono"
            style={{
              fontSize: 11,
              color: 'var(--text-3)',
              border: '1px solid var(--border)',
              padding: '3px 8px',
              borderRadius: 6,
            }}
          >
            {w.stepCount} steps
          </span>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 16, flexWrap: 'wrap' }}>
        {w.depthChips.map((d) => (
          <span
            key={d.label}
            className="mono"
            style={{
              fontSize: 10.5,
              color: 'var(--text-2)',
              background: 'var(--surface-2)',
              padding: '3px 8px',
              borderRadius: 5,
            }}
          >
            {d.label}
          </span>
        ))}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 20,
          marginTop: 16,
          paddingTop: 14,
          borderTop: '1px solid var(--border-2)',
          fontSize: 12,
          color: 'var(--text-3)',
        }}
      >
        <span>
          <span style={{ color: 'var(--text)', fontWeight: 600 }}>{w.scanCount}</span> scans
        </span>
        <span>last used {w.lastUsed || '—'}</span>
      </div>
    </div>
  );
}

function NewWorkflowDialog({ workflows, onClose, onImport, importing, importError }) {
  const [mode, setMode] = useState(null); // null | 'duplicate'
  const [sel, setSel] = useState(workflows[0]?.id || '');
  const hasWorkflows = workflows.length > 0;
  const dialogRef = useModalDialog(onClose);
  const duplicatePages = usePagination(workflows, { pageSize: 6, resetKey: mode });

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(0,0,0,.32)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-workflow-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 460,
          maxWidth: '100%',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          boxShadow: '0 18px 50px rgba(0,0,0,.28)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--border-2)',
          }}
        >
          <div id="new-workflow-title" style={{ fontSize: 16, fontWeight: 600 }}>
            New workflow
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              color: 'var(--text-3)',
              fontSize: 20,
            }}
          >
            ×
          </button>
        </div>

        <div style={{ padding: 20 }}>
          {mode !== 'duplicate' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <OptionCard
                autoFocus
                title="Generate with AI"
                sub="Describe the research process you want, then review a detailed, valid workflow draft."
                to="/workflows/generate"
              />
              <OptionCard
                title="Blank workflow"
                sub="Start from an empty blueprint and build every step yourself."
                to="/workflows/new"
              />
              <OptionCard
                title={importing ? 'Importing workflow…' : 'Import JSON file'}
                sub="Create a workflow from an open-kritt export or compatible workflow JSON."
                disabled={importing}
                onClick={onImport}
              />
              <OptionCard
                title="Duplicate an existing workflow"
                sub={
                  hasWorkflows
                    ? 'Copy another workflow’s steps as a starting point, then tweak.'
                    : 'No workflows yet to duplicate.'
                }
                disabled={!hasWorkflows}
                onClick={() => hasWorkflows && setMode('duplicate')}
              />
              {importError && (
                <div role="alert">
                  <ErrorState error={{ message: importError }} />
                </div>
              )}
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 10 }}>
                Pick a workflow to copy — it opens as a new, unsaved draft.
              </div>
              <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {duplicatePages.pageItems.map((w) => (
                  <button
                    key={w.id}
                    type="button"
                    onClick={() => setSel(w.id)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      padding: '10px 12px',
                      borderRadius: 9,
                      cursor: 'pointer',
                      border: `1.5px solid ${sel === w.id ? 'var(--accent)' : 'var(--border)'}`,
                      background: sel === w.id ? 'var(--accent-subtle)' : 'var(--surface)',
                      color: 'var(--text)',
                      font: 'inherit',
                      textAlign: 'left',
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        className="mono"
                        style={{
                          fontSize: 13.5,
                          fontWeight: 600,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {w.name}
                      </div>
                      {w.description && (
                        <div
                          style={{
                            fontSize: 12,
                            color: 'var(--text-3)',
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                          }}
                        >
                          {w.description}
                        </div>
                      )}
                    </div>
                    <span
                      className="mono"
                      style={{
                        flex: 'none',
                        fontSize: 10.5,
                        color: 'var(--text-3)',
                        border: '1px solid var(--border)',
                        padding: '2px 7px',
                        borderRadius: 6,
                      }}
                    >
                      {w.stepCount} steps
                    </span>
                  </button>
                ))}
              </div>
              <Pagination
                {...duplicatePages}
                setPage={(nextPage) => {
                  duplicatePages.setPage(nextPage);
                  const nextWorkflow = workflows[(nextPage - 1) * duplicatePages.pageSize];
                  if (nextWorkflow) setSel(nextWorkflow.id);
                }}
                itemLabel="workflows"
                compact
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 18 }}>
                <button
                  type="button"
                  onClick={() => setMode(null)}
                  style={{
                    border: 0,
                    padding: 0,
                    background: 'transparent',
                    fontSize: 12.5,
                    color: 'var(--text-2)',
                    cursor: 'pointer',
                  }}
                >
                  ← back
                </button>
                <Button to={sel ? `/workflows/new?from=${sel}` : undefined} disabled={!sel}>
                  Duplicate &amp; edit
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function OptionCard({ title, sub, to, onClick, disabled, autoFocus = false }) {
  const content = (
    <>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.45 }}>{sub}</div>
    </>
  );
  const style = {
    width: '100%',
    padding: '14px 16px',
    borderRadius: 8,
    border: '1px solid var(--border)',
    background: 'var(--surface)',
    color: 'var(--text)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    textAlign: 'left',
    font: 'inherit',
    textDecoration: 'none',
  };
  if (to) {
    return (
      <Link to={to} data-autofocus={autoFocus || undefined} style={style}>
        {content}
      </Link>
    );
  }
  return (
    <button type="button" data-autofocus={autoFocus || undefined} disabled={disabled} onClick={onClick} style={style}>
      {content}
    </button>
  );
}

import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { CardLinkOverlay, Spinner, ErrorState, EmptyState, StatusBadge, Button } from '../components/ui.jsx';
import LinkifiedText from '../components/LinkifiedText.jsx';
import { duplicateScanPath } from '../lib/scanDuplication.js';
import { isScanDeletable } from '../lib/scanPresentation.js';
import { useModalDialog } from '../lib/useModalDialog.js';
import {
  providerCapacityAutoscalePresentation,
  rateLimitPresentation,
  rateLimitRetryText,
  storageWarningPresentation,
} from '../lib/format.js';
import { useNewestFirst, usePagination } from '../lib/usePagination.js';
import Pagination from '../components/Pagination.jsx';

const FILTERS = [
  ['all', 'All'],
  ['running', 'Running'],
  ['queued', 'Queued'],
  ['rate_limited', 'Rate limited'],
  ['completed', 'Completed'],
  ['failed', 'Failed'],
];
const SCANS_PAGE_SIZE = 6;

export default function Scans() {
  const [params, setParams] = useSearchParams();
  const newDialogParam = params.get('new');
  const [dialogOpen, setDialogOpen] = useState(newDialogParam === '1');
  const [filter, setFilter] = useState('all');
  const [page, setPage] = useState(1);
  const [busyScanId, setBusyScanId] = useState(null);
  const [expandedErrorIds, setExpandedErrorIds] = useState(() => new Set());
  const [actionError, setActionError] = useState(null);
  const closeDialog = () => {
    setDialogOpen(false);
    if (params.has('new')) setParams({}, { replace: true });
  };
  useEffect(() => {
    setDialogOpen(newDialogParam === '1');
  }, [newDialogParam]);
  usePageChrome([{ label: 'Scans', active: true }], { label: '+ New scan', to: '/scans?new=1' }, []);
  const requestKey = `${filter}:${page}`;
  const { data, loading, error, reload } = useFetch(
    async () => ({ ...(await api.scanPage({ status: filter, page, pageSize: SCANS_PAGE_SIZE })), requestKey }),
    [requestKey],
    { pollMs: 1000 }
  );
  const pageData = data?.requestKey === requestKey ? data : null;
  const scans = pageData?.items || [];
  const scanPages = pageData
    ? {
        pageItems: scans,
        page: pageData.page,
        pageSize: pageData.pageSize,
        totalItems: pageData.totalItems,
        totalPages: pageData.totalPages,
        startIndex: pageData.startIndex,
        endIndex: pageData.endIndex,
        setPage,
      }
    : null;

  useEffect(() => {
    if (pageData && page > pageData.totalPages) setPage(pageData.totalPages);
  }, [page, pageData]);
  const resumeScan = async (event, scanId) => {
    event.stopPropagation();
    setBusyScanId(scanId);
    setActionError(null);
    try {
      await api.resumeScan(scanId);
      reload();
    } catch (resumeError) {
      setActionError(resumeError);
    } finally {
      setBusyScanId(null);
    }
  };
  const toggleError = (event, scanId) => {
    event.stopPropagation();
    setExpandedErrorIds((prev) => {
      const next = new Set(prev);
      if (next.has(scanId)) next.delete(scanId);
      else next.add(scanId);
      return next;
    });
  };
  const deleteScan = async (event, scan) => {
    event.stopPropagation();
    const confirmed = window.confirm(
      `Permanently delete scan #${scan.id} and all findings, attempts, logs, and review data? This cannot be undone.`
    );
    if (!confirmed) return;
    setBusyScanId(scan.id);
    setActionError(null);
    try {
      await api.deleteScan(scan.id);
      reload();
    } catch (deleteError) {
      setActionError(deleteError);
    } finally {
      setBusyScanId(null);
    }
  };

  return (
    <div className="scans-page" style={{ padding: '30px 32px', maxWidth: 1180 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <div style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em' }}>Scans</div>
          <div style={{ fontSize: 14, color: 'var(--text-2)', marginTop: 3 }}>
            {pageData
              ? `${pageData.totalItems} scan${pageData.totalItems === 1 ? '' : 's'} · ${pageData.runningCount} running now`
              : ' '}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
        {FILTERS.map(([k, label]) => (
          <span
            key={k}
            onClick={() => {
              setFilter(k);
              setPage(1);
            }}
            style={{
              fontSize: 12.5,
              padding: '5px 12px',
              borderRadius: 7,
              cursor: 'pointer',
              background: filter === k ? 'var(--text)' : 'var(--surface-2)',
              color: filter === k ? 'var(--bg)' : 'var(--text-2)',
            }}
          >
            {label}
          </span>
        ))}
      </div>

      {dialogOpen && <NewScanDialog onClose={closeDialog} />}

      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {actionError && <ErrorState error={actionError} />}
      {pageData && pageData.totalItems === 0 && (
        <EmptyState
          title="No scans here"
          sub="Queue a scan by pointing a workflow at a repository."
          action={<Button to="/scans?new=1">+ New scan</Button>}
        />
      )}
      {pageData && pageData.totalItems > 0 && (
        <>
          <div className="scans-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            {scans.map((s) => (
              <ScanCard
                key={s.id}
                scan={s}
                to={`/scans/${s.id}`}
                busy={busyScanId === s.id}
                errorExpanded={expandedErrorIds.has(s.id)}
                onResume={(event) => resumeScan(event, s.id)}
                onToggleError={(event) => toggleError(event, s.id)}
                onDelete={(event) => deleteScan(event, s)}
              />
            ))}
          </div>
          {scanPages && <Pagination {...scanPages} itemLabel="scans" />}
        </>
      )}
    </div>
  );
}

function NewScanDialog({ onClose }) {
  const [mode, setMode] = useState(null); // null | 'duplicate'
  const [selectedId, setSelectedId] = useState('');
  const { data, loading, error, reload } = useFetch(() => api.scans(), []);
  const scans = useNewestFirst(data, 'updatedAt');
  const hasScans = scans.length > 0;
  const duplicateDisabled = data !== null && !error && !hasScans;
  const dialogRef = useModalDialog(onClose);
  const duplicatePages = usePagination(scans, { pageSize: 6, resetKey: mode });

  useEffect(() => {
    setSelectedId((current) => {
      if (scans.some((scan) => `${scan.id}` === current)) return current;
      return scans[0]?.id == null ? '' : `${scans[0].id}`;
    });
  }, [scans]);

  const duplicateDescription = loading
    ? 'Loading previous scans…'
    : error
      ? 'Previous scans could not be loaded. Open this option to retry.'
      : hasScans
        ? 'Copy a previous target and configuration, then review it before starting.'
        : 'No existing scans yet to duplicate.';

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
        aria-labelledby="new-scan-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 500,
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
          <div id="new-scan-title" style={{ fontSize: 16, fontWeight: 600 }}>
            New scan
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
              <ScanCreationOption
                autoFocus
                title="Blank scan"
                sub="Start with the default scan configuration and choose every input yourself."
                to="/scans/new"
              />
              <ScanCreationOption
                title="Duplicate an existing scan"
                sub={duplicateDescription}
                disabled={duplicateDisabled}
                onClick={() => !duplicateDisabled && setMode('duplicate')}
              />
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 10 }}>
                Pick a scan to copy — only its editable configuration is carried into the new draft.
              </div>

              {loading && !data && <Spinner label="Loading previous scans…" />}
              {error && <ErrorState error={error} onRetry={reload} />}
              {data && hasScans && (
                <>
                  <div style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {duplicatePages.pageItems.map((scan) => {
                      const scanId = `${scan.id}`;
                      const selected = selectedId === scanId;
                      const label = scan.repoDisplay || scan.repoFull || `Scan ${scan.id}`;
                      const modelOverrideCount = Object.keys(scan.modelOverrides || {}).length;
                      const detail = [
                        `#${scan.id}`,
                        scan.workflowName,
                        scan.model,
                        modelOverrideCount
                          ? `${modelOverrideCount} depth override${modelOverrideCount === 1 ? '' : 's'}`
                          : null,
                        scan.repoKind === 'local' ? 'local snapshot' : null,
                        scan.age ? `${scan.age} ago` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ');
                      return (
                        <button
                          key={scanId}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setSelectedId(scanId)}
                          style={{
                            width: '100%',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'space-between',
                            gap: 12,
                            padding: '10px 12px',
                            borderRadius: 9,
                            cursor: 'pointer',
                            border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                            background: selected ? 'var(--accent-subtle)' : 'var(--surface)',
                            color: 'var(--text)',
                            font: 'inherit',
                            textAlign: 'left',
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                fontSize: 13.5,
                                fontWeight: 600,
                                whiteSpace: 'nowrap',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                              }}
                            >
                              {label}
                            </div>
                            {detail && (
                              <div
                                className="mono"
                                style={{
                                  marginTop: 3,
                                  fontSize: 10.5,
                                  color: 'var(--text-3)',
                                  whiteSpace: 'nowrap',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                }}
                              >
                                {detail}
                              </div>
                            )}
                          </div>
                          <StatusBadge status={scan.status} reasoning={scan.reasoning} size="sm" />
                        </button>
                      );
                    })}
                  </div>
                  <Pagination
                    {...duplicatePages}
                    setPage={(nextPage) => {
                      duplicatePages.setPage(nextPage);
                      const nextScan = scans[(nextPage - 1) * duplicatePages.pageSize];
                      if (nextScan) setSelectedId(`${nextScan.id}`);
                    }}
                    itemLabel="scans"
                    compact
                  />
                </>
              )}
              {data && !hasScans && (
                <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-3)', fontSize: 12.5 }}>
                  No existing scans to duplicate.
                </div>
              )}

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
                <Button
                  to={!loading && selectedId ? duplicateScanPath(selectedId) : undefined}
                  disabled={!selectedId || loading}
                >
                  Duplicate &amp; configure
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ScanCreationOption({ title, sub, to, onClick, disabled, autoFocus = false }) {
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

function ScanCard({ scan, to, onResume, onToggleError, onDelete, busy, errorExpanded }) {
  const isRunning =
    scan.status === 'running' || scan.status === 'prewarming_cache' || scan.status === 'post_processing';
  const isPaused = scan.status === 'paused';
  const isDone = scan.status === 'completed' || scan.status === 'stopped';
  const isFailed = scan.status === 'failed';
  const isPending = scan.status === 'pending';
  const isQueued = scan.status === 'queued';
  const isRateLimited = scan.status === 'rate_limited';
  const rateLimit = rateLimitPresentation(scan.reasoning);
  const providerAutoscale = providerCapacityAutoscalePresentation(scan.reasoning);
  const storageWarning = storageWarningPresentation(scan.reasoning);
  const summary = scan.statusSummary || {};
  const latestError = summary.latestError;
  const currentFailedAttempts = summary.currentFailedAttempts ?? summary.failedAttempts ?? 0;
  const failedLabel = currentFailedAttempts
    ? `Failed after ${currentFailedAttempts} failed attempt${currentFailedAttempts === 1 ? '' : 's'}`
    : 'Failed';
  const modelOverrideCount = Object.keys(scan.modelOverrides || {}).length;

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
      <CardLinkOverlay to={to} label={`Open scan ${scan.repoDisplay || scan.repoFull || scan.id}`} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div style={{ fontWeight: 600, fontSize: 15 }}>{scan.repoDisplay || scan.repoFull}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <ScanActionsMenu scan={scan} onDelete={onDelete} busy={busy} />
          <StatusBadge status={scan.status} reasoning={scan.reasoning} size="sm" />
        </div>
      </div>
      <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 6 }}>
        {scan.workflowName} · {scan.model}
        {modelOverrideCount
          ? ` · ${modelOverrideCount} depth override${modelOverrideCount === 1 ? '' : 's'}`
          : ''} · {scan.repoKind === 'local' ? 'local snapshot' : scan.commitShort}
      </div>

      {providerAutoscale && (
        <div
          className="mono"
          style={{ marginTop: 10, color: 'var(--run)', fontSize: 10.5, fontWeight: 600 }}
          title={providerAutoscale.message}
        >
          {providerAutoscale.compact} · {providerAutoscale.reductions}{' '}
          {providerAutoscale.reductions === 1 ? 'reduction' : 'reductions'}
        </div>
      )}

      {storageWarning && (
        <div
          style={{
            marginTop: 12,
            padding: '9px 10px',
            borderRadius: 8,
            color: 'var(--pend)',
            background: 'var(--pend-bg)',
            fontSize: 12,
            lineHeight: 1.45,
          }}
        >
          <strong>Low storage.</strong> {storageWarning.message}
        </div>
      )}

      {isRunning && (
        <div style={{ marginTop: 18, paddingTop: 14, borderTop: '1px solid var(--border-2)' }}>
          <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 4, overflow: 'hidden' }}>
            <div style={{ height: '100%', width: scan.progress || '40%', background: 'var(--run)' }} />
          </div>
          <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 8 }}>
            {scan.progressLabel ||
              (scan.status === 'prewarming_cache'
                ? 'prewarming checkout cache…'
                : scan.status === 'post_processing'
                  ? 'post-processing…'
                  : 'running…')}
          </div>
          <StatusMini scan={scan} />
        </div>
      )}
      {isDone && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 26,
            marginTop: 18,
            paddingTop: 14,
            borderTop: '1px solid var(--border-2)',
          }}
        >
          <Stat value={scan.rawCandidates ?? scan.findings} label="raw candidates" />
          <Stat value={scan.findings} label="findings listed" color="var(--accent)" />
          <Stat value={scan.exploitable} label="exploitable" />
          <Stat value={scan.age} label="ago" />
        </div>
      )}
      {isPaused && (
        <div
          style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: '1px solid var(--border-2)',
            fontSize: 12.5,
            color: 'var(--text-2)',
          }}
        >
          <div>Paused — completed work is preserved.</div>
          <div onClick={(event) => event.stopPropagation()} style={{ position: 'relative', zIndex: 2, marginTop: 10 }}>
            <Button variant="subtle" style={{ height: 30, padding: '0 12px' }} onClick={onResume} disabled={busy}>
              {busy ? '…' : 'Resume'}
            </Button>
          </div>
        </div>
      )}
      {isFailed && (
        <div
          style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: '1px solid var(--border-2)',
            fontSize: 12.5,
            color: 'var(--text-2)',
          }}
        >
          <div style={{ color: 'var(--fail)', fontWeight: 600 }}>{failedLabel}</div>
          <FailedErrorPreview error={latestError} expanded={errorExpanded} onToggle={onToggleError} />
          <div
            onClick={(event) => event.stopPropagation()}
            style={{
              position: 'relative',
              zIndex: 2,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              marginTop: 12,
            }}
          >
            <StatusMini scan={scan} />
            <Button
              variant="subtle"
              style={{ height: 30, padding: '0 12px', flex: 'none' }}
              onClick={onResume}
              disabled={busy}
              title="Continue from completed steps and retry failed work"
            >
              {busy ? '…' : 'Resume'}
            </Button>
          </div>
        </div>
      )}
      {isPending && (
        <div
          style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: '1px solid var(--border-2)',
            fontSize: 12.5,
            color: 'var(--text-2)',
          }}
        >
          Pending — the engine will pick this up shortly.
        </div>
      )}
      {isQueued && (
        <div
          style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: '1px solid var(--border-2)',
            fontSize: 12.5,
            color: 'var(--text-2)',
          }}
        >
          Queued — this scan will start after active scans finish.
        </div>
      )}
      {isRateLimited && (
        <div
          style={{
            marginTop: 18,
            paddingTop: 14,
            borderTop: '1px solid var(--border-2)',
            fontSize: 12.5,
            color: 'var(--text-2)',
          }}
        >
          <div style={{ color: 'var(--pend)', fontWeight: 600 }}>
            {rateLimit.accountRelated ? (
              <Link
                to="/accounts"
                onClick={(event) => event.stopPropagation()}
                style={{ position: 'relative', zIndex: 2, color: 'inherit' }}
              >
                {rateLimit.label}.
              </Link>
            ) : (
              `${rateLimit.label}.`
            )}
          </div>
          <div style={{ marginTop: 4 }}>{rateLimit.message}</div>
          {rateLimit.accountRelated && (
            <Link
              to="/accounts"
              onClick={(event) => event.stopPropagation()}
              style={{
                position: 'relative',
                zIndex: 2,
                display: 'inline-block',
                marginTop: 6,
                color: 'var(--accent)',
                fontWeight: 600,
              }}
            >
              View usage and provider limits in Accounts
            </Link>
          )}
          <div className="mono" style={{ marginTop: 6, fontSize: 11.5 }}>
            {rateLimitRetryText(scan.reasoning)}
          </div>
          <StatusMini scan={scan} />
        </div>
      )}
    </div>
  );
}

function ScanActionsMenu({ scan, onDelete, busy }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);
  const triggerRef = useRef(null);
  const canDelete = isScanDeletable(scan.status);

  useEffect(() => {
    if (!open) return undefined;

    const closeOutside = (event) => {
      if (!containerRef.current?.contains(event.target)) setOpen(false);
    };
    const closeWithEscape = (event) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('focusin', closeOutside);
    document.addEventListener('keydown', closeWithEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('focusin', closeOutside);
      document.removeEventListener('keydown', closeWithEscape);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      onClick={(event) => event.stopPropagation()}
      style={{ position: 'relative', zIndex: 2, display: 'inline-flex' }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-label={`Actions for scan #${scan.id}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Scan actions"
        onClick={() => setOpen((current) => !current)}
        style={{
          width: 28,
          height: 26,
          padding: 0,
          border: '1px solid var(--border)',
          borderRadius: 7,
          background: open ? 'var(--surface-2)' : 'var(--surface)',
          color: 'var(--text-2)',
          cursor: 'pointer',
          fontSize: 18,
          lineHeight: 1,
        }}
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          aria-label={`Scan #${scan.id} actions`}
          style={{
            position: 'absolute',
            top: 31,
            right: 0,
            zIndex: 20,
            width: 154,
            padding: 5,
            border: '1px solid var(--border)',
            borderRadius: 8,
            background: 'var(--surface)',
            boxShadow: '0 10px 30px rgba(0,0,0,.18)',
          }}
        >
          <ScanMenuItem
            to={duplicateScanPath(scan.id)}
            onClick={() => {
              setOpen(false);
            }}
          >
            Duplicate scan
          </ScanMenuItem>
          <ScanMenuItem
            danger
            disabled={!canDelete || busy}
            title={!canDelete ? 'Stop this scan and wait for active work to finish before deleting it.' : undefined}
            onClick={(event) => {
              setOpen(false);
              onDelete(event);
            }}
          >
            Delete scan
          </ScanMenuItem>
        </div>
      )}
    </div>
  );
}

function ScanMenuItem({ children, danger = false, disabled = false, onClick, title, to }) {
  const style = {
    width: '100%',
    height: 32,
    padding: '0 10px',
    border: 0,
    borderRadius: 6,
    background: 'transparent',
    color: disabled ? 'var(--text-3)' : danger ? 'var(--fail)' : 'var(--text)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.55 : 1,
    font: 'inherit',
    fontSize: 12.5,
    textAlign: 'left',
    textDecoration: 'none',
    display: 'flex',
    alignItems: 'center',
  };
  if (to) {
    return (
      <Link to={to} role="menuitem" title={title} onClick={onClick} style={style}>
        {children}
      </Link>
    );
  }
  return (
    <button type="button" role="menuitem" disabled={disabled} title={title} onClick={onClick} style={style}>
      {children}
    </button>
  );
}

function FailedErrorPreview({ error, expanded, onToggle }) {
  const message = error?.message;
  if (!message) return null;
  const knownError = error?.knownError;
  return (
    <div
      onClick={(event) => event.stopPropagation()}
      style={{
        position: 'relative',
        zIndex: 2,
        marginTop: 9,
        border: '1px solid var(--fail-bg)',
        borderRadius: 8,
        background: 'var(--fail-bg)',
        padding: '8px 9px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 5 }}>
        <span
          className="mono"
          style={{ fontSize: 10, letterSpacing: '0.05em', color: 'var(--fail)', textTransform: 'uppercase' }}
        >
          Latest error
        </span>
        <button
          type="button"
          onClick={onToggle}
          style={{
            height: 24,
            padding: '0 8px',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: 'var(--text-2)',
            fontSize: 11.5,
            cursor: 'pointer',
          }}
        >
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>
      {knownError && <KnownErrorBadge knownError={knownError} />}
      <div
        className="mono"
        style={{
          color: 'var(--text-2)',
          fontSize: 11.5,
          lineHeight: 1.45,
          overflowWrap: 'anywhere',
          whiteSpace: 'pre-wrap',
          ...(expanded
            ? { maxHeight: 170, overflowY: 'auto', paddingRight: 4 }
            : { display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }),
        }}
      >
        <LinkifiedText text={message} />
      </div>
      <ErrorFixLinks knownError={knownError} />
    </div>
  );
}

function KnownErrorBadge({ knownError }) {
  if (!knownError?.title) return null;
  return (
    <span
      className="mono"
      style={{
        display: 'inline-flex',
        marginBottom: 6,
        padding: '2px 7px',
        borderRadius: 999,
        border: '1px solid var(--fail)',
        background: 'var(--surface)',
        color: 'var(--fail)',
        fontSize: 10.5,
      }}
    >
      {knownError.title}
    </span>
  );
}

function ErrorFixLinks({ knownError }) {
  const links = knownError?.fixLinks || [];
  if (!links.length) return null;
  return (
    <div className="mono" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 7, fontSize: 11 }}>
      {links.map((link) =>
        link.internal || link.url?.startsWith('/') ? (
          <Link
            key={`${link.label}-${link.url}`}
            to={link.url}
            style={{ color: 'var(--accent)', textDecoration: 'none', borderBottom: '1px solid var(--accent)' }}
          >
            {link.label || link.url}
          </Link>
        ) : (
          <a
            key={`${link.label}-${link.url}`}
            href={link.url}
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'none', borderBottom: '1px solid var(--accent)' }}
          >
            {link.label || link.url}
          </a>
        )
      )}
    </div>
  );
}

function StatusMini({ scan }) {
  const summary = scan.statusSummary || {};
  const active = summary.activeJobs || [];
  const currentFailedAttempts = summary.currentFailedAttempts ?? summary.failedAttempts ?? 0;
  const rateLimited = scan.status === 'rate_limited';
  const first = active[0];
  const completedLineages = summary.completedStepLineages ?? summary.stepCompletedAttempts ?? 0;
  const expectedLineages = summary.expectedStepLineages ?? summary.stepAttempts ?? 0;
  if (!summary.totalAttempts && !active.length && !summary.latestError) return null;
  return (
    <div
      className="mono"
      style={{ display: 'flex', flexWrap: 'wrap', gap: 9, marginTop: 9, fontSize: 11.2, color: 'var(--text-3)' }}
    >
      {first && (
        <span style={{ color: 'var(--run)' }}>
          {first.phaseLabel}: {first.title}
        </span>
      )}
      {expectedLineages > 0 && (
        <span>
          {completedLineages}/{expectedLineages} workflow lineages
        </span>
      )}
      {summary.totalAttempts > 0 && <span>{summary.totalAttempts} attempts</span>}
      {currentFailedAttempts > 0 && (
        <span style={{ color: rateLimited ? 'var(--pend)' : 'var(--fail)' }}>
          {currentFailedAttempts} {rateLimited ? 'attempt errors' : 'failed'}
        </span>
      )}
      {summary.postRunningAttempts > 0 && <span>{summary.postRunningAttempts} post running</span>}
    </div>
  );
}

function Stat({ value, label, color = 'var(--text)' }) {
  return (
    <div>
      <div style={{ fontSize: 20, fontWeight: 600, color }}>{value}</div>
      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{label}</div>
    </div>
  );
}

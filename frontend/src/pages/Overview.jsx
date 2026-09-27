import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, StatusBadge } from '../components/ui.jsx';
import { isScanDeletable } from '../lib/scanPresentation.js';

const todayLabel = () => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export default function Overview() {
  usePageChrome([{ label: 'Overview', active: true }], null, []);
  const [selectedScanId, setSelectedScanId] = useState('');
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const { data, loading, error, reload } = useFetch(() => api.overview(selectedScanId), [selectedScanId], {
    pollMs: 5000,
  });
  const deleteSelectedScan = async () => {
    const scan = data?.focusScan;
    if (!scan || !isScanDeletable(scan) || deleting) return;
    if (
      !window.confirm(
        `Permanently delete scan #${scan.id} and all findings, attempts, logs, and review data? This cannot be undone.`
      )
    )
      return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteScan(scan.id);
      setSelectedScanId('');
      reload();
    } catch (deleteScanError) {
      setDeleteError(deleteScanError);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div style={{ padding: '30px 32px', maxWidth: 1180 }}>
      <div className="mono" style={{ fontSize: 13, color: 'var(--text-2)' }}>
        {todayLabel()}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'end',
          justifyContent: 'space-between',
          gap: 18,
          margin: '4px 0 24px',
        }}
      >
        <div style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em' }}>Overview</div>
        {data?.availableScans?.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'end', gap: 8 }}>
            <label style={{ display: 'grid', gap: 5, minWidth: 310 }}>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', textTransform: 'uppercase' }}>
                Research
              </span>
              <select
                aria-label="Research"
                value={selectedScanId || data.focusScan?.id || ''}
                onChange={(event) => setSelectedScanId(event.target.value)}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '9px 11px',
                  background: 'var(--surface)',
                  color: 'var(--text)',
                }}
              >
                {data.availableScans.map((scan) => (
                  <option key={scan.id} value={scan.id}>
                    #{scan.id} · {scan.repoDisplay || scan.repoFull} · {scan.status}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!isScanDeletable(data.focusScan) || deleting}
              title={
                isScanDeletable(data.focusScan)
                  ? 'Permanently delete the selected scan'
                  : 'Stop active work before deleting this scan'
              }
              onClick={deleteSelectedScan}
              style={{
                height: 37,
                padding: '0 12px',
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--surface)',
                color: isScanDeletable(data.focusScan) ? 'var(--fail)' : 'var(--text-3)',
                cursor: isScanDeletable(data.focusScan) ? 'pointer' : 'not-allowed',
              }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        )}
      </div>

      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {deleteError && <ErrorState error={deleteError} />}
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 26 }}>
            <Kpi
              label="Latest run"
              value={data.focusScan ? `#${data.focusScan.id}` : '—'}
              sub={data.focusScan?.repoDisplay || data.focusScan?.repoFull || 'No scans yet'}
            />
            <Kpi
              label="Status"
              value={data.focusScan?.status || '—'}
              sub={data.focusScan?.progressLabel || 'Current research only'}
            />
            <Kpi label="Findings" value={data.findingsCount} sub="selected research" color="var(--accent)" />
            <Kpi label="Exploitable" value={data.exploitableCount} sub="selected research" color="var(--fail)" />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Current research</div>
            <Link
              to={data.focusScan ? `/scans?researchScan=${data.focusScan.id}` : '/scans'}
              style={{ fontSize: 12.5, color: 'var(--accent)', cursor: 'pointer', textDecoration: 'none' }}
            >
              View all →
            </Link>
          </div>
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 12,
              overflow: 'hidden',
              background: 'var(--surface)',
            }}
          >
            {data.recentScans.map((s) => (
              <Link
                key={s.id}
                to={`/scans/${s.id}`}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '13px 16px',
                  borderBottom: '1px solid var(--border-2)',
                  cursor: 'pointer',
                  color: 'inherit',
                  textDecoration: 'none',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 13.5 }}>{s.repoDisplay || s.repoFull}</div>
                  <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 2 }}>
                    {s.workflowName} · {s.model}
                    {Object.keys(s.modelOverrides || {}).length
                      ? ` · ${Object.keys(s.modelOverrides).length} depth overrides`
                      : ''}
                  </div>
                </div>
                <StatusBadge status={s.status} reasoning={s.reasoning} />
              </Link>
            ))}
            {data.recentScans.length === 0 && (
              <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
                No scans yet.
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Kpi({ label, value, sub, color = 'var(--text)' }) {
  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '16px 18px',
        background: 'var(--surface)',
        boxShadow: 'var(--shadow)',
      }}
    >
      <div
        className="mono"
        style={{ fontSize: 10.5, letterSpacing: '0.06em', color: 'var(--text-3)', textTransform: 'uppercase' }}
      >
        {label}
      </div>
      <div style={{ fontSize: 28, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 8, color }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{sub}</div>
    </div>
  );
}

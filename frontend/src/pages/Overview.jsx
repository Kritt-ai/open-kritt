import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, StatusBadge } from '../components/ui.jsx';

const todayLabel = () => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

export default function Overview() {
  usePageChrome([{ label: 'Overview', active: true }], null, []);
  const { data, loading, error, reload } = useFetch(() => api.overview(), []);

  return (
    <div style={{ padding: '30px 32px', maxWidth: 1180 }}>
      <div className="mono" style={{ fontSize: 13, color: 'var(--text-2)' }}>
        {todayLabel()}
      </div>
      <div style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em', margin: '4px 0 24px' }}>Overview</div>

      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 14, marginBottom: 26 }}>
            <Kpi label="Workflows" value={data.workflowCount} sub="blueprints defined" />
            <Kpi label="Scans" value={data.scanCount} sub={`${data.runningCount} running now`} />
            <Kpi label="Findings" value={data.findingsCount} sub="across all scans" color="var(--accent)" />
            <Kpi label="Exploitable" value={data.exploitableCount} sub="confirmed by final pass" color="var(--fail)" />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 600 }}>Active &amp; recent scans</div>
            <Link
              to="/scans"
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

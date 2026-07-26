import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, EmptyState } from '../components/ui.jsx';
import { usePagination } from '../lib/usePagination.js';
import Pagination from '../components/Pagination.jsx';

const GRID = '1.8fr 0.6fr 0.7fr 1.4fr 0.9fr';

export default function Steps() {
  usePageChrome([{ label: 'Steps', active: true }], null, []);
  const { data, loading, error, reload } = useFetch(() => api.steps(), []);
  const stepPages = usePagination(data || [], { pageSize: 25 });

  return (
    <div style={{ padding: '30px 32px', maxWidth: 1180 }}>
      <div style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em' }}>Steps</div>
      <div style={{ fontSize: 14, color: 'var(--text-2)', margin: '3px 0 22px' }}>
        Every step defined across your workflows.
      </div>

      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && <EmptyState title="No steps yet" sub="Steps are created as part of a workflow." />}
      {data && data.length > 0 && (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 11,
            overflow: 'hidden',
            background: 'var(--surface)',
          }}
        >
          <div
            className="mono"
            style={{
              display: 'grid',
              gridTemplateColumns: GRID,
              padding: '10px 18px',
              fontSize: 10,
              letterSpacing: '0.05em',
              color: 'var(--text-3)',
              borderBottom: '1px solid var(--border-2)',
            }}
          >
            <span>NAME</span>
            <span>DEPTH</span>
            <span>MULTI</span>
            <span>OUTPUT KEYS</span>
            <span>WORKFLOW</span>
          </div>
          {stepPages.pageItems.map((s) => (
            <div
              key={s.id}
              style={{
                display: 'grid',
                gridTemplateColumns: GRID,
                padding: '13px 18px',
                alignItems: 'center',
                borderBottom: '1px solid var(--border-2)',
                fontSize: 13,
              }}
            >
              <span style={{ fontWeight: 500 }}>{s.name || 'Untitled step'}</span>
              <span className="mono" style={{ color: 'var(--text-2)' }}>
                {s.depth}
              </span>
              <span className="mono" style={{ color: s.multiOutput ? 'var(--accent)' : 'var(--text-2)' }}>
                {String(s.multiOutput)}
              </span>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                {s.keys.join(', ')}
              </span>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
                {s.workflowName || '—'}
              </span>
            </div>
          ))}
          <Pagination
            {...stepPages}
            itemLabel="steps"
            style={{ padding: '0 16px 14px', borderTop: '1px solid var(--border-2)' }}
          />
        </div>
      )}
    </div>
  );
}

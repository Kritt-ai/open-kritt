import { Link } from 'react-router-dom';
import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, EmptyState, Button } from '../components/ui.jsx';
import { rankerDescOf, rankerRuleCount } from '../lib/severityRanker.js';
import { useNewestFirst, usePagination } from '../lib/usePagination.js';
import Pagination from '../components/Pagination.jsx';

export default function SeverityRankers() {
  usePageChrome(
    [{ label: 'Severity rankers', active: true }],
    { label: '+ New severity ranker', to: '/severity-rankers/new' },
    []
  );
  const { data, loading, error, reload } = useFetch(() => api.severityRankers(), []);
  const rankers = useNewestFirst(data);
  const rankerPages = usePagination(rankers, { pageSize: 9 });

  return (
    <div style={{ padding: '30px 32px', maxWidth: 1180 }}>
      <div style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em' }}>Severity rankers</div>
      <div style={{ fontSize: 14, color: 'var(--text-2)', margin: '3px 0 22px' }}>
        Reusable rule-sets that tell the model how to rank a finding — critical, high, medium, low or informational.
        Attach one or more when you create a scan.
      </div>

      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && (
        <EmptyState
          title="No severity rankers yet"
          sub="Write the rules by which findings should be ranked, then attach them to scans."
          action={<Button to="/severity-rankers/new">+ New severity ranker</Button>}
        />
      )}
      {data && data.length > 0 && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
            {rankerPages.pageItems.map((r) => {
              const count = rankerRuleCount(r.content);
              return (
                <Link
                  key={r.id}
                  to={`/severity-rankers/${r.id}`}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 12,
                    padding: 18,
                    background: 'var(--surface)',
                    boxShadow: 'var(--shadow)',
                    cursor: 'pointer',
                    display: 'flex',
                    flexDirection: 'column',
                    color: 'inherit',
                    textDecoration: 'none',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div className="mono" style={{ fontWeight: 600, fontSize: 14.5 }}>
                      {r.name}
                    </div>
                    <span
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: 'var(--text-3)',
                        border: '1px solid var(--border)',
                        padding: '2px 7px',
                        borderRadius: 5,
                        flex: 'none',
                      }}
                    >
                      {count} rule{count === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 8, lineHeight: 1.55 }}>
                    {r.description || rankerDescOf(r.content)}
                  </div>
                </Link>
              );
            })}
          </div>
          <Pagination {...rankerPages} itemLabel="rankers" />
        </>
      )}
    </div>
  );
}

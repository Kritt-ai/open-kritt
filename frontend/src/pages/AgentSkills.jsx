import { CardLinkOverlay, Spinner, ErrorState, EmptyState, Button } from '../components/ui.jsx';
import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { useNewestFirst, usePagination } from '../lib/usePagination.js';
import Pagination from '../components/Pagination.jsx';

export default function AgentSkills() {
  usePageChrome([{ label: 'Agent skills', active: true }], { label: '+ New skill', to: '/agent-skills/new' }, []);
  const { data, loading, error, reload } = useFetch(() => api.agentSkills(), []);
  const skills = useNewestFirst(data);
  const skillPages = usePagination(skills, { pageSize: 9 });

  return (
    <div style={{ padding: '30px 32px', maxWidth: 1180 }}>
      <div style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em' }}>Agent skills</div>
      <div style={{ fontSize: 14, color: 'var(--text-2)', margin: '3px 0 22px' }}>
        Selected per scan and installed into each executor agent home.
      </div>

      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && (
        <EmptyState
          title="No agent skills yet"
          sub="Create reusable security-review instructions and attach them to scans."
          action={<Button to="/agent-skills/new">+ New skill</Button>}
        />
      )}
      {data && data.length > 0 && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr 1fr',
              gap: 14,
              paddingRight: 4,
            }}
          >
            {skillPages.pageItems.map((skill) => (
              <div
                key={skill.id}
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
                <CardLinkOverlay to={`/agent-skills/${skill.id}`} label={`Open agent skill ${skill.name}`} />
                <div className="mono" style={{ fontWeight: 600, fontSize: 14.5 }}>
                  {skill.name}
                </div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 4 }}>
                  {skill.slug}
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: 'var(--text-2)',
                    marginTop: 8,
                    lineHeight: 1.5,
                    height: 56,
                    overflow: 'hidden',
                  }}
                >
                  {skill.description}
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    flexWrap: 'wrap',
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: '1px solid var(--border-2)',
                  }}
                >
                  {skill.licenseSpdx && <Chip>{skill.licenseSpdx}</Chip>}
                  {skill.sourceUrl && (
                    <a
                      href={skill.sourceUrl}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="mono"
                      style={{
                        position: 'relative',
                        zIndex: 2,
                        display: 'inline-flex',
                        alignItems: 'center',
                        height: 22,
                        padding: '0 9px',
                        borderRadius: 6,
                        border: '1px solid var(--accent)',
                        background: 'var(--accent-subtle)',
                        color: 'var(--accent)',
                        fontSize: 10.5,
                        fontWeight: 700,
                        textDecoration: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      source
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
          <Pagination {...skillPages} itemLabel="skills" />
        </>
      )}
    </div>
  );
}

function Chip({ children }) {
  return (
    <span
      className="mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 22,
        padding: '0 7px',
        fontSize: 10,
        color: 'var(--text-2)',
        background: 'var(--surface-2)',
        borderRadius: 5,
      }}
    >
      {children}
    </span>
  );
}

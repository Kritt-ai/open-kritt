import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api/client.js';
import { useFetch } from '../lib/useFetch.js';
import { usePageChrome } from '../context/ui.jsx';
import { Spinner, ErrorState, EmptyState, Button } from '../components/ui.jsx';
import { useModalDialog } from '../lib/useModalDialog.js';
import { useNewestFirst, usePagination } from '../lib/usePagination.js';
import Pagination from '../components/Pagination.jsx';

export default function PostScripts() {
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
  usePageChrome(
    [{ label: 'Post-scripts', active: true }],
    { label: '+ New post-script', to: '/post-scripts?new=1' },
    []
  );
  const { data, loading, error, reload } = useFetch(() => api.postScripts(), []);
  const postScripts = useNewestFirst(data);
  const postScriptPages = usePagination(postScripts, { pageSize: 9 });

  return (
    <div style={{ padding: '30px 32px', maxWidth: 1180 }}>
      <div style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em' }}>Post-scripts</div>
      <div style={{ fontSize: 14, color: 'var(--text-2)', margin: '3px 0 22px' }}>
        Run after every finding to enrich, grade or cluster it. Reserved keys only.
      </div>

      {dialogOpen && <NewPostScriptDialog onClose={closeDialog} />}

      {loading && <Spinner />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {data && data.length === 0 && (
        <EmptyState
          title="No post-scripts yet"
          sub="A post-script runs once per finding to enrich or grade it."
          action={<Button to="/post-scripts?new=1">+ New post-script</Button>}
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
            {postScriptPages.pageItems.map((p) => (
              <Link
                key={p.id}
                to={`/post-scripts/${p.id}`}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 12,
                  padding: 18,
                  background: 'var(--surface)',
                  boxShadow: 'var(--shadow)',
                  cursor: 'pointer',
                  color: 'inherit',
                  textDecoration: 'none',
                }}
              >
                <div className="mono" style={{ fontWeight: 600, fontSize: 14.5 }}>
                  {p.name}
                </div>
                <div
                  style={{
                    fontSize: 12.5,
                    color: 'var(--text-2)',
                    marginTop: 6,
                    lineHeight: 1.5,
                    height: 54,
                    overflow: 'hidden',
                  }}
                >
                  {p.description}
                </div>
                <div
                  style={{
                    display: 'flex',
                    gap: 5,
                    flexWrap: 'wrap',
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: '1px solid var(--border-2)',
                  }}
                >
                  {p.keys.map((k) => (
                    <span
                      key={k}
                      className="mono"
                      style={{
                        fontSize: 10,
                        color: 'var(--text-2)',
                        background: 'var(--surface-2)',
                        padding: '2px 7px',
                        borderRadius: 5,
                      }}
                    >
                      {k}
                    </span>
                  ))}
                </div>
              </Link>
            ))}
          </div>
          <Pagination {...postScriptPages} itemLabel="post-scripts" />
        </>
      )}
    </div>
  );
}

function NewPostScriptDialog({ onClose }) {
  const dialogRef = useModalDialog(onClose);

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
        aria-labelledby="new-post-script-title"
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
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
          <div id="new-post-script-title" style={{ fontSize: 16, fontWeight: 600 }}>
            New post-script
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
        <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <OptionCard
            autoFocus
            title="Generate with AI"
            sub="Describe how findings should be enriched, then review a detailed, valid post-script draft."
            to="/post-scripts/generate"
          />
          <OptionCard
            title="Blank post-script"
            sub="Start with an empty post-script and define it yourself."
            to="/post-scripts/new"
          />
        </div>
      </div>
    </div>
  );
}

function OptionCard({ title, sub, to, autoFocus = false }) {
  return (
    <Link
      to={to}
      data-autofocus={autoFocus || undefined}
      style={{
        width: '100%',
        padding: '14px 16px',
        borderRadius: 8,
        border: '1px solid var(--border)',
        background: 'var(--surface)',
        color: 'var(--text)',
        cursor: 'pointer',
        textAlign: 'left',
        font: 'inherit',
        textDecoration: 'none',
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
      <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.45 }}>{sub}</div>
    </Link>
  );
}

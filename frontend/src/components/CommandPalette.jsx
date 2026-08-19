import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client.js';
import { newScanChooserPath } from '../lib/scanDuplication.js';

// Static destinations + actions, always available even before data loads.
const STATIC = [
  { type: 'Page', label: 'Overview', to: '/' },
  { type: 'Page', label: 'Workflows', to: '/workflows' },
  { type: 'Page', label: 'Scans', to: '/scans' },
  { type: 'Page', label: 'Settings', to: '/settings' },
  { type: 'Page', label: 'Accounts', to: '/accounts' },
  { type: 'Page', label: 'Steps', to: '/steps' },
  { type: 'Page', label: 'Agent skills', to: '/agent-skills' },
  { type: 'Page', label: 'Severity rankers', to: '/severity-rankers' },
  { type: 'Page', label: 'Post-scripts', to: '/post-scripts' },
  { type: 'Action', label: 'New scan', to: newScanChooserPath() },
  { type: 'Action', label: 'New workflow', to: '/workflows?new=1' },
  { type: 'Action', label: 'Generate workflow with AI', to: '/workflows/generate' },
  { type: 'Action', label: 'New post-script', to: '/post-scripts?new=1' },
  { type: 'Action', label: 'Generate post-script with AI', to: '/post-scripts/generate' },
  { type: 'Action', label: 'New severity ranker', to: '/severity-rankers/new' },
];

const TYPE_COLOR = {
  Page: 'var(--text-3)',
  Action: 'var(--accent)',
  Workflow: 'var(--run)',
  Scan: 'var(--ok)',
  'Post-script': 'var(--pend)',
  'Agent skill': 'var(--text-2)',
  'Severity ranker': 'var(--accent)',
};

function haystack(item) {
  return `${item.label} ${item.sub || ''} ${item.type}`.toLowerCase();
}

export default function CommandPalette({ open, onClose }) {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const listRef = useRef(null);
  const [query, setQuery] = useState('');
  const [data, setData] = useState(null); // dynamic items (null until first load)
  const [index, setIndex] = useState(0);

  // Lazily load searchable records the first time the palette opens.
  useEffect(() => {
    if (!open || data) return;
    let active = true;
    Promise.all([api.workflows(), api.scans(), api.postScripts(), api.agentSkills(), api.severityRankers()])
      .then(([wf, sc, ps, ag, sr]) => {
        if (!active) return;
        const items = [
          ...wf.map((w) => ({ type: 'Workflow', label: w.name, sub: w.description, to: `/workflows/${w.id}` })),
          ...sc.map((s) => ({
            type: 'Scan',
            label: s.repoDisplay || s.repoFull,
            sub: [
              s.workflowName,
              s.model,
              Object.keys(s.modelOverrides || {}).length
                ? `${Object.keys(s.modelOverrides).length} depth overrides`
                : null,
              s.status,
            ]
              .filter(Boolean)
              .join(' · '),
            to: `/scans/${s.id}`,
          })),
          ...ps.map((p) => ({ type: 'Post-script', label: p.name, sub: p.description, to: `/post-scripts/${p.id}` })),
          ...ag.map((a) => ({
            type: 'Agent skill',
            label: a.name,
            sub: a.description || a.slug,
            to: `/agent-skills/${a.id}`,
          })),
          ...sr.map((r) => ({
            type: 'Severity ranker',
            label: r.name,
            sub: r.description,
            to: `/severity-rankers/${r.id}`,
          })),
        ];
        setData(items);
      })
      .catch(() => active && setData([]));
    return () => {
      active = false;
    };
  }, [open, data]);

  // Reset query/selection each time the palette opens, and focus the input.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    const t = setTimeout(() => inputRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, [open]);

  const results = useMemo(() => {
    const all = [...STATIC, ...(data || [])];
    const q = query.trim().toLowerCase();
    if (!q) return STATIC;
    const tokens = q.split(/\s+/);
    return all
      .filter((it) => {
        const h = haystack(it);
        return tokens.every((t) => h.includes(t));
      })
      .slice(0, 40);
  }, [query, data]);

  // Keep the selection in range and scrolled into view.
  useEffect(() => {
    setIndex((i) => Math.min(i, Math.max(0, results.length - 1)));
  }, [results.length]);
  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-idx="${index}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const go = useCallback(
    (item) => {
      if (!item) return;
      onClose();
      navigate(item.to);
    },
    [navigate, onClose]
  );

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(results[index]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  if (!open) return null;

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 80,
        background: 'rgba(0,0,0,.32)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '12vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 560,
          maxWidth: '92vw',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 14,
          boxShadow: '0 24px 60px rgba(0,0,0,.32)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '13px 16px',
            borderBottom: '1px solid var(--border-2)',
          }}
        >
          <span
            style={{ width: 13, height: 13, border: '1.6px solid var(--text-3)', borderRadius: '50%', flex: 'none' }}
          />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search workflows, scans, post-scripts, skills…"
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              background: 'transparent',
              color: 'var(--text)',
              fontSize: 14.5,
            }}
          />
          <span
            className="mono"
            style={{
              fontSize: 10,
              color: 'var(--text-3)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              padding: '1px 5px',
            }}
          >
            esc
          </span>
        </div>

        <div ref={listRef} style={{ maxHeight: 360, overflowY: 'auto', padding: 6 }}>
          {results.length === 0 && (
            <div style={{ padding: '22px 14px', textAlign: 'center', color: 'var(--text-3)', fontSize: 13 }}>
              {data === null ? 'Loading…' : 'No matches.'}
            </div>
          )}
          {results.map((it, i) => (
            <Link
              key={`${it.type}-${it.to}-${i}`}
              to={it.to}
              data-idx={i}
              onClick={onClose}
              onMouseEnter={() => setIndex(i)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '9px 11px',
                borderRadius: 8,
                cursor: 'pointer',
                background: i === index ? 'var(--hover)' : 'transparent',
                color: 'inherit',
                textDecoration: 'none',
              }}
            >
              <span
                className="mono"
                style={{
                  flex: 'none',
                  width: 92,
                  fontSize: 9.5,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  color: TYPE_COLOR[it.type] || 'var(--text-3)',
                }}
              >
                {it.type}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div
                  style={{
                    fontSize: 13.5,
                    color: 'var(--text)',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {it.label}
                </div>
                {it.sub && (
                  <div
                    style={{
                      fontSize: 11.5,
                      color: 'var(--text-3)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      marginTop: 1,
                    }}
                  >
                    {it.sub}
                  </div>
                )}
              </div>
              {i === index && (
                <span className="mono" style={{ flex: 'none', fontSize: 10, color: 'var(--text-3)' }}>
                  ↵
                </span>
              )}
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { useChrome } from '../context/ui.jsx';
import CommandPalette from './CommandPalette.jsx';

export default function Topbar() {
  const { chrome } = useChrome();
  const crumbs = chrome.crumbs || [];
  const primary = chrome.primaryAction;
  const [searchOpen, setSearchOpen] = useState(false);

  // ⌘K / Ctrl-K toggles the global search palette anywhere in the app.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setSearchOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <div
        className="app-topbar"
        style={{
          height: 54,
          flex: 'none',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 22px',
          background: 'var(--bg)',
        }}
      >
        <div className="topbar-crumbs" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
          {crumbs.map((c, i) => (
            <span className="topbar-crumb" key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {c.to ? (
                <Link
                  to={c.to}
                  style={{
                    color: c.active ? 'var(--text)' : 'var(--text-2)',
                    fontWeight: c.active ? 600 : 400,
                    textDecoration: 'none',
                  }}
                >
                  {c.label}
                </Link>
              ) : (
                <span style={{ color: c.active ? 'var(--text)' : 'var(--text-2)', fontWeight: c.active ? 600 : 400 }}>
                  {c.label}
                </span>
              )}
              {i < crumbs.length - 1 && <span style={{ color: 'var(--text-3)' }}>/</span>}
            </span>
          ))}
        </div>

        <div className="topbar-actions" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button
            className="topbar-search"
            type="button"
            aria-label="Search"
            onClick={() => setSearchOpen(true)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              height: 32,
              padding: '0 11px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              color: 'var(--text-3)',
              fontSize: 13,
              background: 'var(--surface)',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <span
              style={{
                width: 12,
                height: 12,
                border: '1.6px solid currentColor',
                borderRadius: '50%',
                display: 'inline-block',
              }}
            />
            <span className="topbar-search-label">Search</span>
            <span
              className="mono topbar-search-shortcut"
              style={{
                fontSize: 10,
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '1px 4px',
                marginLeft: 18,
              }}
            >
              ⌘K
            </span>
          </button>
          {primary?.to ? (
            <Link
              className="topbar-primary"
              to={primary.to}
              style={{
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                height: 32,
                padding: '0 14px',
                background: 'var(--accent)',
                color: 'var(--accent-fg)',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
                textDecoration: 'none',
              }}
            >
              {primary.label}
            </Link>
          ) : primary ? (
            <button
              className="topbar-primary"
              type="button"
              onClick={primary.onClick}
              style={{
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                gap: 7,
                height: 32,
                padding: '0 14px',
                background: 'var(--accent)',
                color: 'var(--accent-fg)',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {primary.label}
            </button>
          ) : null}
        </div>
      </div>
      <CommandPalette open={searchOpen} onClose={() => setSearchOpen(false)} />
    </>
  );
}

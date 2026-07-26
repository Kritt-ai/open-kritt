import { paginationTokens } from '../lib/pagination.js';

export default function Pagination({
  page,
  pageSize,
  totalItems,
  totalPages,
  startIndex,
  endIndex,
  setPage,
  itemLabel = 'items',
  compact = false,
  style,
}) {
  if (totalItems <= pageSize) return null;

  const buttonStyle = (active = false, disabled = false) => ({
    minWidth: compact ? 28 : 32,
    height: compact ? 28 : 32,
    padding: '0 8px',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: 7,
    background: active ? 'var(--accent-subtle)' : 'var(--surface)',
    color: active ? 'var(--accent)' : disabled ? 'var(--text-3)' : 'var(--text-2)',
    cursor: disabled ? 'default' : 'pointer',
    font: 'inherit',
    fontSize: compact ? 11.5 : 12,
  });

  return (
    <nav
      aria-label={`${itemLabel} pagination`}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 10,
        marginTop: compact ? 10 : 16,
        ...style,
      }}
    >
      <span className="mono" style={{ color: 'var(--text-3)', fontSize: compact ? 10.5 : 11.5 }}>
        {startIndex + 1}–{endIndex} of {totalItems} {itemLabel}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <button
          type="button"
          aria-label={`Previous ${itemLabel} page`}
          disabled={page === 1}
          onClick={() => setPage(page - 1)}
          style={buttonStyle(false, page === 1)}
        >
          ‹
        </button>
        {paginationTokens(page, totalPages, compact ? 5 : 7).map((token) =>
          typeof token === 'number' ? (
            <button
              key={token}
              type="button"
              aria-label={`Page ${token}`}
              aria-current={token === page ? 'page' : undefined}
              onClick={() => setPage(token)}
              style={buttonStyle(token === page)}
            >
              {token}
            </button>
          ) : (
            <span key={token} aria-hidden="true" style={{ color: 'var(--text-3)', padding: '0 2px' }}>
              …
            </span>
          )
        )}
        <button
          type="button"
          aria-label={`Next ${itemLabel} page`}
          disabled={page === totalPages}
          onClick={() => setPage(page + 1)}
          style={buttonStyle(false, page === totalPages)}
        >
          ›
        </button>
      </div>
    </nav>
  );
}

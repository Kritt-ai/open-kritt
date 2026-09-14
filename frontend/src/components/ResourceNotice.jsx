import { Link } from 'react-router-dom';

export default function ResourceNotice({ notice }) {
  if (!notice) return null;
  return (
    <div
      className="resource-notice"
      onClick={(event) => event.stopPropagation()}
      style={{
        position: 'relative',
        zIndex: 2,
        marginTop: 14,
        padding: '10px 12px',
        borderRadius: 8,
        color: 'var(--text-2)',
        background: 'var(--pend-bg)',
        fontSize: 12.5,
        lineHeight: 1.5,
      }}
    >
      <div role="status">
        <strong>{notice.title}.</strong> {notice.message}
      </div>
      {(notice.detail || notice.remedy) && (
        <details style={{ marginTop: 6 }}>
          <summary style={{ cursor: 'pointer', color: 'var(--text)' }}>Details and remedies</summary>
          {notice.detail && <p>{notice.detail}</p>}
          {notice.remedy && <p>{notice.remedy}</p>}
        </details>
      )}
      {notice.observedAt && (
        <div aria-live="off" style={{ fontSize: 11, marginTop: 6 }}>
          Measured <time dateTime={notice.observedAt}>{new Date(notice.observedAt).toLocaleString()}</time>
        </div>
      )}
      {notice.fixLinks?.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, marginTop: 6 }}>
          {notice.fixLinks.map((link) => (
            <Link key={link.url} to={link.url} style={{ color: 'var(--text)', textDecoration: 'underline' }}>
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

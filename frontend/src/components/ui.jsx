// Small shared presentational components used across screens.
import { Link } from 'react-router-dom';
import { statusMeta } from '../lib/format.js';

export function Spinner({ label = 'Loading…' }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '40px 0',
        color: 'var(--text-3)',
        fontSize: 13,
      }}
    >
      <span
        style={{
          width: 16,
          height: 16,
          borderRadius: '50%',
          border: '2px solid var(--border)',
          borderTopColor: 'var(--accent)',
          display: 'inline-block',
          animation: 'okspin .7s linear infinite',
        }}
      />
      {label}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div
      style={{
        border: '1px solid var(--fail-bg)',
        background: 'var(--fail-bg)',
        borderRadius: 10,
        padding: '16px 18px',
        color: 'var(--fail)',
        fontSize: 13,
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>Something went wrong</div>
      <div style={{ color: 'var(--text-2)' }}>{error?.message || 'Failed to load.'}</div>
      {onRetry && (
        <span
          onClick={onRetry}
          style={{ display: 'inline-block', marginTop: 10, color: 'var(--accent)', cursor: 'pointer', fontSize: 12.5 }}
        >
          Try again →
        </span>
      )}
    </div>
  );
}

export function EmptyState({ title, sub, action }) {
  return (
    <div
      style={{
        border: '1px dashed var(--border)',
        borderRadius: 12,
        padding: '44px 24px',
        textAlign: 'center',
        background: 'var(--surface)',
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 600 }}>{title}</div>
      {sub && (
        <div style={{ fontSize: 13, color: 'var(--text-2)', marginTop: 6, maxWidth: 420, marginInline: 'auto' }}>
          {sub}
        </div>
      )}
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

export function StatusBadge({ status, reasoning, size = 'md' }) {
  const m = statusMeta(status, reasoning);
  const pad = size === 'sm' ? '3px 9px' : '4px 10px';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 11.5,
        color: m.color,
        background: m.bg,
        padding: pad,
        borderRadius: 20,
        whiteSpace: 'nowrap',
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: m.color, animation: m.pulse }} />
      {m.label}
    </span>
  );
}

export function Toggle({ on, onClick, label }) {
  return (
    <span
      onClick={onClick}
      className="mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        fontSize: 11,
        color: 'var(--text-2)',
        cursor: 'pointer',
        userSelect: 'none',
      }}
    >
      {label}
      <span
        style={{
          width: 30,
          height: 17,
          borderRadius: 10,
          background: on ? 'var(--accent)' : 'var(--border)',
          position: 'relative',
          display: 'inline-block',
          transition: 'background .15s',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 2,
            left: on ? 15 : 2,
            width: 13,
            height: 13,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left .15s',
          }}
        />
      </span>
    </span>
  );
}

export function SectionLabel({ children, style }) {
  return (
    <div className="mono" style={{ fontSize: 10, letterSpacing: '0.07em', color: 'var(--text-3)', ...style }}>
      {children}
    </div>
  );
}

// A button that follows the accent / muted styling used in the mockup.
export function Button({ children, onClick, variant = 'primary', disabled, style, type = 'button', to, ...props }) {
  const base = {
    height: 36,
    padding: '0 18px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 7,
    borderRadius: 8,
    fontSize: 13.5,
    fontWeight: 500,
    cursor: disabled ? 'default' : 'pointer',
    border: '1px solid transparent',
    whiteSpace: 'nowrap',
    font: 'inherit',
  };
  const variants = {
    primary: {
      background: disabled ? 'var(--surface-2)' : 'var(--accent)',
      color: disabled ? 'var(--text-3)' : 'var(--accent-fg)',
    },
    ghost: { background: 'var(--surface)', color: 'var(--text-2)', borderColor: 'var(--border)' },
    subtle: { background: 'var(--surface-2)', color: 'var(--text)', borderColor: 'var(--border)' },
    danger: { background: 'var(--fail-bg)', color: 'var(--fail)', borderColor: 'var(--fail-bg)' },
  };
  const combinedStyle = { ...base, ...variants[variant], textDecoration: 'none', ...style };
  if (to && !disabled) {
    return (
      <Link to={to} onClick={onClick} style={combinedStyle} {...props}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} disabled={disabled} onClick={onClick} style={combinedStyle} {...props}>
      {children}
    </button>
  );
}

// Makes an entire card/row a native link while allowing sibling controls to
// sit above it with position: relative and z-index: 2.
export function CardLinkOverlay({ to, label, style }) {
  return (
    <Link
      to={to}
      aria-label={label}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 1,
        borderRadius: 'inherit',
        color: 'inherit',
        textDecoration: 'none',
        ...style,
      }}
    />
  );
}

// A key chip — colored by whether the reference resolves.
export function KeyChip({ name, ok = true, from }) {
  return (
    <span
      className="mono"
      style={{
        fontSize: 11,
        padding: '3px 9px',
        borderRadius: 6,
        color: ok ? 'var(--ok)' : 'var(--fail)',
        background: ok ? 'var(--ok-bg)' : 'var(--fail-bg)',
        border: `1px solid ${ok ? 'var(--ok-bg)' : 'var(--fail-bg)'}`,
      }}
    >
      {ok ? '✓' : '✕'} {name}
      {from && <span style={{ color: 'var(--text-3)' }}> · {from}</span>}
    </span>
  );
}

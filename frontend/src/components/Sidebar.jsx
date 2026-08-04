import { Link, useLocation } from 'react-router-dom';
import { useTheme } from '../context/ui.jsx';
import Logo from './Logo.jsx';

function NavItem({ label, to, active }) {
  return (
    <Link
      className="sidebar-nav-item"
      to={to}
      style={{
        width: '100%',
        border: 'none',
        display: 'flex',
        alignItems: 'center',
        gap: 11,
        padding: '7px 9px',
        borderRadius: 7,
        fontSize: 13.5,
        cursor: 'pointer',
        background: active ? 'var(--accent-subtle)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-2)',
        fontWeight: active ? 500 : 400,
        fontFamily: 'inherit',
        textAlign: 'left',
        textDecoration: 'none',
      }}
    >
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: 2,
          flex: 'none',
          background: active ? 'var(--accent)' : 'var(--text-3)',
        }}
      />
      {label}
    </Link>
  );
}

const GROUP_LABEL = { fontSize: 10, letterSpacing: '0.09em', color: 'var(--text-3)' };

export const COMMUNITY_LINKS = [
  { label: 'GitHub', href: 'https://github.com/Kritt-ai/open-kritt' },
  { label: 'X / Twitter', href: 'https://x.com/Kritt_AI' },
  { label: 'Website', href: 'https://kritt.ai/' },
  { label: 'Discord', href: 'https://discord.gg/JJr2CbBjc' },
  { label: 'Contact us', href: 'mailto:info@kritt.ai', external: false },
];

export function CommunityLinks() {
  return (
    <nav className="sidebar-community-links" aria-label="Project and community links">
      {COMMUNITY_LINKS.map(({ label, href, external = true }) => (
        <a
          className="sidebar-community-link"
          href={href}
          key={href}
          {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
        >
          <span>{label}</span>
          {external && (
            <span className="sidebar-community-external" aria-hidden="true">
              ↗
            </span>
          )}
        </a>
      ))}
    </nav>
  );
}

export function CommunityShareButton({ onClick }) {
  return (
    <button type="button" className="sidebar-community-share" onClick={onClick}>
      <span className="sidebar-community-share-long">Give back to the community by sharing</span>
      <span className="sidebar-community-share-short">Share open·kritt</span>
      <span aria-hidden="true">↗</span>
    </button>
  );
}

export default function Sidebar({ onShareCommunity }) {
  const { pathname } = useLocation();
  const { theme, toggle } = useTheme();

  const isActive = (base, exact = false) =>
    exact ? pathname === base : pathname === base || pathname.startsWith(base + '/');

  const lt = theme === 'light';
  const pill = (active) => ({
    fontSize: 10.5,
    padding: '3px 9px',
    borderRadius: 16,
    background: active ? 'var(--surface)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-3)',
    boxShadow: active ? 'var(--shadow)' : 'none',
  });

  return (
    <div
      className="app-sidebar"
      style={{
        width: 228,
        flex: 'none',
        background: 'var(--sidebar)',
        borderRight: '1px solid var(--border)',
        display: 'flex',
        flexDirection: 'column',
        padding: '16px 12px',
      }}
    >
      <Link
        className="sidebar-brand"
        to="/"
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '6px 8px 16px',
          border: 'none',
          background: 'transparent',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          textDecoration: 'none',
        }}
      >
        <Logo className="sidebar-logo" size={52} color="var(--accent)" />
        <span
          className="sidebar-brand-name"
          style={{ fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--text)', fontSize: 22 }}
        >
          open<span style={{ color: 'var(--accent)' }}>·</span>kritt
        </span>
      </Link>

      <div className="mono sidebar-group-label" style={{ ...GROUP_LABEL, padding: '10px 8px 6px' }}>
        OPERATE
      </div>
      <div className="sidebar-nav-group" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <NavItem label="Overview" to="/" active={isActive('/', true)} />
        <NavItem label="Workflows" to="/workflows" active={isActive('/workflows')} />
        <NavItem label="Scans" to="/scans" active={isActive('/scans')} />
      </div>

      <div className="mono sidebar-group-label" style={{ ...GROUP_LABEL, padding: '16px 8px 6px' }}>
        CONFIGURE
      </div>
      <div className="sidebar-nav-group" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <NavItem label="Agent skills" to="/agent-skills" active={isActive('/agent-skills')} />
        <NavItem label="Severity rankers" to="/severity-rankers" active={isActive('/severity-rankers')} />
        <NavItem label="Post-scripts" to="/post-scripts" active={isActive('/post-scripts')} />
      </div>

      <div className="mono sidebar-group-label" style={{ ...GROUP_LABEL, padding: '16px 8px 6px' }}>
        SETTINGS
      </div>
      <div className="sidebar-nav-group" style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
        <NavItem label="Accounts" to="/accounts" active={isActive('/accounts')} />
        <NavItem label="Settings" to="/settings" active={isActive('/settings')} />
      </div>

      <div className="sidebar-community">
        <div className="mono sidebar-community-label" style={GROUP_LABEL}>
          COMMUNITY
        </div>
        <CommunityShareButton onClick={onShareCommunity} />
        <CommunityLinks />
      </div>

      <div className="sidebar-footer" style={{ paddingTop: 12, borderTop: '1px solid var(--border)' }}>
        <button
          className="sidebar-theme-toggle"
          type="button"
          onClick={toggle}
          style={{
            width: '100%',
            border: 'none',
            background: 'transparent',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: 8,
            cursor: 'pointer',
            borderRadius: 7,
            fontFamily: 'inherit',
          }}
        >
          <span style={{ fontSize: 12.5, color: 'var(--text-2)' }}>Theme</span>
          <div
            className="mono"
            style={{ display: 'flex', background: 'var(--surface-2)', borderRadius: 20, padding: 2 }}
          >
            <span style={pill(lt)}>LGT</span>
            <span style={pill(!lt)}>DRK</span>
          </div>
        </button>
        <div
          className="mono sidebar-engine-status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '6px 8px',
            fontSize: 11,
            color: 'var(--text-3)',
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--ok)' }} /> engine online · v
          {__APP_VERSION__}
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import Sidebar from './Sidebar.jsx';
import Topbar from './Topbar.jsx';
import ShareResultDialog from './ShareResultDialog.jsx';
import { useTheme } from '../context/ui.jsx';

export default function Layout() {
  const { theme } = useTheme();
  const [communityShareOpen, setCommunityShareOpen] = useState(false);
  return (
    <div
      className="app-shell"
      data-theme={theme}
      style={{
        display: 'flex',
        height: '100vh',
        width: '100%',
        overflow: 'hidden',
        background: 'var(--bg)',
        color: 'var(--text)',
        fontFamily: "'Geist', sans-serif",
        fontSize: 14,
      }}
    >
      <Sidebar onShareCommunity={() => setCommunityShareOpen(true)} />
      {communityShareOpen && <ShareResultDialog mode="community" onClose={() => setCommunityShareOpen(false)} />}
      <div className="app-main" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <Topbar />
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', position: 'relative' }}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}

// A right-side sliding drawer rendered absolutely within a positioned parent.
export default function Drawer({ open, onClose, width = 560, children }) {
  if (!open) return null;
  return (
    <>
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.12)', zIndex: 9 }} />
      <div
        style={{
          position: 'absolute',
          top: 0,
          right: 0,
          height: '100%',
          width,
          maxWidth: '94%',
          zIndex: 10,
          borderLeft: '1px solid var(--border)',
          background: 'var(--surface)',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          boxShadow: '-10px 0 30px rgba(0,0,0,.14)',
          animation: 'okslide .18s ease',
        }}
      >
        {children}
      </div>
    </>
  );
}

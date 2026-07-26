import { useRef, useState, useImperativeHandle, useEffect, forwardRef } from 'react';
import { refResolves } from '../lib/keys.js';
import { getCaretCoordinates } from '../lib/caret.js';

// Render content with {{key}} tokens colored by whether they resolve against
// `available` (a Set or Map of allowed key names). When allowExtra is true,
// {{extra.<key>}} references resolve too.
export function renderHighlighted(content, available, allowExtra = false) {
  const parts = [];
  const re = /(\{\{\s*[a-zA-Z0-9_.]+\s*\}\})/g;
  let last = 0;
  let m;
  let i = 0;
  while ((m = re.exec(content))) {
    if (m.index > last) parts.push(<span key={`t${i++}`}>{content.slice(last, m.index)}</span>);
    const raw = m[0];
    const key = raw.replace(/\{\{\s*|\s*\}\}/g, '');
    const ok = refResolves(key, available, allowExtra);
    parts.push(
      <span
        key={`k${i++}`}
        style={{
          color: ok ? 'var(--ok)' : 'var(--fail)',
          background: ok ? 'var(--ok-bg)' : 'var(--fail-bg)',
          borderRadius: 3,
          textDecoration: ok ? 'none' : 'underline wavy',
        }}
      >
        {raw}
      </span>
    );
    last = m.index + raw.length;
  }
  if (last < content.length) parts.push(<span key={`t${i++}`}>{content.slice(last)}</span>);
  return parts;
}

// Read-only highlighted prompt (used in the detail drawer).
export function PromptHighlight({ content, available, allowExtra = false, style }) {
  return (
    <div
      className="mono"
      style={{
        border: '1px solid var(--border)',
        borderRadius: 9,
        background: 'var(--code-bg)',
        padding: 14,
        fontSize: 12.5,
        lineHeight: 1.7,
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        color: 'var(--text)',
        ...style,
      }}
    >
      {renderHighlighted(content || '', available, allowExtra)}
    </div>
  );
}

const POPUP_W = 268;
const POPUP_H = 232;
const closedAc = { open: false, items: [], index: 0, top: 0, left: 0 };

// Editable prompt with a syntax-highlight backdrop layered under a transparent
// textarea, an IDE-style {{…}} autocomplete, and an optional full-screen dialog.
// Exposes an imperative `insert(token)` that wraps the token in {{ }} at the caret.
export const PromptEditor = forwardRef(function PromptEditor(
  {
    value,
    onChange,
    available,
    allowExtra = false,
    height = 188,
    expandable = false,
    paletteChips = null,
    title = 'Prompt content',
  },
  ref
) {
  const taRef = useRef(null);
  const backRef = useRef(null);
  const modalTaRef = useRef(null);
  const modalBackRef = useRef(null);
  const pendingCaret = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [ac, setAc] = useState(closedAc); // autocomplete popup state

  const activeTa = () => (expanded ? modalTaRef.current : taRef.current);
  const closeAC = () => setAc((a) => (a.open ? closedAc : a));

  // Restore caret after a programmatic change (insert / edit / accept).
  useEffect(() => {
    if (pendingCaret.current != null) {
      const ta = activeTa();
      if (ta) {
        const pos = Math.min(pendingCaret.current, ta.value.length);
        try {
          ta.focus();
          ta.setSelectionRange(pos, pos);
        } catch {
          /* noop */
        }
      }
      pendingCaret.current = null;
    }
  });

  // Focus the big editor when it opens; close on Escape; reset autocomplete.
  useEffect(() => {
    closeAC();
    if (!expanded) return undefined;
    modalTaRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  // ---- token insertion ----
  const doInsert = (token) => {
    const ta = activeTa();
    const ins = `{{${token}}}`;
    const pos = ta ? ta.selectionStart : value.length;
    const next = value.slice(0, pos) + ins + value.slice(pos);
    pendingCaret.current = pos + ins.length;
    onChange({ target: { value: next } });
  };
  useImperativeHandle(ref, () => ({ insert: doInsert }));

  // ---- autocomplete ----
  const suggestionsFor = (query) => {
    let base = [];
    if (available instanceof Map)
      base = [...available.entries()].map(([name, from]) => ({ token: name, label: name, hint: String(from) }));
    else if (available && typeof available.forEach === 'function')
      base = [...available].map((name) => ({ token: name, label: name, hint: 'reserved' }));
    if (allowExtra) base.push({ token: 'extra.', label: 'extra.<key>', hint: 'dynamic', partial: true });
    const q = query.toLowerCase();
    return base
      .filter((k) => k.token.toLowerCase().includes(q))
      .sort((a, b) => {
        const ap = a.token.toLowerCase().startsWith(q) ? 0 : 1;
        const bp = b.token.toLowerCase().startsWith(q) ? 0 : 1;
        return ap - bp || a.token.localeCompare(b.token);
      })
      .slice(0, 8);
  };

  const refreshAC = (ta) => {
    if (!ta) return;
    const pos = ta.selectionStart;
    if (pos !== ta.selectionEnd) return closeAC();
    const before = ta.value.slice(0, pos);
    const openIdx = before.lastIndexOf('{{');
    if (openIdx === -1) return closeAC();
    const query = before.slice(openIdx + 2);
    if (!/^[a-zA-Z0-9_.]*$/.test(query)) return closeAC(); // closed token / stray text
    const items = suggestionsFor(query);
    if (!items.length) return closeAC();

    const coords = getCaretCoordinates(ta, openIdx);
    const rect = ta.getBoundingClientRect();
    let left = rect.left + coords.left - ta.scrollLeft;
    let top = rect.top + coords.top - ta.scrollTop + coords.lineHeight + 4;
    if (left + POPUP_W > window.innerWidth - 8) left = window.innerWidth - POPUP_W - 8;
    if (left < 8) left = 8;
    if (top + POPUP_H > window.innerHeight - 8) top = rect.top + coords.top - ta.scrollTop - POPUP_H - 6;
    if (top < 8) top = 8;
    return setAc({ open: true, items, index: 0, top, left });
  };

  const acceptSuggestion = (item, ta) => {
    if (!item || !ta) return;
    const pos = ta.selectionStart;
    const openIdx = value.slice(0, pos).lastIndexOf('{{');
    if (openIdx === -1) return closeAC();
    const insert = item.token + (item.partial ? '' : '}}');
    const next = value.slice(0, openIdx + 2) + insert + value.slice(pos);
    pendingCaret.current = openIdx + 2 + insert.length;
    closeAC();
    onChange({ target: { value: next } });
  };

  const handleChange = (e) => {
    pendingCaret.current = e.target.selectionStart;
    onChange(e);
    refreshAC(e.target);
  };

  const onEditorKeyDown = (e) => {
    if (!ac.open) return;
    const n = ac.items.length;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setAc((a) => ({ ...a, index: (a.index + 1) % n }));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setAc((a) => ({ ...a, index: (a.index - 1 + n) % n }));
    } else if (e.key === 'Tab' || e.key === 'Enter') {
      e.preventDefault();
      acceptSuggestion(ac.items[ac.index], e.target);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // don't also close the fullscreen dialog
      closeAC();
    }
  };

  const makeScroll = (backR) => (e) => {
    if (backR.current) {
      backR.current.scrollTop = e.target.scrollTop;
      backR.current.scrollLeft = e.target.scrollLeft;
    }
    if (ac.open) refreshAC(e.target);
  };

  const shared = {
    position: 'absolute',
    inset: 0,
    margin: 0,
    padding: 13,
    fontFamily: "'Geist Mono', ui-monospace, monospace",
    fontSize: 12.5,
    lineHeight: 1.7,
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    overflow: 'auto',
  };

  // The backdrop + transparent textarea pair, reused inline and in the dialog.
  const surface = (taR, backR, h) => (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: h,
        border: '1px solid var(--border)',
        borderRadius: 9,
        overflow: 'hidden',
        background: 'var(--code-bg)',
      }}
    >
      <div ref={backR} aria-hidden style={{ ...shared, color: 'var(--text)', pointerEvents: 'none' }}>
        {renderHighlighted(value || ' ', available, allowExtra)}
      </div>
      <textarea
        ref={taR}
        value={value}
        onChange={handleChange}
        onScroll={makeScroll(backR)}
        onKeyDown={onEditorKeyDown}
        onSelect={(e) => refreshAC(e.target)}
        onBlur={() => setTimeout(closeAC, 120)}
        spellCheck={false}
        style={{
          ...shared,
          border: 'none',
          outline: 'none',
          resize: 'none',
          background: 'transparent',
          color: 'transparent',
          caretColor: 'var(--accent)',
        }}
      />
    </div>
  );

  return (
    <>
      <div style={{ position: 'relative' }}>
        {surface(taRef, backRef, height)}
        {expandable && (
          <button
            type="button"
            onClick={() => setExpanded(true)}
            title="Expand editor (full screen)"
            className="mono"
            style={{
              position: 'absolute',
              right: 8,
              bottom: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              height: 24,
              padding: '0 9px',
              fontSize: 10.5,
              color: 'var(--text-2)',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              cursor: 'pointer',
              boxShadow: 'var(--shadow)',
            }}
          >
            ⤢ expand
          </button>
        )}
      </div>

      {expanded && (
        <div
          onClick={() => setExpanded(false)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            background: 'rgba(0,0,0,.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '4vh 4vw',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%',
              maxWidth: 1100,
              height: '92vh',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              overflow: 'hidden',
              boxShadow: '0 20px 60px rgba(0,0,0,.4)',
              animation: 'okslide .14s ease',
            }}
          >
            <div
              style={{
                height: 50,
                flex: 'none',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 18px',
              }}
            >
              <span className="mono" style={{ fontSize: 11, letterSpacing: '0.07em', color: 'var(--text-3)' }}>
                {title.toUpperCase()}
              </span>
              <span
                onClick={() => setExpanded(false)}
                title="Close (Esc)"
                style={{ cursor: 'pointer', color: 'var(--text-3)', fontSize: 20, lineHeight: 1 }}
              >
                ×
              </span>
            </div>
            <div style={{ flex: 1, minHeight: 0, padding: 18 }}>{surface(modalTaRef, modalBackRef, '100%')}</div>
            {paletteChips && paletteChips.length > 0 && (
              <div
                style={{
                  flex: 'none',
                  borderTop: '1px solid var(--border)',
                  padding: '12px 18px',
                  maxHeight: '26vh',
                  overflowY: 'auto',
                }}
              >
                <div
                  className="mono"
                  style={{ fontSize: 10, letterSpacing: '0.07em', color: 'var(--text-3)', marginBottom: 8 }}
                >
                  AVAILABLE KEYS · click to insert
                </div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                  {paletteChips.map((c, i) => (
                    <span
                      key={i}
                      onClick={() => doInsert(c.token)}
                      className="mono"
                      style={{
                        fontSize: 10.5,
                        padding: '3px 8px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        color: c.accent ? 'var(--accent)' : 'var(--text-2)',
                        background: c.accent ? 'var(--accent-subtle)' : 'var(--surface-2)',
                        border: '1px solid var(--border-2)',
                      }}
                    >
                      {c.label}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* {{…}} autocomplete popup — fixed to the caret position */}
      {ac.open && (
        <div
          style={{
            position: 'fixed',
            top: ac.top,
            left: ac.left,
            zIndex: 70,
            width: POPUP_W,
            maxHeight: POPUP_H,
            overflowY: 'auto',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            boxShadow: '0 12px 30px rgba(0,0,0,.22)',
            padding: 4,
          }}
        >
          {ac.items.map((it, i) => (
            <div
              key={`${it.token}-${i}`}
              onMouseDown={(e) => {
                e.preventDefault(); // keep textarea focus
                acceptSuggestion(it, activeTa());
              }}
              onMouseEnter={() => setAc((a) => ({ ...a, index: i }))}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                padding: '5px 9px',
                borderRadius: 6,
                cursor: 'pointer',
                background: i === ac.index ? 'var(--accent-subtle)' : 'transparent',
              }}
            >
              <span className="mono" style={{ fontSize: 12, color: i === ac.index ? 'var(--accent)' : 'var(--text)' }}>
                {it.label}
              </span>
              <span className="mono" style={{ fontSize: 10, color: 'var(--text-3)' }}>
                {it.hint}
              </span>
            </div>
          ))}
          <div
            className="mono"
            style={{
              fontSize: 9.5,
              color: 'var(--text-3)',
              padding: '5px 9px 2px',
              borderTop: '1px solid var(--border-2)',
              marginTop: 2,
              display: 'flex',
              gap: 10,
            }}
          >
            <span>↑↓ navigate</span>
            <span>⇥ insert</span>
            <span>esc close</span>
          </div>
        </div>
      )}
    </>
  );
});

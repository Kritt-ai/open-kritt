import { useState, useEffect } from 'react';
import { FIELD_TYPES, rowsToObject, objectToRows } from '../lib/keys.js';

// Editable output-format schema with a visual (key/type rows) and a raw-JSON mode.
// `validateKey(key)` should return a message string for reserved-key violations,
// or null/undefined when the key is acceptable. Empty + duplicate checks are built in.
export default function SchemaEditor({
  rows,
  onRowsChange,
  mode,
  onToggleMode,
  validateKey = () => null,
  inputBg = 'var(--bg)',
  types = FIELD_TYPES,
}) {
  const [rawText, setRawText] = useState(null);
  const [rawErr, setRawErr] = useState(false);

  useEffect(() => {
    if (mode === 'raw' && rawText == null) {
      setRawText(JSON.stringify(rowsToObject(rows.filter((r) => r.key)), null, 2));
    }
    if (mode === 'visual') {
      setRawText(null);
      setRawErr(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const keyCount = {};
  rows.forEach((r) => {
    if (r.key) keyCount[r.key] = (keyCount[r.key] || 0) + 1;
  });

  const rowError = (row) => {
    if (!row.key) return 'name required';
    if (keyCount[row.key] > 1) return 'key already used in another step';
    return validateKey(row.key);
  };

  const setRow = (idx, patch) => {
    const next = rows.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    onRowsChange(next);
  };
  const removeRow = (idx) => onRowsChange(rows.filter((_, i) => i !== idx));
  const addRow = () => onRowsChange([...rows, { key: '', type: 'string' }]);

  const onRaw = (e) => {
    const text = e.target.value;
    setRawText(text);
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      onRowsChange(objectToRows(parsed));
      setRawErr(false);
    } else {
      setRawErr(true);
    }
  };

  const tab = (active) => ({
    fontSize: 10.5,
    padding: '3px 10px',
    borderRadius: 5,
    background: active ? 'var(--surface)' : 'transparent',
    color: active ? 'var(--text)' : 'var(--text-3)',
    cursor: 'pointer',
  });

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <div className="mono" style={{ display: 'flex', background: 'var(--surface-2)', borderRadius: 7, padding: 2 }}>
          <span style={tab(mode === 'visual')} onClick={mode !== 'visual' ? onToggleMode : undefined}>
            visual
          </span>
          <span style={tab(mode === 'raw')} onClick={mode !== 'raw' ? onToggleMode : undefined}>
            json
          </span>
        </div>
      </div>

      {mode === 'visual' ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {rows.map((row, idx) => {
            const err = rowError(row);
            return (
              <div key={idx}>
                <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                  <input
                    value={row.key}
                    onChange={(e) => setRow(idx, { key: e.target.value.replace(/[^a-zA-Z0-9_]/g, '_') })}
                    spellCheck={false}
                    placeholder="key_name"
                    className="mono"
                    style={{
                      flex: 1,
                      minWidth: 0,
                      height: 34,
                      padding: '0 11px',
                      border: `1px solid ${err ? 'var(--fail)' : 'var(--border)'}`,
                      borderRadius: 7,
                      background: inputBg,
                      color: 'var(--accent)',
                      fontSize: 12.5,
                      outline: 'none',
                    }}
                  />
                  <select
                    value={row.type}
                    onChange={(e) => setRow(idx, { type: e.target.value })}
                    className="mono"
                    style={{
                      width: 104,
                      flex: 'none',
                      height: 34,
                      padding: '0 8px',
                      border: '1px solid var(--border)',
                      borderRadius: 7,
                      background: inputBg,
                      color: 'var(--text-2)',
                      fontSize: 12,
                      outline: 'none',
                    }}
                  >
                    {types.map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                  <span
                    onClick={() => removeRow(idx)}
                    style={{
                      color: 'var(--text-3)',
                      fontSize: 16,
                      cursor: 'pointer',
                      flex: 'none',
                      width: 16,
                      textAlign: 'center',
                    }}
                  >
                    ×
                  </span>
                </div>
                {err && (
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--fail)', margin: '4px 0 0 2px' }}>
                    {err}
                  </div>
                )}
              </div>
            );
          })}
          <div
            onClick={addRow}
            className="mono"
            style={{
              height: 34,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: '1px dashed var(--border)',
              borderRadius: 7,
              fontSize: 11.5,
              color: 'var(--text-2)',
              cursor: 'pointer',
            }}
          >
            + add field
          </div>
        </div>
      ) : (
        <>
          <textarea
            value={rawText ?? ''}
            onChange={onRaw}
            spellCheck={false}
            className="mono"
            style={{
              width: '100%',
              height: 180,
              padding: 12,
              border: `1px solid ${rawErr ? 'var(--fail)' : 'var(--border)'}`,
              borderRadius: 8,
              background: 'var(--code-bg)',
              color: 'var(--text)',
              fontSize: 12,
              lineHeight: 1.6,
              outline: 'none',
              resize: 'vertical',
            }}
          />
          {rawErr && (
            <div className="mono" style={{ fontSize: 11, color: 'var(--fail)', marginTop: 6 }}>
              Invalid JSON object — keep editing to fix.
            </div>
          )}
        </>
      )}
    </div>
  );
}

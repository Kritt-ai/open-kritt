import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../api/client.js';
import { usePageChrome } from '../context/ui.jsx';
import { ErrorState, Spinner } from '../components/ui.jsx';
import Markdown from '../components/Markdown.jsx';
import { rankerDescOf } from '../lib/severityRanker.js';
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt.js';

const STARTER = '# Ranking rules\n\n1. ';

function newSeverityRankerForm() {
  return { name: 'new-severity-ranker', content: STARTER };
}

export default function SeverityRankerEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(!id);
  const [form, setForm] = useState(() => (id ? { name: '', content: '' } : newSeverityRankerForm()));
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const initialRef = useRef(id ? null : JSON.stringify(newSeverityRankerForm()));

  usePageChrome(
    [
      { label: 'Severity rankers', to: '/severity-rankers' },
      { label: id ? form.name || '…' : 'New severity ranker', active: true },
    ],
    null,
    [id, form.name]
  );

  useEffect(() => {
    let active = true;
    initialRef.current = null;
    setLoadError(null);
    setServerErrors([]);
    setSaving(false);
    if (!id) {
      const next = newSeverityRankerForm();
      initialRef.current = JSON.stringify(next);
      setForm(next);
      setLoaded(true);
      return () => {
        active = false;
      };
    }
    setLoaded(false);
    api
      .severityRanker(id)
      .then((r) => {
        if (!active) return;
        const next = { name: r.name || '', content: r.content || '' };
        initialRef.current = JSON.stringify(next);
        setForm(next);
        setLoaded(true);
      })
      .catch((error) => {
        if (active) setLoadError(error);
      });
    return () => {
      active = false;
    };
  }, [id]);

  const snapshot = JSON.stringify(form);
  const dirty = loaded && initialRef.current !== null && snapshot !== initialRef.current;
  const { allow } = useUnsavedChangesPrompt(dirty || saving);

  if (loadError)
    return (
      <div style={{ padding: 26 }}>
        <ErrorState error={loadError} onRetry={() => window.location.reload()} />
      </div>
    );

  if (!loaded)
    return (
      <div style={{ padding: 26 }}>
        <Spinner />
      </div>
    );

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const errs = [];
  if (!form.name.trim()) errs.push('Name the severity ranker');
  if (!form.content.trim()) errs.push('Add at least one rule');
  const canSave = errs.length === 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setServerErrors([]);
    const body = { name: form.name.trim(), content: form.content, description: rankerDescOf(form.content) };
    try {
      if (id) await api.updateSeverityRanker(id, body);
      else await api.createSeverityRanker(body);
      allow();
      navigate('/severity-rankers');
    } catch (e) {
      if (e instanceof ApiError) setServerErrors(e.errors?.map((x) => `${x.field}: ${x.message}`) || [e.message]);
      else setServerErrors([e.message]);
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '26px 32px' }}>
        <div style={{ maxWidth: 980, margin: '0 auto' }}>
          <input
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
            spellCheck={false}
            placeholder="severity-ranker-name"
            className="mono"
            style={{
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 22,
              fontWeight: 600,
              color: 'var(--text)',
              letterSpacing: '-0.01em',
              width: '100%',
              padding: 0,
            }}
          />
          <div style={{ fontSize: 13.5, color: 'var(--text-2)', margin: '6px 0 24px' }}>
            A set of markdown rules the model applies when ranking each finding&rsquo;s severity. Write them as numbered
            or bulleted instructions.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24, alignItems: 'start' }}>
            <div>
              <Label>
                RULES <span style={{ textTransform: 'none', letterSpacing: 0 }}>· markdown</span>
              </Label>
              <textarea
                value={form.content}
                onChange={(e) => set({ content: e.target.value })}
                spellCheck={false}
                placeholder="1. If the finding requires non-trivial privileges, downgrade by 1 rank."
                className="mono"
                style={{
                  width: '100%',
                  height: 440,
                  padding: 14,
                  border: '1px solid var(--border)',
                  borderRadius: 9,
                  background: 'var(--code-bg)',
                  color: 'var(--text)',
                  fontSize: 12.5,
                  lineHeight: 1.7,
                  outline: 'none',
                  resize: 'vertical',
                }}
              />
            </div>
            <div>
              <Label>PREVIEW</Label>
              <div
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 9,
                  background: 'var(--surface)',
                  padding: '18px 20px',
                  minHeight: 440,
                }}
              >
                {form.content.trim() ? (
                  <Markdown source={form.content} />
                ) : (
                  <div style={{ color: 'var(--text-3)', fontSize: 13 }}>Start typing rules to preview them.</div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          flex: 'none',
          borderTop: '1px solid var(--border)',
          background: 'var(--bg)',
          padding: '13px 32px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-2)' }}>
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: errs.length || serverErrors.length ? 'var(--fail)' : 'var(--ok)',
            }}
          />
          {serverErrors[0] || errs[0] || 'Severity ranker is valid.'}
        </span>
        <div
          onClick={save}
          style={{
            height: 36,
            padding: '0 20px',
            display: 'flex',
            alignItems: 'center',
            borderRadius: 9,
            fontSize: 13.5,
            fontWeight: 500,
            cursor: canSave ? 'pointer' : 'default',
            background: canSave ? 'var(--accent)' : 'var(--surface-2)',
            color: canSave ? 'var(--accent-fg)' : 'var(--text-3)',
          }}
        >
          {saving
            ? 'Saving…'
            : errs.length
              ? `${errs.length} issue${errs.length > 1 ? 's' : ''} to fix`
              : id
                ? 'Save changes'
                : 'Create severity ranker'}
        </div>
      </div>
    </div>
  );
}

function Label({ children }) {
  return (
    <div className="mono" style={{ fontSize: 10, letterSpacing: '0.07em', color: 'var(--text-3)', marginBottom: 8 }}>
      {children}
    </div>
  );
}

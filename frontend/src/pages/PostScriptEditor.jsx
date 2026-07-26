import { useState, useRef, useEffect } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, apiErrorMessages } from '../api/client.js';
import { usePageChrome } from '../context/ui.jsx';
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt.js';
import { ErrorState, Spinner } from '../components/ui.jsx';
import { PromptEditor } from '../components/PromptEditor.jsx';
import SchemaEditor from '../components/SchemaEditor.jsx';
import { postScriptDraftFromGeneration, resultFromCompletedGeneration } from '../lib/generationDraft.js';
import {
  BUILTIN_KEYS,
  EXTRA_KEY,
  FIELD_TYPES,
  OPTIONAL_VULN_KEYS,
  POST_SCRIPT_CHIP_PREFIX,
  POST_SCRIPT_MARKDOWN_OUTPUT_KEYS,
  REQUIRED_VULN_KEYS,
  RESERVED_POST_SCRIPT_KEYS,
  isExtraRef,
  isValidKey,
  parseTemplateRefs,
  rowsToObject,
  objectToRows,
} from '../lib/keys.js';

const AVAILABLE = new Set(RESERVED_POST_SCRIPT_KEYS);
const NEW_POST_SCRIPT_CONTENT = 'Grade the finding "{{summary}}" — a {{vulnerability_type}} at {{file_path}}:{{line}}.';

function newPostScriptState() {
  return {
    name: 'new-post-script',
    description: '',
    content: NEW_POST_SCRIPT_CONTENT,
    rows: [{ key: 'severity', type: 'string' }],
  };
}

function postScriptSnapshot({ name, description, content, rows }) {
  return JSON.stringify({ name, description, content, rows });
}

export default function PostScriptEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const generationId = id ? null : params.get('generation');
  const editorRef = useRef(null);

  const [loaded, setLoaded] = useState(!id && !generationId);
  const [loadError, setLoadError] = useState(null);
  const [name, setName] = useState(id ? '' : 'new-post-script');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState(id ? '' : NEW_POST_SCRIPT_CONTENT);
  const [rows, setRows] = useState(id ? [] : [{ key: 'severity', type: 'string' }]);
  const [mode, setMode] = useState('visual');
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState([]);
  const initialRef = useRef(!id && !generationId ? postScriptSnapshot(newPostScriptState()) : null);

  usePageChrome(
    [
      { label: 'Post-scripts', to: '/post-scripts' },
      { label: id ? name || '…' : 'New post-script', active: true },
    ],
    null,
    [id, name]
  );

  useEffect(() => {
    let active = true;
    initialRef.current = null;
    setLoadError(null);
    setServerErrors([]);
    setSaving(false);
    setMode('visual');
    setLoaded(false);
    if (generationId) {
      api
        .generation(generationId)
        .then((job) => {
          if (!active) return;
          const draft = postScriptDraftFromGeneration(resultFromCompletedGeneration(job, 'post_script'));
          setName(draft.name);
          setDescription(draft.description);
          setContent(draft.content);
          setRows(draft.rows);
          initialRef.current = postScriptSnapshot(draft);
          setLoaded(true);
        })
        .catch((error) => active && setLoadError(error));
      return () => {
        active = false;
      };
    }
    if (!id) {
      const next = newPostScriptState();
      setName(next.name);
      setDescription(next.description);
      setContent(next.content);
      setRows(next.rows);
      initialRef.current = postScriptSnapshot(next);
      setLoaded(true);
      return () => {
        active = false;
      };
    }
    api
      .postScript(id)
      .then((p) => {
        if (!active) return;
        const next = {
          name: p.name,
          description: p.description || '',
          content: p.content || '',
          rows: objectToRows(p.outputFormat),
        };
        setName(next.name);
        setDescription(next.description);
        setContent(next.content);
        setRows(next.rows);
        initialRef.current = postScriptSnapshot(next);
        setLoaded(true);
      })
      .catch((error) => active && setLoadError(error));
    return () => {
      active = false;
    };
  }, [generationId, id]);

  const snapshot = postScriptSnapshot({ name, description, content, rows });
  const dirty = loaded && (Boolean(generationId) || (initialRef.current !== null && snapshot !== initialRef.current));
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

  // ---- live validation ----
  const parsedRefs = parseTemplateRefs(content);
  const refs = [...new Set(parsedRefs.refs)];
  const malformedRefs = [...new Set(parsedRefs.malformed)];
  const refIsAvailable = (key) => AVAILABLE.has(key) || isExtraRef(key);
  const badRefs = refs.filter((key) => !refIsAvailable(key));
  const keyCount = {};
  rows.forEach((r) => r.key && (keyCount[r.key] = (keyCount[r.key] || 0) + 1));
  const schemaValid =
    rows.length > 0 &&
    rows.every(
      (r) =>
        r.key &&
        isValidKey(r.key) &&
        FIELD_TYPES.includes(r.type) &&
        !RESERVED_POST_SCRIPT_KEYS.includes(r.key) &&
        keyCount[r.key] === 1 &&
        r.key !== POST_SCRIPT_CHIP_PREFIX &&
        (!POST_SCRIPT_MARKDOWN_OUTPUT_KEYS.includes(r.key) || r.type === 'string')
    );

  const errs = [];
  if (!name.trim()) errs.push('Name the post-script');
  if (!content.trim()) errs.push('Content is required');
  if (!schemaValid) errs.push('Fix output schema');
  if (malformedRefs.length) errs.push(`${malformedRefs.length} malformed template reference`);
  if (badRefs.length) errs.push(`${badRefs.length} non-reserved key reference`);
  const canSave = errs.length === 0 && !saving;

  const validateKey = (key) => {
    if (!isValidKey(key)) return 'invalid key name';
    if (RESERVED_POST_SCRIPT_KEYS.includes(key)) return 'reserved key — those are inputs';
    if (key === POST_SCRIPT_CHIP_PREFIX) return 'add a label after _chip_';
    return null;
  };

  const insert = (token) => editorRef.current?.insert(token);

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setServerErrors([]);
    try {
      const body = {
        name: name.trim(),
        description,
        content,
        outputFormat: rowsToObject(rows.filter((r) => r.key)),
      };
      if (id) await api.updatePostScript(id, body);
      else await api.createPostScript(body);
      allow();
      navigate('/post-scripts');
    } catch (e) {
      if (e instanceof ApiError) setServerErrors(apiErrorMessages(e, { includeField: false }));
      else setServerErrors([e.message]);
      setSaving(false);
    }
  };

  return (
    <div
      className="post-script-editor"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <div className="post-script-editor-body" style={{ flex: 1, overflowY: 'auto', padding: '26px 32px' }}>
        <div className="post-script-editor-content" style={{ maxWidth: 880, margin: '0 auto' }}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            spellCheck={false}
            placeholder="post-script-name"
            className="mono"
            style={{
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 22,
              fontWeight: 600,
              color: 'var(--text)',
              letterSpacing: 0,
              width: '100%',
              padding: 0,
            }}
          />
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Describe what this post-script adds to a finding…"
            style={{
              border: 'none',
              outline: 'none',
              background: 'transparent',
              fontSize: 13.5,
              color: 'var(--text-2)',
              width: '100%',
              marginTop: 6,
              padding: 0,
            }}
          />
          <div style={{ fontSize: 13.5, color: 'var(--text-2)', margin: '6px 0 24px' }}>
            Runs once per finding. It may only reference the reserved context and finding keys below — no step outputs.
          </div>

          {generationId && (
            <div
              style={{
                margin: '-10px 0 22px',
                padding: '10px 12px',
                border: '1px solid var(--run-bg)',
                borderRadius: 8,
                background: 'var(--run-bg)',
                color: 'var(--run)',
                fontSize: 12.5,
                lineHeight: 1.5,
              }}
            >
              AI-generated draft. Review the prompt, referenced variables, and output schema before saving.
            </div>
          )}

          <div
            className="post-script-editor-grid"
            style={{ display: 'grid', gridTemplateColumns: '1.25fr 1fr', gap: 24, alignItems: 'start' }}
          >
            {/* left: prompt */}
            <div>
              <Label>CONTENT</Label>
              <PromptEditor
                ref={editorRef}
                value={content}
                onChange={(e) => setContent(e.target.value)}
                available={AVAILABLE}
                allowExtra
                height={240}
                expandable
                title="Post-script content"
                paletteChips={[
                  ...BUILTIN_KEYS.map((k) => ({ label: `${k} · context`, token: k })),
                  ...[...REQUIRED_VULN_KEYS, ...OPTIONAL_VULN_KEYS].map((k) => ({
                    label: `${k} · finding`,
                    token: k,
                    accent: true,
                  })),
                  { label: 'extra.<key> · scan input', token: 'extra.', accent: true },
                ]}
              />

              <div
                style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '14px 0 8px' }}
              >
                <Label inline>REFERENCED KEYS</Label>
                <span
                  className="mono"
                  style={{
                    fontSize: 10.5,
                    color:
                      malformedRefs.length || badRefs.length
                        ? 'var(--fail)'
                        : refs.length
                          ? 'var(--ok)'
                          : 'var(--text-3)',
                  }}
                >
                  {refs.length === 0 && malformedRefs.length === 0
                    ? 'no references yet'
                    : malformedRefs.length || badRefs.length
                      ? `${malformedRefs.length + badRefs.length} invalid reference${malformedRefs.length + badRefs.length > 1 ? 's' : ''}`
                      : `all ${refs.length} resolved`}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {refs.map((k) => {
                  const ok = refIsAvailable(k);
                  return (
                    <span
                      key={k}
                      className="mono"
                      style={{
                        fontSize: 11,
                        padding: '3px 9px',
                        borderRadius: 6,
                        color: ok ? 'var(--ok)' : 'var(--fail)',
                        background: ok ? 'var(--ok-bg)' : 'var(--fail-bg)',
                      }}
                    >
                      {ok ? '✓' : '✕'} {k}
                    </span>
                  );
                })}
                {malformedRefs.map((token, index) => (
                  <span
                    key={`${token}-${index}`}
                    className="mono"
                    style={{
                      fontSize: 11,
                      padding: '3px 9px',
                      borderRadius: 6,
                      color: 'var(--fail)',
                      background: 'var(--fail-bg)',
                    }}
                  >
                    ✕ {token}
                  </span>
                ))}
              </div>

              <Label style={{ margin: '20px 0 8px' }}>
                CONTEXT KEYS <span style={{ textTransform: 'none', letterSpacing: 0 }}>· scan inputs</span>
              </Label>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {[...BUILTIN_KEYS, EXTRA_KEY].map((k) => (
                  <span
                    key={k}
                    onClick={() => insert(k === EXTRA_KEY ? `${EXTRA_KEY}.` : k)}
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      padding: '3px 8px',
                      borderRadius: 6,
                      color: 'var(--text-2)',
                      background: 'var(--surface-2)',
                      border: '1px solid var(--border-2)',
                      cursor: 'pointer',
                    }}
                  >
                    {k === EXTRA_KEY ? 'extra.<key>' : k}
                  </span>
                ))}
              </div>
              <Label style={{ margin: '14px 0 8px' }}>
                FINDING KEYS <span style={{ textTransform: 'none', letterSpacing: 0 }}>· vulnerability fields</span>
              </Label>
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
                {[...REQUIRED_VULN_KEYS, ...OPTIONAL_VULN_KEYS].map((k) => (
                  <span
                    key={k}
                    onClick={() => insert(k)}
                    className="mono"
                    style={{
                      fontSize: 10.5,
                      padding: '3px 8px',
                      borderRadius: 6,
                      color: 'var(--accent)',
                      background: 'var(--accent-subtle)',
                      border: '1px solid var(--accent-subtle)',
                      cursor: 'pointer',
                    }}
                  >
                    {k}
                  </span>
                ))}
              </div>
            </div>

            {/* right: output schema */}
            <div>
              <Label style={{ marginBottom: 8 }}>OUTPUT FORMAT</Label>
              <SchemaEditor
                rows={rows}
                onRowsChange={setRows}
                mode={mode}
                onToggleMode={() => setMode((m) => (m === 'visual' ? 'raw' : 'visual'))}
                validateKey={validateKey}
                inputBg="var(--surface)"
              />
              <div
                style={{
                  marginTop: 14,
                  fontSize: 11.5,
                  color: 'var(--text-3)',
                  lineHeight: 1.5,
                  background: 'var(--surface-2)',
                  borderRadius: 8,
                  padding: '11px 13px',
                }}
              >
                Output keys become columns on{' '}
                <span className="mono" style={{ color: 'var(--text-2)' }}>
                  post_script_answer
                </span>
                . They can't reuse a reserved context or finding key.
              </div>
            </div>
          </div>
        </div>
      </div>

      <div
        className="post-script-editor-footer"
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
        <span
          className="post-script-editor-footer-status"
          style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: 'var(--text-2)' }}
        >
          <span
            style={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: errs.length || serverErrors.length ? 'var(--fail)' : 'var(--ok)',
            }}
          />
          {serverErrors[0] || errs[0] || 'Post-script is valid.'}
        </span>
        <button
          type="button"
          disabled={!canSave}
          onClick={save}
          className="post-script-editor-save"
          style={{
            border: 0,
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
                : 'Create post-script'}
        </button>
      </div>
    </div>
  );
}

function Label({ children, style, inline }) {
  return (
    <div
      className="mono"
      style={{ fontSize: 10, letterSpacing: '0.07em', color: 'var(--text-3)', marginBottom: inline ? 0 : 8, ...style }}
    >
      {children}
    </div>
  );
}

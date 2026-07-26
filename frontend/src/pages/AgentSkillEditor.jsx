import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api, ApiError, apiErrorMessages } from '../api/client.js';
import { usePageChrome } from '../context/ui.jsx';
import { ErrorState, Spinner } from '../components/ui.jsx';
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt.js';

function slugify(value) {
  return (value || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function newAgentSkillForm() {
  return {
    name: 'new-agent-skill',
    slug: 'new-agent-skill',
    description: '',
    content:
      'Use this skill when a scan needs focused security-review guidance.\n\nProcess:\n- Map reachable attacker input.\n- Trace to sensitive sinks or invariants.\n- Report only concrete, production-reachable vulnerabilities.',
    sourceUrl: '',
    licenseSpdx: '',
    attribution: '',
  };
}

export default function AgentSkillEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState(!id);
  const [form, setForm] = useState(() =>
    id ? { ...newAgentSkillForm(), name: '', slug: '', content: '' } : newAgentSkillForm()
  );
  const [saving, setSaving] = useState(false);
  const [serverErrors, setServerErrors] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const initialRef = useRef(id ? null : JSON.stringify(newAgentSkillForm()));

  usePageChrome(
    [
      { label: 'Agent skills', to: '/agent-skills' },
      { label: id ? form.name || '…' : 'New skill', active: true },
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
      const next = newAgentSkillForm();
      initialRef.current = JSON.stringify(next);
      setForm(next);
      setLoaded(true);
      return () => {
        active = false;
      };
    }
    setLoaded(false);
    api
      .agentSkill(id)
      .then((skill) => {
        if (!active) return;
        const next = {
          name: skill.name || '',
          slug: skill.slug || '',
          description: skill.description || '',
          content: skill.content || '',
          sourceUrl: skill.sourceUrl || '',
          licenseSpdx: skill.licenseSpdx || '',
          attribution: skill.attribution || '',
        };
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
  if (!form.name.trim()) errs.push('Name the skill');
  if (!form.slug.trim()) errs.push('Set a slug');
  if (!form.content.trim()) errs.push('Content is required');
  if (form.sourceUrl.trim()) {
    try {
      const parsed = new URL(form.sourceUrl.trim());
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        errs.push('Source URL must use http or https');
      }
    } catch {
      errs.push('Source URL is invalid');
    }
  }
  const canSave = errs.length === 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    setServerErrors([]);
    const body = {
      name: form.name.trim(),
      slug: slugify(form.slug),
      description: form.description,
      content: form.content,
      sourceUrl: form.sourceUrl.trim() || null,
      licenseSpdx: form.licenseSpdx.trim() || null,
      attribution: form.attribution.trim() || null,
    };
    try {
      if (id) await api.updateAgentSkill(id, body);
      else await api.createAgentSkill(body);
      allow();
      navigate('/agent-skills');
    } catch (e) {
      if (e instanceof ApiError) setServerErrors(apiErrorMessages(e));
      else setServerErrors([e.message]);
      setSaving(false);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '26px 32px' }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <input
            value={form.name}
            onChange={(e) => set({ name: e.target.value, slug: id ? form.slug : slugify(e.target.value) })}
            spellCheck={false}
            placeholder="skill name"
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
            Markdown instructions installed as a Codex skill for selected scans.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <Field label="slug">
              <Input value={form.slug} onChange={(e) => set({ slug: slugify(e.target.value) })} mono />
            </Field>
            <Field label="license_spdx">
              <Input
                value={form.licenseSpdx}
                onChange={(e) => set({ licenseSpdx: e.target.value })}
                placeholder="MIT, CC-BY-SA-4.0, Apache-2.0"
                mono
              />
            </Field>
          </div>

          <Field label="description">
            <Input value={form.description} onChange={(e) => set({ description: e.target.value })} />
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, margin: '16px 0' }}>
            <Field label="source_url">
              <Input
                value={form.sourceUrl}
                onChange={(e) => set({ sourceUrl: e.target.value })}
                placeholder="https://github.com/…"
                mono
              />
            </Field>
            <Field label="attribution">
              <Input value={form.attribution} onChange={(e) => set({ attribution: e.target.value })} />
            </Field>
          </div>

          <Field label="content">
            <textarea
              value={form.content}
              onChange={(e) => set({ content: e.target.value })}
              spellCheck={false}
              className="mono"
              style={{
                width: '100%',
                minHeight: 420,
                padding: 13,
                border: '1px solid var(--border)',
                borderRadius: 8,
                background: 'var(--code-bg)',
                color: 'var(--text)',
                fontSize: 12.5,
                lineHeight: 1.6,
                outline: 'none',
                resize: 'vertical',
              }}
            />
          </Field>
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
          {serverErrors[0] || errs[0] || 'Agent skill is valid.'}
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
                : 'Create skill'}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <div>
      <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-2)', marginBottom: 5 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function Input({ mono, style, ...props }) {
  return (
    <input
      {...props}
      spellCheck={false}
      className={mono ? 'mono' : undefined}
      style={{
        width: '100%',
        height: 38,
        padding: '0 12px',
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--surface)',
        color: 'var(--text)',
        fontSize: 13,
        outline: 'none',
        ...style,
      }}
    />
  );
}

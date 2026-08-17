import { useEffect, useMemo, useState } from 'react';

import { api } from '../api/client.js';
import { Button, ErrorState, Spinner } from '../components/ui.jsx';
import { usePageChrome } from '../context/ui.jsx';

const EMPTY_FORM = {
  name: '',
  baseUrl: '',
  apiKey: '',
  model: '',
  organization: '',
  extraHeaders: '{\n  \n}',
};

function parseHeaders(value) {
  const text = `${value || ''}`.trim();
  if (!text) return {};
  return JSON.parse(text);
}

function formatHeaders(headers) {
  return JSON.stringify(headers && typeof headers === 'object' ? headers : {}, null, 2);
}

function formFromProvider(provider) {
  return {
    name: provider.label || '',
    baseUrl: provider.baseUrl || '',
    apiKey: '',
    model: provider.model || '',
    organization: provider.organization || '',
    extraHeaders: formatHeaders(provider.extraHeaders || {}),
  };
}

export default function CustomProviders() {
  const [providers, setProviders] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [testingId, setTestingId] = useState(null);
  const [deletingId, setDeletingId] = useState(null);
  const [statusMessage, setStatusMessage] = useState('');

  const editingProvider = useMemo(
    () => (Array.isArray(providers) ? providers.find((provider) => provider.id === editingId) || null : null),
    [editingId, providers]
  );

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await api.customProviders();
      setProviders(result.providers || []);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  usePageChrome([{ label: 'Custom Providers', active: true }], null, []);

  const resetForm = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setStatusMessage('');
  };

  const startEdit = (provider) => {
    setEditingId(provider.id);
    setForm(formFromProvider(provider));
    setStatusMessage('');
  };

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    setStatusMessage('');
    try {
      const body = {
        name: form.name,
        baseUrl: form.baseUrl,
        apiKey: form.apiKey,
        model: form.model,
        organization: form.organization,
        extraHeaders: parseHeaders(form.extraHeaders),
      };
      const response = editingId ? await api.updateCustomProvider(editingId, body) : await api.createCustomProvider(body);
      const saved = response.provider;
      setProviders((current) => {
        const next = Array.isArray(current) ? [...current.filter((provider) => provider.id !== saved.id), saved] : [saved];
        next.sort((left, right) => left.label.localeCompare(right.label));
        return next;
      });
      setStatusMessage(`${saved.label} saved.`);
      setEditingId(saved.id);
      setForm({ ...formFromProvider(saved), apiKey: '' });
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSaving(false);
    }
  };

  const testConnection = async (provider) => {
    setTestingId(provider.id);
    setError(null);
    setStatusMessage('');
    try {
      const result = await api.testCustomProvider(provider.id);
      setStatusMessage(`${provider.label} connected through ${result.endpoint} (${result.status}).`);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setTestingId(null);
    }
  };

  const removeProvider = async (provider) => {
    if (!window.confirm(`Delete ${provider.label}?`)) return;
    setDeletingId(provider.id);
    setError(null);
    setStatusMessage('');
    try {
      await api.deleteCustomProvider(provider.id);
      setProviders((current) => current.filter((entry) => entry.id !== provider.id));
      if (editingId === provider.id) resetForm();
      setStatusMessage(`${provider.label} deleted.`);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setDeletingId(null);
    }
  };

  if (loading && !providers) {
    return (
      <div style={{ padding: 30 }}>
        <Spinner label="Loading custom providers..." />
      </div>
    );
  }

  if (error && !providers) {
    return (
      <div style={{ padding: 30 }}>
        <ErrorState error={error} onRetry={load} />
      </div>
    );
  }

  return (
    <div style={{ padding: '30px 32px 56px', maxWidth: 1280 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(320px, 420px) minmax(420px, 1fr)', gap: 24 }}>
        <section style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div>
              <div style={{ fontSize: 27, fontWeight: 600 }}>Custom Providers</div>
              <div style={{ color: 'var(--text-2)', marginTop: 7, lineHeight: 1.5 }}>
                Add OpenAI-compatible endpoints for Codex scans.
              </div>
            </div>
            <Button variant="ghost" onClick={resetForm}>
              New provider
            </Button>
          </div>

          <div style={{ display: 'grid', gap: 12, marginTop: 22 }}>
            {providers?.length ? (
              providers.map((provider) => (
                <article
                  key={provider.id}
                  style={{
                    border: provider.id === editingId ? '1px solid var(--accent)' : '1px solid var(--border)',
                    borderRadius: 8,
                    padding: 14,
                    background: 'var(--surface)',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontWeight: 600 }}>{provider.label}</div>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                        {provider.id}
                      </div>
                    </div>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)' }}>
                      {provider.harnesses?.join(', ') || 'codex'}
                    </div>
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 10, lineHeight: 1.5 }}>
                    <div>{provider.baseUrl}</div>
                    <div className="mono" style={{ marginTop: 4 }}>
                      {provider.model}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                    <Button variant="ghost" onClick={() => startEdit(provider)}>
                      Edit
                    </Button>
                    <Button variant="ghost" onClick={() => testConnection(provider)} disabled={testingId === provider.id}>
                      {testingId === provider.id ? 'Testing...' : 'Test connection'}
                    </Button>
                    <Button variant="ghost" onClick={() => removeProvider(provider)} disabled={deletingId === provider.id}>
                      {deletingId === provider.id ? 'Deleting...' : 'Delete'}
                    </Button>
                  </div>
                </article>
              ))
            ) : (
              <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 18, color: 'var(--text-2)' }}>
                No custom providers configured.
              </div>
            )}
          </div>
        </section>

        <section
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 20,
            background: 'var(--surface)',
            minWidth: 0,
          }}
        >
          <div style={{ fontSize: 20, fontWeight: 600 }}>{editingProvider ? `Edit ${editingProvider.label}` : 'Add provider'}</div>
          <div style={{ color: 'var(--text-2)', marginTop: 8, lineHeight: 1.5 }}>
            Store the endpoint definition locally. The API key is write-only.
          </div>

          <form onSubmit={submit} style={{ display: 'grid', gap: 14, marginTop: 20 }}>
            <Field label="Name">
              <input value={form.name} onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))} />
            </Field>
            <Field label="Base URL">
              <input
                value={form.baseUrl}
                onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
                placeholder="https://example.com/v1/"
              />
            </Field>
            <Field label="API key">
              <input
                type="password"
                value={form.apiKey}
                onChange={(event) => setForm((current) => ({ ...current, apiKey: event.target.value }))}
                placeholder={editingProvider ? 'Enter a new key to replace the current one' : 'Paste key'}
              />
            </Field>
            <Field label="Model">
              <input value={form.model} onChange={(event) => setForm((current) => ({ ...current, model: event.target.value }))} />
            </Field>
            <Field label="Organization">
              <input
                value={form.organization}
                onChange={(event) => setForm((current) => ({ ...current, organization: event.target.value }))}
                placeholder="Optional"
              />
            </Field>
            <Field label="Extra headers">
              <textarea
                rows={8}
                className="mono"
                value={form.extraHeaders}
                onChange={(event) => setForm((current) => ({ ...current, extraHeaders: event.target.value }))}
                style={fieldStyle({ minHeight: 170, resize: 'vertical' })}
              />
            </Field>

            {statusMessage && <div style={{ color: 'var(--ok)', fontSize: 12.5 }}>{statusMessage}</div>}
            {error && (
              <div style={{ color: 'var(--fail)', fontSize: 12.5 }}>
                {error.errors?.[0]?.message || error.message || 'Request failed.'}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10 }}>
              <Button type="submit" disabled={saving}>
                {saving ? 'Saving...' : editingProvider ? 'Save changes' : 'Add provider'}
              </Button>
              <Button type="button" variant="ghost" onClick={resetForm}>
                Clear
              </Button>
            </div>
          </form>
        </section>
      </div>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'grid', gap: 6 }}>
      <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-2)' }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function fieldStyle(extra = {}) {
  return {
    width: '100%',
    height: 38,
    padding: '0 11px',
    border: '1px solid var(--border)',
    borderRadius: 8,
    background: 'var(--surface)',
    fontSize: 13,
    outline: 'none',
    color: 'var(--text)',
    ...extra,
  };
}

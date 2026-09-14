import { useId, useState } from 'react';
import { api } from '../api/client.js';
import { Button } from './ui.jsx';

export default function DeepSeekApiCheck({ configured }) {
  const id = useId();
  const [models, setModels] = useState([]);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const run = async (check) => {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (check) {
        await api.checkDeepSeekModel(model);
        setMessage(`Text API check succeeded for ${model}.`);
      } else {
        const result = await api.deepSeekModels();
        setModels(result.models);
        // Keep an exact choice visible if a refreshed catalog no longer lists it.
        setModel((current) => current || result.models[0]?.id || '');
        if (!result.models.length) setMessage('DeepSeek returned no available models.');
      }
    } catch (nextError) {
      setError(nextError.message || 'Could not complete the DeepSeek request.');
    } finally {
      setBusy(false);
    }
  };

  const listed = models.some((item) => item.id === model);
  return (
    <div className="account-empty" aria-busy={busy}>
      <p>Model discovery and text API checks only. DeepSeek is not available in scan harnesses.</p>
      {!configured ? (
        <p>Add a DeepSeek API key to load models.</p>
      ) : (
        <>
          <Button variant="ghost" onClick={() => run(false)} disabled={busy}>
            {busy ? 'Waiting…' : 'Load DeepSeek models'}
          </Button>
          {(models.length > 0 || model) && (
            <div style={{ display: 'grid', gap: 8, marginTop: 12 }}>
              <label htmlFor={id}>Model for API check</label>
              <select
                id={id}
                value={model}
                disabled={busy}
                onChange={(event) => {
                  setModel(event.target.value);
                  setMessage('');
                  setError('');
                }}
              >
                {model && !listed && (
                  <option value={model} disabled>
                    {model} (unavailable)
                  </option>
                )}
                {models.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.label}
                  </option>
                ))}
              </select>
              <p>The check sends “Reply with OK.” to DeepSeek and may incur a small API charge.</p>
              <Button variant="ghost" onClick={() => run(true)} disabled={busy || !listed}>
                Run text API check
              </Button>
            </div>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

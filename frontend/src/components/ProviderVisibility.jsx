import { useSyncExternalStore } from 'react';
import { DEFAULT_VISIBLE_PROVIDERS, PROVIDER_LABELS, providerVisibilityStore } from '../lib/providerVisibility.js';

const initialSnapshot = { visible: DEFAULT_VISIBLE_PROVIDERS, persistenceError: false };

export function useProviderVisibility() {
  const preferences = useSyncExternalStore(
    providerVisibilityStore.subscribe,
    providerVisibilityStore.getSnapshot,
    () => initialSnapshot
  );
  return { ...preferences, setVisible: providerVisibilityStore.setVisible };
}

export default function ProviderVisibility({ configuredProviders = [], selected = '' }) {
  const { visible, setVisible, persistenceError } = useProviderVisibility();
  const hiddenConfigured = configuredProviders.filter((provider) => !visible.includes(provider)).length;
  return (
    <div style={{ margin: '12px 0', fontSize: 12.5, color: 'var(--text-2)' }}>
      <details>
        <summary style={{ cursor: 'pointer', color: 'var(--accent)' }}>
          Show or hide providers{hiddenConfigured > 0 ? ` · ${hiddenConfigured} configured hidden` : ''}
        </summary>
        <p>Visibility is saved in this browser. Hiding keeps accounts and saved selections.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
          {Object.entries(PROVIDER_LABELS).map(([id, label]) => (
            <label key={id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={visible.includes(id)}
                onChange={(e) => setVisible(id, e.target.checked)}
              />
              {label}
              {configuredProviders.includes(id) ? ' (configured)' : ''}
              {id === 'deepseek' ? ' · API checks in Accounts' : ''}
            </label>
          ))}
        </div>
      </details>
      {selected && !visible.includes(selected) && (
        <p>The selected {PROVIDER_LABELS[selected] || selected} provider remains available here while hidden.</p>
      )}
      {persistenceError && (
        <p role="alert">Visibility changed for this session, but could not be saved in this browser.</p>
      )}
    </div>
  );
}

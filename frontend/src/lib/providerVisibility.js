export const PROVIDER_LABELS = {
  codex: 'Codex',
  claude: 'Claude Code',
  openrouter: 'OpenRouter',
  omniroute: 'OmniRoute',
  xai: 'xAI',
  deepseek: 'DeepSeek',
  ollama: 'Ollama (local)',
};

export const DEFAULT_VISIBLE_PROVIDERS = Object.keys(PROVIDER_LABELS);
export const PROVIDER_VISIBILITY_KEY = 'ok-visible-providers';

export function parseProviderVisibility(raw) {
  try {
    const value = JSON.parse(raw);
    if (value?.version === 1 && Array.isArray(value.visible)) {
      return Object.keys(PROVIDER_LABELS).filter((provider) => value.visible.includes(provider));
    }
  } catch {
    // Invalid or unavailable preferences use the initial view.
  }
  return [...DEFAULT_VISIBLE_PROVIDERS];
}

// Presentation only: callers retain the full provider list for validation.
export function visibleProviderIds(providers, visible, selected = '') {
  return providers.filter((provider) => visible.includes(provider) || provider === selected);
}

export function createProviderVisibilityStore({ storage = () => globalThis.localStorage, events = globalThis } = {}) {
  let snapshot;
  let persistenceError = false;
  const listeners = new Set();
  const read = () => {
    try {
      return parseProviderVisibility(storage()?.getItem(PROVIDER_VISIBILITY_KEY));
    } catch {
      return [...DEFAULT_VISIBLE_PROVIDERS];
    }
  };
  const getSnapshot = () => {
    if (!snapshot) snapshot = { visible: read(), persistenceError };
    return snapshot;
  };
  const notify = (visible) => {
    snapshot = { visible, persistenceError };
    listeners.forEach((listener) => listener());
  };
  const onStorage = (event) => {
    if (event.key === PROVIDER_VISIBILITY_KEY || event.key === null) {
      persistenceError = false;
      notify(read());
    }
  };
  return {
    getSnapshot,
    subscribe(listener) {
      const first = !listeners.size;
      if (first) events.addEventListener?.('storage', onStorage);
      listeners.add(listener);
      if (first && !persistenceError && snapshot) {
        const visible = read();
        if (JSON.stringify(visible) !== JSON.stringify(snapshot.visible)) notify(visible);
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) events.removeEventListener?.('storage', onStorage);
      };
    },
    setVisible(provider, shown) {
      if (!Object.hasOwn(PROVIDER_LABELS, provider)) return;
      const current = getSnapshot().visible;
      const visible = Object.keys(PROVIDER_LABELS).filter((id) => (id === provider ? shown : current.includes(id)));
      try {
        const target = storage();
        if (!target) throw new Error('Storage unavailable');
        target.setItem(PROVIDER_VISIBILITY_KEY, JSON.stringify({ version: 1, visible }));
        persistenceError = false;
      } catch {
        persistenceError = true;
      }
      notify(visible);
    },
  };
}

export const providerVisibilityStore = createProviderVisibilityStore();

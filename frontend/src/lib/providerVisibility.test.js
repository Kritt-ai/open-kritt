import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ProviderVisibility from '../components/ProviderVisibility.jsx';
import { ProviderSelect } from '../components/ModelConfiguration.jsx';
import {
  createProviderVisibilityStore,
  parseProviderVisibility,
  PROVIDER_VISIBILITY_KEY,
  visibleProviderIds,
} from './providerVisibility.js';

function fixture() {
  const values = new Map();
  const events = new EventTarget();
  const storage = () => ({ getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) });
  return { values, events, storage, store: createProviderVisibilityStore({ storage, events }) };
}

describe('provider presentation preferences', () => {
  it('shows all supported providers by default and recovers from malformed storage', () => {
    for (const value of [undefined, null, 'broken', '{}', '{"version":2,"visible":[]}']) {
      expect(parseProviderVisibility(value)).toEqual([
        'codex',
        'claude',
        'openrouter',
        'omniroute',
        'xai',
        'deepseek',
        'ollama',
      ]);
    }
    expect(parseProviderVisibility('{"version":1,"visible":[]}')).toEqual([]);
    expect(parseProviderVisibility('{"version":1,"visible":["codex","claude"]}')).toEqual(['codex', 'claude']);
    const html = renderToStaticMarkup(createElement(ProviderSelect, { configuredProviders: ['codex', 'openrouter'] }));
    expect(html).toContain('>Codex</option>');
    expect(html).toContain('>Claude Code — add in Accounts</option>');
    expect(html).toContain('>OpenRouter</option>');
    expect(html).toContain('>xAI — add in Accounts</option>');
    expect(html).toContain('>DeepSeek — add in Accounts</option>');
  });

  it('shows, hides, and persists choices without touching accounts or selected values', () => {
    const { store, storage, events, values } = fixture();
    const selection = Object.freeze({ provider: 'openrouter', model: 'example/text-model' });
    const providers = Object.freeze(['codex', 'claude', 'openrouter', 'xai']);
    store.setVisible('xai', false);
    store.setVisible('openrouter', true);
    store.setVisible('deepseek', true);
    expect(createProviderVisibilityStore({ storage, events }).getSnapshot().visible).toEqual([
      'codex',
      'claude',
      'openrouter',
      'omniroute',
      'deepseek',
      'ollama',
    ]);
    store.setVisible('openrouter', false);
    expect(visibleProviderIds(providers, store.getSnapshot().visible, selection.provider)).toEqual([
      'codex',
      'claude',
      'openrouter',
    ]);
    expect(selection).toEqual({ provider: 'openrouter', model: 'example/text-model' });
    expect([...values.keys()]).toEqual([PROVIDER_VISIBILITY_KEY]);
    store.setVisible('unknown', true);
    expect(store.getSnapshot().visible).not.toContain('unknown');
  });

  it('keeps selected providers available and offers controls to hide providers', () => {
    expect(visibleProviderIds(['codex', 'claude', 'openrouter', 'xai'], ['codex'], 'openrouter')).toEqual([
      'codex',
      'openrouter',
    ]);
    const html = renderToStaticMarkup(
      createElement(ProviderSelect, {
        value: 'openrouter',
        configuredProviders: ['codex', 'openrouter'],
        onChange: () => {},
      })
    );
    expect(html).toContain('value="openrouter" selected="">OpenRouter</option>');
    const manager = renderToStaticMarkup(
      createElement(ProviderVisibility, {
        configuredProviders: ['openrouter', 'deepseek'],
        selected: 'openrouter',
      })
    );
    expect(manager).not.toContain('configured hidden');
    expect(manager).toContain('OpenRouter (configured)');
    expect(manager).toContain('DeepSeek (configured)');
    expect(manager).toContain('Show or hide providers');
  });

  it('synchronizes subscribers and other tabs, including clearing storage', () => {
    const { store, values, events } = fixture();
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    const initial = store.getSnapshot();
    expect(store.getSnapshot()).toBe(initial);
    store.setVisible('xai', true);
    expect(calls).toBe(1);
    values.set(PROVIDER_VISIBILITY_KEY, '{"version":1,"visible":["deepseek"]}');
    const event = new Event('storage');
    Object.defineProperty(event, 'key', { value: PROVIDER_VISIBILITY_KEY });
    events.dispatchEvent(event);
    expect(store.getSnapshot().visible).toEqual(['deepseek']);
    values.clear();
    const cleared = new Event('storage');
    Object.defineProperty(cleared, 'key', { value: null });
    events.dispatchEvent(cleared);
    expect(store.getSnapshot().visible).toEqual([
      'codex',
      'claude',
      'openrouter',
      'omniroute',
      'xai',
      'deepseek',
      'ollama',
    ]);
    unsubscribe();
    expect(calls).toBe(3);
  });

  it('keeps session changes usable and reports storage failures', () => {
    const store = createProviderVisibilityStore({
      storage: () => {
        throw new Error('blocked');
      },
    });
    expect(store.getSnapshot().visible).toEqual([
      'codex',
      'claude',
      'openrouter',
      'omniroute',
      'xai',
      'deepseek',
      'ollama',
    ]);
    store.setVisible('deepseek', false);
    expect(store.getSnapshot()).toEqual({
      visible: ['codex', 'claude', 'openrouter', 'omniroute', 'xai', 'ollama'],
      persistenceError: true,
    });
  });
});

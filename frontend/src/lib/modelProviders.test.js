import { describe, expect, it } from 'vitest';
import {
  configuredModelCatalog,
  configuredModelProviders,
  defaultHarnessForModelProvider,
  defaultModelForModelProvider,
  harnessesForModelProvider,
  isModelSelectionValid,
  modelCatalogForProvider,
  modelCatalogIsReady,
  modelForCatalogChange,
  modelForProviderChange,
  modelsForModelProvider,
  thinkingEffortForModelChange,
  thinkingEffortsForModel,
  usesFreeTextModelInput,
} from './modelProviders.js';

const modelCatalog = configuredModelCatalog({
  providers: [
    {
      provider: 'codex',
      input: 'select',
      status: 'ready',
      defaultModel: 'gpt-5-codex',
      models: [
        {
          id: 'gpt-5-codex',
          label: 'GPT-5 Codex',
          note: 'This model may have cybersecurity usage restrictions.',
          noteUrl: 'https://chatgpt.com/cyber',
          isDefault: true,
          thinkingEfforts: ['low', 'medium', 'high'],
        },
        { id: 'gpt-4.1', label: 'GPT-4.1' },
      ],
    },
    {
      provider: 'claude',
      input: 'select',
      status: 'ready',
      models: [{ id: 'claude-sonnet-4', label: 'Claude Sonnet 4', thinkingEfforts: ['medium', 'high'] }],
    },
    {
      provider: 'openrouter',
      input: 'text',
      status: 'ready',
      defaultModel: 'z-ai/glm-5.2',
      models: [
        {
          id: 'z-ai/glm-5.2',
          label: 'Z.ai: GLM 5.2',
          isDefault: true,
          thinkingEfforts: ['high', 'xhigh'],
        },
        { id: 'moonshotai/kimi-code', label: 'Moonshot: Kimi Code', thinkingEfforts: ['default'] },
      ],
    },
  ],
});

describe('configuredModelProviders', () => {
  it('uses only supported provider IDs returned by the API', () => {
    expect(
      configuredModelProviders({ providers: ['OPENROUTER', 'unknown', 'claude', 'codex', 'codex', 'xai'] })
    ).toEqual(['codex', 'claude', 'openrouter', 'xai']);
  });

  it('handles empty and malformed availability responses', () => {
    expect(configuredModelProviders({ providers: [] })).toEqual([]);
    expect(configuredModelProviders({})).toEqual([]);
  });
});

describe('model provider defaults', () => {
  it('defines the default model for each provider', () => {
    expect(defaultModelForModelProvider('codex')).toBe('gpt-5-codex');
    expect(defaultModelForModelProvider('claude')).toBe('claude-sonnet-5');
    expect(defaultModelForModelProvider('openrouter')).toBe('z-ai/glm-5.2');
    expect(defaultModelForModelProvider('xai')).toBe('grok-4.6');
  });

  it('moves provider-owned model defaults with the provider', () => {
    expect(modelForProviderChange('z-ai/glm-5.2', 'openrouter', 'codex')).toBe('gpt-5-codex');
    expect(modelForProviderChange('gpt-5-codex', 'codex', 'claude')).toBe('claude-sonnet-5');
  });

  it('keeps a user-selected model when the provider changes', () => {
    expect(modelForProviderChange('my-custom-model', 'openrouter', 'codex')).toBe('my-custom-model');
  });
});

describe('model catalog', () => {
  it('normalizes the configured provider catalog from the API array contract', () => {
    const catalog = configuredModelCatalog({
      providers: [
        {
          provider: 'CODEX',
          input: 'select',
          status: 'ready',
          defaultModel: 'gpt-5-codex',
          models: [
            {
              id: 'gpt-5-codex',
              label: 'GPT-5 Codex',
              note: 'Safe text with an unsafe link',
              noteUrl: 'javascript:alert(1)',
              isDefault: true,
            },
            { id: 'gpt-5-codex', label: 'Duplicate' },
            { id: '' },
          ],
        },
        { provider: 'unknown', input: 'text', status: 'ready', models: [] },
      ],
    });

    expect(Object.keys(catalog)).toEqual(['codex']);
    expect(modelCatalogForProvider(catalog, 'codex')).toMatchObject({
      input: 'select',
      status: 'ready',
      defaultModel: 'gpt-5-codex',
    });
    expect(modelsForModelProvider(catalog, 'codex')).toEqual([
      {
        id: 'gpt-5-codex',
        label: 'GPT-5 Codex',
        note: 'Safe text with an unsafe link',
        isDefault: true,
      },
    ]);
  });

  it('offers OpenRouter catalog suggestions without turning them into an allow-list', () => {
    expect(modelsForModelProvider(modelCatalog, 'codex')[0]).toMatchObject({
      note: 'This model may have cybersecurity usage restrictions.',
      noteUrl: 'https://chatgpt.com/cyber',
    });
    expect(usesFreeTextModelInput(modelCatalog, 'openrouter')).toBe(true);
    expect(usesFreeTextModelInput(modelCatalog, 'codex')).toBe(false);
    expect(usesFreeTextModelInput(modelCatalog, 'claude')).toBe(false);
    expect(modelsForModelProvider(modelCatalog, 'openrouter').map(({ id }) => id)).toEqual([
      'z-ai/glm-5.2',
      'moonshotai/kimi-code',
    ]);
    expect(modelCatalogIsReady(modelCatalog, 'codex')).toBe(true);
    expect(modelCatalogIsReady(modelCatalog, 'claude')).toBe(true);
    expect(modelCatalogIsReady(modelCatalog, 'openrouter')).toBe(true);
    expect(modelCatalogIsReady(modelCatalog, 'unknown')).toBe(false);
    expect(isModelSelectionValid('custom/provider-model', modelCatalog, 'openrouter')).toBe(true);
    expect(isModelSelectionValid('', modelCatalog, 'openrouter')).toBe(false);
    expect(isModelSelectionValid('gpt-5-codex', modelCatalog, 'codex')).toBe(true);
    expect(isModelSelectionValid('custom-model', modelCatalog, 'codex')).toBe(false);
  });

  it('chooses a valid destination model when the provider changes', () => {
    expect(modelForCatalogChange('z-ai/glm-5.2', 'openrouter', 'codex', modelCatalog)).toBe('gpt-5-codex');
    expect(modelForCatalogChange('gpt-4.1', 'codex', 'codex', modelCatalog)).toBe('gpt-4.1');
    expect(modelForCatalogChange('not-listed', 'codex', 'codex', modelCatalog)).toBe('gpt-5-codex');
    expect(modelForCatalogChange('gpt-5-codex', 'codex', 'openrouter', modelCatalog)).toBe('z-ai/glm-5.2');
  });

  it('clears native model selections while their catalog is loading', () => {
    const loadingCatalog = configuredModelCatalog({
      providers: [{ provider: 'codex', input: 'select', status: 'loading', models: [] }],
    });

    expect(modelCatalogIsReady(loadingCatalog, 'codex')).toBe(false);
    expect(modelForCatalogChange('gpt-5-codex', 'codex', 'codex', loadingCatalog)).toBe('');
    expect(isModelSelectionValid('gpt-5-codex', loadingCatalog, 'codex')).toBe(false);
  });

  it('keeps exact OpenRouter IDs usable while suggestions load or refresh', () => {
    const loadingCatalog = configuredModelCatalog({
      providers: [{ provider: 'openrouter', input: 'text', status: 'loading', models: [] }],
    });

    expect(usesFreeTextModelInput(loadingCatalog, 'openrouter')).toBe(true);
    expect(modelCatalogIsReady(loadingCatalog, 'openrouter')).toBe(false);
    expect(isModelSelectionValid('vendor/custom-model', loadingCatalog, 'openrouter')).toBe(true);
    expect(modelForCatalogChange('vendor/custom-model', 'openrouter', 'openrouter', loadingCatalog)).toBe(
      'vendor/custom-model'
    );
    expect(modelForCatalogChange('gpt-5-codex', 'codex', 'openrouter', loadingCatalog)).toBe('');
  });

  it('keeps exact xAI IDs usable while suggestions load or refresh', () => {
    expect(usesFreeTextModelInput({}, 'xai')).toBe(true);
    const loadingCatalog = configuredModelCatalog({
      providers: [{ provider: 'xai', input: 'text', status: 'loading', models: [] }],
    });

    expect(usesFreeTextModelInput(loadingCatalog, 'xai')).toBe(true);
    expect(modelCatalogIsReady(loadingCatalog, 'xai')).toBe(false);
    expect(isModelSelectionValid('grok-4.5', loadingCatalog, 'xai')).toBe(true);
    expect(modelForCatalogChange('grok-4.5', 'xai', 'xai', loadingCatalog)).toBe('grok-4.5');
    expect(modelForCatalogChange('gpt-5-codex', 'codex', 'xai', loadingCatalog)).toBe('');
  });

  it('uses Grok Build model-specific efforts and includes xhigh for Grok 4.6', () => {
    const xaiCatalog = configuredModelCatalog({
      providers: [
        {
          provider: 'xai',
          input: 'text',
          status: 'ready',
          defaultModel: 'grok-4.6',
          models: [
            { id: 'grok-4.6', thinkingEfforts: ['low', 'medium', 'high', 'xhigh'] },
            { id: 'grok-4.5', thinkingEfforts: ['low', 'medium', 'high'] },
          ],
        },
      ],
    });

    expect(thinkingEffortsForModel(xaiCatalog, 'xai', 'grok-4.6', [], 'grok-build')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
    expect(thinkingEffortsForModel(xaiCatalog, 'xai', 'grok-4.5', [], 'grok-build')).toEqual(['low', 'medium', 'high']);
    expect(thinkingEffortsForModel(xaiCatalog, 'xai', 'custom-model', [], 'grok-build')).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
    ]);
  });

  it('uses only the selected native model thinking efforts', () => {
    expect(thinkingEffortsForModel(modelCatalog, 'codex', 'gpt-5-codex', ['low', 'medium', 'high', 'xhigh'])).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(thinkingEffortsForModel(modelCatalog, 'codex', 'gpt-4.1', ['low', 'medium'])).toEqual([]);
    expect(thinkingEffortsForModel(modelCatalog, 'claude', 'custom-model', ['low', 'medium', 'high'])).toEqual([]);
  });

  it('uses discovered OpenRouter efforts and falls back safely for custom IDs', () => {
    const openRouterCatalog = configuredModelCatalog({
      providers: [
        {
          provider: 'openrouter',
          input: 'text',
          status: 'ready',
          models: [
            { id: 'google/gemini', thinkingEfforts: ['low', 'medium', 'high'] },
            { id: 'moonshotai/kimi', thinkingEfforts: ['default'] },
          ],
        },
      ],
    });
    expect(thinkingEffortsForModel(openRouterCatalog, 'openrouter', 'google/gemini', [], 'claude-code')).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(thinkingEffortsForModel(openRouterCatalog, 'openrouter', 'google/gemini', [], 'codex')).toEqual([
      'low',
      'medium',
      'high',
    ]);
    expect(thinkingEffortsForModel(openRouterCatalog, 'openrouter', 'vendor/custom', [], 'codex')).toEqual([
      'default',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(thinkingEffortForModelChange('xhigh', ['low', 'medium', 'high'])).toBe('medium');
  });
});

describe('model provider harnesses', () => {
  it('pairs Codex and Claude with their native harnesses', () => {
    expect(harnessesForModelProvider('codex')).toEqual(['codex']);
    expect(harnessesForModelProvider('claude')).toEqual(['claude-code']);
    expect(defaultHarnessForModelProvider('codex')).toBe('codex');
    expect(defaultHarnessForModelProvider('claude')).toBe('claude-code');
  });

  it('defaults OpenRouter to Claude Code and retains Codex as an advanced option', () => {
    expect(harnessesForModelProvider('openrouter')).toEqual(['claude-code', 'codex']);
    expect(defaultHarnessForModelProvider('openrouter')).toBe('claude-code');
  });

  it('pairs xAI with the Grok Build harness', () => {
    expect(harnessesForModelProvider('xai')).toEqual(['grok-build']);
    expect(defaultHarnessForModelProvider('xai')).toBe('grok-build');
  });

  it('returns no harness for an unsupported provider', () => {
    expect(harnessesForModelProvider('unknown')).toEqual([]);
    expect(defaultHarnessForModelProvider('unknown')).toBe('');
  });
});

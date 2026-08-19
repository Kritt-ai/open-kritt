import { MODEL_PROVIDERS, THINKING_EFFORTS } from './constants.js';

const SAFE_MODEL_NOTE_URLS = new Set(['https://chatgpt.com/cyber']);

const CLAUDE_CODE_MODELS = [
  {
    id: 'claude-fable-5',
    label: 'Fable 5',
    note: 'Cyber requests may route to Opus 4.8.',
    thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    isDefault: false,
  },
  {
    id: 'claude-opus-5',
    label: 'Opus 5',
    thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    isDefault: false,
  },
  {
    id: 'claude-opus-4-8',
    label: 'Opus 4.8',
    thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    isDefault: false,
  },
  {
    id: 'claude-opus-4-7',
    label: 'Opus 4.7',
    thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    isDefault: false,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Opus 4.6',
    thinkingEfforts: ['low', 'medium', 'high', 'max'],
    isDefault: false,
  },
  {
    id: 'claude-sonnet-5',
    label: 'Sonnet 5',
    thinkingEfforts: ['low', 'medium', 'high', 'xhigh', 'max'],
    isDefault: true,
  },
];

function normalizedProvider(provider) {
  return `${provider || ''}`.trim().toLowerCase();
}

function normalizedModel(model) {
  return typeof model === 'string' ? model.trim() : '';
}

function catalogValue(catalog, camelCase, snakeCase) {
  return catalog?.[camelCase] ?? catalog?.[snakeCase];
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedThinkingEfforts(efforts) {
  if (!Array.isArray(efforts)) return [];
  return [
    ...new Set(
      efforts
        .map((effort) => normalizedModel(effort).toLowerCase())
        .filter((effort) => THINKING_EFFORTS.includes(effort))
    ),
  ];
}

export function modelCatalogModels(catalog) {
  const models = catalogValue(catalog, 'models', 'models');
  const defaultModel = normalizedModel(catalogValue(catalog, 'defaultModel', 'default_model'));
  const seen = new Set();
  const result = [];

  const add = (model) => {
    const isObject = model && typeof model === 'object' && !Array.isArray(model);
    const id = normalizedModel(isObject ? model.id : model);
    if (!id || seen.has(id)) return;
    seen.add(id);
    const note = normalizedModel(isObject ? model.note : '');
    const requestedNoteUrl = normalizedModel(isObject ? (model.noteUrl ?? model.note_url) : '');
    const noteUrl = note && SAFE_MODEL_NOTE_URLS.has(requestedNoteUrl) ? requestedNoteUrl : '';
    result.push({
      id,
      label: normalizedModel(isObject ? model.label : '') || id,
      ...(note ? { note } : {}),
      ...(noteUrl ? { noteUrl } : {}),
      thinkingEfforts: normalizedThinkingEfforts(isObject ? (model.thinkingEfforts ?? model.thinking_efforts) : []),
      isDefault: id === defaultModel,
    });
  };

  if (Array.isArray(models)) models.forEach(add);
  return result;
}

export function modelCatalogEntry(provider, catalog) {
  const models = modelCatalogModels(catalog);
  const configuredDefault = normalizedModel(catalogValue(catalog, 'defaultModel', 'default_model'));
  const defaultModel = models.some((model) => model.id === configuredDefault) ? configuredDefault : null;

  // Subscription logins authenticate Claude Code but cannot call Anthropic's
  // API-key-only /v1/models endpoint. Keep a small current list of Claude Code
  // model IDs so subscription logins receive useful suggestions too.
  if (provider === 'claude' && (!models.length || !defaultModel)) {
    return {
      provider,
      input: 'select',
      models: CLAUDE_CODE_MODELS,
      defaultModel: 'claude-sonnet-5',
      status: 'ready',
    };
  }

  const lastError = catalogValue(catalog, 'lastError', 'last_error');
  const defaultIsMissing = !configuredDefault || !defaultModel;
  // A failed refresh must not erase a previously valid bounded catalog. Without
  // one, catalog-backed suggestions remain unavailable; OpenRouter still accepts
  // explicit model IDs through its text input and selection validation policy.
  const status = models.length > 0 && !defaultIsMissing ? 'ready' : hasText(lastError) ? 'unavailable' : 'loading';
  return { provider, input: provider === 'openrouter' ? 'text' : 'select', models, defaultModel, status };
}

export function buildModelCatalogResponse(configuredProviders, catalogs = []) {
  const configured = new Set(
    (Array.isArray(configuredProviders) ? configuredProviders : []).map(normalizedProvider).filter(Boolean)
  );
  const catalogByProvider = new Map(
    (Array.isArray(catalogs) ? catalogs : [])
      .map((catalog) => [normalizedProvider(catalog?.provider), catalog])
      .filter(([provider]) => provider)
  );

  return {
    providers: MODEL_PROVIDERS.filter((provider) => configured.has(provider)).map((provider) =>
      modelCatalogEntry(provider, catalogByProvider.get(provider))
    ),
  };
}

export function isCachedModel(provider, model, catalog) {
  const requestedModel = normalizedModel(model);
  const entry = modelCatalogEntry(normalizedProvider(provider), catalog);
  return Boolean(requestedModel) && entry.models.some(({ id }) => id === requestedModel);
}

export function hasModelCatalog(provider) {
  return MODEL_PROVIDERS.includes(normalizedProvider(provider));
}

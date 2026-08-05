export const MODEL_PROVIDER_IDS = ['codex', 'claude', 'openrouter'];
export const MODEL_CATALOG_STATUSES = ['ready', 'loading', 'unavailable'];
const SAFE_MODEL_NOTE_URLS = new Set(['https://chatgpt.com/cyber']);

const PROVIDER_LABELS = {
  codex: 'Codex',
  claude: 'Claude',
  openrouter: 'OpenRouter',
};

const PROVIDER_HARNESSES = {
  codex: ['codex'],
  claude: ['claude-code'],
  // Claude Code has first-class OpenRouter support. Codex remains available
  // for advanced installations with a matching Codex provider configuration.
  openrouter: ['claude-code', 'codex'],
};

const PROVIDER_DEFAULT_MODELS = {
  codex: 'gpt-5-codex',
  claude: 'claude-sonnet-5',
  openrouter: 'z-ai/glm-5.2',
};

const PROVIDER_THINKING_EFFORTS = {
  codex: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  claude: ['low', 'medium', 'high', 'xhigh', 'max'],
  openrouter: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
};

const HARNESS_THINKING_EFFORTS = {
  codex: ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  'claude-code': ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
  'openai-compatible': ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
};

function normalizedProviderId(provider) {
  return `${provider || ''}`.trim().toLowerCase();
}

function normalizedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function titleCaseProvider(provider) {
  return normalizedProviderId(provider)
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(' ');
}

function normalizedModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) return null;

  const id = normalizedString(model.id);
  if (!id) return null;

  const thinkingEfforts = Array.isArray(model.thinkingEfforts)
    ? [...new Set(model.thinkingEfforts.map(normalizedString).filter(Boolean))]
    : null;
  const note = normalizedString(model.note);
  const requestedNoteUrl = normalizedString(model.noteUrl);
  const noteUrl = note && SAFE_MODEL_NOTE_URLS.has(requestedNoteUrl) ? requestedNoteUrl : '';

  return {
    id,
    label: normalizedString(model.label) || id,
    ...(note ? { note } : {}),
    ...(noteUrl ? { noteUrl } : {}),
    isDefault: model.isDefault === true,
    ...(thinkingEfforts ? { thinkingEfforts } : {}),
  };
}

// The model catalog contains only configured providers. OpenRouter's catalog is
// advisory: its text input keeps accepting exact IDs while the cached entries
// provide searchable suggestions and per-model reasoning metadata.
export function configuredModelCatalog(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : [];
  const catalog = {};

  for (const entry of providers) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;

    const provider = normalizedProviderId(entry.provider);
    if (!provider || catalog[provider]) continue;

    const models = [];
    const seenModels = new Set();
    for (const rawModel of Array.isArray(entry.models) ? entry.models : []) {
      const model = normalizedModel(rawModel);
      if (model && !seenModels.has(model.id)) {
        seenModels.add(model.id);
        models.push(model);
      }
    }

    const input = entry.input === 'text' ? 'text' : 'select';
    const requestedDefault = normalizedString(entry.defaultModel);
    const listedDefault = models.find((model) => model.isDefault)?.id || models[0]?.id || '';
    const defaultModel =
      input === 'text'
        ? requestedDefault || listedDefault
        : models.some((model) => model.id === requestedDefault)
          ? requestedDefault
          : listedDefault;
    const status = MODEL_CATALOG_STATUSES.includes(entry.status) ? entry.status : 'unavailable';
    const label = normalizedString(entry.label) || PROVIDER_LABELS[provider] || titleCaseProvider(provider) || provider;
    const harnesses = Array.isArray(entry.harnesses)
      ? [...new Set(entry.harnesses.map(normalizedString).filter(Boolean))]
      : [...(PROVIDER_HARNESSES[provider] || [])];

    catalog[provider] = { input, models, defaultModel, status, label, harnesses };
  }

  return catalog;
}

export function modelCatalogForProvider(catalog, provider) {
  return catalog?.[normalizedProviderId(provider)] || null;
}

export function modelsForModelProvider(catalog, provider) {
  return modelCatalogForProvider(catalog, provider)?.models || [];
}

export function providerLabel(provider, catalog) {
  const normalized = normalizedProviderId(provider);
  return modelCatalogForProvider(catalog, normalized)?.label || PROVIDER_LABELS[normalized] || titleCaseProvider(normalized);
}

export function usesFreeTextModelInput(catalog, provider) {
  const normalizedProvider = normalizedProviderId(provider);
  const providerCatalog = modelCatalogForProvider(catalog, normalizedProvider);
  return providerCatalog?.input === 'text' || (!providerCatalog && normalizedProvider === 'openrouter');
}

export function modelCatalogIsReady(catalog, provider) {
  const providerCatalog = modelCatalogForProvider(catalog, provider);
  return (
    ['select', 'text'].includes(providerCatalog?.input) &&
    providerCatalog.status === 'ready' &&
    providerCatalog.models.length > 0
  );
}

export function isModelSelectionValid(model, catalog, provider) {
  const selectedModel = normalizedString(model);
  if (!selectedModel) return false;
  if (usesFreeTextModelInput(catalog, provider)) return true;
  if (!modelCatalogIsReady(catalog, provider)) return false;

  return modelsForModelProvider(catalog, provider).some((candidate) => candidate.id === selectedModel);
}

function defaultCatalogModel(catalog, provider) {
  return modelCatalogForProvider(catalog, provider)?.defaultModel || '';
}

// A provider switch chooses the destination catalog default. OpenRouter keeps
// an existing exact ID because its dynamically discovered catalog is advisory.
export function modelForCatalogChange(model, previousProvider, nextProvider, catalog) {
  const previous = normalizedProviderId(previousProvider);
  const next = normalizedProviderId(nextProvider);
  const currentModel = normalizedString(model);
  const switchedProvider = previous !== next;

  if (usesFreeTextModelInput(catalog, next)) {
    return switchedProvider || !currentModel ? defaultCatalogModel(catalog, next) : `${model || ''}`;
  }

  if (!modelCatalogIsReady(catalog, next)) return '';
  if (!switchedProvider && isModelSelectionValid(currentModel, catalog, next)) return currentModel;
  return defaultCatalogModel(catalog, next);
}

export function thinkingEffortsForModel(catalog, provider, model, fallback, harness) {
  const providerEfforts = PROVIDER_THINKING_EFFORTS[normalizedProviderId(provider)];
  const selectedHarness = normalizedString(harness) || defaultHarnessForModelProvider(provider, catalog);
  const fallbackEfforts =
    providerEfforts ||
    (selectedHarness === 'openai-compatible' ? HARNESS_THINKING_EFFORTS['openai-compatible'] : null) ||
    (Array.isArray(fallback) ? fallback : []);
  const harnessEfforts = HARNESS_THINKING_EFFORTS[selectedHarness] || [];
  const selected = modelsForModelProvider(catalog, provider).find(
    (candidate) => candidate.id === normalizedString(model)
  );

  if (usesFreeTextModelInput(catalog, provider)) {
    const efforts = selected?.thinkingEfforts?.length ? selected.thinkingEfforts : fallbackEfforts;
    return efforts.filter((effort) => harnessEfforts.includes(effort));
  }
  if (!modelCatalogIsReady(catalog, provider)) return [];

  return (selected?.thinkingEfforts || []).filter((effort) => harnessEfforts.includes(effort));
}

export function thinkingEffortForModelChange(currentEffort, availableEfforts) {
  if (!availableEfforts.length) return '';
  if (availableEfforts.includes(currentEffort)) return currentEffort;
  return availableEfforts.includes('medium') ? 'medium' : availableEfforts[0];
}

// The API exposes only configured provider IDs. Keep the UI defensive so an
// unexpected response cannot create an unsupported scan configuration.
export function configuredModelProviders(payload) {
  const providers = Array.isArray(payload) ? payload : payload?.providers;
  if (!Array.isArray(providers)) return [];

  return [...new Set(providers.map((provider) => normalizedProviderId(provider)).filter(Boolean))];
}

export function harnessesForModelProvider(provider, catalog) {
  const normalized = normalizedProviderId(provider);
  const configured = modelCatalogForProvider(catalog, normalized)?.harnesses;
  return configured?.length ? [...configured] : [...(PROVIDER_HARNESSES[normalized] || [])];
}

export function defaultHarnessForModelProvider(provider, catalog) {
  return harnessesForModelProvider(provider, catalog)[0] || '';
}

export function defaultModelForModelProvider(provider, catalog) {
  return modelCatalogForProvider(catalog, provider)?.defaultModel || PROVIDER_DEFAULT_MODELS[normalizedProviderId(provider)] || '';
}

// Retain an explicit model choice while moving provider-owned defaults together.
export function modelForProviderChange(model, previousProvider, nextProvider, catalog) {
  const previousDefault = defaultModelForModelProvider(previousProvider, catalog);
  const nextDefault = defaultModelForModelProvider(nextProvider, catalog);
  return previousDefault && nextDefault && `${model || ''}`.trim() === previousDefault ? nextDefault : model;
}

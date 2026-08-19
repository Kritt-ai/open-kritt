import { useId } from 'react';
import { Link } from 'react-router-dom';
import SearchSelect from './SearchSelect.jsx';
import {
  defaultHarnessForModelProvider,
  harnessesForModelProvider,
  isModelSelectionValid,
  MODEL_PROVIDER_IDS,
  modelCatalogForProvider,
  modelCatalogIsReady,
  modelForCatalogChange,
  modelsForModelProvider,
  thinkingEffortForModelChange,
  thinkingEffortsForModel,
  usesFreeTextModelInput,
} from '../lib/modelProviders.js';

export const THINKING_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

const PROVIDER_LABELS = {
  codex: 'Codex',
  claude: 'Claude',
  openrouter: 'OpenRouter',
};

export function modelConfigurationForCatalog(current, providers, catalog) {
  const previousProvider = current?.model_provider || '';
  const modelProvider = providers.includes(previousProvider)
    ? previousProvider
    : MODEL_PROVIDER_IDS.find((provider) => providers.includes(provider)) || '';
  const model = modelForCatalogChange(current?.model || '', previousProvider, modelProvider, catalog);
  const harness = harnessesForModelProvider(modelProvider).includes(current?.harness)
    ? current.harness
    : defaultHarnessForModelProvider(modelProvider);
  const thinkingEffort = thinkingEffortForModelChange(
    current?.thinking_effort || 'medium',
    thinkingEffortsForModel(catalog, modelProvider, model, THINKING_EFFORTS, harness)
  );
  return {
    model_provider: modelProvider,
    model,
    thinking_effort: thinkingEffort,
    harness,
  };
}

export function modelConfigurationIsValid(value, providers, catalog) {
  const compatibleHarnesses = harnessesForModelProvider(value.model_provider);
  const efforts = thinkingEffortsForModel(catalog, value.model_provider, value.model, THINKING_EFFORTS, value.harness);
  return (
    providers.includes(value.model_provider) &&
    compatibleHarnesses.includes(value.harness) &&
    isModelSelectionValid(value.model, catalog, value.model_provider) &&
    efforts.includes(value.thinking_effort)
  );
}

export default function ModelConfiguration({
  value,
  onChange,
  providers,
  catalog,
  catalogError,
  disabled = false,
  showAvailabilityHelp = true,
}) {
  const providerConfigured = providers.includes(value.model_provider);
  const compatibleHarnesses = harnessesForModelProvider(value.model_provider);
  const selectableModels = modelsForModelProvider(catalog, value.model_provider);
  const selectedModel = selectableModels.find((model) => model.id === value.model);
  const providerCatalog = modelCatalogForProvider(catalog, value.model_provider);
  const catalogReady = modelCatalogIsReady(catalog, value.model_provider);
  const freeTextModel = usesFreeTextModelInput(catalog, value.model_provider);
  const suggestionsReady = providerCatalog?.status === 'ready' && selectableModels.length > 0;
  const availableEfforts = thinkingEffortsForModel(
    catalog,
    value.model_provider,
    value.model,
    THINKING_EFFORTS,
    value.harness
  );
  const providerName = PROVIDER_LABELS[value.model_provider] || 'selected provider';
  let catalogMessage = '';
  if (providerConfigured && freeTextModel && !suggestionsReady) {
    if (catalogError) {
      catalogMessage = `Could not load ${providerName} model suggestions. You can still enter an exact model ID.`;
    } else if (providerCatalog?.status === 'loading') {
      catalogMessage = `Loading available ${providerName} models. You can still enter an exact model ID.`;
    } else if (providerCatalog?.status === 'ready') {
      catalogMessage = `No ${providerName} model suggestions are available. You can still enter an exact model ID.`;
    } else {
      catalogMessage = `${providerName} model suggestions are unavailable. You can still enter an exact model ID.`;
    }
  } else if (providerConfigured && !freeTextModel && !catalogReady) {
    catalogMessage = catalogError
      ? `Could not load the ${providerName} model catalog. Model selection is unavailable.`
      : providerCatalog?.status === 'loading'
        ? `Loading available ${providerName} models.`
        : providerCatalog?.status === 'ready'
          ? `No ${providerName} models are available.`
          : `${providerName} model catalog is unavailable.`;
  }
  const unavailableProviders = MODEL_PROVIDER_IDS.filter((provider) => !providers.includes(provider));

  const changeProvider = (modelProvider) => {
    const model = modelForCatalogChange(value.model, value.model_provider, modelProvider, catalog);
    const harness = defaultHarnessForModelProvider(modelProvider);
    onChange({
      ...value,
      model_provider: modelProvider,
      model,
      harness,
      thinking_effort: thinkingEffortForModelChange(
        value.thinking_effort,
        thinkingEffortsForModel(catalog, modelProvider, model, THINKING_EFFORTS, harness)
      ),
    });
  };

  const changeModel = (model) =>
    onChange({
      ...value,
      model,
      thinking_effort: thinkingEffortForModelChange(
        value.thinking_effort,
        thinkingEffortsForModel(catalog, value.model_provider, model, THINKING_EFFORTS, value.harness)
      ),
    });

  const changeHarness = (harness) =>
    onChange({
      ...value,
      harness,
      thinking_effort: thinkingEffortForModelChange(
        value.thinking_effort,
        thinkingEffortsForModel(catalog, value.model_provider, value.model, THINKING_EFFORTS, harness)
      ),
    });

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: 12,
        }}
      >
        <Field label="provider">
          {(fieldId) => (
            <ProviderSelect
              id={fieldId}
              value={value.model_provider}
              onChange={(event) => changeProvider(event.target.value)}
              configuredProviders={providers}
              disabled={disabled}
            />
          )}
        </Field>
        <Field label="model">
          {(fieldId) => (
            <div data-model-input-mode={freeTextModel ? 'autocomplete' : 'select'}>
              <SearchSelect
                id={fieldId}
                label="Model"
                items={selectableModels}
                value={value.model}
                onChange={changeModel}
                height={38}
                placeholder={freeTextModel ? 'Filter models or enter an exact ID...' : 'Filter models...'}
                emptyText={freeTextModel ? 'Type an exact model ID to use it.' : 'No matching models.'}
                disabled={disabled || !providerConfigured || (!freeTextModel && !catalogReady)}
                allowCustomValue={freeTextModel}
                customValueLabel="Use exact model ID"
                customValueMaxLength={200}
                filter={(model, query) =>
                  !query || model.id.toLowerCase().includes(query) || model.label.toLowerCase().includes(query)
                }
                renderTrigger={(model) => (
                  <span
                    className="mono"
                    style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {model?.label ||
                      (freeTextModel
                        ? 'Select or enter a model'
                        : catalogReady
                          ? 'Select a model'
                          : providerCatalog?.status === 'loading'
                            ? 'Loading models...'
                            : 'Models unavailable')}
                  </span>
                )}
                renderItem={(model) => (
                  <span style={{ minWidth: 0 }}>
                    <span className="mono" style={{ display: 'block', fontSize: 12.5, fontWeight: 600 }}>
                      {model.label}
                    </span>
                    {model.label !== model.id && (
                      <span
                        className="mono"
                        style={{ display: 'block', marginTop: 2, color: 'var(--text-3)', fontSize: 11 }}
                      >
                        {model.id}
                      </span>
                    )}
                  </span>
                )}
              />
            </div>
          )}
        </Field>
        <Field label="thinking effort">
          {(fieldId) => (
            <Select
              id={fieldId}
              value={value.thinking_effort}
              onChange={(event) => onChange({ ...value, thinking_effort: event.target.value })}
              options={availableEfforts}
              disabled={disabled || availableEfforts.length === 0}
              emptyLabel="No supported efforts"
            />
          )}
        </Field>
        <Field label="harness">
          {(fieldId) => (
            <Select
              id={fieldId}
              value={value.harness}
              onChange={(event) => changeHarness(event.target.value)}
              options={compatibleHarnesses}
              disabled={disabled || !providerConfigured}
              emptyLabel="No compatible harnesses"
            />
          )}
        </Field>
      </div>
      <div
        role={selectedModel?.note ? 'note' : undefined}
        style={{ minHeight: 20, marginTop: 7, color: 'var(--text-2)', fontSize: 12, lineHeight: 1.5 }}
      >
        {selectedModel?.note && (
          <>
            <span className="mono" style={{ marginRight: 7, color: 'var(--text-3)', fontSize: 10.5 }}>
              MODEL NOTE
            </span>
            {selectedModel.note}
            {selectedModel.noteUrl && (
              <>
                {' '}
                <a
                  href={selectedModel.noteUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  style={{ color: 'var(--accent)', fontWeight: 600 }}
                >
                  Learn more in ChatGPT Cyber
                </a>
                .
              </>
            )}
          </>
        )}
      </div>
      {showAvailabilityHelp && (unavailableProviders.length > 0 || catalogMessage) && (
        <div style={{ marginTop: 10, color: 'var(--text-2)', fontSize: 12.5, lineHeight: 1.5 }}>
          {unavailableProviders.length > 0 && (
            <div>
              {providers.length === 0
                ? 'No model providers are configured.'
                : `${unavailableProviders.map((provider) => PROVIDER_LABELS[provider]).join(' and ')} ${
                    unavailableProviders.length === 1 ? 'is' : 'are'
                  } greyed out because ${unavailableProviders.length === 1 ? 'it has' : 'they have'} no account.`}{' '}
              <Link to="/accounts" style={{ color: 'var(--accent)' }}>
                Add {unavailableProviders.length === 1 ? 'it' : 'them'} in Accounts
              </Link>
              .
            </div>
          )}
          {catalogMessage && <div>{catalogMessage}</div>}
        </div>
      )}
    </>
  );
}

function Field({ label, children }) {
  const id = useId();
  return (
    <div style={{ minWidth: 0 }}>
      <label
        htmlFor={id}
        className="mono"
        style={{ display: 'block', fontSize: 11.5, color: 'var(--text-2)', marginBottom: 5 }}
      >
        {label}
      </label>
      {children(id, label)}
    </div>
  );
}

function ProviderSelect({ id, value, onChange, configuredProviders, disabled }) {
  return (
    <select
      id={id}
      value={value || ''}
      onChange={onChange}
      disabled={disabled}
      className="mono"
      style={{
        width: '100%',
        height: 38,
        padding: '0 11px',
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--surface)',
        fontSize: 13,
        outline: 'none',
        color: disabled ? 'var(--text-3)' : 'var(--text)',
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {!value && <option value="">No configured providers</option>}
      {MODEL_PROVIDER_IDS.map((provider) => {
        const configured = configuredProviders.includes(provider);
        return (
          <option key={provider} value={provider} disabled={!configured}>
            {PROVIDER_LABELS[provider]}
            {configured ? '' : ' — add in Accounts'}
          </option>
        );
      })}
    </select>
  );
}

function Select({ id, value, onChange, options, disabled = false, emptyLabel }) {
  const hasOptions = options.length > 0;
  return (
    <select
      id={id}
      value={hasOptions ? value : ''}
      onChange={onChange}
      disabled={disabled || !hasOptions}
      className="mono"
      style={{
        width: '100%',
        height: 38,
        padding: '0 11px',
        border: '1px solid var(--border)',
        borderRadius: 8,
        background: 'var(--surface)',
        fontSize: 13,
        outline: 'none',
        color: disabled || !hasOptions ? 'var(--text-3)' : 'var(--text)',
        cursor: disabled || !hasOptions ? 'not-allowed' : 'pointer',
      }}
    >
      {hasOptions ? (
        options.map((option) => (
          <option key={option} value={option}>
            {PROVIDER_LABELS[option] || option}
          </option>
        ))
      ) : (
        <option value="">{emptyLabel}</option>
      )}
    </select>
  );
}

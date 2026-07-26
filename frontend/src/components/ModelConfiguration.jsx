import { useId } from 'react';
import { Link } from 'react-router-dom';
import SearchSelect from './SearchSelect.jsx';
import {
  defaultHarnessForModelProvider,
  harnessesForModelProvider,
  isModelSelectionValid,
  modelCatalogForProvider,
  modelCatalogIsReady,
  modelForCatalogChange,
  modelsForModelProvider,
  providerIds,
  providerLabel,
  thinkingEffortForModelChange,
  thinkingEffortsForModel,
  usesFreeTextModelInput,
} from '../lib/modelProviders.js';

export const THINKING_EFFORTS = ['default', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

export function modelConfigurationForCatalog(current, providers, catalog) {
  const previousProvider = current?.model_provider || '';
  const modelProvider = providers.includes(previousProvider)
    ? previousProvider
    : providerIds(providers).find((provider) => providers.includes(provider)) || '';
  const model = modelForCatalogChange(current?.model || '', previousProvider, modelProvider, catalog);
  const harness = harnessesForModelProvider(modelProvider, catalog).includes(current?.harness)
    ? current.harness
    : defaultHarnessForModelProvider(modelProvider, catalog);
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
  const compatibleHarnesses = harnessesForModelProvider(value.model_provider, catalog);
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
  accountProviders = [],
  disabled = false,
}) {
  const providerConfigured = providers.includes(value.model_provider);
  const compatibleHarnesses = harnessesForModelProvider(value.model_provider, catalog);
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
  const providerName = providerLabel(value.model_provider, catalog) || 'selected provider';
  const providerOptionIds = providerIds(providers);
  const unavailableProviders = providerOptionIds.filter(
    (provider) => !providers.includes(provider) && ['codex', 'claude', 'openrouter'].includes(provider)
  );
  const selectedAccountProvider = accountProviders.find((provider) => provider.id === value.model_provider);
  const localSessionAccounts =
    ['codex', 'claude'].includes(value.model_provider) && selectedAccountProvider?.accounts?.length
      ? selectedAccountProvider.accounts.filter((account) => account.active)
      : [];
  const selectedAccountId =
    localSessionAccounts.find((account) => account.id === value.provider_account_id)?.id ||
    localSessionAccounts[0]?.id ||
    '';

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

  const changeProvider = (modelProvider) => {
    const model = modelForCatalogChange(value.model, value.model_provider, modelProvider, catalog);
    const harness = defaultHarnessForModelProvider(modelProvider, catalog);
    onChange({
      ...value,
      model_provider: modelProvider,
      model,
      harness,
      provider_account_id:
        accountProviders
          .find((provider) => provider.id === modelProvider)
          ?.accounts?.find((account) => account.active)?.id || '',
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
              providerOptionIds={providerOptionIds}
              catalog={catalog}
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
        {['codex', 'claude'].includes(value.model_provider) && (
          <Field label="account">
            {(fieldId) =>
              localSessionAccounts.length ? (
                <Select
                  id={fieldId}
                  value={selectedAccountId}
                  onChange={(event) => onChange({ ...value, provider_account_id: event.target.value })}
                  options={localSessionAccounts.map((account) => ({
                    value: account.id,
                    label: `${account.email || account.label} - local session`,
                  }))}
                  disabled={disabled}
                  emptyLabel="No local sessions"
                />
              ) : (
                <select
                  id={fieldId}
                  value=""
                  disabled
                  className="mono"
                  style={selectStyle(true)}
                >
                  <option value="">No local session detected</option>
                </select>
              )
            }
          </Field>
        )}
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
      {(unavailableProviders.length > 0 || catalogMessage) && (
        <div style={{ marginTop: 10, color: 'var(--text-2)', fontSize: 12.5, lineHeight: 1.5 }}>
          {unavailableProviders.length > 0 && (
            <div>
              {providers.length === 0
                ? 'No model providers are configured.'
                : `${unavailableProviders.map((provider) => providerLabel(provider, catalog)).join(' and ')} ${
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

function ProviderSelect({ id, value, onChange, configuredProviders, providerOptionIds, catalog, disabled }) {
  return (
    <select
      id={id}
      value={value || ''}
      onChange={onChange}
      disabled={disabled}
      className="mono"
      style={selectStyle(disabled)}
    >
      {!value && <option value="">No configured providers</option>}
      {providerOptionIds.map((provider) => {
        const configured = configuredProviders.includes(provider);
        return (
          <option key={provider} value={provider} disabled={!configured}>
            {providerLabel(provider, catalog)}
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
      style={selectStyle(disabled || !hasOptions)}
    >
      {hasOptions ? (
        options.map((option) => {
          const value = typeof option === 'string' ? option : option.value;
          const label = typeof option === 'string' ? option : option.label;
          return (
          <option key={value} value={value}>
            {label}
          </option>
          );
        })
      ) : (
        <option value="">{emptyLabel}</option>
      )}
    </select>
  );
}

function selectStyle(disabled) {
  return {
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
  };
}

import ModelConfiguration, {
  THINKING_EFFORTS,
  modelConfigurationForCatalog,
  modelConfigurationIsValid,
} from './ModelConfiguration.jsx';
import { thinkingEffortsForModel } from '../lib/modelProviders.js';
import {
  enableModelOverrides,
  modelOverridesDraft,
  modelSelectionDraft,
  normalizeModelOverrides,
  resolvedModelConfiguration,
} from '../lib/modelOverrides.js';

function postProcessingOverrideEnabled(value = {}) {
  return Boolean(value.post_processing_model_override ?? value.postProcessingModelOverride);
}

export function postProcessingModelConfiguration(value = {}) {
  const override = postProcessingOverrideEnabled(value);
  return {
    model: override ? (value.post_processing_model ?? value.postProcessingModel ?? value.model) : value.model,
    model_provider: override
      ? (value.post_processing_model_provider ?? value.postProcessingModelProvider ?? value.model_provider)
      : value.model_provider,
    harness: override ? (value.post_processing_harness ?? value.postProcessingHarness ?? value.harness) : value.harness,
    thinking_effort:
      value.post_processing_thinking_effort ?? value.postProcessingThinkingEffort ?? value.thinking_effort,
  };
}

export function workflowModelConfigurationForCatalog(current, providers, catalog) {
  const base = modelConfigurationForCatalog(current, providers, catalog);
  const postProcessingModelOverride = postProcessingOverrideEnabled(current);
  const postProcessing = modelConfigurationForCatalog(
    postProcessingModelOverride
      ? postProcessingModelConfiguration({ ...current, post_processing_model_override: true })
      : {
          ...base,
          thinking_effort:
            current?.post_processing_thinking_effort ?? current?.postProcessingThinkingEffort ?? base.thinking_effort,
        },
    providers,
    catalog
  );
  return {
    ...base,
    post_processing_model_override: postProcessingModelOverride,
    post_processing_model: postProcessing.model,
    post_processing_model_provider: postProcessing.model_provider,
    post_processing_harness: postProcessing.harness,
    post_processing_thinking_effort: postProcessing.thinking_effort,
    model_overrides: normalizeModelOverrides(current?.model_overrides ?? current?.modelOverrides, (configuration) =>
      modelConfigurationForCatalog(configuration, providers, catalog)
    ),
  };
}

export function workflowModelConfigurationIsValid(value, depths, providers, catalog) {
  if (!modelConfigurationIsValid(value, providers, catalog)) return false;
  if (!modelConfigurationIsValid(postProcessingModelConfiguration(value), providers, catalog)) return false;
  const overrides = modelOverridesDraft(value?.model_overrides ?? value?.modelOverrides);
  const allowedDepths = new Set(depths.map(String));
  if (Object.keys(overrides).some((depth) => !allowedDepths.has(depth))) return false;
  return depths.every((depth) =>
    modelConfigurationIsValid(resolvedModelConfiguration(value, depth), providers, catalog)
  );
}

function modeButtonStyle(active, disabled) {
  return {
    minHeight: 34,
    padding: '0 12px',
    border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
    borderRadius: 8,
    background: active ? 'var(--accent-subtle)' : 'var(--surface)',
    color: disabled ? 'var(--text-3)' : active ? 'var(--accent)' : 'var(--text-2)',
    fontSize: 12,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
  };
}

export default function WorkflowModelConfiguration({
  value,
  onChange,
  depths,
  depthChips = [],
  providers,
  catalog,
  catalogError,
  disabled = false,
}) {
  const overrides = modelOverridesDraft(value?.model_overrides ?? value?.modelOverrides);
  const customized = Object.keys(overrides).length > 0;
  const canCustomize = depths.length > 0;
  const depthLabels = new Map(depthChips.map((chip) => [chip.depth, chip]));
  const postProcessingModelOverride = postProcessingOverrideEnabled(value);
  const postProcessingConfiguration = postProcessingModelConfiguration(value);
  const postProcessingEfforts = thinkingEffortsForModel(
    catalog,
    postProcessingConfiguration.model_provider,
    postProcessingConfiguration.model,
    THINKING_EFFORTS,
    postProcessingConfiguration.harness
  );

  const useSingleModel = () => onChange({ ...value, model_overrides: {} });
  const customizeByDepth = () =>
    onChange({
      ...value,
      model_overrides: enableModelOverrides(depths, value, overrides),
    });

  return (
    <>
      <div
        role="group"
        aria-label="Workflow model strategy"
        style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}
      >
        <button
          type="button"
          aria-pressed={!customized}
          disabled={disabled}
          onClick={useSingleModel}
          style={modeButtonStyle(!customized, disabled)}
        >
          One model for all depths
        </button>
        <button
          type="button"
          aria-pressed={customized}
          disabled={disabled || !canCustomize}
          onClick={customizeByDepth}
          style={modeButtonStyle(customized, disabled || !canCustomize)}
        >
          Customize by depth
        </button>
      </div>

      <div
        style={{
          border: customized ? '1px solid var(--border)' : 0,
          borderRadius: 9,
          padding: customized ? 13 : 0,
          background: customized ? 'var(--surface-2)' : 'transparent',
        }}
      >
        {customized && (
          <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-3)', marginBottom: 9 }}>
            DEFAULT WORKFLOW MODEL
          </div>
        )}
        <ModelConfiguration
          value={value}
          onChange={(configuration) => onChange({ ...value, ...configuration })}
          providers={providers}
          catalog={catalog}
          catalogError={catalogError}
          disabled={disabled}
        />
      </div>

      <div
        style={{
          marginTop: 12,
          border: '1px solid var(--border)',
          borderRadius: 9,
          padding: 13,
          background: 'var(--surface-2)',
        }}
      >
        <span className="mono" style={{ display: 'block', fontSize: 10.5, color: 'var(--text-3)', marginBottom: 7 }}>
          POST-PROCESSING MODEL
        </span>
        <div
          role="group"
          aria-label="Post-processing model strategy"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}
        >
          <button
            type="button"
            aria-pressed={!postProcessingModelOverride}
            disabled={disabled}
            onClick={() =>
              onChange({
                ...value,
                post_processing_model_override: false,
                post_processing_model: value.model,
                post_processing_model_provider: value.model_provider,
                post_processing_harness: value.harness,
              })
            }
            style={modeButtonStyle(!postProcessingModelOverride, disabled)}
          >
            Use scan model
          </button>
          <button
            type="button"
            aria-pressed={postProcessingModelOverride}
            disabled={disabled}
            onClick={() =>
              onChange({
                ...value,
                post_processing_model_override: true,
                post_processing_model: postProcessingConfiguration.model,
                post_processing_model_provider: postProcessingConfiguration.model_provider,
                post_processing_harness: postProcessingConfiguration.harness,
              })
            }
            style={modeButtonStyle(postProcessingModelOverride, disabled)}
          >
            Use different model
          </button>
        </div>

        {postProcessingModelOverride ? (
          <ModelConfiguration
            value={postProcessingConfiguration}
            onChange={(configuration) =>
              onChange({
                ...value,
                post_processing_model_override: true,
                post_processing_model: configuration.model,
                post_processing_model_provider: configuration.model_provider,
                post_processing_harness: configuration.harness,
                post_processing_thinking_effort: configuration.thinking_effort,
              })
            }
            providers={providers}
            catalog={catalog}
            catalogError={catalogError}
            disabled={disabled}
            showAvailabilityHelp={false}
          />
        ) : (
          <label style={{ display: 'block', maxWidth: 280 }}>
            <span className="mono" style={{ display: 'block', fontSize: 10, color: 'var(--text-3)', marginBottom: 6 }}>
              THINKING EFFORT
            </span>
            <select
              className="mono"
              value={postProcessingConfiguration.thinking_effort}
              disabled={disabled || postProcessingEfforts.length === 0}
              onChange={(event) => onChange({ ...value, post_processing_thinking_effort: event.target.value })}
              style={{
                width: '100%',
                height: 36,
                padding: '0 10px',
                borderRadius: 7,
                border: '1px solid var(--border)',
                background: 'var(--surface)',
                color: 'var(--text)',
              }}
            >
              {postProcessingEfforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {customized && (
        <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
          {depths.map((depth) => {
            const chip = depthLabels.get(depth);
            const configuration = resolvedModelConfiguration(value, depth);
            return (
              <div
                key={depth}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 9,
                  padding: 13,
                  background: 'var(--surface)',
                }}
              >
                <div
                  className="mono"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 10,
                    fontSize: 10.5,
                    color: 'var(--text-3)',
                    marginBottom: 9,
                  }}
                >
                  <span>DEPTH {depth}</span>
                  {chip?.count ? (
                    <span>
                      {chip.count} {chip.count === 1 ? 'step' : 'steps'}
                    </span>
                  ) : null}
                </div>
                <ModelConfiguration
                  value={configuration}
                  onChange={(nextConfiguration) =>
                    onChange({
                      ...value,
                      model_overrides: {
                        ...overrides,
                        [`${depth}`]: modelSelectionDraft(nextConfiguration),
                      },
                    })
                  }
                  providers={providers}
                  catalog={catalog}
                  catalogError={catalogError}
                  disabled={disabled}
                  showAvailabilityHelp={false}
                />
              </div>
            );
          })}
        </div>
      )}

      {!canCustomize && (
        <div style={{ marginTop: 8, color: 'var(--text-3)', fontSize: 11.5 }}>
          Select a workflow to configure models by depth.
        </div>
      )}
    </>
  );
}

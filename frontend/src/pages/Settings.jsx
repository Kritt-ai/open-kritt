import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api, apiErrorMessages } from '../api/client.js';
import { Button, ErrorState, Spinner } from '../components/ui.jsx';
import { usePageChrome } from '../context/ui.jsx';
import { runtimeSettingsDraft, runtimeSettingsIssues, runtimeSettingsPatch } from '../lib/runtimeSettings.js';
import { useFetch } from '../lib/useFetch.js';
import { useUnsavedChangesPrompt } from '../lib/useUnsavedChangesPrompt.js';

const PRESENTATION = {
  workerCount: {
    label: 'Engine worker slots',
    unit: 'workers',
    description:
      'Shared capacity for scan workflow and post-processing jobs. Set 0 to pause pickup of new work without stopping jobs already running.',
  },
  maxConcurrentScans: {
    label: 'Concurrent scan pool',
    unit: 'scans',
    description: 'Maximum immediate scans admitted at once. Queued scans wait until the active pool is empty.',
  },
  maxWorkersPerScan: {
    label: 'Workers per scan',
    unit: 'workers',
    description: 'Hard cap for one scan. Set 0 to divide worker slots automatically and fairly across active scans.',
  },
  workersPerAccount: {
    label: 'Workers per account',
    unit: 'workers',
    description:
      'Maximum concurrent root model calls assigned to the same provider account across scans. Codex subagents inside each session use their separate cap.',
  },
  autoscaleScanWorkersOnProviderCapacity: {
    label: 'Autoscale scan workers on capacity errors',
    description:
      'When a provider reports temporary server-capacity throttling or Codex reaches its separate subagent limit, lower only that scan’s future worker cap by one and retry. Account quota errors are not autoscaled.',
    enabledDescription: 'Capacity throttles reduce the affected scan by one worker.',
    disabledDescription: 'Worker caps remain fixed.',
  },
  codexMaxSubagentsPerSession: {
    label: 'Codex subagents per session',
    unit: 'subagents',
    description: 'Hard cap for concurrently running child agents inside each Codex scan session.',
  },
  minFreeStorageGb: {
    label: 'Minimum free storage',
    unit: 'GiB',
    description:
      'Pause new scan containers when free disk space falls below this level. Lowering it can keep scans moving, but increases the risk of filling the disk completely.',
  },
  ignoreLowStorage: {
    label: 'Ignore low-storage safeguard',
    description:
      'Allow new scan containers to start regardless of available disk space. Use only when you accept the risk of exhausting the host disk.',
    enabledDescription: 'The minimum free-storage threshold is not enforced.',
    disabledDescription: 'New containers pause below the configured threshold.',
  },
  memoryReserveGb: {
    label: 'Docker memory reserve',
    unit: 'GiB',
    description:
      'Memory withheld from scan runners for the engine, database, API, and operating overhead. The worker ceiling is reduced automatically when the remaining budget cannot fit every runner.',
  },
  scanRunnerMemoryMb: {
    label: 'Runner hard memory limit',
    unit: 'MiB',
    description:
      'Docker hard limit for each tool-enabled model session. A runner that exceeds this limit is terminated; set 0 only to disable the hard cap.',
  },
  scanRunnerMemoryReservationMb: {
    label: 'Runner memory reservation',
    unit: 'MiB',
    description:
      'Soft memory reservation used for worker-capacity planning and live admission. It may be lower than the hard limit so idle runners share unused Docker memory.',
  },
  workspaceSetupConcurrency: {
    label: 'Workspace setup concurrency',
    unit: 'setups',
    description:
      'Limits simultaneous repository checkout and isolated workspace preparation. Lower values reduce Docker, disk, and network bursts.',
  },
  retryCount: {
    label: 'Model-call retries',
    unit: 'retries',
    description:
      'Additional attempts for retryable workflow-step and post-script failures. This does not automatically resume a failed whole scan.',
  },
  cyberSafetyRetryCount: {
    label: 'Cyber-block retries',
    unit: 'retries',
    description:
      'Additional attempts made only when a provider blocks a request under its cybersecurity safety policy. Set 0 to fail after the first blocked attempt.',
  },
  harnessTimeoutSeconds: {
    label: 'Model-call timeout',
    unit: 'seconds',
    description: 'Maximum duration of each future scan harness invocation before it is terminated as timed out.',
  },
};

const SOURCE_LABELS = {
  runtime_config: 'Runtime config',
  process_environment: 'Process environment',
  project_environment: 'Project .env',
  default: 'Built-in default',
};

const CAPABILITIES = [
  {
    key: 'automaticScanResume',
    label: 'Whole-scan auto-resume',
    description: 'Automatically resume failed scans with durable progress and backoff.',
  },
];

export default function Settings() {
  const { data, loading, error, reload, setData } = useFetch(() => api.settings(), []);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (data) setDraft(runtimeSettingsDraft(data));
  }, [data]);

  const issues = useMemo(() => runtimeSettingsIssues(data, draft), [data, draft]);
  const patch = useMemo(() => runtimeSettingsPatch(data, draft), [data, draft]);
  const issueCount = Object.keys(issues).length;
  const changeCount = Object.keys(patch).length;
  const dirty = issueCount > 0 || changeCount > 0;
  useUnsavedChangesPrompt(dirty || saving);
  usePageChrome([{ label: 'Settings', active: true }], null, []);

  const set = (key, value) => {
    setNotice('');
    setSaveError(null);
    setDraft((current) => ({ ...current, [key]: value }));
  };

  const reset = () => {
    setDraft(runtimeSettingsDraft(data));
    setNotice('');
    setSaveError(null);
  };

  const save = async () => {
    if (!changeCount || issueCount || saving) return;
    if (
      patch.workerCount === 0 &&
      !window.confirm('Pause pickup of new engine work? Jobs already running will be allowed to finish.')
    )
      return;
    const worker = data.settings.workerCount;
    if (
      patch.workerCount > worker.recommendedMax &&
      !window.confirm(
        `Use ${patch.workerCount} engine workers? Values above ${worker.recommendedMax} can exhaust provider, Docker, network, CPU, or memory capacity.`
      )
    )
      return;
    if (
      patch.ignoreLowStorage === true &&
      !window.confirm(
        'Ignore the low-storage safeguard? New scan containers may fill the host disk, causing scans or other services to fail.'
      )
    )
      return;

    setSaving(true);
    setSaveError(null);
    setNotice('');
    try {
      const updated = await api.updateSettings(patch);
      setData(updated);
      setDraft(runtimeSettingsDraft(updated));
      setNotice(
        Object.prototype.hasOwnProperty.call(patch, 'workspaceSetupConcurrency')
          ? 'Settings saved. Live values apply to future work; recreate the engine container to apply workspace setup concurrency.'
          : 'Settings saved. Updated live values apply to future work.'
      );
    } catch (nextError) {
      setSaveError(nextError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="settings-page">
      <div className="settings-heading">
        <div>
          <h1>Settings</h1>
          <p>
            Tune non-secret engine runtime behavior. Provider credentials remain isolated under{' '}
            <Link to="/accounts">Accounts</Link> and are never returned here.
          </p>
        </div>
        {data && <div className="mono settings-updated-at">Loaded {new Date(data.generatedAt).toLocaleString()}</div>}
      </div>

      {loading && !data && <Spinner label="Loading settings…" />}
      {error && <ErrorState error={error} onRetry={reload} />}
      {saveError && <SettingsError error={saveError} />}
      {notice && <div className="settings-notice">{notice}</div>}

      {data && draft && (
        <>
          {!data.persistence.projectEnvironment && (
            <div className="settings-warning">
              The project environment file is unavailable. Live values can be updated, but an engine recreation may
              restore deployment-provided values.
            </div>
          )}

          <section className="settings-section">
            <div className="settings-section-heading">
              <div>
                <h2>Engine runtime</h2>
                <p>Only whitelisted, non-secret settings are exposed by the API.</p>
              </div>
              <div className="settings-actions">
                <Button variant="ghost" onClick={reset} disabled={!dirty || saving}>
                  Reset
                </Button>
                <Button onClick={save} disabled={!changeCount || issueCount > 0 || saving}>
                  {saving
                    ? 'Saving…'
                    : issueCount
                      ? 'Fix validation errors'
                      : changeCount
                        ? `Save ${changeCount} change${changeCount === 1 ? '' : 's'}`
                        : 'Saved'}
                </Button>
              </div>
            </div>

            <RuntimeSettingsFields data={data} draft={draft} issues={issues} saving={saving} onChange={set} />
          </section>

          <section className="settings-section">
            <div className="settings-section-heading">
              <div>
                <h2>Scheduling roadmap</h2>
                <p>Additional lifecycle behavior that remains intentionally manual.</p>
              </div>
            </div>
            <div className="settings-capability-grid">
              {CAPABILITIES.map((capability) => {
                const state = data.capabilities[capability.key];
                return (
                  <div className="settings-capability" key={capability.key}>
                    <div className="settings-card-topline">
                      <h3>{capability.label}</h3>
                      <span className="settings-badge settings-badge-muted">Not available</span>
                    </div>
                    <p>{capability.description}</p>
                    <div className="mono settings-env-key">Tracked by {state.trackedBy}</div>
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export function RuntimeSettingsFields({ data, draft, issues, saving, onChange }) {
  const entries = Object.entries(PRESENTATION);
  const availableEntries = entries.filter(([key]) => data.settings?.[key]);
  const missingLabels = entries.filter(([key]) => !data.settings?.[key]).map(([, presentation]) => presentation.label);

  return (
    <>
      {missingLabels.length > 0 && (
        <div className="settings-warning">
          Some settings are unavailable from the running backend and have been hidden: {missingLabels.join(', ')}.
          Restart the backend to load the current settings schema.
        </div>
      )}
      <div className="settings-grid">
        {availableEntries.map(([key, presentation]) =>
          data.settings[key].type === 'boolean' ? (
            <BooleanRuntimeSetting
              key={key}
              name={key}
              presentation={presentation}
              setting={data.settings[key]}
              value={draft[key]}
              issue={issues[key]}
              disabled={saving}
              onChange={(value) => onChange(key, value)}
            />
          ) : (
            <RuntimeSetting
              key={key}
              name={key}
              presentation={presentation}
              setting={data.settings[key]}
              value={draft[key]}
              issue={issues[key]}
              disabled={saving}
              ignored={key === 'minFreeStorageGb' && draft.ignoreLowStorage}
              onChange={(value) => onChange(key, value)}
            />
          )
        )}
      </div>
    </>
  );
}

function BooleanRuntimeSetting({ name, presentation, setting, value, issue, disabled, onChange }) {
  return (
    <article className="settings-card">
      <div className="settings-card-topline">
        <h3>{presentation.label}</h3>
        <span className="settings-badge settings-badge-live">Live</span>
      </div>
      <p>{presentation.description}</p>
      <label className="settings-toggle-row" htmlFor={`setting-${name}`}>
        <span>
          <strong>{value ? 'Enabled' : 'Disabled'}</strong>
          <small>{value ? presentation.enabledDescription : presentation.disabledDescription}</small>
        </span>
        <input
          id={`setting-${name}`}
          type="checkbox"
          checked={value}
          disabled={disabled}
          aria-invalid={Boolean(issue) || !setting.valid}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
      {issue && <div className="settings-field-error">{issue}</div>}
      {!setting.valid && !issue && (
        <div className="settings-field-error">The stored value was invalid; the safe default is shown.</div>
      )}
      <div className="settings-card-meta">
        <span className="mono settings-env-key">{setting.envKey}</span>
        <span>{SOURCE_LABELS[setting.source] || setting.source}</span>
        <span>Default {setting.defaultValue ? 'enabled' : 'disabled'}</span>
      </div>
    </article>
  );
}

function RuntimeSetting({ name, presentation, setting, value, issue, disabled, ignored, onChange }) {
  const rawValue = `${value}`.trim();
  const numericValue = rawValue && Number.isFinite(Number(rawValue)) ? Number(rawValue) : null;
  const aboveRecommendation = numericValue !== null && numericValue > setting.recommendedMax;
  const paused = name === 'workerCount' && numericValue === 0;
  const cyberRetryEnabled = name === 'cyberSafetyRetryCount' && numericValue !== null && numericValue > 0;
  return (
    <article className="settings-card">
      <div className="settings-card-topline">
        <h3>{presentation.label}</h3>
        <span className={`settings-badge ${setting.apply === 'live' ? 'settings-badge-live' : ''}`}>
          {setting.apply === 'live' ? 'Live' : 'Engine recreation'}
        </span>
      </div>
      <p>{presentation.description}</p>
      <label className="settings-input-label" htmlFor={`setting-${name}`}>
        <span>Value</span>
        <span className="mono">{presentation.unit}</span>
      </label>
      <input
        id={`setting-${name}`}
        className="mono settings-number-input"
        type="number"
        inputMode={setting.type === 'number' ? 'decimal' : 'numeric'}
        min={setting.min}
        max={setting.max}
        step={setting.step || 1}
        value={value}
        disabled={disabled}
        aria-invalid={Boolean(issue) || !setting.valid}
        onChange={(event) => onChange(event.target.value)}
      />
      {issue && <div className="settings-field-error">{issue}</div>}
      {!setting.valid && !issue && (
        <div className="settings-field-error">The stored value was invalid; the safe default is shown.</div>
      )}
      {(aboveRecommendation || paused || ignored || cyberRetryEnabled) && !issue && (
        <div className="settings-field-warning">
          {ignored
            ? 'This threshold is preserved but not enforced while the low-storage safeguard is ignored.'
            : paused
              ? 'New engine work will remain queued until worker slots are raised above zero.'
              : cyberRetryEnabled
                ? `A blocked request may run up to ${numericValue + 1} total attempts. The provider may reject every attempt.`
                : `Above the conservative recommendation of ${setting.recommendedMax}; verify provider and host capacity.`}
        </div>
      )}
      <div className="settings-card-meta">
        <span className="mono settings-env-key">{setting.envKey}</span>
        <span>{SOURCE_LABELS[setting.source] || setting.source}</span>
        <span>
          Range {setting.min}–{setting.max}
        </span>
      </div>
    </article>
  );
}

function SettingsError({ error }) {
  return (
    <div className="settings-error">
      {apiErrorMessages(error).map((message) => (
        <div key={message}>{message}</div>
      ))}
    </div>
  );
}

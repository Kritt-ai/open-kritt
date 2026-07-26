export const RUNTIME_SETTING_KEYS = [
  'workerCount',
  'maxConcurrentScans',
  'maxWorkersPerScan',
  'autoscaleScanWorkersOnProviderCapacity',
  'workspaceSetupConcurrency',
  'retryCount',
  'harnessTimeoutSeconds',
];

export function runtimeSettingsDraft(payload) {
  return Object.fromEntries(
    RUNTIME_SETTING_KEYS.map((key) => {
      const setting = payload?.settings?.[key];
      return [key, setting?.type === 'boolean' ? Boolean(setting.value) : `${setting?.value ?? ''}`];
    })
  );
}

export function runtimeSettingsIssues(payload, draft) {
  const issues = {};
  for (const key of RUNTIME_SETTING_KEYS) {
    const setting = payload?.settings?.[key];
    if (!setting) continue;
    if (setting.type === 'boolean') {
      if (typeof draft?.[key] !== 'boolean') issues[key] = 'Choose enabled or disabled.';
      continue;
    }
    const raw = `${draft?.[key] ?? ''}`.trim();
    if (!/^-?\d+$/.test(raw)) {
      issues[key] = 'Enter a whole number.';
      continue;
    }
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < setting.min || value > setting.max) {
      issues[key] = `Enter a value from ${setting.min} to ${setting.max}.`;
    }
  }
  return issues;
}

export function runtimeSettingsPatch(payload, draft) {
  if (Object.keys(runtimeSettingsIssues(payload, draft)).length) return {};
  const patch = {};
  for (const key of RUNTIME_SETTING_KEYS) {
    const setting = payload?.settings?.[key];
    if (!setting) continue;
    if (setting.type === 'boolean') {
      const value = draft?.[key];
      if (value !== setting.value || setting.valid === false) patch[key] = value;
      continue;
    }
    const value = Number(`${draft?.[key] ?? ''}`.trim());
    if (value !== setting.value || setting.valid === false) patch[key] = value;
  }
  return patch;
}

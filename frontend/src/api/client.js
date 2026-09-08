// Thin fetch wrapper around the open-kritt API.
// In dev, Vite proxies /api -> backend. In prod, VITE_API_BASE_URL can point
// directly at the backend origin.

function isLoopbackHostname(hostname) {
  const normalized = hostname?.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized?.endsWith('.localhost') ||
    normalized === '127.0.0.1' ||
    normalized === '::1'
  );
}

/**
 * Ignore loopback API overrides in the browser. They either bypass the local
 * same-origin proxy or refer to the visitor's computer for remote deployments.
 * Falling back to /api lets Vite's server-side proxy reach the backend in both
 * cases without requiring CORS.
 */
export function resolveApiBase(configuredBase, pageLocation) {
  const base = (configuredBase || '').replace(/\/$/, '');
  if (!base || !pageLocation) return base;

  try {
    const configuredUrl = new URL(base, pageLocation.origin);
    return isLoopbackHostname(configuredUrl.hostname) ? '' : base;
  } catch {
    return base;
  }
}

const BASE = resolveApiBase(
  import.meta.env.VITE_API_BASE_URL,
  typeof window === 'undefined' ? undefined : window.location
);

export class ApiError extends Error {
  constructor(message, status, errors, data = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.errors = errors || [];
    this.code = data?.code || null;
    this.data = data;
  }
}

export function apiErrorMessages(error, { includeField = true } = {}) {
  const details = Array.isArray(error?.errors)
    ? error.errors
        .map((item) => {
          const message = typeof item?.message === 'string' ? item.message.trim() : '';
          if (!message) return '';
          const field = typeof item?.field === 'string' ? item.field.trim() : '';
          return includeField && field ? `${field}: ${message}` : message;
        })
        .filter(Boolean)
    : [];
  if (details.length) return details;
  return [error?.message || 'Request failed.'];
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* no body */
  }
  if (!res.ok) {
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.errors, data);
  }
  return data;
}

function safeAttachmentFilename(value, fallback) {
  const filename = [...`${value || ''}`]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code > 31 && code !== 127;
    })
    .join('')
    .split(/[\\/]/)
    .pop()
    .trim();
  return filename || fallback;
}

export function attachmentFilename(contentDisposition, fallback = 'download.zip') {
  const header = `${contentDisposition || ''}`;
  const encoded = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return safeAttachmentFilename(decodeURIComponent(encoded.trim()), fallback);
    } catch {
      // Fall through to the plain filename parameter.
    }
  }
  const quoted = header.match(/filename\s*=\s*"((?:[^"\\]|\\.)*)"/i)?.[1];
  if (quoted) return safeAttachmentFilename(quoted.replace(/\\(["\\])/g, '$1'), fallback);
  const plain = header.match(/filename\s*=\s*([^;]+)/i)?.[1];
  return safeAttachmentFilename(plain?.trim(), fallback);
}

async function download(path, fallbackFilename) {
  const res = await fetch(`${BASE}/api${path}`, { cache: 'no-store' });
  if (!res.ok) {
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* no JSON error body */
    }
    throw new ApiError(data?.error || `Request failed (${res.status})`, res.status, data?.errors);
  }
  return {
    blob: await res.blob(),
    filename: attachmentFilename(res.headers.get('Content-Disposition'), fallbackFilename),
  };
}

export const api = {
  // overview
  overview: () => request('/overview'),
  // non-secret engine runtime settings
  settings: () => request('/settings'),
  updateSettings: (body) => request('/settings', { method: 'PATCH', body }),
  // workflows
  workflows: () => request('/workflows'),
  workflow: (id) => request(`/workflows/${id}`),
  createWorkflow: (body) => request('/workflows', { method: 'POST', body }),
  updateWorkflow: (id, body) => request(`/workflows/${id}`, { method: 'PUT', body }),
  deleteWorkflow: (id) => request(`/workflows/${id}`, { method: 'DELETE' }),
  // steps
  steps: () => request('/steps'),
  // scans
  scans: (status) => request(`/scans${status && status !== 'all' ? `?status=${status}` : ''}`),
  scanPage: ({ status = 'all', page = 1, pageSize = 6 } = {}) => {
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (status && status !== 'all') params.set('status', status);
    return request(`/scans?${params}`);
  },
  scan: (id) => request(`/scans/${id}`),
  scanVulnerabilities: (id) => request(`/scans/${id}/vulnerabilities`),
  supplementalPostScriptRuns: (id) => request(`/scans/${id}/supplemental-post-script-runs`),
  createSupplementalPostScriptRun: (id, body) =>
    request(`/scans/${id}/supplemental-post-script-runs`, { method: 'POST', body }),
  retrySupplementalPostScriptRun: (id, runId, body) =>
    request(`/scans/${id}/supplemental-post-script-runs/${runId}/retry`, { method: 'POST', body }),
  exportScanFindings: (id) => download(`/scans/${id}/export`, `scan-${id}-findings.zip`),
  createScan: (body) => request('/scans', { method: 'POST', body }),
  updateScan: (id, body) => request(`/scans/${id}`, { method: 'PATCH', body }),
  // model providers currently configured for the engine
  modelProviders: () => request('/model-providers'),
  // configured providers and their selectable model catalogs
  modelCatalog: () => request('/model-catalog'),
  // provider accounts, provider login sessions, and the managed OpenRouter key
  accounts: (refresh = false) => request(`/accounts${refresh ? '?refresh=1' : ''}`, { cache: 'no-store' }),
  accountSummary: () => request('/accounts/summary', { cache: 'no-store' }),
  accountProvider: (provider, refresh = false) =>
    request(`/accounts/provider/${encodeURIComponent(provider)}${refresh ? '?refresh=1' : ''}`, {
      cache: 'no-store',
    }),
  saveProviderCredential: (provider, credential) =>
    request(`/accounts/${provider}`, { method: 'POST', body: { credential } }),
  removeProviderCredential: (provider) => request(`/accounts/${provider}`, { method: 'DELETE' }),
  removeProviderAccount: (provider, accountId) =>
    request(`/accounts/${encodeURIComponent(provider)}/account/${encodeURIComponent(accountId)}`, {
      method: 'DELETE',
    }),
  startCodexWeeklyUsage: (accountId) =>
    request(`/accounts/codex/account/${encodeURIComponent(accountId)}/start-weekly`, { method: 'POST' }),
  useCodexManualReset: (accountId) =>
    request(`/accounts/codex/account/${encodeURIComponent(accountId)}/reset`, {
      method: 'POST',
      body: { confirm: 'use-reset' },
    }),
  startProviderLogin: (provider, accountId = null) =>
    request(`/accounts/${provider}/login`, {
      method: 'POST',
      ...(accountId ? { body: { accountId } } : {}),
    }),
  providerLogin: (sessionId) => request(`/accounts/login/${sessionId}`, { cache: 'no-store' }),
  submitProviderLoginCode: (sessionId, code) =>
    request(`/accounts/login/${sessionId}/input`, { method: 'POST', body: { code } }),
  cancelProviderLogin: (sessionId) => request(`/accounts/login/${sessionId}`, { method: 'DELETE' }),
  // AI-authored workflow and post-script drafts
  createGeneration: (body) => request('/generations', { method: 'POST', body }),
  generation: (id) => request(`/generations/${id}`),
  updateScanStatus: (id, status) => request(`/scans/${id}`, { method: 'PATCH', body: { status } }),
  resumeScan: (id) => request(`/scans/${id}`, { method: 'PATCH', body: { status: 'pending' } }),
  deleteScan: (id) => request(`/scans/${id}`, { method: 'DELETE' }),
  // vulnerabilities
  vulnerability: (id) => request(`/vulnerabilities/${id}`),
  updateVulnerability: (id, body) => request(`/vulnerabilities/${id}`, { method: 'PATCH', body }),
  // local repos available to scan
  localRepos: () => request('/local-repos'),
  localRepoStats: (name, options) => request(`/local-repos/${encodeURIComponent(name)}/stats`, options),
  // post-scripts
  postScripts: () => request('/post-scripts'),
  postScript: (id) => request(`/post-scripts/${id}`),
  createPostScript: (body) => request('/post-scripts', { method: 'POST', body }),
  updatePostScript: (id, body) => request(`/post-scripts/${id}`, { method: 'PUT', body }),
  deletePostScript: (id) => request(`/post-scripts/${id}`, { method: 'DELETE' }),
  // agent skills
  agentSkills: () => request('/agent-skills'),
  agentSkill: (id) => request(`/agent-skills/${id}`),
  createAgentSkill: (body) => request('/agent-skills', { method: 'POST', body }),
  updateAgentSkill: (id, body) => request(`/agent-skills/${id}`, { method: 'PUT', body }),
  deleteAgentSkill: (id) => request(`/agent-skills/${id}`, { method: 'DELETE' }),
  // severity rankers
  severityRankers: () => request('/severity-rankers'),
  severityRanker: (id) => request(`/severity-rankers/${id}`),
  createSeverityRanker: (body) => request('/severity-rankers', { method: 'POST', body }),
  updateSeverityRanker: (id, body) => request(`/severity-rankers/${id}`, { method: 'PUT', body }),
  deleteSeverityRanker: (id) => request(`/severity-rankers/${id}`, { method: 'DELETE' }),
};

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { renewClaudeCredential } from './claudeCredentials.js';
import { providerCredentialStatuses } from './providerCredentials.js';
import { CLAUDE_ACCOUNTS_ROOT, CLAUDE_HOME } from './providerLogins.js';

const EXECUTOR_VIEW_URL = process.env.EXECUTOR_VIEW_URL || 'http://executor-view:8090';
const EXECUTOR_VIEW_INTERNAL_TOKEN_FILE =
  process.env.EXECUTOR_VIEW_INTERNAL_TOKEN_FILE || '/executor-auth/internal-token';
const ACCOUNT_PROVIDER_IDS = ['codex', 'claude', 'openrouter'];
const EXECUTOR_ACCOUNT_TIMEOUT_MS = 180000;
const ACCOUNT_STATUS_KINDS = new Set(['available', 'limited', 'stale', 'expired', 'warning', 'missing']);
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeText(value, limit = 500) {
  return typeof value === 'string' ? value.slice(0, limit) : null;
}

function safeDetail(detail) {
  if (!detail || typeof detail !== 'object') return null;
  const label = safeText(detail.label, 100);
  const value = safeText(String(detail.value ?? ''), 500);
  if (!label || !value) return null;
  return { label, value, mono: Boolean(detail.mono) };
}

function safeLimit(limit) {
  if (!limit || typeof limit !== 'object') return null;
  return {
    usedPercent: Number.isFinite(Number(limit.usedPercent)) ? Number(limit.usedPercent) : null,
    windowMinutes: safeNumber(limit.windowMinutes),
    resetsAt: safeText(limit.resetsAt, 100),
  };
}

function safeManualResetCredits(credits) {
  if (!credits || typeof credits !== 'object') return null;
  const availableCount = safeNumber(credits.availableCount);
  const applicableAvailableCount = safeNumber(credits.applicableAvailableCount);
  const sanitizedCredits = Array.isArray(credits.credits)
    ? credits.credits
        .map((credit) => {
          if (!credit || typeof credit !== 'object') return null;
          const expiresAt = safeText(credit.expiresAt, 100);
          if (!expiresAt) return null;
          return {
            title: safeText(credit.title, 100) || 'Usage reset',
            expiresAt,
          };
        })
        .filter(Boolean)
        .slice(0, 50)
    : [];
  if (availableCount === null && applicableAvailableCount === null && !sanitizedCredits.length) return null;
  const result = {
    availableCount: availableCount === null ? null : Math.max(0, Math.trunc(availableCount)),
    applicableAvailableCount:
      applicableAvailableCount === null ? null : Math.max(0, Math.trunc(applicableAvailableCount)),
  };
  if (sanitizedCredits.length) result.credits = sanitizedCredits;
  return result;
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function safeCredit(credit) {
  if (!credit || typeof credit !== 'object') return null;
  const result = {
    usage: safeNumber(credit.usage),
    limit: safeNumber(credit.limit),
    remaining: safeNumber(credit.remaining),
    usedPercent: safeNumber(credit.usedPercent),
    dailyUsage: safeNumber(credit.dailyUsage),
    weeklyUsage: safeNumber(credit.weeklyUsage),
    monthlyUsage: safeNumber(credit.monthlyUsage),
    limitReset: safeText(credit.limitReset, 50),
    expiresAt: safeText(credit.expiresAt, 100),
  };
  return Object.values(result).some((value) => value !== null) ? result : null;
}

function safeAccount(account) {
  if (!account || typeof account !== 'object') return null;
  const statusKind = ACCOUNT_STATUS_KINDS.has(account.statusKind) ? account.statusKind : 'warning';
  const id = safeText(account.id, 200);
  return {
    id,
    label: safeText(account.label, 200) || 'Account',
    email: safeText(account.email, 320),
    path: safeText(account.path, 1000),
    active: Boolean(account.active),
    canRemove: Boolean(id && account.canRemove),
    status: safeText(account.status, 200) || 'unknown',
    statusKind,
    authError: safeText(account.authError, 500),
    plan: safeText(account.plan, 100),
    subscriptionUntil: safeText(account.subscriptionUntil, 100),
    details: Array.isArray(account.details) ? account.details.map(safeDetail).filter(Boolean).slice(0, 20) : [],
    credit: safeCredit(account.credit),
    rateLimits: account.rateLimits
      ? {
          observedAt: safeText(account.rateLimits.observedAt, 100),
          source: safeText(account.rateLimits.source, 100),
          primary: safeLimit(account.rateLimits.primary),
          secondary: safeLimit(account.rateLimits.secondary),
          manualResetCredits: safeManualResetCredits(account.rateLimits.manualResetCredits),
        }
      : null,
  };
}

async function executorInternalToken({ internalToken, internalTokenFile = EXECUTOR_VIEW_INTERNAL_TOKEN_FILE } = {}) {
  const configured = String(internalToken ?? process.env.EXECUTOR_VIEW_INTERNAL_TOKEN ?? '').trim();
  if (configured) return configured;
  try {
    const value = (await readFile(internalTokenFile, 'utf8')).trim();
    return value.length <= 4096 ? value : '';
  } catch {
    return '';
  }
}

function accountActionError(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

export async function consumeCodexManualReset(
  accountId,
  { executorViewUrl = EXECUTOR_VIEW_URL, internalToken, internalTokenFile } = {}
) {
  const token = await executorInternalToken({ internalToken, internalTokenFile });
  if (!token) throw accountActionError('Account service is unavailable.', 503);
  try {
    const response = await fetch(
      new URL(`/api/accounts/codex/${encodeURIComponent(accountId)}/reset`, executorViewUrl),
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(12000),
      }
    );
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const statusCode = response.status >= 400 && response.status < 500 ? response.status : 502;
      throw accountActionError(payload?.error || 'Could not use the Codex reset.', statusCode);
    }
    if (!['reset', 'alreadyRedeemed'].includes(payload?.outcome)) {
      throw accountActionError('Codex returned an unexpected reset response.');
    }
    return payload;
  } catch (error) {
    if (error?.statusCode) throw error;
    throw accountActionError('Account service is unavailable.', 503);
  }
}

export async function fetchExecutorProvider(
  providerId,
  {
    refresh = false,
    executorViewUrl = EXECUTOR_VIEW_URL,
    internalToken,
    internalTokenFile,
    timeoutMs = EXECUTOR_ACCOUNT_TIMEOUT_MS,
    claudeHome = CLAUDE_HOME,
    claudeAccountsRoot = CLAUDE_ACCOUNTS_ROOT,
    renewClaudeLogin = renewClaudeCredential,
  } = {}
) {
  if (!ACCOUNT_PROVIDER_IDS.includes(providerId)) return null;
  try {
    const token = await executorInternalToken({ internalToken, internalTokenFile });
    if (!token) return null;
    const requestProvider = async () => {
      const url = new URL(`/api/accounts/${providerId}`, executorViewUrl);
      if (refresh) url.searchParams.set('refresh', '1');
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return null;
      const payload = await response.json();
      return payload?.kind === providerId ? payload : null;
    };

    let provider = await requestProvider();
    const claudeLoginRejected =
      providerId === 'claude' && refresh && provider?.accounts?.some((account) => account?.statusKind === 'expired');
    if (claudeLoginRejected) {
      let renewed = false;
      const homes = new Set(
        provider.accounts
          .filter((account) => account?.statusKind === 'expired')
          .map((account) => {
            if (!account?.id || account.id === 'default') return claudeHome;
            return ACCOUNT_ID_PATTERN.test(account?.id || '') ? join(claudeAccountsRoot, account.id, '.claude') : null;
          })
          .filter(Boolean)
      );
      for (const home of homes) {
        try {
          renewed = (await renewClaudeLogin(home)) || renewed;
        } catch {
          // Preserve the sanitized sign-in response when local renewal cannot run.
        }
      }
      if (renewed) provider = await requestProvider();
    }
    return provider;
  } catch {
    return null;
  }
}

export async function fetchExecutorAccounts({
  refresh = false,
  executorViewUrl = EXECUTOR_VIEW_URL,
  internalToken,
  internalTokenFile,
  claudeHome,
  claudeAccountsRoot,
  renewClaudeLogin,
} = {}) {
  const providers = await Promise.all(
    ACCOUNT_PROVIDER_IDS.map((providerId) =>
      fetchExecutorProvider(providerId, {
        refresh,
        executorViewUrl,
        internalToken,
        internalTokenFile,
        claudeHome,
        claudeAccountsRoot,
        renewClaudeLogin,
      })
    )
  );
  const loaded = providers.filter(Boolean);
  return loaded.length ? { providers: loaded } : null;
}

export function buildAccountsOverview(statuses, executorAccounts) {
  const executorProviders = new Map(
    (Array.isArray(executorAccounts?.providers) ? executorAccounts.providers : [])
      .filter((provider) => provider && typeof provider.kind === 'string')
      .map((provider) => [provider.kind, provider])
  );

  const providers = statuses.map((status) => {
    const executorProvider = executorProviders.get(status.id);
    const accounts = Array.isArray(executorProvider?.accounts)
      ? executorProvider.accounts.map(safeAccount).filter(Boolean)
      : [];
    const hasActiveAccount = accounts.some((account) => account.active);
    const configured = status.configured || hasActiveAccount;
    return {
      ...status,
      configured,
      active: accounts.filter((account) => account.active).length,
      total: accounts.length,
      limited: accounts.filter((account) => account.statusKind === 'limited').length,
      stale: accounts.filter((account) => account.statusKind === 'stale').length,
      accounts,
    };
  });

  return {
    generatedAt: new Date().toISOString(),
    configuredProviders: providers.filter((provider) => provider.configured).length,
    providerCount: providers.length,
    active: providers.reduce((total, provider) => total + provider.active, 0),
    total: providers.reduce((total, provider) => total + provider.total, 0),
    providers,
  };
}

export async function getAccountsOverview({ refresh = false, statusOptions, executorOptions } = {}) {
  const [statuses, executorAccounts] = await Promise.all([
    Promise.resolve(providerCredentialStatuses(statusOptions)),
    fetchExecutorAccounts({ refresh, ...executorOptions }),
  ]);
  return buildAccountsOverview(statuses, executorAccounts);
}

export function getAccountsSummary({ statusOptions } = {}) {
  return buildAccountsOverview(providerCredentialStatuses(statusOptions), null);
}

export async function getAccountProvider(providerId, { refresh = false, statusOptions, executorOptions } = {}) {
  const status = providerCredentialStatuses(statusOptions).find((provider) => provider.id === providerId);
  if (!status) return null;
  const executorProvider = await fetchExecutorProvider(providerId, { refresh, ...executorOptions });
  const provider = buildAccountsOverview([status], executorProvider ? { providers: [executorProvider] } : null)
    .providers[0];
  return {
    ...provider,
    loadError: executorProvider ? null : 'Account status is unavailable.',
  };
}

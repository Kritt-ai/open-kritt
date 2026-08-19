import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api/client.js';
import Pagination from '../components/Pagination.jsx';
import { Button, ErrorState, Spinner } from '../components/ui.jsx';
import { usePageChrome } from '../context/ui.jsx';
import { usePagination } from '../lib/usePagination.js';

const PROVIDER_LINKS = {
  openrouter: 'https://openrouter.ai/settings/keys',
};

const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const RESET_ALIGNMENT_TOLERANCE_MS = 5000;

const SOURCE_LABELS = {
  managed_api_key: 'Managed in open·kritt',
  codex_login: 'Codex login',
  claude_login: 'Claude login',
  environment: 'Environment configuration',
};

export default function Accounts() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [removingAccount, setRemovingAccount] = useState(null);
  const [startingUsage, setStartingUsage] = useState(() => new Set());
  const [resettingUsage, setResettingUsage] = useState(() => new Set());
  const [loadingProviders, setLoadingProviders] = useState(() => new Set());
  const [providerErrors, setProviderErrors] = useState({});
  const loadSequence = useRef(0);

  const load = useCallback(async (refresh = false) => {
    const sequence = ++loadSequence.current;
    refresh ? setRefreshing(true) : setLoading(true);
    setError(null);
    try {
      const summary = await api.accountSummary();
      if (sequence !== loadSequence.current) return;
      const providerIds = summary.providers.map((provider) => provider.id);
      setData(summary);
      setLoading(false);
      setLoadingProviders(new Set(providerIds));
      setProviderErrors({});
      await Promise.all(
        providerIds.map(async (providerId) => {
          try {
            const provider = await api.accountProvider(providerId, refresh);
            if (sequence !== loadSequence.current) return;
            setData((current) => replaceAccountProvider(current, provider));
            if (provider.loadError) {
              setProviderErrors((current) => ({ ...current, [providerId]: provider.loadError }));
            }
          } catch (nextError) {
            if (sequence !== loadSequence.current) return;
            setProviderErrors((current) => ({
              ...current,
              [providerId]: nextError.message || `Could not load ${providerId} accounts.`,
            }));
          } finally {
            if (sequence === loadSequence.current) {
              setLoadingProviders((current) => {
                const next = new Set(current);
                next.delete(providerId);
                return next;
              });
            }
          }
        })
      );
    } catch (nextError) {
      if (sequence !== loadSequence.current) return;
      setError(nextError);
    } finally {
      if (sequence === loadSequence.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    // Executor View intentionally leaves its expensive account cache cold at startup.
    // The Accounts page is an explicit status surface, so hydrate that cache on entry.
    load(true);
  }, [load]);

  usePageChrome(
    [{ label: 'Accounts', active: true }],
    { label: refreshing ? 'Refreshing…' : 'Refresh accounts', onClick: () => load(true) },
    [refreshing, load]
  );

  const save = async (provider, credential) => {
    const next = await api.saveProviderCredential(provider.id, credential);
    setData(next);
    setEditing(null);
  };

  const remove = async (provider) => {
    if (!window.confirm('Remove the OpenRouter API key from open·kritt?')) return;
    const previous = data;
    setData(removeProviderFromOverview(data, provider.id));
    try {
      setError(null);
      setData(await api.removeProviderCredential(provider.id));
    } catch (nextError) {
      setData(previous);
      setError(nextError);
    }
  };

  const removeLoginAccount = async (provider, account) => {
    const label = account.email || account.label;
    const impact =
      provider.id === 'codex'
        ? 'This signs Codex out locally and removes its managed account home when applicable. Existing scans and results are kept.'
        : 'This signs Claude out locally and removes its managed account home when applicable. Existing scans and results are kept.';
    if (!window.confirm(`Remove ${label}?\n\n${impact}`)) return;
    const key = `${provider.id}:${account.id}`;
    const previous = data;
    setData(removeAccountFromOverview(data, provider.id, account.id));
    try {
      setError(null);
      setRemovingAccount(key);
      setData(await api.removeProviderAccount(provider.id, account.id));
    } catch (nextError) {
      setData(previous);
      setError(nextError);
    } finally {
      setRemovingAccount(null);
    }
  };

  const startWeeklyUsage = async (account) => {
    setError(null);
    setStartingUsage((current) => updatePendingAccounts(current, account.id, true));
    try {
      await startCodexWeeklyUsageUntilStarted(account.id, api.startCodexWeeklyUsage, setData);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setStartingUsage((current) => updatePendingAccounts(current, account.id, false));
    }
  };

  const useManualReset = async (account) => {
    const available = finiteNumber(account?.rateLimits?.manualResetCredits?.availableCount);
    const label = account.email || account.label;
    if (!window.confirm(`Use 1 of ${available} manual resets for ${label}?\n\nThis cannot be undone.`)) return;
    setError(null);
    setResettingUsage((current) => updatePendingAccounts(current, account.id, true));
    try {
      setData(await api.useCodexManualReset(account.id));
    } catch (nextError) {
      setError(nextError);
    } finally {
      setResettingUsage((current) => updatePendingAccounts(current, account.id, false));
    }
  };

  return (
    <div className="accounts-page" style={{ padding: '30px 32px 56px', maxWidth: 1240 }}>
      <div className="accounts-heading">
        <div>
          <div style={{ fontSize: 27, fontWeight: 600, letterSpacing: '-0.02em' }}>Accounts</div>
          <div style={{ color: 'var(--text-2)', marginTop: 7, maxWidth: 680, lineHeight: 1.5 }}>
            See which model providers are ready. Sign in to Codex or Claude with their official login flows, or add an
            OpenRouter API key. Secret values are never returned by the API.
          </div>
        </div>
        {data && (
          <div className="mono" style={{ color: 'var(--text-3)', fontSize: 11 }}>
            Updated {formatDate(data.generatedAt)}
          </div>
        )}
      </div>

      {loading && !data && <Spinner label="Loading provider accounts…" />}
      {error && <ErrorState error={error} onRetry={() => load()} />}

      {data && (
        <>
          <div className="account-summary-grid">
            <Summary label="Providers ready" value={`${data.configuredProviders}/${data.providerCount}`} />
            <Summary label="Active accounts" value={data.active} color="var(--ok)" />
            <Summary label="Accounts observed" value={data.total} />
          </div>

          <div className="account-provider-grid">
            {data.providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                onEdit={() => setEditing(provider)}
                onRemove={() => remove(provider)}
                onRemoveAccount={(account) => removeLoginAccount(provider, account)}
                onStartWeeklyUsage={startWeeklyUsage}
                onUseManualReset={useManualReset}
                removingAccount={removingAccount}
                startingUsage={startingUsage}
                resettingUsage={resettingUsage}
                loading={loadingProviders.has(provider.id)}
                loadError={providerErrors[provider.id]}
              />
            ))}
          </div>
        </>
      )}

      {editing?.management === 'login' && (
        <LoginDialog provider={editing} onClose={() => setEditing(null)} onComplete={() => load(true)} />
      )}
      {editing?.management === 'api_key' && (
        <CredentialDialog provider={editing} onClose={() => setEditing(null)} onSave={save} />
      )}
    </div>
  );
}

function Summary({ label, value, color = 'var(--text)' }) {
  return (
    <div className="account-summary-card">
      <div className="mono account-kicker">{label}</div>
      <div style={{ fontSize: 28, fontWeight: 600, marginTop: 8, color }}>{value}</div>
    </div>
  );
}

function ProviderCard({
  provider,
  onEdit,
  onRemove,
  onRemoveAccount,
  onStartWeeklyUsage,
  onUseManualReset,
  removingAccount,
  startingUsage,
  resettingUsage,
  loading,
  loadError,
}) {
  const accountPages = usePagination(provider.accounts || [], { pageSize: 5, resetKey: provider.id });
  const ready = provider.configured && provider.active > 0;
  const signInRequired =
    ['codex', 'claude'].includes(provider.id) && provider.accounts.some((account) => account.statusKind === 'expired');
  const status = loading
    ? 'Loading'
    : loadError
      ? 'Unavailable'
      : signInRequired
        ? 'Sign-in required'
        : provider.limited
          ? 'Limited'
          : ready
            ? 'Ready'
            : provider.configured
              ? 'Needs attention'
              : 'Not configured';
  const statusColor =
    loading || loadError || provider.limited || (provider.configured && !ready)
      ? 'var(--pend)'
      : ready
        ? 'var(--ok)'
        : 'var(--text-3)';
  return (
    <section className="account-provider-card" data-provider={provider.id}>
      <div className="account-provider-header">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <ProviderMark provider={provider.id} />
            <h2 style={{ fontSize: 18, margin: 0 }}>{provider.label}</h2>
          </div>
          <div style={{ color: 'var(--text-2)', fontSize: 12.5, lineHeight: 1.45, marginTop: 9 }}>
            {provider.description}
          </div>
        </div>
        <span className="account-status-badge" style={{ color: statusColor }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'currentColor' }} />
          {status}
        </span>
      </div>

      <div className="account-provider-meta">
        <span>{provider.active || 0} active</span>
        <span>{provider.total || 0} total</span>
        {provider.source && <span>{SOURCE_LABELS[provider.source] || provider.source}</span>}
      </div>

      <div className="account-list">
        {loading ? (
          <div className="account-empty">
            <Spinner label={`Loading ${provider.label} accounts…`} />
          </div>
        ) : loadError ? (
          <div className="account-empty">
            <div style={{ fontWeight: 500 }}>Could not load {provider.label} accounts</div>
            <div style={{ color: 'var(--text-2)', fontSize: 12, marginTop: 4 }}>{loadError}</div>
          </div>
        ) : provider.configured && provider.accounts.length ? (
          accountPages.pageItems.map((account, index) => (
            <AccountDetail
              key={`${account.path || account.label}-${accountPages.startIndex + index}`}
              providerId={provider.id}
              account={account}
              onRemove={() => onRemoveAccount(account)}
              onStartWeeklyUsage={() => onStartWeeklyUsage(account)}
              onUseManualReset={() => onUseManualReset(account)}
              removing={removingAccount === `${provider.id}:${account.id}`}
              startingUsage={startingUsage.has(account.id)}
              resettingUsage={resettingUsage.has(account.id)}
            />
          ))
        ) : (
          <div className="account-empty">
            <div style={{ fontWeight: 500 }}>
              {provider.configured
                ? `No ${provider.label} account data found`
                : `No ${provider.label} account configured`}
            </div>
            <div style={{ color: 'var(--text-2)', fontSize: 12, marginTop: 4 }}>
              {provider.configured
                ? `Refresh or reconnect ${provider.label} to load its accounts.`
                : provider.management === 'login'
                  ? `Sign in to ${provider.label} to make this provider available.`
                  : `Add ${provider.credentialLabel.toLowerCase()} to make this provider available.`}
            </div>
          </div>
        )}
      </div>
      <Pagination {...accountPages} itemLabel="accounts" compact />

      <div className="account-provider-actions">
        <Button onClick={onEdit}>{providerActionLabel(provider)}</Button>
        {provider.canRemove && (
          <Button variant="ghost" onClick={onRemove}>
            Remove key
          </Button>
        )}
        {PROVIDER_LINKS[provider.id] && (
          <a className="account-provider-link" href={PROVIDER_LINKS[provider.id]} target="_blank" rel="noreferrer">
            Get a key ↗
          </a>
        )}
      </div>
    </section>
  );
}

export function providerActionLabel(provider) {
  if (provider.management !== 'login') return provider.configured ? 'Add or replace key' : 'Add OpenRouter key';
  const signInRequired = provider.accounts.some((account) => account.statusKind === 'expired');
  if (provider.id === 'codex') return signInRequired ? 'Sign in to Codex again' : 'Add Codex account';
  if (signInRequired) return 'Sign in to Claude again';
  return 'Add Claude account';
}

export function updatePendingAccounts(current, accountId, pending) {
  const next = new Set(current);
  if (pending) next.add(accountId);
  else next.delete(accountId);
  return next;
}

export function providerReloginAccountId(provider) {
  if (!['codex', 'claude'].includes(provider.id)) return null;
  return provider.accounts.find((account) => account.statusKind === 'expired')?.id || null;
}

function recalculateOverview(overview, providers) {
  return {
    ...overview,
    configuredProviders: providers.filter((provider) => provider.configured).length,
    active: providers.reduce((total, provider) => total + (provider.active || 0), 0),
    total: providers.reduce((total, provider) => total + (provider.total || 0), 0),
    providers,
  };
}

export function replaceAccountProvider(overview, provider) {
  if (!overview || !provider) return overview;
  return recalculateOverview(
    overview,
    overview.providers.map((current) => (current.id === provider.id ? provider : current))
  );
}

export function removeAccountFromOverview(overview, providerId, accountId) {
  if (!overview) return overview;
  const providers = overview.providers.map((provider) => {
    if (provider.id !== providerId) return provider;
    const accounts = provider.accounts.filter((account) => account.id !== accountId);
    const active = accounts.filter((account) => account.active).length;
    return {
      ...provider,
      configured: accounts.length > 0,
      active,
      total: accounts.length,
      limited: accounts.filter((account) => account.statusKind === 'limited').length,
      stale: accounts.filter((account) => account.statusKind === 'stale').length,
      accounts,
    };
  });
  return recalculateOverview(overview, providers);
}

export function removeProviderFromOverview(overview, providerId) {
  if (!overview) return overview;
  const providers = overview.providers.map((provider) =>
    provider.id === providerId
      ? {
          ...provider,
          configured: false,
          source: null,
          managed: false,
          canRemove: false,
          active: 0,
          total: 0,
          accounts: [],
        }
      : provider
  );
  return recalculateOverview(overview, providers);
}

function ProviderMark({ provider }) {
  const label = provider === 'codex' ? 'CX' : provider === 'claude' ? 'CL' : 'OR';
  return <span className={`mono account-provider-mark account-provider-mark-${provider}`}>{label}</span>;
}

function AccountDetail({
  providerId,
  account,
  onRemove,
  onStartWeeklyUsage,
  onUseManualReset,
  removing,
  startingUsage,
  resettingUsage,
}) {
  const weeklyUsage = providerId === 'codex' ? codexWeeklyUsage(account) : null;
  const signInRequired = ['codex', 'claude'].includes(providerId) && account.statusKind === 'expired';
  const showRateLimits = providerId !== 'claude' || account.active;

  return (
    <div className="account-detail">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 550, overflowWrap: 'anywhere' }}>{account.email || account.label}</div>
          {account.path && (
            <div
              className="mono"
              style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 3, overflowWrap: 'anywhere' }}
            >
              {account.path}
            </div>
          )}
        </div>
        <span className={`account-kind account-kind-${account.statusKind}`}>{account.status}</span>
      </div>

      {account.plan && (
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 10 }}>
          Plan: {account.plan}
          {isFuture(account.subscriptionUntil) ? ` · ${formatUntil(account.subscriptionUntil, 'expires')}` : ''}
        </div>
      )}

      {signInRequired && <ProviderSignInRequired providerId={providerId} message={account.authError} />}

      {account.credit && <CreditUsage credit={account.credit} />}

      {weeklyUsage && (
        <CodexWeeklyUsage
          usage={weeklyUsage}
          onStart={onStartWeeklyUsage}
          onReset={onUseManualReset}
          starting={startingUsage}
          resetting={resettingUsage}
        />
      )}

      {account.details?.length > 0 && (
        <div className="account-detail-grid">
          {account.details.map((detail) => (
            <div key={`${detail.label}-${detail.value}`}>
              <div className="mono account-kicker">{detail.label}</div>
              <div
                className={detail.mono ? 'mono' : undefined}
                style={{ fontSize: 11.5, marginTop: 3, overflowWrap: 'anywhere' }}
              >
                {detail.value}
              </div>
            </div>
          ))}
        </div>
      )}

      {showRateLimits && (
        <AccountRateLimits providerId={providerId} rateLimits={account.rateLimits} authenticated={account.active} />
      )}

      {account.canRemove && (
        <div className="account-detail-actions">
          <Button variant="ghost" onClick={onRemove} disabled={removing} aria-label={`Remove ${account.label} account`}>
            {removing ? 'Removing…' : 'Remove account'}
          </Button>
        </div>
      )}
    </div>
  );
}

export function CodexSignInRequired() {
  return <ProviderSignInRequired providerId="codex" />;
}

export function ProviderSignInRequired({ providerId, message }) {
  const provider = providerId === 'claude' ? 'Claude' : 'Codex';
  return (
    <div className="account-auth-required" role="alert">
      <span className="account-auth-required-mark" aria-hidden="true">
        !
      </span>
      <div>
        <strong>Sign in to {provider} again</strong>
        <div>
          {message || `The saved token was rejected. Quota usage is hidden until this account is authenticated again.`}
        </div>
      </div>
    </div>
  );
}

export function CodexWeeklyUsage({ usage, onStart, onReset, starting, resetting }) {
  const busy = starting || resetting;
  const hasManualReset = usage.manualResetsAvailable !== null && usage.manualResetsAvailable > 0;
  const resetEligible = usage.manualResetsApplicable === null || usage.manualResetsApplicable > 0;
  const manualResetCredits = usage.manualResetCredits || [];
  return (
    <div
      className={`account-weekly-usage${usage.notStarted ? ' account-weekly-usage-warning' : ''}`}
      aria-busy={busy || undefined}
    >
      {usage.notStarted && (
        <div className="account-weekly-nudge">
          <span className="account-weekly-warning-mark" aria-hidden="true">
            !
          </span>
          <span>
            <strong>Weekly usage hasn’t started.</strong> Use this account now so its allowance doesn’t go unused.
          </span>
        </div>
      )}
      <div className="account-weekly-meta">
        <div className="account-weekly-stat">
          <span className="mono account-kicker">Weekly reset</span>
          <span>{usage.resetRemaining || 'Time unavailable'}</span>
        </div>
        {usage.manualResetsAvailable !== null && (
          <div className="account-weekly-stat account-manual-reset-stat">
            <span className="mono account-kicker">Manual resets</span>
            <span className="account-manual-reset-details">
              <span>{usage.manualResetsAvailable} available</span>
              {manualResetCredits.map((credit, index) => (
                <span className="account-manual-reset-expiry" key={`${credit.expiresAt}-${index}`}>
                  {credit.title} · Expires {formatResetExpiryDate(credit.expiresAt)}
                </span>
              ))}
            </span>
          </div>
        )}
      </div>
      {(usage.notStarted || hasManualReset) && (
        <div className="account-weekly-actions">
          {usage.notStarted && (
            <Button variant="ghost" onClick={onStart} disabled={busy} className="account-weekly-button">
              {starting ? 'Waiting…' : 'Start quota'}
            </Button>
          )}
          {hasManualReset && (
            <Button
              variant="ghost"
              onClick={onReset}
              disabled={busy || !resetEligible}
              className="account-weekly-button"
              title={resetEligible ? 'Use one manual reset' : 'No current usage window is eligible for a reset'}
            >
              {resetting ? 'Using reset…' : 'Use reset'}
            </Button>
          )}
        </div>
      )}
      {busy && (
        <div className="account-weekly-processing" role="status">
          <span className="account-weekly-spinner" aria-hidden="true" />
          {resetting
            ? 'Using a manual reset, then refreshing quota…'
            : 'Waiting for Codex, then refreshing quota. This can take a while.'}
        </div>
      )}
    </div>
  );
}

export function codexWeeklyUsage(account, now = Date.now()) {
  const weeklyLimit = [account?.rateLimits?.primary, account?.rateLimits?.secondary].find(
    (limit) => finiteNumber(limit?.windowMinutes) === WEEKLY_WINDOW_MINUTES
  );
  if (!weeklyLimit) return null;

  const usedPercent = finiteNumber(weeklyLimit.usedPercent);
  const observedAt = new Date(account?.rateLimits?.observedAt).getTime();
  const resetsAt = new Date(weeklyLimit.resetsAt).getTime();
  const weeklyWindowMs = finiteNumber(weeklyLimit.windowMinutes) * 60 * 1000;
  // Codex reports a moving reset exactly one window after observation until
  // the first usage anchors that reset. The displayed percentage alone may
  // still round a started window down to 0%.
  const resetIsFullWindowAway =
    Number.isFinite(observedAt) &&
    Number.isFinite(resetsAt) &&
    Math.abs(resetsAt - observedAt - weeklyWindowMs) <= RESET_ALIGNMENT_TOLERANCE_MS;
  const manualResetCredits = Array.isArray(account?.rateLimits?.manualResetCredits?.credits)
    ? account.rateLimits.manualResetCredits.credits
        .map((credit) => ({
          title: typeof credit?.title === 'string' && credit.title.trim() ? credit.title.trim() : 'Usage reset',
          expiresAt: credit?.expiresAt,
        }))
        .filter((credit) => Number.isFinite(new Date(credit.expiresAt).getTime()))
    : [];
  return {
    notStarted: Boolean(account?.active && usedPercent !== null && usedPercent <= 0 && resetIsFullWindowAway),
    resetRemaining: formatResetRemaining(weeklyLimit.resetsAt, now),
    manualResetsAvailable: finiteNumber(account?.rateLimits?.manualResetCredits?.availableCount),
    manualResetsApplicable: finiteNumber(account?.rateLimits?.manualResetCredits?.applicableAvailableCount),
    ...(manualResetCredits.length ? { manualResetCredits } : {}),
  };
}

export async function startCodexWeeklyUsageUntilStarted(accountId, startUsage, update, maxAttempts = 3) {
  let overview = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    overview = await startUsage(accountId);
    update(overview);
    const account = overview?.providers
      ?.find((provider) => provider.id === 'codex')
      ?.accounts?.find((candidate) => candidate.id === accountId);
    if (!codexWeeklyUsage(account)?.notStarted) break;
  }
  return overview;
}

export function formatResetRemaining(value, now = Date.now()) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '';

  let seconds = Math.ceil((timestamp - now) / 1000);
  if (seconds <= 0) return 'Reset due';
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h remaining`;
  if (hours) return `${hours}h ${minutes}m remaining`;
  if (minutes) return `${minutes}m remaining`;
  return '<1m remaining';
}

export function formatResetExpiryDate(value, locale) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'date unavailable';
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function CreditUsage({ credit }) {
  const usage = finiteNumber(credit.usage);
  const limit = finiteNumber(credit.limit);
  const percentage = Math.max(0, Math.min(100, finiteNumber(credit.usedPercent) || 0));
  const hasLimit = limit !== null;

  return (
    <div className="account-credit-summary">
      <div className="account-credit-heading">
        <div>
          <div className="mono account-kicker">Credit usage</div>
          <div className="account-credit-value">{usage === null ? '—' : `${formatUsd(usage)} used`}</div>
        </div>
        <div className="account-credit-percent">
          {hasLimit ? `${Math.round(percentage)}% of ${formatUsd(limit)}` : 'No key limit'}
        </div>
      </div>
      {hasLimit && (
        <div className="account-limit-track">
          <div style={{ width: `${percentage}%`, background: percentage >= 90 ? 'var(--fail)' : 'var(--accent)' }} />
        </div>
      )}
      <div className="account-credit-note">{creditUsageNote(credit)}</div>
    </div>
  );
}

export function creditUsageNote(credit) {
  const limit = finiteNumber(credit?.limit);
  if (limit === null) return 'No per-key spending limit; remaining account credits are unavailable.';
  const remaining = finiteNumber(credit?.remaining);
  const remainingLabel = remaining === null ? 'Remaining amount unavailable' : `${formatUsd(remaining)} remaining`;
  const reset = credit?.limitReset ? `${credit.limitReset} reset` : 'Does not reset';
  return `${remainingLabel} · ${reset}`;
}

export function AccountRateLimits({ providerId, rateLimits, authenticated = true }) {
  const showClaudeUsage = providerId === 'claude';
  if (showClaudeUsage && !authenticated) return null;
  const primary = rateLimits?.primary;
  const secondary = rateLimits?.secondary;
  if (!showClaudeUsage && !primary && !secondary) return null;

  const unavailableNote = showClaudeUsage ? 'Usage unavailable · refresh or reconnect Claude' : undefined;
  return (
    <div className="account-limit-grid">
      {(primary || showClaudeUsage) && (
        <RateLimit
          label={rateLimitLabel(primary, showClaudeUsage ? '5-hour window' : 'Primary window')}
          limit={primary}
          unavailableNote={unavailableNote}
        />
      )}
      {(secondary || showClaudeUsage) && (
        <RateLimit
          label={rateLimitLabel(secondary, showClaudeUsage ? 'Weekly window' : 'Secondary window')}
          limit={secondary}
          unavailableNote={unavailableNote}
        />
      )}
    </div>
  );
}

function RateLimit({ label, limit, unavailableNote = 'No recent limit data' }) {
  const used = Math.max(0, Math.min(100, Number(limit?.usedPercent) || 0));
  const note = limit?.resetsAt ? formatUntil(limit.resetsAt, 'resets') : limit ? null : unavailableNote;
  return (
    <div>
      <div className="mono account-kicker">{label}</div>
      <div style={{ fontWeight: 600, fontSize: 17, marginTop: 5 }}>{limit ? `${Math.round(used)}%` : '—'}</div>
      <div
        className="account-limit-track"
        role="progressbar"
        aria-label={`${label} usage`}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuenow={limit ? Math.round(used) : undefined}
        aria-valuetext={limit ? `${Math.round(used)}% used` : 'Usage unavailable'}
      >
        <div style={{ width: `${used}%`, background: used >= 90 ? 'var(--fail)' : 'var(--accent)' }} />
      </div>
      {note && <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 5 }}>{note}</div>}
    </div>
  );
}

export function rateLimitLabel(limit, fallback) {
  const minutes = finiteNumber(limit?.windowMinutes);
  if (minutes === null || minutes <= 0) return fallback;
  if (minutes === WEEKLY_WINDOW_MINUTES) return 'Weekly window';
  if (minutes === 24 * 60) return 'Daily window';
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day window`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour window`;
  return `${minutes}-minute window`;
}

function LoginDialog({ provider, onClose, onComplete }) {
  const completionReported = useRef(false);
  const [session, setSession] = useState(null);
  const [starting, setStarting] = useState(false);
  const [callbackCode, setCallbackCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const active = session && ['starting', 'waiting'].includes(session.status);
  const reloginAccountId = providerReloginAccountId(provider);
  const relogin = Boolean(reloginAccountId);

  useEffect(() => {
    if (!active) return undefined;
    let stopped = false;
    const poll = async () => {
      try {
        const next = await api.providerLogin(session.id);
        if (!stopped) setSession(next);
      } catch (nextError) {
        if (!stopped) setError(nextError.message || 'Could not read the login status.');
      }
    };
    const interval = window.setInterval(poll, 1000);
    return () => {
      stopped = true;
      window.clearInterval(interval);
    };
  }, [active, session?.id]);

  useEffect(() => {
    if (session?.status !== 'completed' || completionReported.current) return;
    completionReported.current = true;
    onComplete();
  }, [session?.status, onComplete]);

  useEffect(() => {
    if (active) return undefined;
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, onClose]);

  const start = async () => {
    setStarting(true);
    setError(null);
    try {
      setSession(await api.startProviderLogin(provider.id, reloginAccountId));
    } catch (nextError) {
      setError(nextError.message || `Could not start ${provider.label} login.`);
    } finally {
      setStarting(false);
    }
  };

  const submitCode = async (event) => {
    event.preventDefault();
    if (!callbackCode.trim()) {
      setError('Paste the callback code from Claude.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      setSession(await api.submitProviderLoginCode(session.id, callbackCode));
      setCallbackCode('');
    } catch (nextError) {
      setError(nextError.message || 'Could not submit the callback code.');
    } finally {
      setSubmitting(false);
    }
  };

  const cancel = async () => {
    if (active) {
      try {
        await api.cancelProviderLogin(session.id);
      } catch {
        // The process may have completed between the last poll and this click.
      }
    }
    onClose();
  };

  return (
    <div className="account-dialog-backdrop" role="presentation" onMouseDown={() => !active && onClose()}>
      <div
        className="account-dialog account-login-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-login-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="account-dialog-header">
          <div>
            <div className="mono account-kicker">{provider.label}</div>
            <div id="account-login-title" style={{ fontSize: 20, fontWeight: 600, marginTop: 5 }}>
              {relogin
                ? `Sign in to ${provider.label} again`
                : provider.id === 'codex'
                  ? 'Add Codex account'
                  : 'Add Claude account'}
            </div>
          </div>
          <button className="account-dialog-close" type="button" aria-label="Close" onClick={cancel}>
            ×
          </button>
        </div>

        {!session && (
          <div className="account-login-intro">
            {provider.id === 'codex' ? (
              <>
                Codex will create a one-time device code. Open the sign-in page, enter the code, and authenticate the
                ChatGPT account you want open·kritt to use.
              </>
            ) : (
              <>
                Claude will open its subscription sign-in page. After authentication, copy the callback code into this
                dialog to {relogin ? 'replace the expired login on this account' : 'add this Claude account'}.
              </>
            )}
          </div>
        )}

        {session && (
          <div className={`account-login-state account-login-state-${session.status}`}>
            <div className="mono account-kicker">{loginStatusLabel(session.status)}</div>
            <div style={{ marginTop: 6, lineHeight: 1.5 }}>{session.message}</div>
          </div>
        )}

        {session?.authorizationUrl && session.status !== 'completed' && (
          <a className="account-login-link" href={session.authorizationUrl} target="_blank" rel="noreferrer">
            Open {provider.label} sign-in page ↗
          </a>
        )}

        {session?.deviceCode && session.status !== 'completed' && (
          <div className="account-device-code-wrap">
            <div className="mono account-kicker">One-time device code</div>
            <div className="mono account-device-code">{session.deviceCode}</div>
            <Button variant="ghost" onClick={() => navigator.clipboard?.writeText(session.deviceCode)}>
              Copy code
            </Button>
          </div>
        )}

        {session?.requiresInput && session.status === 'waiting' && (
          <form onSubmit={submitCode}>
            <label htmlFor="claude-callback-code" style={{ display: 'block', fontWeight: 500, fontSize: 13 }}>
              Claude callback code
            </label>
            <input
              id="claude-callback-code"
              type="password"
              autoComplete="off"
              spellCheck="false"
              value={callbackCode}
              onChange={(event) => setCallbackCode(event.target.value)}
              placeholder="Paste code"
              className="account-credential-input mono"
            />
            <Button type="submit" disabled={submitting} style={{ marginTop: 12 }}>
              {submitting ? 'Verifying…' : 'Finish Claude login'}
            </Button>
          </form>
        )}

        {error && <div className="account-dialog-error">{error}</div>}

        <div className="account-dialog-actions">
          {session?.status === 'completed' ? (
            <Button onClick={onClose}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" onClick={cancel}>
                {active ? 'Cancel login' : 'Cancel'}
              </Button>
              {!session && (
                <Button onClick={start} disabled={starting}>
                  {starting ? 'Starting…' : 'Start login'}
                </Button>
              )}
              {session?.status === 'failed' && <Button onClick={start}>Try again</Button>}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function loginStatusLabel(status) {
  if (status === 'completed') return 'Login complete';
  if (status === 'failed') return 'Login failed';
  if (status === 'canceled') return 'Login canceled';
  return 'Waiting for sign-in';
}

function CredentialDialog({ provider, onClose, onSave }) {
  const inputRef = useRef(null);
  const [credential, setCredential] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (event) => {
    event.preventDefault();
    if (!credential.trim()) {
      setError('Enter an API key.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(provider, credential);
      setCredential('');
    } catch (nextError) {
      setError(nextError.errors?.[0]?.message || nextError.message || 'Could not save the credential.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="account-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <form
        className="account-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="account-dialog-header">
          <div>
            <div className="mono account-kicker">{provider.label}</div>
            <div id="account-dialog-title" style={{ fontSize: 20, fontWeight: 600, marginTop: 5 }}>
              {provider.configured ? 'Add or replace API key' : 'Add account'}
            </div>
          </div>
          <button className="account-dialog-close" type="button" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>

        <label htmlFor="provider-credential" style={{ display: 'block', fontWeight: 500, fontSize: 13, marginTop: 22 }}>
          {provider.credentialLabel}
        </label>
        <input
          ref={inputRef}
          id="provider-credential"
          type="password"
          autoComplete="off"
          spellCheck="false"
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          placeholder="Paste key"
          className="account-credential-input mono"
        />
        <div style={{ color: 'var(--text-2)', fontSize: 11.5, lineHeight: 1.5, marginTop: 8 }}>
          Stored locally with restricted file permissions. The value is sent once and is never displayed again.
        </div>
        {error && <div className="account-dialog-error">{error}</div>}

        <div className="account-dialog-actions">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={saving}>
            {saving ? 'Saving…' : 'Save account'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? 'just now'
    : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function formatUntil(value, verb) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return '';
  let seconds = Math.round((timestamp - Date.now()) / 1000);
  if (seconds <= 0) return verb === 'resets' ? 'reset time passed' : verb === 'expires' ? 'expired' : 'time passed';
  const days = Math.floor(seconds / 86400);
  seconds %= 86400;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${verb} in ${days}d ${hours}h`;
  if (hours) return `${verb} in ${hours}h ${minutes}m`;
  return `${verb} in ${Math.max(1, minutes)}m`;
}

function isFuture(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatUsd(value) {
  const amount = finiteNumber(value);
  if (amount === null) return '—';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

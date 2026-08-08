import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AccountRateLimits,
  CodexSignInRequired,
  CodexWeeklyUsage,
  ProviderSignInRequired,
  codexWeeklyUsage,
  creditUsageNote,
  formatResetExpiryDate,
  formatResetRemaining,
  providerActionLabel,
  providerReloginAccountId,
  rateLimitLabel,
  removeAccountFromOverview,
  removeProviderFromOverview,
  replaceAccountProvider,
  startCodexWeeklyUsageUntilStarted,
} from './Accounts.jsx';

describe('expired Codex login', () => {
  it('explains that authentication, not usage, needs attention', () => {
    const html = renderToStaticMarkup(createElement(CodexSignInRequired));

    expect(html).toContain('role="alert"');
    expect(html).toContain('Sign in to Codex again');
    expect(html).toContain('saved token was rejected');
    expect(html).toContain('Quota usage is hidden');
  });

  it('changes the provider action from adding an account to signing in again', () => {
    expect(
      providerActionLabel({
        id: 'codex',
        management: 'login',
        configured: true,
        accounts: [{ statusKind: 'expired' }],
      })
    ).toBe('Sign in to Codex again');
    expect(providerActionLabel({ id: 'codex', management: 'login', configured: true, accounts: [] })).toBe(
      'Add Codex account'
    );
    expect(
      providerReloginAccountId({
        id: 'codex',
        accounts: [
          { id: 'active', statusKind: 'available' },
          { id: 'expired', statusKind: 'expired' },
        ],
      })
    ).toBe('expired');
  });
});

describe('Claude usage bars', () => {
  it('hides usage bars while Claude requires authentication', () => {
    const html = renderToStaticMarkup(createElement(AccountRateLimits, { providerId: 'claude', authenticated: false }));

    expect(html).toBe('');
  });

  it('renders live Claude percentages when both usage windows are available', () => {
    const html = renderToStaticMarkup(
      createElement(AccountRateLimits, {
        providerId: 'claude',
        rateLimits: {
          primary: { usedPercent: 47.2, windowMinutes: 300 },
          secondary: { usedPercent: 8.9, windowMinutes: 10080 },
        },
      })
    );

    expect(html).toContain('47%');
    expect(html).toContain('9%');
    expect(html).toContain('aria-valuenow="47"');
    expect(html).toContain('aria-valuenow="9"');
  });

  it('does not call usage unavailable when an unused window has no reset time yet', () => {
    const html = renderToStaticMarkup(
      createElement(AccountRateLimits, {
        providerId: 'claude',
        rateLimits: {
          primary: { usedPercent: 0, windowMinutes: 300, resetsAt: null },
          secondary: { usedPercent: 0, windowMinutes: 10080, resetsAt: null },
        },
      })
    );

    expect(html).toContain('aria-valuenow="0"');
    expect(html).not.toContain('Usage unavailable');
  });
});

describe('multiple Claude accounts', () => {
  it('offers another account instead of reconnecting the configured provider', () => {
    expect(
      providerActionLabel({
        id: 'claude',
        management: 'login',
        configured: true,
        accounts: [{ id: 'default', statusKind: 'available' }],
      })
    ).toBe('Add Claude account');
    expect(
      providerActionLabel({
        id: 'claude',
        management: 'login',
        configured: false,
        accounts: [],
      })
    ).toBe('Add Claude account');
  });
});

describe('expired Claude login', () => {
  it('shows the provider authentication error and a same-account login action', () => {
    const html = renderToStaticMarkup(
      createElement(ProviderSignInRequired, {
        providerId: 'claude',
        message: 'Claude rejected the saved login (HTTP 401). Sign in to Claude again to renew this account.',
      })
    );
    const provider = {
      id: 'claude',
      management: 'login',
      configured: true,
      accounts: [{ id: 'default', statusKind: 'expired' }],
    };

    expect(html).toContain('Sign in to Claude again');
    expect(html).toContain('HTTP 401');
    expect(providerActionLabel(provider)).toBe('Sign in to Claude again');
    expect(providerReloginAccountId(provider)).toBe('default');
  });
});

describe('rateLimitLabel', () => {
  it('uses each provider window duration instead of a fixed slot label', () => {
    expect(rateLimitLabel({ windowMinutes: 300 }, 'Primary window')).toBe('5-hour window');
    expect(rateLimitLabel({ windowMinutes: 10080 }, 'Primary window')).toBe('Weekly window');
    expect(rateLimitLabel(null, 'Primary window')).toBe('Primary window');
  });
});

describe('Codex weekly usage', () => {
  const now = Date.parse('2026-07-19T10:00:00Z');

  it('recommends starting active accounts with an untouched weekly window', () => {
    expect(
      codexWeeklyUsage(
        {
          active: true,
          rateLimits: {
            observedAt: '2026-07-19T10:00:00Z',
            manualResetCredits: {
              availableCount: 3,
              applicableAvailableCount: 1,
              credits: [{ title: 'Full reset', expiresAt: '2026-08-12T18:07:27Z' }],
            },
            primary: {
              usedPercent: 0,
              windowMinutes: 10080,
              resetsAt: '2026-07-26T10:00:00Z',
            },
          },
        },
        now
      )
    ).toEqual({
      notStarted: true,
      resetRemaining: '7d 0h remaining',
      manualResetsAvailable: 3,
      manualResetsApplicable: 1,
      manualResetCredits: [{ title: 'Full reset', expiresAt: '2026-08-12T18:07:27Z' }],
    });
  });

  it('still reports the reset remaining after weekly usage starts', () => {
    expect(
      codexWeeklyUsage(
        {
          active: true,
          rateLimits: {
            observedAt: '2026-07-19T10:00:00Z',
            secondary: {
              usedPercent: 0.5,
              windowMinutes: 10080,
              resetsAt: '2026-07-19T13:15:00Z',
            },
          },
        },
        now
      )
    ).toEqual({
      notStarted: false,
      resetRemaining: '3h 15m remaining',
      manualResetsAvailable: null,
      manualResetsApplicable: null,
    });
  });

  it('does not mistake rounded-down usage for an untouched window once its reset clock is running', () => {
    expect(
      codexWeeklyUsage(
        {
          active: true,
          rateLimits: {
            observedAt: '2026-07-19T10:00:00Z',
            primary: {
              usedPercent: 0,
              windowMinutes: 10080,
              resetsAt: '2026-07-26T09:50:00Z',
            },
          },
        },
        now
      )
    ).toEqual({
      notStarted: false,
      resetRemaining: '6d 23h remaining',
      manualResetsAvailable: null,
      manualResetsApplicable: null,
    });
  });

  it('does not infer untouched usage when the weekly percentage is unavailable', () => {
    expect(
      codexWeeklyUsage({ active: true, rateLimits: { primary: { windowMinutes: 10080, usedPercent: null } } }, now)
    ).toEqual({
      notStarted: false,
      resetRemaining: '',
      manualResetsAvailable: null,
      manualResetsApplicable: null,
    });
    expect(codexWeeklyUsage({ active: true, rateLimits: { primary: { windowMinutes: 300 } } }, now)).toBeNull();
  });

  it('formats due and sub-minute resets clearly', () => {
    expect(formatResetRemaining('2026-07-19T10:00:00Z', now)).toBe('Reset due');
    expect(formatResetRemaining('2026-07-19T10:00:30Z', now)).toBe('<1m remaining');
  });

  it('shows a persistent processing cue while Codex is running', () => {
    const html = renderToStaticMarkup(
      createElement(CodexWeeklyUsage, {
        usage: {
          notStarted: true,
          resetRemaining: '7d remaining',
          manualResetsAvailable: 3,
          manualResetsApplicable: 1,
        },
        onStart: () => {},
        onReset: () => {},
        starting: true,
      })
    );

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Waiting for Codex, then refreshing quota');
    expect(html).toContain('account-weekly-spinner');
    expect(html).toContain('Manual resets');
    expect(html).toContain('3 available');
  });

  it('shows but disables reset use when no usage window is eligible', () => {
    const html = renderToStaticMarkup(
      createElement(CodexWeeklyUsage, {
        usage: {
          notStarted: false,
          resetRemaining: '2d remaining',
          manualResetsAvailable: 3,
          manualResetsApplicable: 0,
        },
        onReset: () => {},
      })
    );

    expect(html).toContain('Use reset');
    expect(html).toContain('disabled=""');
    expect(html).toContain('No current usage window is eligible');
  });

  it('shows the expiry date for each available manual reset', () => {
    const html = renderToStaticMarkup(
      createElement(CodexWeeklyUsage, {
        usage: {
          notStarted: false,
          resetRemaining: '2d remaining',
          manualResetsAvailable: 2,
          manualResetsApplicable: 1,
          manualResetCredits: [
            { title: 'Full reset', expiresAt: '2026-08-12T18:07:27Z' },
            { title: 'Full reset', expiresAt: '2026-08-13T18:07:27Z' },
          ],
        },
        onReset: () => {},
      })
    );

    expect(html).toContain('Full reset · Expires Aug 12, 2026');
    expect(html).toContain('Full reset · Expires Aug 13, 2026');
    expect(formatResetExpiryDate('2026-08-12T18:07:27Z', 'en-US')).toBe('Aug 12, 2026');
  });

  it('retries at most three times while the refreshed timestamp still shows an untouched window', async () => {
    const overview = (notStarted) => ({
      providers: [
        {
          id: 'codex',
          accounts: [
            {
              id: 'reviewer',
              active: true,
              rateLimits: {
                observedAt: '2026-07-19T10:00:00Z',
                primary: {
                  usedPercent: notStarted ? 0 : 0.1,
                  windowMinutes: 10080,
                  resetsAt: '2026-07-26T10:00:00Z',
                },
              },
            },
          ],
        },
      ],
    });
    const updates = [];
    let calls = 0;
    const start = async () => {
      calls += 1;
      return overview(calls < 3);
    };

    await startCodexWeeklyUsageUntilStarted('reviewer', start, (next) => updates.push(next));

    expect(calls).toBe(3);
    expect(updates).toHaveLength(3);
    expect(codexWeeklyUsage(updates.at(-1).providers[0].accounts[0])?.notStarted).toBe(false);
  });

  it('stops retrying as soon as the refreshed warning is no longer valid', async () => {
    let calls = 0;
    const cleared = {
      providers: [{ id: 'codex', accounts: [{ id: 'reviewer', active: true, rateLimits: {} }] }],
    };

    await startCodexWeeklyUsageUntilStarted(
      'reviewer',
      async () => {
        calls += 1;
        return cleared;
      },
      () => {}
    );

    expect(calls).toBe(1);
  });
});

describe('creditUsageNote', () => {
  it('does not describe missing key-limit data as unlimited account credits', () => {
    expect(creditUsageNote({ usage: 12.5, limit: null, remaining: null })).toBe(
      'No per-key spending limit; remaining account credits are unavailable.'
    );
  });

  it('distinguishes an unavailable remaining amount from a zero balance', () => {
    expect(creditUsageNote({ limit: 100, remaining: null, limitReset: null })).toBe(
      'Remaining amount unavailable · Does not reset'
    );
    expect(creditUsageNote({ limit: 100, remaining: 0, limitReset: 'monthly' })).toContain('$0.00 remaining');
  });
});

describe('optimistic account removal', () => {
  const overview = {
    configuredProviders: 3,
    providerCount: 3,
    active: 3,
    total: 3,
    providers: [
      {
        id: 'codex',
        configured: true,
        active: 1,
        total: 1,
        limited: 0,
        stale: 0,
        accounts: [{ id: 'primary', active: true, statusKind: 'available' }],
      },
      {
        id: 'claude',
        configured: true,
        active: 1,
        total: 1,
        limited: 0,
        stale: 0,
        accounts: [{ id: 'default', active: true, statusKind: 'available' }],
      },
      {
        id: 'openrouter',
        configured: true,
        source: 'environment',
        managed: false,
        canRemove: true,
        active: 1,
        total: 1,
        accounts: [{ id: 'openrouter-key', active: true, statusKind: 'available' }],
      },
    ],
  };

  it('removes the last login account and updates summary counts immediately', () => {
    const next = removeAccountFromOverview(overview, 'codex', 'primary');

    expect(next.providers[0]).toMatchObject({ configured: false, active: 0, total: 0, accounts: [] });
    expect(next).toMatchObject({ configuredProviders: 2, active: 2, total: 2 });
  });

  it('removes an environment-bootstrapped key from the visible overview', () => {
    const next = removeProviderFromOverview(overview, 'openrouter');

    expect(next.providers[2]).toMatchObject({
      configured: false,
      source: null,
      managed: false,
      canRemove: false,
      active: 0,
      total: 0,
      accounts: [],
    });
    expect(next).toMatchObject({ configuredProviders: 2, active: 2, total: 2 });
  });

  it('merges each independently loaded provider without replacing the others', () => {
    const next = replaceAccountProvider(overview, {
      ...overview.providers[1],
      active: 0,
      total: 0,
      accounts: [],
    });

    expect(next.providers[0]).toBe(overview.providers[0]);
    expect(next.providers[1]).toMatchObject({ id: 'claude', active: 0, total: 0, accounts: [] });
    expect(next.providers[2]).toBe(overview.providers[2]);
    expect(next).toMatchObject({ active: 2, total: 2 });
  });
});

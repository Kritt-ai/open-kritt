import { describe, expect, it } from 'vitest';
import { routeIdentityChanged } from './useUnsavedChangesPrompt.js';

describe('routeIdentityChanged', () => {
  it('treats a search-only draft source change as navigation', () => {
    expect(
      routeIdentityChanged(
        { pathname: '/workflows/new', search: '' },
        { pathname: '/workflows/new', search: '?from=42' }
      )
    ).toBe(true);
  });

  it('does not block an identical route identity', () => {
    expect(
      routeIdentityChanged(
        { pathname: '/workflows/new', search: '?from=42' },
        { pathname: '/workflows/new', search: '?from=42' }
      )
    ).toBe(false);
  });
});

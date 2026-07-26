import { useEffect, useRef } from 'react';
import { useBlocker } from 'react-router-dom';

export function routeIdentityChanged(currentLocation, nextLocation) {
  return currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search;
}

// Prompts the user before leaving the current route while `when` is true.
// Covers in-app navigation (clicking another section/tab) via the router blocker,
// and browser-level navigation (refresh / closing the tab) via beforeunload.
//
// Returns { allow } — call allow() right before an intentional navigation (e.g.
// after a successful save) so it doesn't prompt.
export function useUnsavedChangesPrompt(
  when,
  message = 'You have unsaved changes here. Are you sure you want to leave?'
) {
  const bypass = useRef(false);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      when && !bypass.current && routeIdentityChanged(currentLocation, nextLocation)
  );

  useEffect(() => {
    if (blocker.state === 'blocked') {
      if (window.confirm(message)) blocker.proceed();
      else blocker.reset();
    }
  }, [blocker, message]);

  useEffect(() => {
    if (!when) return undefined;
    const handler = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [when]);

  return {
    allow: () => {
      bypass.current = true;
    },
  };
}

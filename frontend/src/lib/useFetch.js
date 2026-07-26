import { useState, useEffect, useCallback, useRef } from 'react';

// Small request-generation guard used by useFetch. A route change, reload, or
// newer foreground request invalidates every older request so late responses
// cannot replace data that belongs to the current route. Background polls wait
// for the current request to finish instead of continuously superseding it.
export function createLatestRequestGate() {
  let generation = 0;
  let pendingGeneration = null;
  return {
    begin: ({ background = false } = {}) => {
      if (background && pendingGeneration !== null) return null;
      pendingGeneration = ++generation;
      return pendingGeneration;
    },
    isCurrent: (requestGeneration) => requestGeneration === generation,
    finish: (requestGeneration) => {
      if (pendingGeneration === requestGeneration) pendingGeneration = null;
    },
    invalidate: () => {
      generation += 1;
      pendingGeneration = null;
    },
  };
}

// Generic data hook: runs `fn` (a function returning a promise), tracks
// loading/error/data, and exposes a `reload`. Re-runs when any dep changes.
//
// Options:
//   pollMs  — if > 0, re-fetch on this interval. Background refreshes do NOT
//             toggle the loading flag, and `data` is only replaced when the new
//             payload actually differs (deep-compared), so an unchanged poll
//             causes no re-render. Polling pauses while the tab is hidden.
export function useFetch(fn, deps = [], { pollMs = 0 } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Hold the latest serialized payload so polls can skip identical responses.
  const lastSerialized = useRef(undefined);
  const requestGate = useRef(null);
  if (requestGate.current === null) requestGate.current = createLatestRequestGate();

  const run = useCallback((isPoll = false) => {
    const requestGeneration = requestGate.current.begin({ background: isPoll });
    // Do not stack background polls behind a slow initial load, reload, or
    // previous poll. The foreground request remains eligible to settle.
    if (requestGeneration === null) return null;
    if (!isPoll) setLoading(true);
    if (!isPoll) setError(null);
    Promise.resolve()
      .then(() => fn())
      .then((d) => {
        if (!requestGate.current.isCurrent(requestGeneration)) return;
        const serialized = JSON.stringify(d);
        // Only update state when the payload changed — avoids needless re-renders
        // (and flicker) on every poll tick.
        if (serialized !== lastSerialized.current) {
          lastSerialized.current = serialized;
          setData(d);
        }
        if (isPoll) setError(null);
      })
      .catch((e) => {
        // Don't blow away good data on a transient poll failure.
        if (requestGate.current.isCurrent(requestGeneration) && !isPoll) setError(e);
      })
      .finally(() => {
        if (requestGate.current.isCurrent(requestGeneration)) setLoading(false);
        requestGate.current.finish(requestGeneration);
      });
    return requestGeneration;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // Initial load + reload when deps change.
  useEffect(() => {
    lastSerialized.current = undefined;
    run(false);
    return () => requestGate.current.invalidate();
  }, [run]);

  // Background polling.
  useEffect(() => {
    if (!pollMs) return undefined;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.hidden) return;
      run(true);
    }, pollMs);
    return () => clearInterval(id);
  }, [run, pollMs]);

  const reload = useCallback(() => run(false), [run]);

  // Wrap setData so optimistic external updates keep the dedupe ref in sync,
  // and invalidate an already in-flight poll so stale server state cannot
  // immediately clobber the optimistic value.
  const setDataTracked = useCallback((updater) => {
    requestGate.current.invalidate();
    setLoading(false);
    setData((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater;
      lastSerialized.current = JSON.stringify(next);
      return next;
    });
  }, []);

  return { data, loading, error, reload, setData: setDataTracked };
}

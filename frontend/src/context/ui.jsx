import { createContext, useContext, useState, useEffect, useCallback, useMemo } from 'react';

// ---- Theme ------------------------------------------------------------------
const ThemeContext = createContext(null);

export function ThemeProvider({ children }) {
  const [theme, setTheme] = useState(() => localStorage.getItem('ok-theme') || 'light');
  useEffect(() => {
    localStorage.setItem('ok-theme', theme);
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === 'light' ? 'dark' : 'light')), []);
  const value = useMemo(() => ({ theme, toggle }), [theme, toggle]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
export const useTheme = () => useContext(ThemeContext);

// ---- Page chrome (breadcrumbs + primary action in the topbar) ---------------
const ChromeContext = createContext(null);

export function ChromeProvider({ children }) {
  const [chrome, setChromeState] = useState({ crumbs: [], primaryAction: null });
  const setChrome = useCallback((next) => setChromeState(next), []);
  const value = useMemo(() => ({ chrome, setChrome }), [chrome, setChrome]);
  return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>;
}
export const useChrome = () => useContext(ChromeContext);

// Convenience hook: declaratively set the topbar chrome for a page.
export function usePageChrome(crumbs, primaryAction, deps = []) {
  const { setChrome } = useChrome();
  useEffect(() => {
    setChrome({ crumbs, primaryAction });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

import {
  createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState,
} from 'react';
import { DEFAULT_THEME, getThemeFromCookie, saveTheme, ThemeMode } from '../lib/mode';

interface ThemeModeApi {
  mode: ThemeMode;
  toggle(): void;
  set(m: ThemeMode): void;
}

const Ctx = createContext<ThemeModeApi | null>(null);

/**
 * Holds the current light/dark mode in React state and persists every
 * change to the `theme` cookie. _document.tsx reads the same cookie on
 * SSR and stamps `data-theme` on <html> so the very first paint is
 * already in the correct mode (no FOUC).
 *
 * Toggling does NOT reload the page (unlike grcpay's reference impl);
 * the ThemeProvider in _app.tsx re-renders against the new theme
 * synchronously.
 */
export function ThemeModeProvider({
  initialMode,
  children,
}: {
  initialMode?: ThemeMode;
  children: ReactNode;
}) {
  const [mode, setMode] = useState<ThemeMode>(initialMode ?? DEFAULT_THEME);

  // Re-sync from cookie on mount in case the SSR-injected initialMode
  // disagrees (rare, but possible if the user toggled in another tab).
  useEffect(() => {
    const fromCookie = getThemeFromCookie();
    if (fromCookie !== mode) setMode(fromCookie);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = useCallback((m: ThemeMode) => {
    saveTheme(m);
    setMode(m);
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = m;
    }
  }, []);

  const toggle = useCallback(() => {
    set(mode === 'light' ? 'dark' : 'light');
  }, [mode, set]);

  const api = useMemo<ThemeModeApi>(() => ({ mode, toggle, set }), [mode, toggle, set]);
  return <Ctx.Provider value={api}>{children}</Ctx.Provider>;
}

export function useThemeMode(): ThemeModeApi {
  const v = useContext(Ctx);
  if (v) return v;
  return {
    mode: DEFAULT_THEME,
    toggle: () => undefined,
    set: () => undefined,
  };
}

/**
 * Light/dark mode persistence — same shape as stamp/grcpay so the
 * cookie name and surface match across the gridcoin.club family.
 *
 * Stored as a cookie (not localStorage) because we want the chosen
 * theme to be readable server-side at SSR time, which is how
 * _document.tsx avoids a flash-of-unstyled-content on first paint.
 *
 * The cookie is set with `domain=.gridcoin.club` so the preference is
 * shared across the apex and every *.gridcoin.club subdomain — toggling
 * dark mode here reflects on stamp/grcpay/the hub on the next request.
 */
export type ThemeMode = 'light' | 'dark';

export const DEFAULT_THEME: ThemeMode = 'light';

// Localhost / IP-only / non-club hosts must skip the domain attribute
// (browsers reject cookies whose domain isn't a registrable suffix of
// the current host).
function sharedCookieDomain(): string | null {
  if (typeof window === 'undefined') return null;
  const host = window.location.hostname;
  if (host === 'gridcoin.club' || host.endsWith('.gridcoin.club')) {
    return '.gridcoin.club';
  }
  return null;
}

export function saveTheme(theme: ThemeMode) {
  if (typeof document === 'undefined') return;
  const domain = sharedCookieDomain();
  const isSecure = window.location.protocol === 'https:';
  const parts = [
    `theme=${theme}`,
    'path=/',
    'max-age=31536000',
    'samesite=lax',
  ];
  if (domain) parts.push(`domain=${domain}`);
  if (isSecure) parts.push('secure');
  document.cookie = parts.join('; ');
}

export function getThemeFromCookie(): ThemeMode {
  if (typeof document === 'undefined') return DEFAULT_THEME;
  const match = document.cookie.match(/theme=(dark|light)/);
  if (match) {
    const theme = match[1];
    if (theme === 'light' || theme === 'dark') return theme as ThemeMode;
  }
  return DEFAULT_THEME;
}

export function toggleTheme(current: ThemeMode): ThemeMode {
  const next = current === 'light' ? 'dark' : 'light';
  saveTheme(next);
  return next;
}

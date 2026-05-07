import { CacheProvider, EmotionCache } from '@emotion/react';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { AppProps } from 'next/app';
import Head from 'next/head';
import Script from 'next/script';
import * as React from 'react';
import createEmotionCache from '../createEmotionCache';
import { SSEProvider } from '../hooks/useSSE';
import { ThemeModeProvider, useThemeMode } from '../hooks/useThemeMode';
import { TimeMachineProvider } from '../hooks/useTimeMachine';
import { ThemeMode } from '../lib/mode';
import { IS_TESTNET, NETWORK } from '../lib/network';
import { themeCreator } from '../theme';
import '../styles/style.css';

const clientSideEmotionCache = createEmotionCache();

interface MyAppProps extends AppProps {
  emotionCache?: EmotionCache;
  /** SSR-injected initial mode (read from cookie in _document.tsx). */
  mode?: ThemeMode;
}

/**
 * Inner shell that consumes the ThemeMode context and feeds it into
 * MUI's ThemeProvider. Split out so ThemeModeProvider can wrap it.
 */
function AppShell({ Component, pageProps }: { Component: AppProps['Component']; pageProps: AppProps['pageProps'] }) {
  const { mode } = useThemeMode();
  const theme = React.useMemo(() => themeCreator(mode, NETWORK), [mode]);
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <SSEProvider>
        <TimeMachineProvider>
          <Component {...pageProps} />
        </TimeMachineProvider>
      </SSEProvider>
    </ThemeProvider>
  );
}

export default function MyApp(props: MyAppProps) {
  const { Component, emotionCache = clientSideEmotionCache, pageProps, mode } = props;
  const titlePrefix = IS_TESTNET ? '[testnet] ' : '';
  // Favicon mirrors the AppBar logo. Network is build-time fixed; the
  // dark/light mode is user-toggled through ThemeModeProvider below.
  const faviconHref = IS_TESTNET ? '/ic-logo-testnet.svg' : '/ic-logo-mainnet.svg';

  return (
    <CacheProvider value={emotionCache}>
      <Head>
        <meta name="viewport" content="initial-scale=1.0, width=device-width" />
        <link rel="icon" type="image/svg+xml" href={faviconHref} />
        <link rel="apple-touch-icon" href={faviconHref} />
        {IS_TESTNET && <meta name="robots" content="noindex,nofollow" />}
        <title>{`${titlePrefix}Gridcoin Block Explorer`}</title>
      </Head>
      {process.env.NEXT_PUBLIC_TRACK === 'true' && (
        <Script
          src="https://daj.pw/js/plausible.js"
          data-domain={IS_TESTNET ? 'testnet-explorer.gridcoin.club' : 'explorer.gridcoin.club'}
        />
      )}
      <ThemeModeProvider initialMode={mode}>
        <AppShell Component={Component} pageProps={pageProps} />
      </ThemeModeProvider>
    </CacheProvider>
  );
}

/**
 * Read the theme cookie on the server so the very first paint already
 * matches the user's preference (no light-flash on dark-mode reload).
 * Same pattern as stamp/grcpay's modeDataServer helper, inlined here.
 */
MyApp.getInitialProps = async (appCtx: import('next/app').AppContext) => {
  const App = (await import('next/app')).default;
  const appProps = await App.getInitialProps(appCtx);
  let mode: ThemeMode = 'light';
  const cookieHeader = appCtx.ctx?.req?.headers?.cookie;
  if (typeof cookieHeader === 'string') {
    const m = cookieHeader.match(/(?:^|;\s*)theme=(dark|light)/);
    if (m) mode = m[1] as ThemeMode;
  }
  return { ...appProps, mode };
};

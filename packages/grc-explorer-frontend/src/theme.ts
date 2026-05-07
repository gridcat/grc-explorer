import { PaletteMode, ThemeOptions } from '@mui/material';
import { red } from '@mui/material/colors';
import { createTheme, lighten, responsiveFontSizes } from '@mui/material/styles';

export type Network = 'mainnet' | 'testnet';

interface PaletteSpec {
  primary: { main: string; light: string; dark: string };
  secondary: { main: string; light: string; dark: string };
}

// Two distinct, mutually-exclusive palettes. Switched at *build time*
// via NEXT_PUBLIC_NETWORK. The palette swap is the primary "I'm on
// testnet" signal — see plan §6.
const PALETTES: Record<Network, PaletteSpec> = {
  mainnet: {
    // Azure — production identity. Reads as "trustworthy block explorer."
    primary: { main: '#1565c0', light: '#5e92f3', dark: '#003c8f' },
    secondary: { main: '#f5a623', light: '#ffc14d', dark: '#c47e0e' },
  },
  testnet: {
    // Amber — universal "non-prod, caution" signal. Distinct from
    // grcpay green and stamp purple.
    primary: { main: '#ef6c00', light: '#ff9d3f', dark: '#b53d00' },
    secondary: { main: '#1976d2', light: '#5e92f3', dark: '#003c8f' },
  },
};

const themeOptions = (mode: PaletteMode, network: Network): ThemeOptions => {
  const palette = PALETTES[network];
  // Lighten primary slightly in dark mode so it stays vivid against the
  // dark canvas — same trick stamp/grcpay use on their primaries.
  const lift = mode === 'dark' ? 0.2 : 0;
  return {
    palette: {
      primary: mode === 'light' ? palette.primary : {
        main: lighten(palette.primary.main, lift),
        light: lighten(palette.primary.light, lift),
        dark: lighten(palette.primary.dark, lift),
      },
      secondary: palette.secondary,
      error: { main: red.A400 },
      mode,
      // Explicit dark-mode background tones — MUI's defaults are good
      // but we want the canvas slightly warmer than pure #121212 so the
      // outlined cards have a visible border against it.
      ...(mode === 'dark' ? {
        background: {
          default: '#101418',
          paper: '#181d23',
        },
        divider: 'rgba(255,255,255,0.08)',
      } : {
        background: {
          default: '#f8fafd',
          paper: '#ffffff',
        },
      }),
    },
    typography: {
      fontFamily: ['SF UI Text Regular', '-apple-system', 'Arial', 'sans-serif'].join(','),
    },
    components: {
      MuiButton: {
        styleOverrides: {
          contained: {
            borderRadius: 50,
            textTransform: 'none',
            paddingLeft: 24,
            paddingRight: 24,
            paddingTop: 10,
            paddingBottom: 10,
          },
          outlined: {
            borderWidth: 2,
            borderRadius: 50,
            paddingLeft: 24,
            paddingRight: 24,
            paddingTop: 10,
            paddingBottom: 10,
            textTransform: 'none',
            ':hover': { borderWidth: 2 },
          },
          text: { textTransform: 'none' },
          root: { '&.Mui-disabled': { borderWidth: 2 } },
        },
      },
      MuiCssBaseline: {
        // Keep the body bg in sync with the active palette so the
        // global stylesheet's `body { background-color }` rule doesn't
        // override us in dark mode. Wins over styles/style.css.
        styleOverrides: (themeArg) => ({
          body: { backgroundColor: themeArg.palette.background.default },
        }),
      },
    },
  };
};

export const themeCreator = (mode: PaletteMode = 'light', network: Network = 'testnet') => (
  responsiveFontSizes(createTheme(themeOptions(mode, network)))
);

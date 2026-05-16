import {
  Box, CircularProgress, Container, InputBase, alpha,
} from '@mui/material';
import SearchIcon from '@mui/icons-material/Search';
import { useTheme } from '@mui/material/styles';
import { useRouter } from 'next/router';
import { ReactNode, useState } from 'react';
import { Footer } from '../components/Footer';
import { Header } from '../components/Header';
import { PageWrapper } from '../components/PageWrapper';
import { ScrollTopFab } from '../components/ScrollTopFab';
import { TimeMachineDock } from '../components/TimeMachineDock';
import { useTimeMachine } from '../hooks/useTimeMachine';
import { TIME_MACHINE_ENABLED } from '../lib/featureFlags';
import { track } from '../lib/track';

interface LayoutProps {
  children: ReactNode;
  /** When true, render an above-content global search bar (home dashboard etc). */
  showSearch?: boolean;
  /**
   * Whether the bottom-fixed time-machine dock should appear. Defaults
   * to true. Pages that have no time dimension to scrub (API docs, 404,
   * etc.) can pass `false` to suppress it.
   */
  showTimeMachine?: boolean;
}

export function Layout({ children, showSearch = false, showTimeMachine = true }: LayoutProps) {
  const theme = useTheme();
  const router = useRouter();
  const tm = useTimeMachine();
  const [query, setQuery] = useState('');
  // The /search route is SSR — getServerSideProps awaits Meili before
  // the navigation resolves, and with the trimmed Meili tiers that can
  // take a few seconds during which the home page sits unchanged. Track
  // the in-flight submit so we can show a spinner, freeze the input,
  // and ignore repeat Enter presses instead of stacking navigations.
  const [submitting, setSubmitting] = useState(false);

  const submitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const q = query.trim();
    if (!q) return;
    // Don't ship the query string itself to analytics — only the
    // shape (length bucket) so we can see if users are typing
    // hashes vs short keywords without storing what they searched.
    const lengthBucket = q.length <= 8 ? '1-8' : q.length <= 32 ? '9-32' : '33+';
    track('Search', { length: lengthBucket });
    setSubmitting(true);
    // router.push resolves once the SSR fetch completes and the route
    // transition is done (or it redirected — single-hit shortcut). The
    // home Layout unmounts on success so this state mostly matters on
    // the rare push-rejected path; reset either way.
    router.push(`/search?q=${encodeURIComponent(q)}`).finally(() => setSubmitting(false));
  };

  // The dock + its padding are gated on a global feature flag so we
  // can deploy without it and turn it back on with one constant flip.
  const dockMounted = TIME_MACHINE_ENABLED && showTimeMachine;
  // Reserve bottom space on the whole wrapper so the fixed
  // TimeMachineDock never overlaps page content OR the footer. Replay
  // mode = full dock (~108px on desktop, taller on mobile because of
  // the row wrap). Live mode = small floating pill, doesn't need
  // page-content reservation.
  const dockPad = (dockMounted && tm.isReplay)
    ? { xs: 200, sm: 130, md: 110 }
    : 0;

  return (
    <PageWrapper sx={{ pb: dockPad }}>
      <Header />
      <Container component="main" maxWidth="xl" sx={{ flex: 1, py: { xs: 3, md: 5 } }}>
        {showSearch && (
          <Box
            component="form"
            onSubmit={submitSearch}
            sx={{
              display: 'flex',
              alignItems: 'center',
              bgcolor: alpha(theme.palette.primary.main, 0.06),
              borderRadius: 50,
              px: 2.5,
              py: 1,
              mb: 4,
              maxWidth: 720,
              mx: 'auto',
              transition: 'background 200ms',
              ':focus-within': {
                bgcolor: alpha(theme.palette.primary.main, 0.1),
              },
            }}
          >
            {submitting
              ? <CircularProgress size={18} thickness={5} sx={{ color: 'text.secondary', mr: 1 }} />
              : <SearchIcon fontSize="small" sx={{ color: 'text.secondary', mr: 1 }} />}
            <InputBase
              fullWidth
              placeholder="Block height, tx hash, address, CPID, organisation…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={submitting}
              inputProps={{ 'aria-label': 'search the chain' }}
            />
          </Box>
        )}
        {children}
      </Container>
      <Footer />
      <ScrollTopFab />
      {dockMounted && <TimeMachineDock />}
    </PageWrapper>
  );
}

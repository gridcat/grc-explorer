import {
  Box, Button, Container, Typography,
} from '@mui/material';
import { styled } from '@mui/material/styles';
import Head from 'next/head';
import Image from 'next/image';
import Link from 'next/link';
import { useEffect } from 'react';
import { PageWrapper } from '../../components/PageWrapper';
import { plausibleClass, track } from '../../lib/track';

const PageBody = styled(Box)(() => ({
  backgroundImage: 'url(/il-background-error-page.svg)',
  backgroundSize: 'cover',
}));

const NotFoundError = styled(Typography)(({ theme }) => ({
  // Always white — the page sits on top of the dark-blue background
  // SVG regardless of light/dark theme, and `primary.contrastText`
  // resolves to black under some palettes.
  color: '#fff',
  padding: theme.spacing(5),
}));

const ErrorContainer = styled(Container)(() => ({
  flexGrow: 1,
  justifyContent: 'center',
  alignItems: 'center',
  display: 'flex',
  flexDirection: 'column',
}));

export function NotFound() {
  useEffect(() => {
    track('404', { path: document.location.pathname });
  }, []);
  return (
    <PageBody>
      <Head>
        <title>Page Not Found</title>
        <meta name="description" content="The page you were looking for does not exist." />
        <meta name="robots" content="noindex" />
      </Head>
      <PageWrapper>
        <ErrorContainer maxWidth="xl">
          <Image
            src="/ic-error.svg"
            width={244}
            height={310}
            alt="Major Tom"
          />
          <NotFoundError variant="h4">
            This page has been eaten by Major Tom!
          </NotFoundError>
          <Link href="/" passHref className={plausibleClass('CTA Click', { cta: '404 Home' })}>
            <Button variant="contained">Ground control, bring me home.</Button>
          </Link>
        </ErrorContainer>
      </PageWrapper>
    </PageBody>
  );
}

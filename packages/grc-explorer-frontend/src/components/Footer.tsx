import { Container, Divider, Grid, Typography } from '@mui/material';
import { styled } from '@mui/material/styles';
import GithubIcon from '@mui/icons-material/GitHub';
import { DaemonInfo } from './DaemonInfo';
import { NextMuiLink } from './NextMuiLink';
import {
  IS_TESTNET, NETWORK, SISTER_NETWORK, SISTER_NETWORK_URL,
} from '../lib/network';

const SISTER_NETWORK_LABEL = SISTER_NETWORK === 'mainnet' ? 'Mainnet' : 'Testnet';

const SubFooterTypography = styled(Typography)(({ theme }) => ({
  textAlign: 'left',
  lineHeight: theme.spacing(8),
  width: '100%',
  display: 'inline-block',
  color: theme.palette.text.disabled,
  [theme.breakpoints.down('sm')]: {
    textAlign: 'center',
    lineHeight: theme.spacing(5),
  },
}));

const FooterTextTypography = styled(Typography)(({ theme }) => ({
  display: 'inline-block',
  width: '100%',
  [theme.breakpoints.down('md')]: {
    textAlign: 'left',
  },
  [theme.breakpoints.down('sm')]: {
    textAlign: 'center',
  },
}));

export function Footer() {
  return (
    <Container maxWidth="xl">
      <div><Divider /></div>
      <Grid container spacing={0} sx={{ mt: 2, mb: 2 }}>
        <Grid size={{ xs: 12, md: 6 }}>
          <FooterTextTypography variant="caption">
            Live, event-driven Gridcoin blockchain explorer · {NETWORK}.
          </FooterTextTypography>
          <FooterTextTypography variant="caption" sx={{ color: 'text.disabled' }}>
            <DaemonInfo />
          </FooterTextTypography>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <FooterTextTypography variant="caption" sx={{ textAlign: 'right' }}>
            <a
              href="https://github.com/gridcat/grc-explorer"
              target="_blank"
              rel="nofollow noreferrer"
              style={{ display: 'inline-block' }}
            >
              <GithubIcon color="primary" sx={{ fontSize: 40 }} />
            </a>
          </FooterTextTypography>
        </Grid>
      </Grid>
      <Divider />
      <SubFooterTypography variant="caption">
        Made with
        {' '}
        <span style={{ color: 'red' }}>❤</span>
        {' '}
        by @gridcat
        {' · '}
        <a
          href="https://gridcoin.club"
          style={{ color: 'inherit' }}
        >
          Part of Gridcoin Club ↗
        </a>
        {' · '}
        <NextMuiLink href="/disclaimer">Terms</NextMuiLink>
        {SISTER_NETWORK_URL && (
          <>
            {' · '}
            <a
              href={SISTER_NETWORK_URL}
              style={{ color: 'inherit' }}
              rel={IS_TESTNET ? undefined : 'nofollow'}
            >
              {SISTER_NETWORK_LABEL}
              {' ↗'}
            </a>
          </>
        )}
      </SubFooterTypography>
    </Container>
  );
}

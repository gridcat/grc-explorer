import {
  Box, Button, Container, Dialog, Divider, IconButton, Stack, Toolbar, Typography,
} from '@mui/material';
import { styled } from '@mui/material/styles';
import CloseIcon from '@mui/icons-material/Close';
import MenuIcon from '@mui/icons-material/Menu';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { IS_TESTNET } from '../lib/network';
import { activeChildHref } from '../lib/navActive';
import { track } from '../lib/track';
import { ModeToggle } from './ModeToggle';

interface NavLeaf { href: string; label: string }
interface NavGroup { label: string; children: NavLeaf[] }
export type NavEntry = NavLeaf | NavGroup;
function isLeaf(e: NavEntry): e is NavLeaf {
  return 'href' in e;
}

const MenuButton = styled(Button)(({ theme }) => ({
  paddingLeft: theme.spacing(5),
  paddingRight: theme.spacing(5),
  fontWeight: 600,
  textTransform: 'none',
  fontSize: '1rem',
}));

/**
 * Mobile hamburger menu — opens a full-screen Dialog with the same
 * NAV_ITEMS as the desktop nav. Closes automatically when the route
 * changes, so tapping a menu item dismisses the dialog.
 */
export function NavMenuMobile({ items }: { items: NavEntry[] }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const logoSrc = IS_TESTNET ? '/ic-logo-testnet.svg' : '/ic-logo-mainnet.svg';

  useEffect(() => {
    const close = () => setOpen(false);
    router.events.on('routeChangeComplete', close);
    return () => router.events.off('routeChangeComplete', close);
  }, [router.events]);

  return (
    <>
      <IconButton
        size="large"
        edge="start"
        color="inherit"
        aria-label="menu"
        onClick={() => setOpen(true)}
      >
        <MenuIcon />
      </IconButton>
      <Dialog fullScreen open={open} onClose={() => setOpen(false)}>
        <Container sx={{ display: 'flex', alignItems: 'center', py: 1 }}>
          <Stack direction="row" spacing={1.5} sx={{ alignItems: 'center' }}>
            <Image src={logoSrc} width={32} height={32} alt="Gridcoin Explorer logo" />
            <Typography
              component="span"
              sx={{
                fontWeight: 800,
                letterSpacing: '0.02em',
                fontSize: '1.25rem',
                background: (t) => `linear-gradient(90deg, ${t.palette.primary.dark}, ${t.palette.primary.light})`,
                WebkitBackgroundClip: 'text',
                WebkitTextFillColor: 'transparent',
                backgroundClip: 'text',
              }}
            >
              Explorer
            </Typography>
            {IS_TESTNET && (
              <Box
                component="span"
                sx={{
                  ml: 0.5,
                  px: 1,
                  py: 0.25,
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  letterSpacing: 1.4,
                  color: 'primary.main',
                  border: '1px solid',
                  borderColor: 'primary.main',
                  borderRadius: 1,
                  lineHeight: 1.2,
                }}
              >
                TESTNET
              </Box>
            )}
          </Stack>
          <Toolbar sx={{ justifyContent: 'flex-end', flexGrow: 1 }} disableGutters>
            <IconButton edge="start" color="inherit" onClick={() => setOpen(false)} aria-label="close">
              <CloseIcon />
            </IconButton>
          </Toolbar>
        </Container>

        <Container
          sx={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            flexGrow: 1,
          }}
        >
          <Stack spacing={1.5} sx={{ alignItems: 'center', width: '100%' }}>
            {items.map((entry) => {
              if (isLeaf(entry)) {
                const isCurrent = router.pathname === entry.href || router.pathname.startsWith(`${entry.href}/`);
                return (
                  <Link
                    key={entry.href}
                    href={entry.href}
                    passHref
                    style={{ textDecoration: 'none' }}
                    onClick={() => track('Nav', { item: entry.label, surface: 'mobile' })}
                  >
                    <MenuButton
                      variant={isCurrent ? 'contained' : 'text'}
                      disableElevation
                      color="primary"
                    >
                      {entry.label}
                    </MenuButton>
                  </Link>
                );
              }
              // Group — flat with a section header. The mobile dialog
              // is roomy enough that we don't need the desktop-style
              // collapsible pattern; just label the cluster and stack
              // its children below.
              return (
                <Stack key={entry.label} spacing={0.5} sx={{ alignItems: 'center', width: '100%' }}>
                  <Typography
                    variant="caption"
                    sx={{
                      textTransform: 'uppercase',
                      letterSpacing: 1.2,
                      color: 'text.secondary',
                      fontWeight: 600,
                      mt: 1,
                    }}
                  >
                    {entry.label}
                  </Typography>
                  {entry.children.map((c) => {
                    const isCurrent = activeChildHref(router.pathname, entry.children) === c.href;
                    return (
                      <Link
                        key={c.href}
                        href={c.href}
                        passHref
                        style={{ textDecoration: 'none' }}
                        onClick={() => track('Nav', { item: c.label, surface: 'mobile-submenu' })}
                      >
                        <MenuButton
                          variant={isCurrent ? 'contained' : 'text'}
                          disableElevation
                          color="primary"
                        >
                          {c.label}
                        </MenuButton>
                      </Link>
                    );
                  })}
                </Stack>
              );
            })}
          </Stack>
        </Container>
        <Divider />
        <Toolbar sx={{ justifyContent: 'flex-end' }}>
          <ModeToggle />
        </Toolbar>
      </Dialog>
    </>
  );
}

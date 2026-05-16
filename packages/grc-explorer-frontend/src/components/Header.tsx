import * as React from 'react';
import { useRef } from 'react';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import useScrollTrigger from '@mui/material/useScrollTrigger';
import { styled, useTheme } from '@mui/material/styles';
import { useMediaQuery } from '@mui/material';
import KeyboardArrowDownIcon from '@mui/icons-material/KeyboardArrowDown';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter, NextRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { IS_TESTNET } from '../lib/network';
import { track } from '../lib/track';
import { ModeToggle } from './ModeToggle';
import { NavMenuMobile, NavEntry } from './NavMenuMobile';
import { NextMuiLink } from './NextMuiLink';

interface Props {
  children: React.ReactElement<React.ComponentProps<typeof AppBar>>;
}

/**
 * Re-elevate the AppBar on scroll. While at the top the bar is
 * transparent (so the gradient/hero shows through); after even a few
 * pixels of scroll it gains a paper background + drop shadow, so the
 * page content scrolls underneath without a hard line.
 */
export function ElevationScroll({ children }: Props) {
  const theme = useTheme();
  const trigger = useScrollTrigger({ disableHysteresis: true, threshold: 0 });
  return React.cloneElement(children, {
    elevation: trigger ? 4 : 0,
    sx: { backgroundColor: trigger ? theme.palette.background.paper : 'transparent' },
  });
}

const itemHorzPadding = 1;
const gutter = 2;

const Nav = styled('ul')(() => ({
  listStyle: 'none',
  display: 'flex',
  overflow: 'auto',
  padding: 0,
  margin: 0,
}));

const NavItem = styled('li')(({ theme }) => ({
  flexShrink: 0,
  display: 'flex',
  alignItems: 'center',
  position: 'relative',
  borderRadius: 4,
  padding: theme.spacing(1, itemHorzPadding),
  cursor: 'pointer',
  textDecoration: 'none',
  transition: '0.2s ease-out',
  '& a': {
    color: theme.palette.text.secondary,
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    background: 'none',
    border: 'none',
    font: 'inherit',
    cursor: 'pointer',
    padding: 0,
  },
  '&:after': {
    content: '""',
    display: 'block',
    position: 'absolute',
    bottom: 0,
    left: theme.spacing(itemHorzPadding),
    width: `calc(100% - ${theme.spacing(itemHorzPadding * 2)})`,
    height: 3,
    transform: 'scale(0, 1)',
    transition: '0.2s ease-out',
    opacity: 0,
    borderRadius: 2,
    backgroundImage: `linear-gradient(to right, ${theme.palette.primary.dark}, ${theme.palette.primary.light})`,
  },
  '&:hover': {
    '& a': {
      color: theme.palette.mode === 'dark' ? theme.palette.primary.light : theme.palette.primary.main,
    },
    '&:after': { opacity: 1, transform: 'scale(1, 1)' },
  },
  '&:not(:first-of-type)': {
    marginLeft: theme.spacing(gutter),
  },
  '&.itemActive': {
    '& a': {
      color: theme.palette.mode === 'dark' ? theme.palette.primary.light : theme.palette.primary.main,
    },
    '&:after': { opacity: 1, transform: 'scale(1, 1)' },
  },
}));

// `NavEntry` is either a leaf (renders as a direct link) or a group
// (renders a button that opens a Menu with the children). Adding a new
// item: drop a leaf at the top level, or nest it inside an existing
// group's `children`.
const NAV_ITEMS: NavEntry[] = [
  { href: '/blocks', label: 'Blocks' },
  { href: '/history', label: 'History' },
  { href: '/mempool', label: 'Mempool' },
  { href: '/wallets', label: 'Wallets' },
  {
    label: 'Researchers',
    children: [
      { href: '/superblocks', label: 'Superblocks' },
      { href: '/beacons', label: 'Beacons' },
      { href: '/cpids/cohorts', label: 'Cohorts' },
      { href: '/researchers/history', label: 'Top researchers history' },
      { href: '/mrc-requests', label: 'MRC requests' },
      { href: '/network/difficulty', label: 'Difficulty' },
      { href: '/network/stakers', label: 'Active stakers' },
      { href: '/projects/history', label: 'BOINC projects' },
    ],
  },
  { href: '/polls', label: 'Polls' },
  { href: '/developers', label: 'API' },
];

function isLeaf(entry: NavEntry): entry is { href: string; label: string } {
  return 'href' in entry;
}

/**
 * Top-level desktop nav item that opens a Menu of children. Active
 * state lights up if any child route matches the current pathname.
 *
 * The Menu is rendered as a *sibling* of the NavItem (via React
 * fragment) — not as its child — because MUI's Menu portals its
 * Modal/Backdrop to document.body, and React synthetic events from
 * inside the Menu bubble back through the JSX tree. If the Menu
 * lives inside the NavItem, every backdrop click (and every click
 * on a MenuItem) bubbles to NavItem.onClick, which immediately
 * re-toggles the menu open. The fix is to anchor the Menu via a
 * ref and keep it sibling-level so the bubble stops at the
 * fragment.
 */
function GroupNavItem({
  group,
  router,
}: {
  group: { label: string; children: Array<{ href: string; label: string }> };
  router: NextRouter;
}) {
  const anchorRef = useRef<HTMLLIElement | null>(null);
  const [open, setOpen] = useState(false);
  const isActive = group.children.some((c) => router.pathname.startsWith(c.href));
  return (
    <>
      <NavItem
        ref={anchorRef}
        className={isActive ? 'itemActive' : undefined}
        onClick={() => {
          setOpen((prev) => !prev);
          track('Nav', { item: group.label, surface: 'desktop-group' });
        }}
      >
        <Box
          component="span"
          sx={{
            display: 'inline-flex', alignItems: 'center', gap: 0.25, color: 'inherit',
          }}
        >
          {group.label}
          <KeyboardArrowDownIcon
            fontSize="small"
            sx={{
              transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: '0.2s ease-out',
            }}
          />
        </Box>
      </NavItem>
      <Menu
        anchorEl={anchorRef.current}
        open={open}
        onClose={() => setOpen(false)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
        transformOrigin={{ vertical: 'top', horizontal: 'left' }}
        slotProps={{ paper: { sx: { mt: 1, minWidth: 160 } } }}
      >
        {group.children.map((c) => {
          const childActive = router.pathname.startsWith(c.href);
          return (
            <MenuItem
              key={c.href}
              component={Link}
              href={c.href}
              selected={childActive}
              onClick={() => {
                setOpen(false);
                track('Nav', { item: c.label, surface: 'desktop-submenu' });
              }}
            >
              {c.label}
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}

export function Header() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down('sm'));
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const logoSrc = IS_TESTNET ? '/ic-logo-testnet.svg' : '/ic-logo-mainnet.svg';

  useEffect(() => { setMounted(true); }, []);

  return (
    <>
      <ElevationScroll>
        <AppBar color="transparent">
          <Container maxWidth="xl" sx={{ display: 'flex', alignItems: 'center' }}>
            <Box>
              <Link
                passHref
                href="/"
                style={{
                  textDecoration: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 12,
                }}
              >
                <Image
                  src={logoSrc}
                  width={isMobile && mounted ? 32 : 40}
                  height={isMobile && mounted ? 32 : 40}
                  alt="Gridcoin Explorer logo"
                  priority
                />
                <Typography
                  component="span"
                  sx={{
                    fontWeight: 800,
                    letterSpacing: '0.02em',
                    fontSize: isMobile && mounted ? '1.25rem' : '1.5rem',
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
                      ml: 1,
                      px: 1,
                      py: 0.25,
                      fontSize: '0.65rem',
                      fontWeight: 700,
                      letterSpacing: 1.4,
                      color: theme.palette.primary.main,
                      border: `1px solid ${theme.palette.primary.main}`,
                      borderRadius: 1,
                      lineHeight: 1.2,
                    }}
                  >
                    TESTNET
                  </Box>
                )}
              </Link>
            </Box>

            <Toolbar sx={{ justifyContent: 'flex-end', flexGrow: 1 }} disableGutters>
              {/* Desktop nav — fades to hamburger below md. */}
              <Box component="nav" sx={{ display: { xs: 'none', md: 'block' } }}>
                <Nav>
                  {NAV_ITEMS.map((entry) => {
                    if (!isLeaf(entry)) {
                      return <GroupNavItem key={entry.label} group={entry} router={router} />;
                    }
                    const isActive = router.pathname.startsWith(entry.href);
                    return (
                      <NavItem
                        key={entry.href}
                        className={isActive ? 'itemActive' : undefined}
                        onClick={() => track('Nav', { item: entry.label, surface: 'desktop' })}
                      >
                        <NextMuiLink href={entry.href}>{entry.label}</NextMuiLink>
                      </NavItem>
                    );
                  })}
                </Nav>
              </Box>
              {/* Light/dark mode toggle — visible at every breakpoint. */}
              <ModeToggle />
              {/* Mobile hamburger — full-screen Dialog with the same items. */}
              <Box sx={{ display: { xs: 'block', md: 'none' } }}>
                <NavMenuMobile items={NAV_ITEMS} />
              </Box>
            </Toolbar>
          </Container>
        </AppBar>
      </ElevationScroll>
      <Toolbar />
    </>
  );
}

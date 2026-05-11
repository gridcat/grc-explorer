import {
  Box, Chip, Container, Paper, Stack, Table, TableBody, TableCell,
  TableHead, TableRow, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Head from 'next/head';
import Link from 'next/link';
import { Crumbs } from '../../components/Crumbs';
import { Layout } from '../../layouts/Layout';
import { api } from '../../lib/api';
import { formatTime } from '../../lib/format';
import { IS_TESTNET } from '../../lib/network';

interface Fork {
  key: string;
  height: number;
  timestamp: number | null;
  chart_label: string;
  summary: string;
  category: 'consensus' | 'patch';
}

interface ProtocolPageProps {
  forks: Fork[];
}

const PAGE_TITLE = IS_TESTNET
  ? '[testnet] Gridcoin consensus forks — chain version history & activation heights'
  : 'Gridcoin consensus forks — chain version history & activation heights';

const PAGE_DESCRIPTION = 'Reference table of every Gridcoin consensus fork: '
  + 'mainnet activation height, block time, and what each version-bump '
  + 'changed. Sources every entry against gridcoin-community/Gridcoin-Research '
  + 'so the answers are unambiguous. Includes the two R Halford patches '
  + 'that fixed the 2014–2015 difficulty pathologies.';

// Structured data so search crawlers index every fork as a defined term
// rather than just one opaque article. Rendered as inline script
// children (raw-text element — React passes JSON through unescaped) so
// the page ships valid JSON-LD without resorting to other risky APIs.
function buildJsonLd(forks: Fork[]): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    mainEntity: {
      '@type': 'DefinedTermSet',
      name: 'Gridcoin consensus forks',
      hasDefinedTerm: forks.map((f) => ({
        '@type': 'DefinedTerm',
        '@id': `#${f.key}`,
        name: f.chart_label,
        description: f.summary,
      })),
    },
  });
}

function categoryChip(category: 'consensus' | 'patch') {
  return category === 'patch'
    ? <Chip size="small" label="patch" color="warning" variant="outlined" />
    : <Chip size="small" label="consensus" color="primary" variant="outlined" />;
}

export default function ProtocolPage({ forks }: ProtocolPageProps) {
  // Sorted by activation height so the table reads as the chain
  // timeline — pre-PoSv2 first, V14 last. Forks the indexer hasn't
  // reached yet (timestamp null) sink to the bottom rather than
  // disappearing.
  const sorted = [...forks].sort((a, b) => a.height - b.height);

  return (
    <Layout showTimeMachine={false}>
      <Head>
        <title>{PAGE_TITLE}</title>
        <meta name="description" content={PAGE_DESCRIPTION} />
        <link rel="canonical" href="/protocol" />
        <script
          type="application/ld+json"
          // React treats <script> children as raw text content (no
          // HTML-escaping for the JSON-safe characters in our payload),
          // so this produces valid JSON-LD in the SSR'd page source.
        >
          {buildJsonLd(sorted)}
        </script>
      </Head>
      <Container maxWidth="lg" sx={{ flexGrow: 1, py: 2 }}>
        <Stack spacing={3}>
          <Crumbs items={[{ label: 'Protocol' }]} />
          <Box>
            <Typography component="h1" variant="h4" sx={{ fontWeight: 700 }}>
              Gridcoin consensus forks
            </Typography>
            <Typography variant="body1" color="text.secondary" sx={{ mt: 1 }}>
              A single source of truth for every chain-version bump in
              Gridcoin&apos;s history. Each row gives the activation
              height on the {IS_TESTNET ? 'testnet' : 'mainnet'} chain
              the explorer is following, the block-time of that
              activation block (so you can plug it into a difficulty
              or staker chart), and what the fork changed. Every entry
              is sourced from{' '}
              <Link href="https://github.com/gridcoin-community/Gridcoin-Research/blob/development/src/chainparams.cpp" style={{ color: 'inherit' }}>
                chainparams.cpp
              </Link>
              {' '}or the matching consensus file in
              {' '}
              <Link href="https://github.com/gridcoin-community/Gridcoin-Research" style={{ color: 'inherit' }}>
                gridcoin-community/Gridcoin-Research
              </Link>.
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              Looking for the visualisation? The{' '}
              <Link href="/network/difficulty" style={{ color: 'inherit', fontWeight: 600 }}>
                difficulty chart
              </Link>
              {' '}renders every fork in this table as a vertical marker
              annotation; hover a line to see the same summary.
            </Typography>
          </Box>

          <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Fork</TableCell>
                  <TableCell>Category</TableCell>
                  <TableCell align="right">Block height</TableCell>
                  <TableCell>Activated</TableCell>
                  <TableCell>What changed</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sorted.map((f) => (
                  <TableRow key={f.key} id={f.key} hover>
                    <TableCell sx={{ fontWeight: 600 }}>
                      <a
                        href={`#${f.key}`}
                        style={{ color: 'inherit', textDecoration: 'none' }}
                      >
                        {f.chart_label}
                      </a>
                    </TableCell>
                    <TableCell>{categoryChip(f.category)}</TableCell>
                    <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      <Link href={`/block/${f.height}`} style={{ color: 'inherit' }}>
                        {f.height.toLocaleString()}
                      </Link>
                    </TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontSize: 13 }}>
                      {f.timestamp !== null ? formatTime(f.timestamp) : (
                        <em>not yet indexed</em>
                      )}
                    </TableCell>
                    <TableCell sx={{ fontSize: 13 }}>{f.summary}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>

          <Box>
            <Typography variant="h5" component="h2" sx={{ fontWeight: 700, mb: 1 }}>
              Two notable patches in the early chain
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Not every consensus rule landed at a version bump. Two
              R Halford patches dropped into the codebase in late 2014
              and early 2015 to fix runaway difficulty pathologies
              that the early retargeting algorithm couldn&apos;t damp
              on its own. Both are still in the wallet today as
              hardcoded special-cases inside{' '}
              <code>GRC::GetNextTargetRequired</code> (
              <Link href="https://github.com/gridcoin-community/Gridcoin-Research/blob/development/src/gridcoin/staking/difficulty.cpp" style={{ color: 'inherit' }}>
                src/gridcoin/staking/difficulty.cpp
              </Link>
              ).
            </Typography>
            <Stack spacing={2}>
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  2014-12-19 &mdash; Halford diff reset (blocks 91,387&ndash;91,500)
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Diff was sticking at 2065 due to multiple incompatible
                  features layered on the early target-spacing logic.
                  The patch force-resets the target to
                  {' '}<code>PROOF_OF_STAKE_LIMIT</code>{' '}
                  for 114 consecutive blocks so the retarget could find
                  its footing again.
                </Typography>
              </Paper>
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
                  2015-01-14 &mdash; 900k difficulty cap
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  Three days before this patch landed, the chain saw a
                  spike to ~14.5M difficulty (block 114,221). The cap
                  hardcodes
                  {' '}<code>if (GetCurrentDifficulty() &gt; 900000) snap to PoS limit</code>{' '}
                  so any future exponential spiral self-corrects on the
                  very next block. By the protocol&apos;s own definition,
                  anything above 900k is &ldquo;pathological&rdquo;.
                </Typography>
              </Paper>
            </Stack>
          </Box>

          <Box>
            <Typography variant="h5" component="h2" sx={{ fontWeight: 700, mb: 1 }}>
              Cross-references
            </Typography>
            <Typography variant="body2" color="text.secondary" component="div">
              <ul style={{ paddingLeft: '1.25rem', margin: 0 }}>
                <li>
                  <Link href="/network/difficulty" style={{ color: 'inherit' }}>
                    Difficulty history chart
                  </Link>{' '}— every fork in this table as a vertical marker.
                </li>
                <li>
                  <Link href="/protocol/registry" style={{ color: 'inherit' }}>
                    Protocol registry
                  </Link>{' '}— time-travel viewer for on-chain protocol-parameter
                  entries (V13+ knobs the chain itself can adjust).
                </li>
                <li>
                  <a
                    href="https://github.com/gridcoin-community/Gridcoin-Research/blob/development/src/chainparams.cpp"
                    rel="noopener noreferrer"
                    style={{ color: 'inherit' }}
                  >
                    chainparams.cpp
                  </a>{' '}— authoritative C++ definitions for every height in this table.
                </li>
              </ul>
            </Typography>
          </Box>
        </Stack>
      </Container>
    </Layout>
  );
}

export const getServerSideProps: GetServerSideProps<ProtocolPageProps> = async () => {
  try {
    const r = await api.get('/network/forks');
    const forks = (r.data?.data?.attributes?.forks ?? []) as Fork[];
    return { props: { forks } };
  } catch {
    return { props: { forks: [] } };
  }
};

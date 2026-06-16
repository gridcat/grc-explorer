import {
  Box, Chip, Table, TableBody, TableCell, TableHead, TableRow,
} from '@mui/material';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { CpidLabel } from './CpidLabel';
import { HashTrim } from './HashTrim';
import { TimeAgo } from './TimeAgo';
import {
  formatCompact, formatGrc, formatNumber, formatTime, timeAgo,
} from '../lib/format';
import { track } from '../lib/track';

// Normalized row shape every block list converges on. The home ticker
// (snake_case SSE payload), the /blocks page, and the date archive each
// map their own fetch result onto this before handing it here, so the
// 11-column table renders identically in all three contexts.
export interface BlockRowData {
  height: number;
  hash: string;
  time: number;
  txCount: number;
  isPos: boolean;
  isSuperblock: boolean;
  isMrc: boolean;
  valueMoved: string;
  feeTotal: string;
  // Raw difficulty (Number()'d for display), size in bytes, and the
  // block reward as a halford2grc'd GRC string (like valueMoved/feeTotal).
  difficulty: number | string;
  size: number;
  reward: string;
  stakerCpid: string | null;
  // Resolved BOINC display name, when known. Live tables fill this from
  // the useCpidNames hook each render; the SSR archive bakes it in
  // server-side. Absent/undefined falls back to the short CPID hash.
  stakerName?: string | null;
}

export function BlockTable({
  blocks,
  liveAge = false,
  minRows,
  emptyMessage,
  trackSource,
}: {
  blocks: BlockRowData[];
  /** Tick the Age column every second via <TimeAgo> (home only). When
   *  false, render a static age string with the exact time on hover. */
  liveAge?: boolean;
  /** Pad with blank rows up to this count so the table height is stable
   *  while data loads (home + /blocks). Omit for the static archive. */
  minRows?: number;
  /** Message shown in the first pad row while `blocks` is still empty.
   *  Only renders when `minRows` is set (no pad rows otherwise). */
  emptyMessage?: string;
  /** Analytics `from` label; when set, a row click fires a track() event.
   *  Omit to skip tracking (home + archive). */
  trackSource?: string;
}) {
  const router = useRouter();
  const pad = minRows ? Math.max(0, minRows - blocks.length) : 0;

  return (
    <Table size="small" sx={{ minWidth: 1080 }}>
      <TableHead>
        <TableRow>
          <TableCell sx={{ width: 110 }}>Height</TableCell>
          <TableCell>Hash</TableCell>
          <TableCell sx={{ width: 110 }}>Age</TableCell>
          <TableCell align="right" sx={{ width: 70 }}>Txs</TableCell>
          <TableCell align="right" sx={{ width: 90 }}>Size</TableCell>
          <TableCell align="right" sx={{ width: 100 }}>Difficulty</TableCell>
          <TableCell align="right" sx={{ width: 110 }}>Amount</TableCell>
          <TableCell align="right" sx={{ width: 90 }}>Fees</TableCell>
          <TableCell align="right" sx={{ width: 110 }}>Reward</TableCell>
          <TableCell sx={{ width: 130 }}>Type</TableCell>
          <TableCell sx={{ width: 140 }}>Staker</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {blocks.map((b) => {
          // Superblocks have their own richer detail page (magnitudes /
          // projects / verified beacons); everything else routes to the
          // generic block detail.
          const href = b.isSuperblock ? `/superblocks/${b.height}` : `/block/${b.height}`;
          return (
            <TableRow
              key={b.hash}
              hover
              sx={{
                cursor: 'pointer',
                // Superblock rows are anchored: brand-coloured left border
                // + stronger tint so they stand out in a long list.
                ...(b.isSuperblock && {
                  backgroundColor: (theme) => `${theme.palette.secondary.main}26`,
                  borderLeft: 4,
                  borderLeftColor: 'secondary.main',
                }),
              }}
              onClick={() => {
                if (trackSource) {
                  track(b.isSuperblock ? 'Superblock: open' : 'Block: open', { from: trackSource });
                }
                router.push(href);
              }}
              onMouseEnter={() => router.prefetch(href)}
            >
              <TableCell sx={{ fontWeight: 600 }}>
                <Link
                  href={href}
                  style={{ color: 'inherit', textDecoration: 'none' }}
                  onClick={(e) => e.stopPropagation()}
                >
                  {`#${b.height.toLocaleString('en-US')}`}
                </Link>
              </TableCell>
              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, color: 'text.secondary' }}>
                <HashTrim text={b.hash} head={12} tail={6} />
              </TableCell>
              <TableCell title={formatTime(b.time)} sx={{ color: 'text.secondary' }}>
                {liveAge ? <TimeAgo unixSec={b.time} /> : timeAgo(b.time)}
              </TableCell>
              <TableCell align="right">{b.txCount}</TableCell>
              <TableCell align="right" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
                {formatNumber(b.size)}
              </TableCell>
              <TableCell align="right" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
                {formatCompact(Number(b.difficulty), 2)}
              </TableCell>
              <TableCell align="right" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
                {formatGrc(b.valueMoved)}
              </TableCell>
              <TableCell align="right" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
                {formatGrc(b.feeTotal)}
              </TableCell>
              <TableCell align="right" sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>
                {formatGrc(b.reward)}
              </TableCell>
              <TableCell>
                <Box sx={{ display: 'flex', gap: 0.5 }}>
                  {b.isSuperblock && <Chip label="SB" size="small" color="secondary" />}
                  {b.isMrc && <Chip label="MRC" size="small" color="secondary" variant="outlined" />}
                  {b.isPos
                    ? <Chip label="PoS" size="small" variant="outlined" />
                    : <Chip label="PoW" size="small" variant="outlined" />}
                </Box>
              </TableCell>
              <TableCell sx={{ fontSize: 12, maxWidth: 220 }}>
                {b.stakerCpid ? (
                  <Link
                    href={`/cpids/${b.stakerCpid}`}
                    style={{
                      color: 'inherit', textDecoration: 'none', display: 'block', minWidth: 0,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <CpidLabel cpid={b.stakerCpid} name={b.stakerName ?? undefined} />
                  </Link>
                ) : (
                  <Box sx={{ color: 'text.disabled', fontStyle: 'italic' }}>investor</Box>
                )}
              </TableCell>
            </TableRow>
          );
        })}
        {/* Pad up to minRows so the table height is stable: without this
            it grows from 1 placeholder row to N when the API resolves,
            reflowing the page and dragging scroll. The first pad row
            carries the waiting message; the rest are blank. */}
        {Array.from({ length: pad }).map((_, i) => (
          <TableRow key={`pad-${i}`} sx={{ '& td': { borderColor: 'transparent' } }}>
            <TableCell
              colSpan={11}
              sx={{
                textAlign: 'center', color: 'text.secondary', height: 41, py: 0,
              }}
            >
              {i === 0 && blocks.length === 0 ? emptyMessage ?? ' ' : ' '}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

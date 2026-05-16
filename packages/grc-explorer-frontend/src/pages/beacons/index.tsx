import {
  Box, Chip, Paper, Stack, Tab, Table, TableBody, TableCell, TableHead, TablePagination, TableRow, Tabs, Typography,
} from '@mui/material';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useEffect, useRef, useState } from 'react';
import { Crumbs, RESEARCHERS_CRUMB } from '../../components/Crumbs';
import { HashTrim } from '../../components/HashTrim';
import { Layout } from '../../layouts/Layout';
import { api } from '../../lib/api';
import { formatNumber, formatTime } from '../../lib/format';
import { readPageFromQuery, readPageSizeFromQuery } from '../../lib/pagination';

interface Beacon {
  cpid: string;
  address: string;
  status: 'active' | 'expired' | 'superseded' | 'revoked';
  txId: string;
  blockHeight: number;
  timestamp: number;
  expiration: number;
  /** Set when the beacon is past its 150-day renewal window and still
   *  active; equals the 180-day expiration. Null otherwise. */
  renewableUntil: number | null;
  /** Pre-v11 beacons cannot be renewed by the wallet — they have to
   *  be re-advertised. Surface this on the UI so researchers don't
   *  attempt a renewal that will be rejected. */
  mustReadvertise: boolean;
  /** Auth flow used to register the beacon — derived from the
   *  BeaconPayload version (v1=legacy hashboinc, v2=email-verify,
   *  v3=BOINC-server RSA-SHA512 ownership proof). 'unknown' for
   *  pre-feature indexed rows that pre-date the column. */
  authMethod: 'legacy' | 'v2_email_verify' | 'v3_boinc_signed' | 'unknown';
}

interface BeaconsPageProps {
  initialRows: Beacon[];
  initialTotal: number;
  initialStatus: string;
  initialPage: number;
  initialPageSize: number;
}

const STATUSES = ['all', 'active', 'expired', 'superseded', 'revoked'] as const;

const STATUS_CHIP_COLOR: Record<string, 'success' | 'default' | 'warning' | 'error'> = {
  active: 'success',
  expired: 'default',
  superseded: 'warning',
  revoked: 'error',
};

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];
const DEFAULT_PAGE_SIZE = 100;

function readStatusFromQuery(q: Record<string, string | string[] | undefined>): string {
  const raw = typeof q.status === 'string' ? q.status : '';
  return (STATUSES as readonly string[]).includes(raw) ? raw : 'all';
}

export default function BeaconsPage({
  initialRows, initialTotal, initialStatus, initialPage, initialPageSize,
}: BeaconsPageProps) {
  const router = useRouter();
  const [rows, setRows] = useState<Beacon[]>(initialRows);
  const [total, setTotal] = useState<number>(initialTotal);
  const [loading, setLoading] = useState(false);

  const page = readPageFromQuery(router.query);
  const pageSize = readPageSizeFromQuery(router.query, PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE);
  const status = readStatusFromQuery(router.query);

  // Skip the first fetch — SSR primed us with the right page already.
  const initialKey = `${initialStatus}/${initialPage}/${initialPageSize}`;
  const lastFetchedKey = useRef(initialKey);

  useEffect(() => {
    const key = `${status}/${page}/${pageSize}`;
    if (key === lastFetchedKey.current) return;
    lastFetchedKey.current = key;
    let cancelled = false;
    setLoading(true);
    const params: Record<string, string | number> = {
      'page[number]': page + 1,
      'page[size]': pageSize,
    };
    if (status !== 'all') params.status = status;
    api.get('/beacons', { params }).then((r) => {
      if (cancelled) return;
      const data = (r.data?.data ?? []) as Array<{ attributes: Beacon }>;
      setRows(data.map((d) => d.attributes));
      setTotal(Number(r.data?.meta?.count ?? 0));
    }).catch(() => {
      if (cancelled) return;
      setRows([]);
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [status, page, pageSize]);

  const updateQuery = (next: { status?: string; page?: number; pageSize?: number }) => {
    const query: Record<string, string> = {
      page: String(next.page ?? page),
      pageSize: String(next.pageSize ?? pageSize),
    };
    const nextStatus = next.status ?? status;
    if (nextStatus !== 'all') query.status = nextStatus;
    router.replace(
      { pathname: router.pathname, query },
      undefined,
      { scroll: false, shallow: true },
    );
  };

  const onTabChange = (_e: React.SyntheticEvent, value: string) => {
    // Reset to page 0 on filter change — page-N on a 200-row /active
    // filter is meaningless on a 5000-row /all view.
    updateQuery({ status: value, page: 0 });
  };

  return (
    <Layout>
      <Stack spacing={2}>
        <Crumbs items={[
          RESEARCHERS_CRUMB,
          { label: 'Beacons' },
        ]}
        />
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>Beacons</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
            Beacons are on-chain advertisements that link a researcher&apos;s
            CPID to a Gridcoin address. Every researcher who wants their
            BOINC magnitude rewarded must have a live beacon. Beacons
            expire 180 days after advertisement, become <em>renewable</em>
            at 150 days, and can be marked <em>superseded</em> when a newer
            beacon for the same CPID lands. Pre-v11 (Fern) beacons can&apos;t
            be renewed by the wallet — they must be re-advertised.
            Status is evaluated against current chain-time, not the value
            stored at write, so an &quot;active&quot; row really is still
            in force.
          </Typography>
        </Box>

        <Tabs
          value={status}
          onChange={onTabChange}
          variant="scrollable"
          scrollButtons="auto"
          sx={{ borderBottom: 1, borderColor: 'divider' }}
        >
          {STATUSES.map((s) => (
            <Tab key={s} value={s} label={s} sx={{ textTransform: 'capitalize' }} />
          ))}
        </Tabs>

        <Paper variant="outlined" sx={{ overflowX: 'auto', opacity: loading ? 0.6 : 1, transition: 'opacity 120ms' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>CPID</TableCell>
                <TableCell>Address</TableCell>
                <TableCell>Status</TableCell>
                <TableCell>Advertised</TableCell>
                <TableCell>Expires</TableCell>
                <TableCell sx={{ width: 100 }}>Block</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((b) => (
                <TableRow key={`${b.cpid}-${b.txId}`} hover>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    <Link href={`/cpids/${b.cpid}`} style={{ color: 'inherit' }}>
                      {b.cpid}
                    </Link>
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                    <Link href={`/addresses/${b.address}`} style={{ color: 'inherit' }}>
                      <HashTrim text={b.address} head={10} tail={6} />
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
                      <Chip
                        size="small"
                        label={b.status}
                        color={STATUS_CHIP_COLOR[b.status] ?? 'default'}
                        variant={b.status === 'active' ? 'filled' : 'outlined'}
                      />
                      {b.renewableUntil !== null && (
                        <Chip
                          size="small"
                          label="renewable"
                          color="info"
                          variant="outlined"
                          title={`Past the 150-day renewal window; can be renewed without re-advertising until ${formatTime(b.renewableUntil)}.`}
                        />
                      )}
                      {b.mustReadvertise && b.status === 'active' && (
                        <Chip
                          size="small"
                          label="must re-advertise"
                          color="warning"
                          variant="outlined"
                          title="Beacon registered before the v11 (Fern) fork — the wallet rejects renewal contracts that reference pre-v11 beacons. The owner must submit a fresh beacon advertisement."
                        />
                      )}
                      <AuthMethodChip method={b.authMethod} />
                    </Stack>
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>
                    {formatTime(b.timestamp)}
                  </TableCell>
                  <TableCell sx={{ color: 'text.secondary', fontSize: 12 }}>
                    {formatTime(b.expiration)}
                  </TableCell>
                  <TableCell>
                    <Link href={`/block/${b.blockHeight}`} style={{ color: 'inherit' }}>
                      {`#${formatNumber(b.blockHeight)}`}
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={6} sx={{ textAlign: 'center', color: 'text.secondary', py: 4 }}>
                    No beacons match this filter yet.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          <TablePagination
            component="div"
            count={total}
            page={page}
            onPageChange={(_, p) => updateQuery({ page: p })}
            rowsPerPage={pageSize}
            rowsPerPageOptions={PAGE_SIZE_OPTIONS}
            onRowsPerPageChange={(e) => updateQuery({ page: 0, pageSize: parseInt(e.target.value, 10) })}
          />
        </Paper>
      </Stack>
    </Layout>
  );
}

// Compact chip identifying the auth flow a beacon was registered with.
// Only renders for legacy/v2/v3 — 'unknown' is silenced because every
// pre-feature row would otherwise carry a noisy badge for no reason.
function AuthMethodChip({ method }: { method: Beacon['authMethod'] }) {
  if (method === 'unknown') return null;
  const label = method === 'v3_boinc_signed'
    ? 'v3'
    : method === 'v2_email_verify' ? 'v2' : 'v1';
  // v3 is the new BOINC-signed flow — highlight it so the rare-and-new
  // adoption is visible at a glance on the list. v1 (legacy) and v2
  // (email-verify) stay neutral so they don't compete for attention.
  const color: 'primary' | 'default' = method === 'v3_boinc_signed' ? 'primary' : 'default';
  const title = method === 'v3_boinc_signed'
    ? 'v3 beacon · BOINC-server-signed ownership proof (V14)'
    : method === 'v2_email_verify'
      ? 'v2 beacon · Fern-era email-verification flow'
      : 'v1 beacon · legacy hashboinc-derived (pre-Fern)';
  return <Chip size="small" label={label} color={color} variant="outlined" title={title} />;
}

export const getServerSideProps: GetServerSideProps<BeaconsPageProps> = async (ctx) => {
  const q = ctx.query as Record<string, string | string[] | undefined>;
  const status = readStatusFromQuery(q);
  const page = readPageFromQuery(q);
  const pageSize = readPageSizeFromQuery(q, PAGE_SIZE_OPTIONS, DEFAULT_PAGE_SIZE);
  try {
    const params: Record<string, string | number> = {
      'page[number]': page + 1,
      'page[size]': pageSize,
    };
    if (status !== 'all') params.status = status;
    const r = await api.get('/beacons', { params });
    const data = (r.data?.data ?? []) as Array<{ attributes: Beacon }>;
    const meta = r.data?.meta as { count?: number } | undefined;
    return {
      props: {
        initialRows: data.map((d) => d.attributes),
        initialTotal: typeof meta?.count === 'number' ? meta.count : 0,
        initialStatus: status,
        initialPage: page,
        initialPageSize: pageSize,
      },
    };
  } catch {
    return {
      props: {
        initialRows: [],
        initialTotal: 0,
        initialStatus: status,
        initialPage: page,
        initialPageSize: pageSize,
      },
    };
  }
};

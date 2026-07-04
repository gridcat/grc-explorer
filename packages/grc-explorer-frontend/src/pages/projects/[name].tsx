import {
  Card, CardContent, Chip, Paper, Stack, Table, TableBody, TableCell, TableHead, TableRow, Tooltip, Typography,
} from '@mui/material';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { useTheme } from '@mui/material/styles';
import type { GetServerSideProps } from 'next';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { useMemo } from 'react';
import { Seo } from '@/components/Seo';
import {
  ChartAxes, ChartFrame, ChartFrameProvider, linearScale, niceTicks,
} from '../../components/charts/SvgChart';
import { Crumbs, RESEARCHERS_CRUMB } from '../../components/Crumbs';
import { Layout } from '../../layouts/Layout';
import { api, notFoundOrRethrow } from '../../lib/api';
import { formatNumber, formatTime } from '../../lib/format';

// Validate that the on-chain `base_url` is something we can safely
// render as an `<a href>`. Delisted/legacy projects carry junk like
// "1" in this field; without the http(s) prefix check the browser
// resolves it as a same-origin path and the user lands on our own
// 404 page. Reject anything that isn't an absolute http(s) URL.
function isHttpUrl(s: string | null | undefined): s is string {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim();
  if (!trimmed) return false;
  try {
    const u = new URL(trimmed);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

interface ContractEvent {
  action: 'add' | 'remove' | string;
  baseUrl: string;
  contractVersion: number;
  txId: string;
  blockHeight: number;
  time: number;
}

interface RacSample {
  superblockHeight: number;
  rac: number;
  averageRac: number;
  totalCredit: number;
}

interface RelatedPoll {
  pollId: string;
  title: string;
  blockHeight: number;
  endTime: number;
}

interface ProjectAttributes {
  name: string;
  status: string | null;
  displayName: string;
  baseUrl: string | null;
  gdprControls: boolean | null;
  requiresExternalAdapter: boolean | null;
  contractEvents: ContractEvent[];
  racHistory: RacSample[];
  relatedPolls: RelatedPoll[];
}

interface ProjectPageProps {
  attrs: ProjectAttributes | null;
}

export default function ProjectPage({ attrs }: ProjectPageProps) {
  const router = useRouter();
  const routeName = typeof router.query.name === 'string' ? router.query.name : '';
  if (!attrs) {
    return (
      <>
        <Seo
          title="Project not found · Gridcoin Block Explorer"
          description="This BOINC project has no indexed superblock history on Gridcoin."
          path={`/projects/${routeName}`}
          noindex
        />
        <Layout>
          <Typography>Project not found.</Typography>
        </Layout>
      </>
    );
  }

  // Reject on-chain garbage like "1" that delisted projects sometimes
  // carry; we'd otherwise render a same-origin link that 404s. Only
  // accept absolute http(s) URLs.
  const cleanUrl = isHttpUrl(attrs.baseUrl) ? attrs.baseUrl.replace(/@$/, '') : null;
  const tone = statusTone(attrs.status);

  return (
    <>
      <Seo
        title={`${attrs.displayName} · Gridcoin Projects · Gridcoin Block Explorer`}
        description={`RAC, magnitude and superblock history for the ${attrs.name} BOINC project on Gridcoin.`}
        path={`/projects/${attrs.name}`}
      />
      <Layout>
      <Stack spacing={2}>
        <Crumbs
          items={[
            RESEARCHERS_CRUMB,
            { label: 'BOINC projects', href: '/' },
            { label: attrs.displayName },
          ]}
        />
        <Stack direction="row" sx={{ alignItems: 'baseline', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="h4" sx={{ fontWeight: 700 }}>
            {attrs.displayName}
          </Typography>
          {attrs.status && (
            <Chip label={attrs.status} size="small" color={tone} variant={tone === 'default' ? 'outlined' : 'filled'} />
          )}
          {attrs.gdprControls && (
            <Chip label="GDPR" size="small" variant="outlined" />
          )}
          {cleanUrl && (
            <a
              href={cleanUrl}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                color: 'inherit',
                opacity: 0.75,
                fontSize: 13,
              }}
            >
              {cleanUrl}
              <OpenInNewIcon sx={{ fontSize: 14 }} />
            </a>
          )}
        </Stack>

        <Card variant="outlined">
          <CardContent>
            <Stack direction="row" sx={{ alignItems: 'center', gap: 0.5, mb: 0.5 }}>
              <Typography variant="subtitle2" component="h2" sx={{ fontWeight: 700 }}>
                RAC over time
              </Typography>
              <Tooltip
                title="RAC — Recent Average Credit. A BOINC project-side rolling average of the credit awarded across all contributors, decaying with a 1-week half-life. Higher RAC means more compute was being thrown at the project around that superblock."
                placement="top"
                arrow
              >
                <InfoOutlinedIcon sx={{ fontSize: 14, color: 'text.disabled', cursor: 'help' }} />
              </Tooltip>
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
              {attrs.racHistory.length === 0
                ? 'No superblock samples for this project yet.'
                : `${formatNumber(attrs.racHistory.length)} samples across the chain — one per ~256 superblocks.`}
            </Typography>
            {attrs.racHistory.length >= 2 && (
              <ChartFrameProvider height={260}>
                {(frame) => <RacChart frame={frame} samples={attrs.racHistory} />}
              </ChartFrameProvider>
            )}
          </CardContent>
        </Card>

        {attrs.contractEvents.length > 0 && (
          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle2" component="h2" sx={{ fontWeight: 700, mb: 0.5 }}>
                Lifecycle (on chain)
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
                Project contract ADD / REMOVE events from the blockchain.
              </Typography>
              <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Action</TableCell>
                      <TableCell>Block</TableCell>
                      <TableCell>Time</TableCell>
                      <TableCell>URL at the time</TableCell>
                      <TableCell>Tx</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {attrs.contractEvents.map((ev) => (
                      <TableRow key={`${ev.txId}-${ev.action}`}>
                        <TableCell>
                          <Chip
                            label={ev.action === 'add' ? 'whitelist add' : 'de-list'}
                            size="small"
                            color={ev.action === 'add' ? 'success' : 'default'}
                            variant="outlined"
                          />
                        </TableCell>
                        <TableCell>
                          <Link href={`/block/${ev.blockHeight}`} style={{ color: 'inherit' }}>
                            {`#${formatNumber(ev.blockHeight)}`}
                          </Link>
                        </TableCell>
                        <TableCell>{formatTime(ev.time)}</TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all' }}>
                          {isHttpUrl(ev.baseUrl)
                            ? ev.baseUrl
                            : <span style={{ opacity: 0.5 }}>—</span>}
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                          <Link href={`/transactions/${ev.txId}`} style={{ color: 'inherit' }}>
                            {`${ev.txId.slice(0, 10)}…`}
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Paper>
            </CardContent>
          </Card>
        )}

        {attrs.relatedPolls.length > 0 && (
          <Card variant="outlined">
            <CardContent>
              <Typography variant="subtitle2" component="h2" sx={{ fontWeight: 700, mb: 0.5 }}>
                Related polls
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
                Polls whose title mentions {attrs.name}. Pattern-matched by name; some
                may be unrelated and a few may be missed if the title used a different spelling.
              </Typography>
              <Paper variant="outlined" sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Title</TableCell>
                      <TableCell>Block</TableCell>
                      <TableCell>Closed</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {attrs.relatedPolls.map((p) => (
                      <TableRow key={p.pollId}>
                        <TableCell>
                          <Link href={`/polls/${p.pollId}`} style={{ color: 'inherit' }}>{p.title}</Link>
                        </TableCell>
                        <TableCell>
                          <Link href={`/block/${p.blockHeight}`} style={{ color: 'inherit' }}>
                            {`#${formatNumber(p.blockHeight)}`}
                          </Link>
                        </TableCell>
                        <TableCell>{formatTime(p.endTime)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Paper>
            </CardContent>
          </Card>
        )}
      </Stack>
      </Layout>
    </>
  );
}

function statusTone(status: string | null): 'success' | 'default' {
  if (!status) return 'default';
  if (status === 'Active') return 'success';
  return 'default';
}

function RacChart({ frame, samples }: { frame: ChartFrame; samples: RacSample[] }) {
  const theme = useTheme();
  const layout = useMemo(() => {
    if (samples.length < 2 || frame.innerWidth <= 0) return null;
    const xMin = samples[0].superblockHeight;
    const xMax = samples[samples.length - 1].superblockHeight;
    const xScale = linearScale(xMin, xMax, 0, frame.innerWidth);
    let yMax = 0;
    for (const s of samples) {
      if (s.rac > yMax) yMax = s.rac;
    }
    if (yMax === 0) yMax = 1;
    const yPad = yMax * 0.05;
    const yScale = linearScale(0, yMax + yPad, frame.innerHeight, 0);
    const yTicks = niceTicks(0, yMax + yPad, 5);
    return {
      xMin, xMax, xScale, yScale, yTicks,
    };
  }, [samples, frame.innerWidth, frame.innerHeight]);

  const path = useMemo(() => {
    if (!layout) return null;
    const segs: string[] = [];
    for (let i = 0; i < samples.length; i += 1) {
      const s = samples[i];
      const x = layout.xScale(s.superblockHeight);
      const y = layout.yScale(s.rac);
      segs.push(`${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`);
    }
    return segs.join(' ');
  }, [layout, samples]);

  if (!layout || frame.width === 0) return null;

  // 6 evenly-spaced superblock-height ticks on the X axis. Keeps the
  // axis legible across very long spans (10k+ superblocks).
  const xTicks: { value: number; x: number }[] = [];
  const span = layout.xMax - layout.xMin;
  for (let i = 0; i <= 5; i += 1) {
    const v = Math.round(layout.xMin + (span * i) / 5);
    xTicks.push({ value: v, x: layout.xScale(v) });
  }

  return (
    <svg
      width="100%"
      height={frame.height}
      viewBox={`0 0 ${frame.width} ${frame.height}`}
      style={{ display: 'block' }}
    >
      <ChartAxes
        frame={frame}
        yTicks={layout.yTicks}
        xTicks={xTicks}
        yFormat={(v) => formatRac(v)}
        xFormat={(v) => `#${v.toLocaleString()}`}
      />
      <g transform={`translate(${frame.margin.left},${frame.margin.top})`}>
        {path && (
          <path
            d={path}
            fill="none"
            stroke={theme.palette.primary.main}
            strokeWidth={1.25}
          />
        )}
      </g>
    </svg>
  );
}

function formatRac(v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return v.toFixed(0);
}

export const getServerSideProps: GetServerSideProps<ProjectPageProps> = async (ctx) => {
  const { name } = ctx.params ?? {};
  if (typeof name !== 'string') return { notFound: true };
  try {
    const r = await api.get(`/projects/${encodeURIComponent(name)}`);
    const attrs = (r.data?.data?.attributes ?? null) as ProjectAttributes | null;
    if (!attrs) return { notFound: true };
    return { props: { attrs } };
  } catch (err) {
    return notFoundOrRethrow(err);
  }
};

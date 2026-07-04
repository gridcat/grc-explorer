import {
  Box, Button, Card, CardContent, Chip, Dialog, DialogContent, DialogTitle, IconButton, LinearProgress, Stack, Table, TableBody, TableCell, TableHead, TableRow, TableSortLabel, Tooltip, Typography,
} from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import VerifiedUserIcon from '@mui/icons-material/VerifiedUser';
import type { GetServerSideProps } from 'next';
import { useRouter } from 'next/router';
import Link from 'next/link';
import {
  useEffect, useMemo, useRef, useState,
} from 'react';
import { Seo } from '@/components/Seo';
import { Layout } from '../../layouts/Layout';
import { api, notFoundOrRethrow } from '../../lib/api';
import { formatTime, nowSec } from '../../lib/format';
import { Crumbs } from '../../components/Crumbs';
import { HashTrim } from '../../components/HashTrim';
import { NextMuiLink } from '../../components/NextMuiLink';
import { safeUrl } from '../../lib/safeUrl';

interface Poll {
  pollId: string;
  title: string;
  question: string;
  url: string | null;
  pollType: string | null;
  responseType: string;
  weightType: string;
  startTime: number;
  endTime: number;
  blockHeight: number;
  claimTx: string;
  creatorAddress: string | null;
}

interface PollOption {
  idx: number;
  label: string;
  voteCount: number;
  voteWeight: string; // GRC
  pctOfCast: number;
  pctOfAvw: number;
}

interface PollVote {
  txId: string;
  voterAddress: string | null;
  voterCpid: string | null;
  miningId: string | null;
  choiceIdx: number;
  weight: string;
  weightBalance: string;
  weightMagnitude: number;
  blockHeight: number;
  time: number | null;
}

function formatGrcCompact(grc: string | number): string {
  const n = typeof grc === 'number' ? grc : parseFloat(grc);
  if (!Number.isFinite(n) || n === 0) return '0';
  // Spaces every three digits, two decimals — same convention as
  // gridcoinstats so the numbers feel familiar at a glance.
  const fixed = n.toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return decPart === '00' ? grouped : `${grouped}.${decPart}`;
}

// Cap a user-supplied string to `max` characters, suffixing with an
// ellipsis if it was longer. Used for breadcrumb labels where the
// label is purely navigational context — wrapping a megabyte-scale
// title in a single breadcrumb row would make the navigation rail
// unusable.
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function pollDuration(start: number, end: number): string {
  const days = Math.round((end - start) / 86_400);
  return `${days} day${days === 1 ? '' : 's'}`;
}

function pollStatus(end: number): 'Active' | 'Ended' {
  return nowSec() < end ? 'Active' : 'Ended';
}

interface PollDetailProps {
  initialPoll: Poll | null;
  initialOptions: PollOption[];
  initialVotes: PollVote[];
  initialVoteTotal: number;
  initialTotalWeightCast: string;
  initialAvwBalance: string;
  initialAvwMagnitude: number;
  initialAvwCombined: string;
  initialWeightsComputed: boolean;
}

export default function PollDetail({
  initialPoll, initialOptions, initialVotes, initialVoteTotal,
  initialTotalWeightCast, initialAvwBalance, initialAvwMagnitude,
  initialAvwCombined, initialWeightsComputed,
}: PollDetailProps) {
  const router = useRouter();
  const { poll_id: pollId } = router.query;
  const [poll, setPoll] = useState<Poll | null>(initialPoll);
  const [options, setOptions] = useState<PollOption[]>(initialOptions);
  const [votes, setVotes] = useState<PollVote[]>(initialVotes);
  const [voteTotal, setVoteTotal] = useState(initialVoteTotal);
  const [totalWeightCast, setTotalWeightCast] = useState(initialTotalWeightCast);
  const [avwBalance, setAvwBalance] = useState(initialAvwBalance);
  const [avwMagnitude, setAvwMagnitude] = useState(initialAvwMagnitude);
  const [avwCombined, setAvwCombined] = useState(initialAvwCombined);
  const [weightsComputed, setWeightsComputed] = useState(initialWeightsComputed);
  const [claimOpen, setClaimOpen] = useState(false);
  const [claimText, setClaimText] = useState<string>('');
  const [claimLoading, setClaimLoading] = useState(false);

  // Ref guard so post-fetch setPoll doesn't re-trigger the effect.
  const lastFetchedRef = useRef<string | null>(initialPoll?.pollId ?? null);
  useEffect(() => {
    if (typeof pollId !== 'string' || !pollId) return;
    if (lastFetchedRef.current === pollId) return;
    lastFetchedRef.current = pollId;
    api.get(`/polls/${pollId}`).then((r) => {
      setPoll(r.data?.data?.attributes ?? null);
      setOptions(r.data?.options ?? []);
      setVotes(r.data?.votes ?? []);
      setVoteTotal(r.data?.voteTotal ?? 0);
      setTotalWeightCast(String(r.data?.totalWeightCast ?? '0'));
      setAvwBalance(String(r.data?.avwBalance ?? '0'));
      setAvwMagnitude(Number(r.data?.avwMagnitude ?? 0));
      setAvwCombined(String(r.data?.avwCombined ?? '0'));
      setWeightsComputed(!!r.data?.weightsComputed);
    }).catch(() => { /* ignore */ });
  }, [pollId]);

  // Voting Distribution table is sortable by any column. Default is
  // weight desc with a count tiebreak — the natural "winning choice
  // first" view; clicking a header swaps to that key (asc), clicking
  // again flips direction.
  type DistSortKey = 'choice' | 'pct' | 'weight' | 'votes';
  const [distSortKey, setDistSortKey] = useState<DistSortKey>('weight');
  const [distSortDir, setDistSortDir] = useState<'asc' | 'desc'>('desc');
  const toggleDistSort = (key: DistSortKey) => {
    if (key === distSortKey) {
      setDistSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setDistSortKey(key);
      // First click on a fresh column starts at the more useful
      // direction: alphabetical for text, descending for numbers.
      setDistSortDir(key === 'choice' ? 'asc' : 'desc');
    }
  };
  const orderedOptions = useMemo(() => {
    const sign = distSortDir === 'asc' ? 1 : -1;
    return [...options].sort((a, b) => {
      switch (distSortKey) {
        case 'choice':
          return sign * a.label.localeCompare(b.label);
        case 'pct':
          return sign * (a.pctOfCast - b.pctOfCast);
        case 'votes':
          return sign * (a.voteCount - b.voteCount);
        case 'weight':
        default: {
          const w = parseFloat(a.voteWeight) - parseFloat(b.voteWeight);
          if (w !== 0) return sign * w;
          // Tiebreak by count so two zero-weight options sort consistently.
          return sign * (a.voteCount - b.voteCount);
        }
      }
    });
  }, [options, distSortKey, distSortDir]);

  const labelByIdx = useMemo(() => {
    const m = new Map<number, string>();
    for (const o of options) m.set(o.idx, o.label);
    return m;
  }, [options]);

  // Same sortable-headers contract on the per-vote table. Default is
  // time desc — newest votes first — matching how the daemon's
  // `votedetails` and other explorers show them.
  type VoteSortKey = 'time' | 'voter' | 'cpid' | 'choice' | 'weight';
  const [voteSortKey, setVoteSortKey] = useState<VoteSortKey>('time');
  const [voteSortDir, setVoteSortDir] = useState<'asc' | 'desc'>('desc');
  const toggleVoteSort = (key: VoteSortKey) => {
    if (key === voteSortKey) {
      setVoteSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setVoteSortKey(key);
      // Numbers default to desc, text columns default to asc — what
      // people usually want from a fresh click.
      const isNumeric = key === 'time' || key === 'weight';
      setVoteSortDir(isNumeric ? 'desc' : 'asc');
    }
  };
  const orderedVotes = useMemo(() => {
    const sign = voteSortDir === 'asc' ? 1 : -1;
    const cmpStr = (a: string | null | undefined, b: string | null | undefined) => {
      // Empty / null sorts after populated values regardless of direction
      // — saves the user from scrolling past a wall of "—" rows.
      const aHas = !!a;
      const bHas = !!b;
      if (aHas !== bHas) return aHas ? -1 : 1;
      if (!aHas) return 0;
      return (a as string).localeCompare(b as string);
    };
    return [...votes].sort((a, b) => {
      switch (voteSortKey) {
        case 'time': {
          // Fall back to block_height when block time is missing — keeps
          // ordering deterministic for votes whose blocks haven't been
          // joined yet.
          const at = a.time ?? a.blockHeight;
          const bt = b.time ?? b.blockHeight;
          return sign * (at - bt);
        }
        case 'voter':
          return sign * cmpStr(a.voterAddress, b.voterAddress);
        case 'cpid':
          return sign * cmpStr(a.voterCpid ?? a.miningId, b.voterCpid ?? b.miningId);
        case 'choice': {
          const aLabel = labelByIdx.get(a.choiceIdx) ?? `#${a.choiceIdx}`;
          const bLabel = labelByIdx.get(b.choiceIdx) ?? `#${b.choiceIdx}`;
          return sign * aLabel.localeCompare(bLabel);
        }
        case 'weight':
        default:
          return sign * (parseFloat(a.weight) - parseFloat(b.weight));
      }
    });
  }, [votes, voteSortKey, voteSortDir, labelByIdx]);

  if (!poll) return <Layout><Typography>Loading…</Typography></Layout>;

  const status = pollStatus(poll.endTime);
  const cast = parseFloat(totalWeightCast);
  const avw = parseFloat(avwCombined);
  const castPctOfAvw = avw > 0 ? (cast / avw) * 100 : 0;

  // The aggregator computes weights live for active polls too, so the
  // note should only appear while weights are genuinely missing: votes
  // exist but none have been weighted yet (the ≤15-min gap before the
  // aggregator's next pass) and the poll hasn't been finalised. Once
  // weights land — for an active or an ended poll — percentages render
  // and the note clears.
  const weightsPending = voteTotal > 0 && cast === 0 && !weightsComputed;

  const openClaim = (txId: string) => {
    setClaimOpen(true);
    setClaimText('');
    setClaimLoading(true);
    api.get(`/polls/votes/${txId}/claim`).then((r) => {
      const data = r.data?.data;
      const meta = r.data?.meta;
      const isLegacy = !!meta?.legacyVote;
      const daemonMsg = meta?.daemonMessage as string | undefined;
      if (data) {
        const header = isLegacy
          ? '// Legacy (v1) vote — no claim signature to verify.\n'
            + '// The voter\'s self-declared weight + responses are below,\n'
            + '// pulled from the contract body via getrawtransaction.\n\n'
          : '';
        setClaimText(header + JSON.stringify(data, null, 2));
        return;
      }
      setClaimText(daemonMsg ? `Daemon: ${daemonMsg}` : 'No claim returned.');
    }).catch((err) => {
      const daemonMsg = err?.response?.data?.meta?.daemonMessage as string | undefined;
      setClaimText(daemonMsg
        ? `Daemon: ${daemonMsg}`
        : 'Could not reach the daemon to verify this vote.');
    }).finally(() => setClaimLoading(false));
  };

  // Poll titles are user-supplied and unbounded; clamp before baking them
  // into the <title>/description so a pathological poll can't blow out the
  // SERP snippet (and the tab title).
  const seoTitle = poll.title.length > 70 ? `${poll.title.slice(0, 69)}…` : poll.title;

  return (
    <>
      <Seo
        title={`Poll: ${seoTitle} · Gridcoin Block Explorer`}
        description={`Voting results, weight and options for the Gridcoin poll “${seoTitle}”.`}
        path={`/polls/${poll.pollId}`}
      />
      <Layout>
      <Stack spacing={2}>
        <Crumbs items={[
          { label: 'Polls', href: '/polls' },
          // Trim the breadcrumb label aggressively — user-supplied titles
          // can be unbroken multi-kilobyte strings, and the breadcrumb
          // exists for navigation context, not for full content.
          { label: truncate(poll.title, 60) },
        ]}
        />
        <Stack direction="row" spacing={2} sx={{ alignItems: 'center', flexWrap: 'wrap', rowGap: 1 }}>
          {/*
            Wrap unbreakable character runs (`overflow-wrap: anywhere`)
            and clamp to 4 lines so a megabyte-scale title can't take
            half the viewport vertically. The full text remains in the
            DOM (and the title attr) so users can inspect it.
          */}
          <Typography
            variant="h4"
            sx={{
              fontWeight: 700,
              overflowWrap: 'anywhere',
              display: '-webkit-box',
              WebkitLineClamp: 4,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              flex: '1 1 auto',
              minWidth: 0,
            }}
            title={poll.title}
          >
            {poll.title}
          </Typography>
          <Chip
            label={status}
            color={status === 'Active' ? 'success' : 'default'}
            size="small"
          />
          {poll.pollType && <Chip label={poll.pollType} size="small" variant="outlined" />}
        </Stack>

        <Card variant="outlined">
          <CardContent>
            <Typography
              variant="body1"
              sx={{ mb: 1, overflowWrap: 'anywhere' }}
            >
              <strong>Question: </strong>{poll.question}
            </Typography>
            {poll.url && (() => {
              // poll.url comes off the chain — it's user input. Allowlist
              // its scheme via safeUrl so disallowed URLs never reach the
              // anchor. When safeUrl returns null we still show the
              // string so the user can see what was submitted, but it
              // renders as plain text — no clickable href.
              const safe = safeUrl(poll.url);
              return (
                <Typography
                  variant="body2"
                  sx={{ mb: 1, overflowWrap: 'anywhere' }}
                >
                  Read more:{' '}
                  {safe ? (
                    <NextMuiLink href={safe} target="_blank" rel="noopener noreferrer" prose>
                      {poll.url}
                    </NextMuiLink>
                  ) : (
                    <Box
                      component="span"
                      sx={{ color: 'text.disabled', fontStyle: 'italic' }}
                      title="URL scheme not allowed; rendered as plain text for safety."
                    >
                      {poll.url}
                    </Box>
                  )}
                </Typography>
              );
            })()}
            <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: 'wrap', mt: 1 }}>
              <Stat label="Duration" value={pollDuration(poll.startTime, poll.endTime)} />
              <Stat label="Poll type" value={poll.pollType ?? '—'} />
              <Stat label="Weight type" value={poll.weightType} />
              <Stat label="Response type" value={poll.responseType} />
              <Stat label="Status" value={status} />
            </Stack>
            <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: 'wrap', mt: 1.5 }}>
              {poll.creatorAddress && (
                <Stat
                  label="Creator"
                  value={(
                    <Link href={`/addresses/${poll.creatorAddress}`} style={{ color: 'inherit', fontFamily: 'monospace', fontSize: 12 }}>
                      {poll.creatorAddress}
                    </Link>
                  )}
                />
              )}
              <Stat label="Create time" value={formatTime(poll.startTime)} />
              <Stat
                label="Create TX"
                value={(
                  <Link href={`/transactions/${poll.claimTx}`} style={{ color: 'inherit', fontFamily: 'monospace', fontSize: 12 }}>
                    <HashTrim text={poll.claimTx} head={6} tail={0} />
                    {`@${poll.blockHeight}`}
                  </Link>
                )}
              />
            </Stack>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2 }}>Voting Distribution</Typography>
            {weightsPending && (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 1, fontStyle: 'italic' }}>
                Vote weights are still being computed by the aggregator (it runs every ~15 min). Counts are accurate; weighted percentages will fill in shortly.
              </Typography>
            )}
            <Stack direction="row" spacing={3} useFlexGap sx={{ flexWrap: 'wrap', mb: 2 }}>
              <Stat
                label="Active Vote-weight (AV-W)"
                value={`${formatGrcCompact(avwCombined)}${poll.weightType === 'Magnitude+Balance' ? ` (${formatGrcCompact(avwBalance)} bal + ${formatGrcCompact(avwMagnitude)} mag)` : ''}`}
              />
              <Stat
                label="Poll Vote-weight"
                value={`${formatGrcCompact(totalWeightCast)} (${castPctOfAvw.toFixed(2)}% of AV-W)`}
              />
              <Stat label="Total votes" value={String(voteTotal)} />
            </Stack>

            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>
                    <TableSortLabel
                      active={distSortKey === 'choice'}
                      direction={distSortKey === 'choice' ? distSortDir : 'asc'}
                      onClick={() => toggleDistSort('choice')}
                    >
                      Choice
                    </TableSortLabel>
                  </TableCell>
                  <TableCell align="right">
                    <TableSortLabel
                      active={distSortKey === 'pct'}
                      direction={distSortKey === 'pct' ? distSortDir : 'desc'}
                      onClick={() => toggleDistSort('pct')}
                    >
                      % of cast
                    </TableSortLabel>
                  </TableCell>
                  <TableCell align="right">
                    <TableSortLabel
                      active={distSortKey === 'weight'}
                      direction={distSortKey === 'weight' ? distSortDir : 'desc'}
                      onClick={() => toggleDistSort('weight')}
                    >
                      Weight (GRC)
                    </TableSortLabel>
                  </TableCell>
                  <TableCell align="right">
                    <TableSortLabel
                      active={distSortKey === 'votes'}
                      direction={distSortKey === 'votes' ? distSortDir : 'desc'}
                      onClick={() => toggleDistSort('votes')}
                    >
                      Votes
                    </TableSortLabel>
                  </TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {orderedOptions.map((o) => (
                  <TableRow key={o.idx}>
                    <TableCell sx={{ width: '32%', maxWidth: 0 }}>
                      {/* width:32% + maxWidth:0 forces the cell to share
                          row width proportionally, so a megabyte-scale
                          option label can't widen the column out from
                          under the percentage / weight cells. The Box
                          inside clamps to 2 lines and breaks within
                          unbreakable strings. */}
                      <Box
                        title={o.label}
                        sx={{
                          fontWeight: 500,
                          overflowWrap: 'anywhere',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {o.label}
                      </Box>
                      <LinearProgress
                        variant="determinate"
                        value={Math.min(100, Math.max(0, o.pctOfCast))}
                        sx={{ height: 6, borderRadius: 1, mt: 0.5 }}
                      />
                    </TableCell>
                    <TableCell align="right">{o.pctOfCast.toFixed(2)}%</TableCell>
                    <TableCell align="right">{formatGrcCompact(o.voteWeight)}</TableCell>
                    <TableCell align="right">{o.voteCount}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card variant="outlined">
          <CardContent>
            <Typography variant="h6" sx={{ mb: 2 }}>Voting</Typography>
            {votes.length === 0 ? (
              <Typography variant="body2" color="text.secondary">No votes recorded yet.</Typography>
            ) : (
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small" sx={{ minWidth: 720 }}>
                  <TableHead>
                    <TableRow>
                      <TableCell>
                        <TableSortLabel
                          active={voteSortKey === 'time'}
                          direction={voteSortKey === 'time' ? voteSortDir : 'desc'}
                          onClick={() => toggleVoteSort('time')}
                        >
                          Time
                        </TableSortLabel>
                      </TableCell>
                      <TableCell>
                        <TableSortLabel
                          active={voteSortKey === 'voter'}
                          direction={voteSortKey === 'voter' ? voteSortDir : 'asc'}
                          onClick={() => toggleVoteSort('voter')}
                        >
                          Voter
                        </TableSortLabel>
                      </TableCell>
                      <TableCell>
                        <TableSortLabel
                          active={voteSortKey === 'cpid'}
                          direction={voteSortKey === 'cpid' ? voteSortDir : 'asc'}
                          onClick={() => toggleVoteSort('cpid')}
                        >
                          CPID / Mining ID
                        </TableSortLabel>
                      </TableCell>
                      <TableCell>
                        <TableSortLabel
                          active={voteSortKey === 'choice'}
                          direction={voteSortKey === 'choice' ? voteSortDir : 'asc'}
                          onClick={() => toggleVoteSort('choice')}
                        >
                          Choice
                        </TableSortLabel>
                      </TableCell>
                      <TableCell align="right">
                        <TableSortLabel
                          active={voteSortKey === 'weight'}
                          direction={voteSortKey === 'weight' ? voteSortDir : 'desc'}
                          onClick={() => toggleVoteSort('weight')}
                        >
                          Weight (GRC)
                        </TableSortLabel>
                      </TableCell>
                      <TableCell align="center">Verify</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {orderedVotes.map((v) => (
                      // Multi-choice votes generate one row per response
                      // sharing the same `txId`. Keying by txId alone
                      // collides during reconciliation and React reuses
                      // DOM nodes in original mount order, leaving the
                      // table looking unsorted even though the data is.
                      <TableRow key={`${v.txId}#${v.choiceIdx}`} hover>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>
                          {v.time ? formatTime(v.time) : `block #${v.blockHeight}`}
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {v.voterAddress
                            ? <Link href={`/addresses/${v.voterAddress}`} style={{ color: 'inherit' }}>{v.voterAddress}</Link>
                            : '—'}
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                          {v.voterCpid
                            ? <Link href={`/cpids/${v.voterCpid}`} style={{ color: 'inherit' }}>{v.voterCpid}</Link>
                            : v.miningId ?? <Box sx={{ color: 'text.disabled', fontStyle: 'italic' }}>investor</Box>}
                        </TableCell>
                        <TableCell sx={{ maxWidth: 240 }}>
                          {/* Choice label may be the same kind of
                              user-supplied unbounded string as the poll
                              title — clamp + wrap the same way. */}
                          {(() => {
                            const choice = labelByIdx.get(v.choiceIdx) ?? `#${v.choiceIdx}`;
                            return (
                              <Box
                                title={choice}
                                sx={{
                                  overflowWrap: 'anywhere',
                                  display: '-webkit-box',
                                  WebkitLineClamp: 2,
                                  WebkitBoxOrient: 'vertical',
                                  overflow: 'hidden',
                                }}
                              >
                                {choice}
                              </Box>
                            );
                          })()}
                        </TableCell>
                        <TableCell align="right">{formatGrcCompact(v.weight)}</TableCell>
                        <TableCell align="center">
                          <Tooltip title="Verify claim via daemon">
                            <IconButton size="small" onClick={() => openClaim(v.txId)}>
                              <VerifiedUserIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            )}
          </CardContent>
        </Card>
      </Stack>

      <Dialog open={claimOpen} onClose={() => setClaimOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          Vote claim
          <IconButton onClick={() => setClaimOpen(false)} size="small">
            <CloseIcon fontSize="small" />
          </IconButton>
        </DialogTitle>
        <DialogContent>
          {claimLoading ? (
            <Typography variant="body2" color="text.secondary">Verifying…</Typography>
          ) : (
            <Box
              component="pre"
              sx={{
                fontFamily: 'monospace',
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
                m: 0,
              }}
            >
              {claimText || 'No claim payload returned.'}
            </Box>
          )}
        </DialogContent>
      </Dialog>
      </Layout>
    </>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Stack>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="body2" sx={{ fontWeight: 500 }} component="div">{value}</Typography>
    </Stack>
  );
}

export const getServerSideProps: GetServerSideProps<PollDetailProps> = async (ctx) => {
  const { poll_id: pollId } = ctx.params ?? {};
  if (typeof pollId !== 'string') return { notFound: true };
  try {
    const r = await api.get(`/polls/${pollId}`);
    const attrs = r.data?.data?.attributes as Poll | undefined;
    if (!attrs) return { notFound: true };
    return {
      props: {
        initialPoll: attrs,
        initialOptions: r.data?.options ?? [],
        initialVotes: r.data?.votes ?? [],
        initialVoteTotal: r.data?.voteTotal ?? 0,
        initialTotalWeightCast: String(r.data?.totalWeightCast ?? '0'),
        initialAvwBalance: String(r.data?.avwBalance ?? '0'),
        initialAvwMagnitude: Number(r.data?.avwMagnitude ?? 0),
        initialAvwCombined: String(r.data?.avwCombined ?? '0'),
        initialWeightsComputed: !!r.data?.weightsComputed,
      },
    };
  } catch (err) {
    return notFoundOrRethrow(err);
  }
};


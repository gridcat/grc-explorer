import {
  Box, Card, CardContent, LinearProgress, Stack, Tooltip, Typography,
} from '@mui/material';
import { useTheme } from '@mui/material/styles';
import {
  useEffect, useReducer, useRef, useState,
} from 'react';
import { api } from '../lib/api';
import { useSSE } from '../hooks/useSSE';
import { atParam, useTimeMachine } from '../hooks/useTimeMachine';
import {
  formatCompact, formatDuration, formatTime, nowSec,
} from '../lib/format';

export interface NetworkStats {
  /** Daemon chain tip. May be null on first paint when the indexer
   *  hasn't yet successfully polled the wallet RPC; the UI must
   *  handle null without flagging "caught up". */
  tip_height: number | null;
  tip_hash: string;
  indexed_height: number | null;
  indexer_status: 'backfilling' | 'live' | 'reorg' | string;
  difficulty: string;
  peer_count: number;
  mempool_size: number;
  /** Wallet daemon `getnetworkinfo.version`. Older Gridcoin builds
   *  returned a packed integer (`major*1e6 + minor*1e4 + patch*1e2
   *  + build`); current builds return a human string like
   *  `"v5.5.0.1-unk"`. We accept either. */
  net_version?: string | number;
  rpc_version?: string | number;
  /** Per-fork activation status keyed against the indexer's current
   *  height. `forks.v13` flips to true automatically as soon as the
   *  chain crosses the V13 height (3,989,800 mainnet / 2,870,000
   *  testnet), so MSS-related UI panels can gate their visibility on
   *  this without a deploy. Optional because pre-this-feature responses
   *  may not carry it; treat missing as "all false". */
  forks?: Record<string, boolean>;
}

interface NetworkVitalsProps {
  /** Pre-fetched on the server so the four headline tiles render with
   *  values on first paint instead of '—'. The CSR refresh / SSE / poll
   *  flow continues unchanged on top of this seed. */
  initialStats?: NetworkStats | null;
}

export function NetworkVitals({ initialStats = null }: NetworkVitalsProps = {}) {
  const tm = useTimeMachine();
  const [stats, setStats] = useState<NetworkStats | null>(initialStats);

  // Updates ride on the `network.stats` SSE feed (the indexer publishes
  // it every ~15 s with the full payload). The HTTP refresh below is a
  // safety net — it only fires if the SSE channel has been silent for
  // STALE_MS, which happens during disconnects / hidden tab returns /
  // server restarts. While SSE is healthy the network is idle.
  const lastEventAtRef = useRef<number>(Date.now());
  useEffect(() => {
    let alive = true;
    const fetchOnce = () => api.get('/network', { params: atParam(tm.at) }).then((r) => {
      if (!alive) return;
      const attrs = (r.data?.data?.attributes ?? null) as NetworkStats | null;
      if (attrs) {
        setStats((prev) => {
          if (tm.isReplay) return attrs; // replay = full replace, no guard
          if (!prev) return attrs;
          // Monotonic guard: tip should never go backwards outside of
          // replay (a stray Redis cache miss could otherwise briefly
          // drop the displayed value to null/lower). Treat null as
          // "no information" — never let an incoming null stomp a
          // previously known good value.
          const next = { ...attrs };
          const incomingTip = attrs.tip_height;
          const prevTip = prev.tip_height;
          if (incomingTip == null && prevTip != null) {
            next.tip_height = prevTip;
            next.tip_hash = prev.tip_hash;
          } else if (incomingTip != null && prevTip != null && incomingTip < prevTip) {
            next.tip_height = prevTip;
            next.tip_hash = prev.tip_hash;
          }
          return next;
        });
      }
    }).catch(() => { /* ignore */ });

    // Skip the initial fetch when SSR already seeded `stats`. Without
    // this, every page load fires an immediate GET /network — which is
    // exactly the "lot of polling" we're trying to avoid.
    if (initialStats == null) {
      fetchOnce();
      lastEventAtRef.current = Date.now();
    }
    if (tm.isReplay) return () => { alive = false; };

    // Stale check: only refetch if the SSE feed has gone quiet. The
    // indexer publishes `network.stats` every 15 s, so a 3-minute
    // silence window is well outside normal cadence.
    const STALE_MS = 3 * 60 * 1000;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (!alive) return;
      if (Date.now() - lastEventAtRef.current >= STALE_MS) {
        fetchOnce();
        lastEventAtRef.current = Date.now();
      }
      timer = setTimeout(check, STALE_MS);
    };
    timer = setTimeout(check, STALE_MS);
    const onVisible = () => {
      if (!document.hidden && Date.now() - lastEventAtRef.current >= STALE_MS) {
        fetchOnce();
        lastEventAtRef.current = Date.now();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [tm.at, tm.isReplay, initialStats]);

  useSSE(['network.stats'], (_topic, payload) => {
    if (tm.isReplay) return; // ignore live events while in replay
    lastEventAtRef.current = Date.now();
    const incoming = payload as NetworkStats;
    setStats((prev) => {
      if (!prev) return incoming;
      const next = { ...incoming };
      const incomingTip = incoming.tip_height;
      const prevTip = prev.tip_height;
      if (incomingTip == null && prevTip != null) {
        next.tip_height = prevTip;
        next.tip_hash = prev.tip_hash;
      } else if (incomingTip != null && prevTip != null && incomingTip < prevTip) {
        next.tip_height = prevTip;
        next.tip_hash = prev.tip_hash;
      }
      return next;
    });
  });

  return (
    <Stack direction="row" spacing={{ xs: 1, sm: 2 }} useFlexGap sx={{ flexWrap: 'wrap' }}>
      <HeightTile
        indexed={stats?.indexed_height ?? null}
        tip={stats?.tip_height ?? null}
      />
      <ActiveStakersTile />
      <DifficultyTile current={stats?.difficulty} />
      <Tile label="Mempool" value={stats?.mempool_size ?? '—'} />
      <LastBlockTile />
    </Stack>
  );
}

/**
 * Subcomponent isolated so its 5-second tick only re-renders this one
 * tile, not the whole NetworkVitals tree. Anchors on the absolute block
 * time and recomputes display on each tick — no growing counter to
 * carry, and the displayed string stays correct after the user comes
 * back to the tab from background.
 */
function LastBlockTile() {
  const [lastBlockTime, setLastBlockTime] = useState<number | null>(null);
  const [, forceTick] = useReducer((x: number) => x + 1, 0);

  // Seed from the latest indexed block on mount. Without this the tile
  // sat on "—" until the *next* `block.new` SSE event landed — which
  // during a long backfill or on a quiet network is many minutes away.
  useEffect(() => {
    let alive = true;
    api.get('/blocks', { params: { 'page[size]': 1 } }).then((r) => {
      if (!alive) return;
      const t = r.data?.data?.[0]?.attributes?.time;
      if (typeof t === 'number') setLastBlockTime((prev) => (prev == null ? t : Math.max(prev, t)));
    }).catch(() => { /* ignore */ });
    return () => { alive = false; };
  }, []);

  useSSE(['block.new'], (_topic, payload) => {
    const p = payload as { time: number };
    // Keep the latest time we've seen — SSE bursts during backfill can
    // arrive slightly out of order across batches, and we don't want a
    // stale older block to overwrite a newer one.
    if (typeof p.time === 'number') setLastBlockTime((prev) => (prev == null ? p.time : Math.max(prev, p.time)));
  });

  useEffect(() => {
    // 5s interval — formatDuration buckets to s/m/h/d, so faster ticks
    // would mostly be wasted re-renders.
    const handle = setInterval(forceTick, 5000);
    return () => clearInterval(handle);
  }, []);

  const ago = lastBlockTime
    ? `${formatDuration(Math.max(0, nowSec() - lastBlockTime))} ago`
    : '—';
  // Compact date-only line so the on-chain year is visible at a glance
  // during long backfills (when the headline reads "10y ago"). Once
  // caught-up it just confirms today's date — small, useful, low noise.
  // Tooltip carries the full UTC timestamp for anyone who needs the
  // exact second.
  const dateLine = lastBlockTime
    ? new Date(lastBlockTime * 1000).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    })
    : null;
  const fullStamp = lastBlockTime ? formatTime(lastBlockTime) : '';

  return (
    <Card
      variant="outlined"
      sx={{
        flex: { xs: '1 1 calc(50% - 4px)', sm: '1 1 160px' },
        minWidth: { xs: 0, sm: 160 },
      }}
    >
      <CardContent sx={{ p: { xs: 1.25, sm: 2 }, ':last-child': { pb: { xs: 1.25, sm: 2 } } }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: { xs: 9.5, sm: 11 } }}
        >
          Last block
        </Typography>
        <Tooltip title={fullStamp} placement="bottom" disableHoverListener={!fullStamp}>
          <Typography
            sx={{
              mt: 0.5,
              fontWeight: 600,
              fontSize: { xs: '1.05rem', sm: '1.5rem' },
              lineHeight: 1.25,
            }}
          >
            {ago}
          </Typography>
        </Tooltip>
        {dateLine && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {dateLine}
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Combined "Indexed / Tip" tile. Two heights matter to the user:
 *   - the daemon's tip (what the chain actually knows about), and
 *   - the indexer's last_indexed_height (how far we've caught up).
 *
 * They diverge during backfill and rejoin once `indexer_status === 'live'`.
 * We show both as "indexed / tip" with a small percentage when they differ.
 */
function HeightTile({
  indexed,
  tip,
}: {
  indexed: number | null;
  tip: number | null;
}) {
  const fmt = (n: number | null) => (n === null || n === undefined ? '—' : n.toLocaleString());
  const caughtUp = indexed !== null && tip !== null && indexed >= tip - 6;
  const pct = (indexed !== null && tip !== null && tip > 0)
    ? Math.min(100, Math.max(0, (indexed / tip) * 100))
    : null;
  // The cursor's `status` field is intentionally NOT consulted here —
  // it flickers between 'live' (set by every BlockWriter.applyBlocks
  // during backfill) and 'backfilling' (set by TipFollower's tick
  // when it spots the huge lag). The numeric gap via `caughtUp` is
  // the honest test. Without this the % bar blinks on/off during
  // normal backfill rhythm.
  const showProgress = !caughtUp && pct !== null;

  // ETA: rolling 5-minute window of (indexed, tip) samples. We measure
  // how fast the indexed-to-tip *gap* is closing (not raw indexer rate)
  // so the estimate stays honest while the chain itself keeps advancing
  // — at slow backfill rates, tip drift would otherwise make an
  // indexer-only rate too optimistic.
  const samplesRef = useRef<Array<{ at: number; indexed: number; tip: number }>>([]);
  const [, forceTick] = useReducer((x: number) => x + 1, 0);

  useEffect(() => {
    if (indexed == null || tip == null) return;
    const now = Date.now();
    const arr = samplesRef.current;
    const last = arr[arr.length - 1];
    if (!last || last.indexed !== indexed || last.tip !== tip) {
      arr.push({ at: now, indexed, tip });
    }
    const cutoff = now - 5 * 60 * 1000;
    while (arr.length > 1 && arr[0].at < cutoff) arr.shift();
  }, [indexed, tip]);

  // Re-render every 30s so the ETA refreshes when `indexed` plateaus
  // (no incoming SSE means the parent prop reference is stable and
  // wouldn't trip our render otherwise).
  useEffect(() => {
    const id = setInterval(forceTick, 30_000);
    return () => clearInterval(id);
  }, []);

  const etaSec = (() => {
    if (!showProgress || indexed == null || tip == null) return null;
    const arr = samplesRef.current;
    if (arr.length < 2) return null;
    const oldest = arr[0];
    const newest = arr[arr.length - 1];
    const dt = (newest.at - oldest.at) / 1000;
    if (dt < 30) return null; // need at least 30s of signal to be useful
    const gapOld = oldest.tip - oldest.indexed;
    const gapNew = newest.tip - newest.indexed;
    const closingPerSec = (gapOld - gapNew) / dt;
    if (closingPerSec <= 0) return null; // indexer stalled or losing ground
    return Math.round(Math.max(0, tip - indexed) / closingPerSec);
  })();

  return (
    <Card
      variant="outlined"
      sx={{
        flex: { xs: '1 1 calc(50% - 4px)', sm: '1 1 220px' },
        minWidth: { xs: 0, sm: 220 },
      }}
    >
      <CardContent sx={{ p: { xs: 1.25, sm: 2 }, ':last-child': { pb: { xs: 1.25, sm: 2 } } }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: { xs: 9.5, sm: 11 } }}
        >
          Indexed / Tip
        </Typography>
        <Stack direction="row" sx={{ alignItems: 'baseline', gap: 0.75, mt: 0.5, flexWrap: 'wrap' }}>
          <Typography
            sx={{
              fontWeight: 600,
              fontSize: { xs: '1.05rem', sm: '1.5rem' },
              lineHeight: 1.25,
            }}
          >
            {fmt(indexed)}
          </Typography>
          <Typography color="text.secondary" sx={{ fontSize: { xs: '0.95rem', sm: '1.15rem' } }}>
            /
          </Typography>
          <Typography
            color="text.secondary"
            sx={{
              fontWeight: 500,
              fontSize: { xs: '0.95rem', sm: '1.15rem' },
              lineHeight: 1.25,
            }}
          >
            {fmt(tip)}
          </Typography>
        </Stack>
        {showProgress && (
          <>
            <LinearProgress
              variant="determinate"
              value={pct}
              sx={{ mt: 0.75, height: 4, borderRadius: 2 }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              {`backfilling · ${pct.toFixed(2)}%${etaSec !== null ? ` · ~${formatDuration(etaSec)} left` : ''}`}
            </Typography>
          </>
        )}
        {caughtUp && (
          <Typography variant="caption" sx={{ display: 'block', mt: 0.5, color: 'success.main' }}>
            caught up
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

function formatDifficulty(raw: string | undefined | null): string {
  if (raw === undefined || raw === null || raw === '') return '—';
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return '—';
  return formatCompact(n, 2);
}

function Tile({ label, value }: { label: string; value: string | number }) {
  return (
    <Card
      variant="outlined"
      sx={{
        // Two tiles per row on a phone (~375px wide), four+ on desktop.
        flex: { xs: '1 1 calc(50% - 4px)', sm: '1 1 160px' },
        minWidth: { xs: 0, sm: 160 },
      }}
    >
      <CardContent sx={{ p: { xs: 1.25, sm: 2 }, ':last-child': { pb: { xs: 1.25, sm: 2 } } }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: { xs: 9.5, sm: 11 } }}
        >
          {label}
        </Typography>
        <Typography
          sx={{
            mt: 0.5,
            fontWeight: 600,
            fontSize: { xs: '1.05rem', sm: '1.5rem' },
            lineHeight: 1.25,
            wordBreak: 'break-all',
          }}
        >
          {value}
        </Typography>
      </CardContent>
    </Card>
  );
}


function PeerSparkline({
  values, stroke, width = 80, height = 28,
}: {
  values: number[]; stroke: string; width?: number; height?: number;
}) {
  if (values.length < 2) return null;
  let min = values[0];
  let max = values[0];
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const span = max - min || 1;
  const stepX = width / (values.length - 1);
  const path = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / span) * height;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Active stakers tile — chain-derivable measure of "how alive was the
 * network at this moment." Headline is the count of distinct CPIDs
 * that minted a PoS block in the last 24 h of CHAIN-time before the
 * anchor (indexer tip in live mode, `?at=` in time-machine). The
 * sparkline is per-hour distinct-CPID counts.
 *
 * Distinct from `PeersTile`: peers come from our daemon's live
 * `getconnectioncount` and only exist within network_snapshots' 7-day
 * TTL. Active-stakers is purely chain-derivable, so it works for any
 * historical block height.
 */
function ActiveStakersTile() {
  const theme = useTheme();
  const tm = useTimeMachine();
  const [current, setCurrent] = useState<number | null>(null);
  const [history, setHistory] = useState<number[]>([]);

  useEffect(() => {
    let alive = true;
    const fetchOnce = () => api.get('/metrics/active-stakers', {
      params: { hours: 24, ...atParam(tm.at) },
    })
      .then((r) => {
        if (!alive) return;
        const attrs = r.data?.data?.attributes ?? {};
        setCurrent(typeof attrs.current === 'number' ? attrs.current : null);
        const points = (attrs.points ?? []) as Array<{ count: number }>;
        setHistory(points.map((p) => p.count));
      })
      .catch(() => { /* ignore */ });
    fetchOnce();
    if (tm.isReplay) return () => { alive = false; };
    // 5-min poll: distinct-CPID-in-last-24h drifts slowly. The
    // debounced block.new nudge below already fires on every block
    // (capped at 1 per 30 s), so this is just the safety floor for
    // when SSE is silent.
    const id = setInterval(fetchOnce, 5 * 60 * 1000);
    return () => { alive = false; clearInterval(id); };
  }, [tm.at, tm.isReplay]);

  // Block.new still nudges the count when a new staker mints, but we
  // debounce so a backfill burst doesn't fire 100 refetches a second.
  const lastNudgeAtRef = useRef<number>(0);
  useSSE(['block.new'], () => {
    if (tm.isReplay) return;
    const now = Date.now();
    if (now - lastNudgeAtRef.current < 30_000) return;
    lastNudgeAtRef.current = now;
    api.get('/metrics/active-stakers', { params: { hours: 24 } })
      .then((r) => {
        const attrs = r.data?.data?.attributes ?? {};
        if (typeof attrs.current === 'number') setCurrent(attrs.current);
      })
      .catch(() => { /* ignore */ });
  });

  return (
    <Card
      variant="outlined"
      sx={{
        flex: { xs: '1 1 calc(50% - 4px)', sm: '1 1 160px' },
        minWidth: { xs: 0, sm: 160 },
      }}
    >
      <CardContent sx={{ p: { xs: 1.25, sm: 2 }, ':last-child': { pb: { xs: 1.25, sm: 2 } } }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: { xs: 9.5, sm: 11 } }}
        >
          Active stakers
        </Typography>
        <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between', mt: 0.5 }}>
          <Typography
            sx={{
              fontWeight: 600,
              fontSize: { xs: '1.05rem', sm: '1.5rem' },
              lineHeight: 1.25,
            }}
          >
            {current === null ? '—' : current.toLocaleString()}
          </Typography>
          {history.length >= 2 && (
            <Box sx={{ width: 80, height: 28, opacity: 0.7 }}>
              <PeerSparkline values={history} stroke={theme.palette.primary.main} />
            </Box>
          )}
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          on-chain · last 24h
        </Typography>
      </CardContent>
    </Card>
  );
}

/**
 * Difficulty tile — same pattern as PeersTile, sourced from the same
 * /network/history endpoint. Difficulty drifts slowly (PoS retarget
 * is per-block but smoothed); the sparkline shows the recent trend.
 */
function DifficultyTile({ current }: { current: string | undefined }) {
  const theme = useTheme();
  const tm = useTimeMachine();
  const [history, setHistory] = useState<number[]>([]);

  useEffect(() => {
    let alive = true;
    const fetchOnce = () => api.get('/network/history', {
      params: { hours: 1, ...(tm.at !== null ? { endAt: tm.at } : {}) },
    })
      .then((r) => {
        if (!alive) return;
        const points = (r.data?.data?.attributes?.points ?? []) as Array<{ difficulty: string }>;
        setHistory(points.map((p) => Number(p.difficulty)).filter((n) => Number.isFinite(n)));
      })
      .catch(() => { /* migration not applied yet — leave sparkline empty */ });
    fetchOnce();
    if (tm.isReplay) return () => { alive = false; };
    // Slow safety-net poll — the SSE subscription below is the primary
    // refresh path. 5 minutes is enough to self-heal a dropped SSE
    // without flooding the API.
    const id = setInterval(fetchOnce, 300_000);
    return () => { alive = false; clearInterval(id); };
  }, [tm.at, tm.isReplay]);

  // Append the live difficulty from each NetworkStatsPoller tick so
  // the sparkline updates without waiting for the next refetch. Same
  // 1-hour-of-ticks cap as PeersTile.
  useSSE(['network.stats'], (_topic, payload) => {
    if (tm.isReplay) return;
    const incoming = payload as { difficulty?: string };
    const n = Number(incoming.difficulty);
    if (!Number.isFinite(n)) return;
    setHistory((prev) => {
      const next = prev.concat(n);
      return next.length > 240 ? next.slice(-240) : next;
    });
  });

  return (
    <Card
      variant="outlined"
      sx={{
        flex: { xs: '1 1 calc(50% - 4px)', sm: '1 1 160px' },
        minWidth: { xs: 0, sm: 160 },
      }}
    >
      <CardContent sx={{ p: { xs: 1.25, sm: 2 }, ':last-child': { pb: { xs: 1.25, sm: 2 } } }}>
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: { xs: 9.5, sm: 11 } }}
        >
          Difficulty
        </Typography>
        <Stack direction="row" sx={{ alignItems: 'baseline', justifyContent: 'space-between', mt: 0.5 }}>
          <Typography
            sx={{
              fontWeight: 600,
              fontSize: { xs: '1.05rem', sm: '1.5rem' },
              lineHeight: 1.25,
            }}
          >
            {formatDifficulty(current)}
          </Typography>
          {history.length >= 2 && (
            <Box sx={{ width: 80, height: 28, opacity: 0.7 }}>
              <PeerSparkline values={history} stroke={theme.palette.secondary.main} />
            </Box>
          )}
        </Stack>
        {history.length >= 2 && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            on-chain · last 1h
          </Typography>
        )}
      </CardContent>
    </Card>
  );
}

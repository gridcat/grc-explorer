import {
  Box, Chip, Paper, Stack, Tooltip, Typography, useTheme,
} from '@mui/material';
import type { Theme } from '@mui/material';
import { useMemo } from 'react';

// JSON shape returned by GET /blocks/:h `meta.flow` (see backend
// services/blockFlow/buildBlockFlow). Amounts are GRC decimal strings.
interface FlowEndpoint {
  kind: 'address' | 'minted' | 'opreturn' | 'network' | 'inputs';
  address: string | null;
  label?: string;
  isStaker?: boolean;
  cpid?: string | null;
  cpidName?: string | null;
}
interface Flow {
  category: 'transfer' | 'change' | 'mint_block' | 'mint_research' | 'stake_return' | 'sidestake' | 'data' | 'fee' | 'mrc_fee';
  amount: string;
  from: FlowEndpoint;
  to: FlowEndpoint;
  voutIdx?: number;
  detail?: {
    cpid?: string | null;
    magnitude?: number | null;
    isMrc?: boolean;
    sidestakeKind?: 'mandatory' | 'voluntary';
    contract?: { kind: string; summary: string };
  };
}
interface TxFlow { txId: string; kind: string; flows: Flow[] }
export interface BlockFlowPayload {
  summary: {
    height: number;
    minted: {
      block: string; research: string; mrc: string; cpid: string | null; magnitude: number | null;
    };
    moved: string;
    staked: string;
    sidestaked: { total: string; recipients: number };
    data: { stamps: number; votes: number; beacons: number; polls: number; projects: number; other: number };
    txCount: number;
  };
  txFlows: TxFlow[];
}

const CATEGORY_LABEL: Record<Flow['category'], string> = {
  transfer: 'Transfer',
  change: 'Change',
  mint_block: 'Block reward',
  mint_research: 'Research reward',
  stake_return: 'Staked (returned)',
  sidestake: 'Sidestake',
  data: 'Data',
  fee: 'Fee',
  mrc_fee: 'MRC fee',
};

function categoryColor(theme: Theme, c: Flow['category']): string {
  switch (c) {
    case 'transfer': return theme.palette.primary.main;
    case 'mint_block': return theme.palette.success.main;
    case 'mint_research': return theme.palette.secondary.main;
    case 'sidestake': return theme.palette.warning.main;
    case 'data': return theme.palette.warning.dark;
    case 'fee': return theme.palette.error.light;
    case 'mrc_fee': return theme.palette.error.main;
    default: return theme.palette.text.disabled; // change, stake_return
  }
}

const trimAddr = (a: string): string => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

function endpointLabel(e: FlowEndpoint): string {
  switch (e.kind) {
    case 'minted': return '⛏ minted';
    case 'opreturn': return 'OP_RETURN';
    case 'network': return 'fees';
    case 'inputs': return e.label ?? 'inputs';
    default:
      if (e.isStaker) return 'staker';
      return e.address ? trimAddr(e.address) : (e.label ?? '—');
  }
}

const nodeKey = (e: FlowEndpoint, side: 'l' | 'r'): string => `${side}:${e.kind}:${e.address ?? e.label ?? ''}`;

// Coinstake flows all terminate at the staker. Split them into two lanes —
// "staked" (the principal returning) and "rewards" (block + research +
// collected fees, which converge here) — so the diagram reads as two
// separate funnels instead of every link piling onto one node.
type RightLane = 'staked' | 'rewards' | '';
const rightLane = (f: Flow): RightLane => {
  if (!f.to.isStaker) return '';
  return f.category === 'stake_return' ? 'staked' : 'rewards';
};
const rightNodeKey = (f: Flow): string => {
  const lane = rightLane(f);
  return lane ? `r:staker:${lane}` : nodeKey(f.to, 'r');
};

// Block reward and research reward both originate from "minted"; give each
// its own entry node (rather than fanning two lines out of one point) so
// the rewards read as a clean funnel of distinct, labelled sources. MRC
// payouts and their fee shares fan out of one shared "MRC reward" node:
// the mint splits into claimant net + foundation fee + staker fee.
function leftDisplay(f: Flow): { key: string; label?: string } {
  if (f.from.kind === 'minted') {
    if (f.category === 'mrc_fee' || (f.category === 'mint_research' && f.detail?.isMrc)) {
      return { key: 'l:minted:mrc', label: '⛏ MRC reward' };
    }
    if (f.category === 'mint_research') return { key: 'l:minted:research', label: '⛏ research reward' };
    if (f.category === 'mint_block') return { key: 'l:minted:block', label: '⛏ block reward' };
  }
  return { key: nodeKey(f.from, 'l') };
}

function flowTitle(f: Flow): string {
  const amt = f.amount === '0' ? '' : `${f.amount} GRC · `;
  const base = `${amt}${CATEGORY_LABEL[f.category]}: ${endpointLabel(f.from)} → ${endpointLabel(f.to)}`;
  const bits: string[] = [];
  if (f.detail?.contract) bits.push(f.detail.contract.summary);
  if (f.detail?.isMrc) bits.push('MRC');
  if (f.detail?.cpid) bits.push(`CPID ${f.detail.cpid}`);
  if (f.detail?.magnitude != null) bits.push(`magnitude ${f.detail.magnitude}`);
  if (f.detail?.sidestakeKind) bits.push(f.detail.sidestakeKind);
  return bits.length ? `${base} (${bits.join(' · ')})` : base;
}

// A flow endpoint node: a dot + label. Addresses link to their page and,
// when the wallet's researcher CPID is known, show it as a clickable
// sub-line (→ the CPID page). SVG <a> navigates natively.
function FlowNode({
  e, x, y, side, displayLabel, hideCpid,
}: {
  e: FlowEndpoint; x: number; y: number; side: 'left' | 'right'; displayLabel?: string; hideCpid?: boolean;
}) {
  const theme = useTheme();
  const anchor = side === 'left' ? 'end' : 'start';
  const labelX = side === 'left' ? x - 9 : x + 9;
  const isAddr = e.kind === 'address' && !!e.address;
  const showCpid = !!e.cpid && !hideCpid;
  const label = (
    <text
      x={labelX}
      y={showCpid ? y - 1 : y + 3.5}
      textAnchor={anchor}
      fontSize={10.5}
      fill={isAddr ? theme.palette.primary.main : theme.palette.text.primary}
    >
      {displayLabel ?? endpointLabel(e)}
    </text>
  );
  return (
    <g>
      <circle cx={x} cy={y} r={2.5} fill={theme.palette.text.secondary} />
      {isAddr ? <a href={`/addresses/${e.address}`}>{label}</a> : label}
      {showCpid && (
        <a href={`/cpids/${e.cpid}`}>
          <text x={labelX} y={y + 10} textAnchor={anchor} fontSize={8.5} fill={theme.palette.secondary.main}>
            {e.cpidName ? `🔬 ${e.cpidName}` : `CPID ${trimAddr(e.cpid ?? '')}`}
          </text>
        </a>
      )}
    </g>
  );
}

// One bipartite diagram per transaction: distinct `from` endpoints on the
// left, distinct `to` endpoints on the right, a bezier link per flow
// coloured by category and weighted by amount. An endpoint that is both a
// source and a sink (the staker) appears on both sides — the faint
// stake-return link between them reads as "principal came back".
function TxDiagram({ tx }: { tx: TxFlow }) {
  const theme = useTheme();
  const layout = useMemo(() => {
    const left = new Map<string, { e: FlowEndpoint; label?: string }>();
    const right = new Map<string, { e: FlowEndpoint; lane: RightLane }>();
    let maxAmt = 0;
    for (const f of tx.flows) {
      const ld = leftDisplay(f);
      left.set(ld.key, { e: f.from, label: ld.label });
      right.set(rightNodeKey(f), { e: f.to, lane: rightLane(f) });
      // The staked principal (returned to the staker) is typically orders
      // of magnitude larger than the actual rewards/transfers and would
      // crush every other link to a hairline. It never drives the scale —
      // it's drawn as a fixed faint line and netted in the summary.
      if (f.category !== 'stake_return') maxAmt = Math.max(maxAmt, Number(f.amount) || 0);
    }
    return { left: Array.from(left), right: Array.from(right), maxAmt };
  }, [tx]);

  if (tx.flows.length === 0) return null;

  const W = 620;
  const rowH = 34;
  const padY = 14;
  const rows = Math.max(layout.left.length, layout.right.length);
  const H = rows * rowH + padY * 2;
  const leftX = 168;
  const rightX = W - 168;
  const yFor = (i: number, n: number) => padY + (H - padY * 2) * (n === 1 ? 0.5 : i / (n - 1));
  const leftY = new Map(layout.left.map(([k], i) => [k, yFor(i, layout.left.length)]));
  const rightY = new Map(layout.right.map(([k], i) => [k, yFor(i, layout.right.length)]));

  // Thin scale: 1–6px. The old 2–18px range made high-value links read
  // as solid bars; relative weight survives at a fraction of the ink.
  const widthFor = (f: Flow) => {
    if (f.category === 'stake_return') return 1; // fixed faint line; never scales
    const amt = Number(f.amount) || 0;
    return amt > 0 && layout.maxAmt > 0 ? 1 + (amt / layout.maxAmt) * 5 : 1;
  };

  // Several flows can share the same endpoints — e.g. block reward AND
  // research reward both run minted → staker — giving identical curves and
  // identical mid-points where their amount labels stack on top of each
  // other. Bucket links by endpoint pair and fan each bucket apart
  // vertically so both the curves and their labels are legible.
  const mx = (leftX + rightX) / 2;
  const SPREAD = 15;
  const links = tx.flows.map((f, i) => ({
    f, i, y1: leftY.get(leftDisplay(f).key) ?? H / 2, y2: rightY.get(rightNodeKey(f)) ?? H / 2,
  }));
  const bucketSize = new Map<string, number>();
  links.forEach((l) => { const k = `${l.y1}:${l.y2}`; bucketSize.set(k, (bucketSize.get(k) ?? 0) + 1); });
  const bucketSeen = new Map<string, number>();

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} role="img" style={{ display: 'block' }}>
      {/* links */}
      {links.map(({
        f, i, y1, y2,
      }) => {
        const dashed = f.category === 'data' || f.category === 'stake_return' || f.category === 'fee';
        const color = categoryColor(theme, f.category);
        const key = `${y1}:${y2}`;
        const n = bucketSize.get(key) ?? 1;
        const idx = bucketSeen.get(key) ?? 0;
        bucketSeen.set(key, idx + 1);
        // Vertical offset so parallel links (same endpoints) bow apart.
        const off = n > 1 ? (idx - (n - 1) / 2) * SPREAD : 0;
        // Cubic with both controls shifted by `off` puts the t=0.5 point at
        // (mx, midY + 0.75·off) — place the label there too.
        const midY = (y1 + y2) / 2 + 0.75 * off;
        const label = f.amount !== '0'
          ? `${f.amount} GRC`
          : (f.detail?.contract && f.detail.contract.kind !== 'unknown' ? f.detail.contract.kind : 'data');
        return (
          <Tooltip key={`${f.category}-${f.voutIdx ?? i}`} title={flowTitle(f)} arrow>
            <g>
              <path
                d={`M${leftX},${y1} C${mx},${y1 + off} ${mx},${y2 + off} ${rightX},${y2}`}
                fill="none"
                stroke={color}
                strokeWidth={widthFor(f)}
                strokeOpacity={f.category === 'change' || f.category === 'stake_return' ? 0.35 : 0.55}
                strokeDasharray={dashed ? '4 3' : undefined}
                strokeLinecap="round"
              />
              <text
                x={mx}
                y={midY - 3}
                textAnchor="middle"
                fontSize={9}
                fontWeight={500}
                fill={theme.palette.text.primary}
                stroke={theme.palette.background.paper}
                strokeWidth={2}
                paintOrder="stroke"
                style={{ pointerEvents: 'none' }}
              >
                {label}
              </text>
            </g>
          </Tooltip>
        );
      })}
      {layout.left.map(([k, { e, label }]) => (
        <FlowNode key={k} e={e} x={leftX} y={leftY.get(k) ?? H / 2} side="left" displayLabel={label} />
      ))}
      {layout.right.map(([k, { e, lane }]) => (
        <FlowNode
          key={k}
          e={e}
          x={rightX}
          y={rightY.get(k) ?? H / 2}
          side="right"
          displayLabel={lane === 'staked' ? 'staked ↩' : undefined}
          hideCpid={lane === 'staked'}
        />
      ))}
    </svg>
  );
}

function Legend() {
  const theme = useTheme();
  const items: Flow['category'][] = ['mint_research', 'mint_block', 'transfer', 'sidestake', 'data', 'change'];
  return (
    <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', rowGap: 0.5 }}>
      {items.map((c) => (
        <Stack key={c} direction="row" spacing={0.5} sx={{ alignItems: 'center' }}>
          <Box sx={{
            width: 14, height: 3, borderRadius: 2, bgcolor: categoryColor(theme, c),
          }}
          />
          <Typography variant="caption" color="text.secondary">{CATEGORY_LABEL[c]}</Typography>
        </Stack>
      ))}
    </Stack>
  );
}

export function BlockFlow({ flow }: { flow: BlockFlowPayload | null }) {
  const { summary, txFlows } = flow ?? { summary: null, txFlows: [] };
  const drawn = txFlows.filter((t) => t.flows.length > 0);
  if (!summary || drawn.length === 0) return null;

  const mrcMinted = summary.minted.mrc ?? '0';
  const hasMint = summary.minted.research !== '0' || summary.minted.block !== '0' || mrcMinted !== '0';
  const dataTotal = Object.values(summary.data).reduce((a, b) => a + b, 0);

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 0.5 }}>
        What happened in this block
      </Typography>
      <Typography variant="caption" color="text.disabled" sx={{ display: 'block', mb: 1.5 }}>
        A plain-language view of the value that moved, was minted, or was written as data.
      </Typography>

      {/* Headline */}
      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1, mb: 2 }}>
        {hasMint && (
          <Chip
            color="success"
            variant="outlined"
            label={`⛏ minted ${summary.minted.research} research + ${summary.minted.block} block${mrcMinted !== '0' ? ` + ${mrcMinted} MRC` : ''} GRC${summary.minted.cpid ? ` · CPID ${summary.minted.cpid.slice(0, 8)}…` : ''}`}
          />
        )}
        {summary.moved !== '0' && <Chip variant="outlined" label={`💸 moved ${summary.moved} GRC`} />}
        {summary.staked !== '0' && <Chip variant="outlined" label={`🔒 staked ${summary.staked} GRC`} />}
        {summary.sidestaked.total !== '0' && (
          <Chip color="warning" variant="outlined" label={`↪ sidestaked ${summary.sidestaked.total} GRC → ${summary.sidestaked.recipients}`} />
        )}
        {dataTotal > 0 && <Chip color="warning" variant="outlined" label={`📦 ${dataTotal} data record${dataTotal === 1 ? '' : 's'}`} />}
      </Stack>

      <Legend />

      <Stack spacing={1} sx={{ mt: 1.5 }}>
        {drawn.map((tx) => (
          <Box key={tx.txId}>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
              {tx.kind}
              {' · '}
              {trimAddr(tx.txId)}
            </Typography>
            <TxDiagram tx={tx} />
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}

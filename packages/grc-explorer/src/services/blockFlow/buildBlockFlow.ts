// Assembles the per-block flow payload for the block detail endpoint.
//
// Pulls the rows we already index (tx inputs/outputs, the block claim,
// coinstake sidestakes, decoded contracts), maps them into the pure
// `categorizeTx` input shape, and serialises the result (halford bigint →
// GRC string) for JSON. The categorisation semantics live in lib/blockFlow
// and are unit-tested there; this module is just plumbing + I/O.

import { query, hasColumns } from '../../lib/db';
import { cpidDisplayName, resolveCpidNames } from '../../lib/cpidNames';
import { halford2grc } from '../../lib/halford';
import {
  categorizeTx, summarizeBlock, ContractKind, FlowContract, FlowMrc, TxFlow, BlockFlowSummary,
} from '../../lib/blockFlow';

interface TxMeta { txId: string; isCoinbase: boolean; isCoinstake: boolean }
interface ClaimRow {
  cpid: string | null;
  block_subsidy: string | null;
  research_subsidy: string | null;
  magnitude: number | null;
  is_mrc: boolean | null;
  mrc_foundation_fees: string | null;
  mrc_staker_fees: string | null;
}

// Serialised (JSON-safe) shapes: amounts become GRC decimal strings.
interface SerializedEndpoint {
  kind: string;
  address: string | null;
  label?: string;
  isStaker?: boolean;
  cpid?: string | null; // researcher CPID owning the address, when known
  cpidName?: string | null; // resolved researcher display name (e.g. "zepingouin")
}
interface SerializedFlow {
  category: string;
  amount: string;
  from: SerializedEndpoint;
  to: SerializedEndpoint;
  voutIdx?: number;
  detail?: TxFlow['flows'][number]['detail'];
}
interface SerializedTxFlow {
  txId: string;
  kind: string;
  flows: SerializedFlow[];
  totals: { minted: string; moved: string; staked: string; sidestaked: string; fee: string; dataRecords: number };
}
export interface BlockFlowPayload {
  summary: {
    height: number;
    minted: {
      block: string; research: string; mrc: string; cpid: string | null; magnitude: number | null;
    };
    moved: string;
    staked: string;
    sidestaked: { total: string; recipients: number };
    data: BlockFlowSummary['data'];
    txCount: number;
  };
  txFlows: SerializedTxFlow[];
}

function group<T>(rows: T[], key: (r: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    const arr = m.get(k) ?? [];
    arr.push(r);
    m.set(k, arr);
  }
  return m;
}

// One contract per (carrying) tx — enough to label its OP_RETURN output.
// Each source table is filtered to the block and keyed by tx_id.
async function buildContractMap(height: number): Promise<Map<string, FlowContract>> {
  const map = new Map<string, FlowContract>();
  const add = (txId: string, kind: ContractKind, summary: string) => {
    if (txId && !map.has(txId)) map.set(txId, { kind, summary });
  };
  const [beacons, votes, polls, messages, projects, mrcs, protocols] = await Promise.all([
    query<{ tx_id: string; cpid: string }>('SELECT tx_id, cpid FROM beacons WHERE block_height = $h', { h: height }),
    query<{ tx_id: string }>('SELECT DISTINCT tx_id FROM votes WHERE block_height = $h', { h: height }),
    query<{ poll_id: string; title: string }>('SELECT poll_id, title FROM polls WHERE block_height = $h', { h: height }),
    query<{ tx_id: string }>('SELECT tx_id FROM tx_messages WHERE block_height = $h', { h: height }),
    query<{ tx_id: string; project_name: string; action: string }>('SELECT tx_id, project_name, action FROM project_contracts WHERE block_height = $h', { h: height }),
    query<{ tx_id: string }>('SELECT tx_id FROM mrc_requests WHERE block_height = $h', { h: height }),
    query<{ tx_id: string; key: string }>('SELECT tx_id, key FROM protocol_entries WHERE block_height = $h', { h: height }),
  ]);
  for (const b of beacons) add(b.tx_id, 'beacon', b.cpid ? `Beacon · CPID ${b.cpid}` : 'Beacon advertisement');
  for (const v of votes) add(v.tx_id, 'vote', 'Poll vote');
  for (const p of polls) add(p.poll_id, 'poll', p.title ? `Poll: ${p.title}` : 'Poll');
  for (const m of messages) add(m.tx_id, 'message', 'Message');
  for (const p of projects) add(p.tx_id, 'project', `Project ${p.action}: ${p.project_name}`);
  for (const m of mrcs) add(m.tx_id, 'mrc', 'Manual rewards claim');
  for (const p of protocols) add(p.tx_id, 'protocol', p.key ? `Protocol: ${p.key}` : 'Protocol entry');
  return map;
}

// MRCs paid by this block's coinstake (claim_mrcs rows), with each
// claimant's known beacon addresses so the categorizer can match the
// payout vout on rows indexed before the per-MRC fee column existed.
async function fetchFlowMrcs(height: number): Promise<FlowMrc[]> {
  const feeCol = (await hasColumns('claim_mrcs', ['fee'])) ? 'CAST(fee AS VARCHAR)' : 'NULL';
  const rows = await query<{
    cpid: string | null; research_subsidy: string | null; magnitude: number | null; fee: string | null;
  }>(
    `SELECT cpid, CAST(research_subsidy AS VARCHAR) AS research_subsidy, magnitude, ${feeCol} AS fee
     FROM claim_mrcs WHERE block_height = $h
     ORDER BY CAST(research_subsidy AS UBIGINT) DESC`,
    { h: height },
  );
  if (rows.length === 0) return [];
  const cpids = [...new Set(rows.map((r) => r.cpid).filter((c): c is string => !!c))];
  const beaconsByCpid = new Map<string, string[]>();
  if (cpids.length > 0) {
    const beaconRows = await query<{ address: string; cpid: string }>(
      'SELECT DISTINCT address, cpid FROM beacons WHERE cpid = ANY($c)',
      { c: cpids },
    );
    for (const b of beaconRows) {
      if (!b.address || !b.cpid) continue;
      const arr = beaconsByCpid.get(b.cpid) ?? [];
      arr.push(b.address);
      beaconsByCpid.set(b.cpid, arr);
    }
  }
  return rows.map((r) => ({
    cpid: r.cpid,
    researchSubsidy: BigInt(r.research_subsidy ?? '0'),
    fee: r.fee != null ? BigInt(r.fee) : null,
    magnitude: r.magnitude ?? null,
    beaconAddresses: r.cpid ? (beaconsByCpid.get(r.cpid) ?? []) : [],
  }));
}

function withCpid(
  e: TxFlow['flows'][number]['from'],
  addrCpid: Map<string, string>,
  names: Map<string, string>,
): SerializedEndpoint {
  if (e.kind === 'address' && e.address && addrCpid.has(e.address)) {
    const cpid = addrCpid.get(e.address)!;
    return { ...e, cpid, cpidName: cpidDisplayName(names, cpid) };
  }
  return e;
}

const serializeFlow = (
  f: TxFlow['flows'][number],
  addrCpid: Map<string, string>,
  names: Map<string, string>,
): SerializedFlow => ({
  category: f.category,
  amount: halford2grc(f.amount),
  from: withCpid(f.from, addrCpid, names),
  to: withCpid(f.to, addrCpid, names),
  voutIdx: f.voutIdx,
  detail: f.detail,
});

const serializeTxFlow = (
  tf: TxFlow,
  addrCpid: Map<string, string>,
  names: Map<string, string>,
): SerializedTxFlow => ({
  txId: tf.txId,
  kind: tf.kind,
  flows: tf.flows.map((f) => serializeFlow(f, addrCpid, names)),
  totals: {
    minted: halford2grc(tf.totals.minted),
    moved: halford2grc(tf.totals.moved),
    staked: halford2grc(tf.totals.staked),
    sidestaked: halford2grc(tf.totals.sidestaked),
    fee: halford2grc(tf.totals.fee),
    dataRecords: tf.totals.dataRecords,
  },
});

const serializeSummary = (s: BlockFlowSummary): BlockFlowPayload['summary'] => ({
  height: s.height,
  minted: {
    block: halford2grc(s.minted.block),
    research: halford2grc(s.minted.research),
    mrc: halford2grc(s.minted.mrc),
    cpid: s.minted.cpid ?? null,
    magnitude: s.minted.magnitude ?? null,
  },
  moved: halford2grc(s.moved),
  staked: halford2grc(s.staked),
  sidestaked: { total: halford2grc(s.sidestaked.total), recipients: s.sidestaked.recipients },
  data: s.data,
  txCount: s.txCount,
});

export async function buildBlockFlow(
  height: number,
  txs: TxMeta[],
  claim: ClaimRow | null,
): Promise<BlockFlowPayload> {
  if (txs.length === 0) {
    return { summary: serializeSummary(summarizeBlock(height, [])), txFlows: [] };
  }

  const [inRows, outRows, mandRows, contractByTx, flowMrcs] = await Promise.all([
    query<{ tx_id: string; address: string | null; value: string | null }>(
      'SELECT tx_id, address, CAST(value AS VARCHAR) AS value FROM tx_inputs WHERE block_height = $h ORDER BY vin_n ASC',
      { h: height },
    ),
    query<{ tx_id: string; vout_n: number; value: string; address: string; script_type: string }>(
      'SELECT tx_id, vout_n, CAST(value AS VARCHAR) AS value, address, script_type FROM tx_outputs WHERE block_height = $h ORDER BY vout_n ASC',
      { h: height },
    ),
    // MSS registry state as of this height: an address is "mandatory" if
    // its latest event at or below this block is MANDATORY — not merely
    // when an MSS contract happens to land in this very block.
    query<{ address: string }>(
      `SELECT address FROM (
         SELECT address, arg_max(status, block_height) AS status
         FROM mandatory_sidestakes
         WHERE block_height <= $h
         GROUP BY address
       ) WHERE status = 'MANDATORY'`,
      { h: height },
    ),
    buildContractMap(height),
    fetchFlowMrcs(height),
  ]);

  const insByTx = group(inRows, (r) => r.tx_id);
  const outsByTx = group(outRows, (r) => r.tx_id);
  const mandatoryAddresses = mandRows.map((r) => r.address);

  const claimFlow = claim
    ? {
      cpid: claim.cpid ?? null,
      blockSubsidy: BigInt(claim.block_subsidy ?? '0'),
      researchSubsidy: BigInt(claim.research_subsidy ?? '0'),
      magnitude: claim.magnitude ?? null,
      isMrc: !!claim.is_mrc,
      mrcFoundationFees: BigInt(claim.mrc_foundation_fees ?? '0'),
      mrcStakerFees: BigInt(claim.mrc_staker_fees ?? '0'),
    }
    : null;

  const txFlows = txs.map((t) => categorizeTx({
    txId: t.txId,
    isCoinbase: t.isCoinbase,
    isCoinstake: t.isCoinstake,
    inputs: (insByTx.get(t.txId) ?? []).map((r) => ({ address: r.address, value: BigInt(r.value ?? '0') })),
    outputs: (outsByTx.get(t.txId) ?? []).map((r) => ({
      voutN: r.vout_n, value: BigInt(r.value ?? '0'), address: r.address ?? '', scriptType: r.script_type,
    })),
    // The claim belongs to the block's coinstake (or coinbase in PoW blocks).
    claim: t.isCoinstake || t.isCoinbase ? claimFlow : null,
    // MRC payouts ride the coinstake only; sidestakes are derived from
    // the coinstake outputs (the registry only labels mandatory ones).
    mrcs: t.isCoinstake ? flowMrcs : undefined,
    mandatorySidestakeAddresses: t.isCoinstake ? mandatoryAddresses : undefined,
    contracts: contractByTx.has(t.txId) ? [contractByTx.get(t.txId)!] : [],
  }));

  // Address → researcher CPID, so recognised wallets can show their CPID
  // and link to it. Beacons map any beaconed address to its CPID; the
  // staker's CPID is authoritative from the block claim.
  const addresses = [...new Set(
    [...inRows, ...outRows].map((r) => r.address).filter((a): a is string => !!a),
  )];
  const addrCpid = new Map<string, string>();
  if (addresses.length > 0) {
    const beaconRows = await query<{ address: string; cpid: string }>(
      'SELECT DISTINCT address, cpid FROM beacons WHERE address = ANY($a)',
      { a: addresses },
    );
    for (const b of beaconRows) {
      if (b.address && b.cpid && !addrCpid.has(b.address)) addrCpid.set(b.address, b.cpid);
    }
  }
  const coinstakeTx = txs.find((t) => t.isCoinstake);
  const stakerAddr = coinstakeTx ? (insByTx.get(coinstakeTx.txId)?.[0]?.address ?? null) : null;
  if (stakerAddr && claim?.cpid) addrCpid.set(stakerAddr, claim.cpid);

  // Resolve CPIDs to researcher display names (e.g. "zepingouin") once.
  const cpidNames = await resolveCpidNames(Array.from(new Set(addrCpid.values())));

  return {
    summary: serializeSummary(summarizeBlock(height, txFlows)),
    txFlows: txFlows.map((tf) => serializeTxFlow(tf, addrCpid, cpidNames)),
  };
}

// Block / transaction flow categorizer.
//
// Turns a transaction's raw inputs+outputs (plus its block claim, coinstake
// sidestakes, and decoded OP_RETURN contracts) into a small set of
// *semantic* flows — "minted 0.5 GRC research reward → staker", "Alice paid
// Bob 50 GRC", "data: document stamp" — so the UI can draw what actually
// happened instead of a raw vin/vout table.
//
// Pure functions only: no DB, no I/O. The route layer maps DuckDB rows into
// the `FlowTx` input shape (amounts as halford bigint); everything here is
// deterministic and unit-tested. Formatting (halford→GRC, address
// truncation, CPID display names) is the UI's job — we keep raw values.

export type FlowCategory =
  | 'transfer' // value from an input address to a non-input output address
  | 'change' // output back to one of the input addresses
  | 'mint_block' // newly created block subsidy (network/staking reward)
  | 'mint_research' // newly created research subsidy (carries cpid + magnitude)
  | 'stake_return' // staker principal returned to itself (netted, de-emphasized)
  | 'sidestake' // a slice of the staker's reward branched to another address
  | 'data' // OP_RETURN / nulldata — usually value 0; carries a decoded contract
  | 'fee' // to the network
  | 'mrc_fee'; // MRC fee share (minted, split foundation/staker)

export type ContractKind =
  | 'stamp' | 'beacon' | 'vote' | 'poll' | 'message'
  | 'project' | 'mrc' | 'protocol' | 'sidestake' | 'unknown';

export interface FlowEndpoint {
  kind: 'address' | 'minted' | 'opreturn' | 'network' | 'inputs';
  address: string | null; // null for minted / opreturn / network / pooled inputs
  label?: string; // "staker", "3 inputs", etc. (UI may override with a name)
  isStaker?: boolean;
}

export interface Flow {
  category: FlowCategory;
  amount: bigint; // halford; 0 for pure-data outputs
  from: FlowEndpoint;
  to: FlowEndpoint;
  voutIdx?: number; // ties the flow back to a concrete output row
  detail?: {
    cpid?: string | null;
    magnitude?: number | null;
    isMrc?: boolean;
    sidestakeKind?: 'mandatory' | 'voluntary';
    contract?: { kind: ContractKind; summary: string };
  };
}

export interface TxFlow {
  txId: string;
  kind: 'coinbase' | 'coinstake' | 'standard';
  flows: Flow[];
  totals: { minted: bigint; moved: bigint; staked: bigint; sidestaked: bigint; fee: bigint; dataRecords: number };
}

export interface BlockFlowSummary {
  height: number;
  minted: {
    block: bigint; research: bigint; mrc: bigint; cpid?: string | null; magnitude?: number | null;
  };
  moved: bigint;
  staked: bigint;
  sidestaked: { total: bigint; recipients: number };
  data: { stamps: number; votes: number; beacons: number; polls: number; projects: number; other: number };
  txCount: number;
}

// ---- Input shape (what the route maps DuckDB rows into) -------------------

export interface FlowInput { address: string | null; value: bigint }
export interface FlowOutput { voutN: number; value: bigint; address: string; scriptType: string }
export interface FlowClaim {
  cpid: string | null;
  blockSubsidy: bigint;
  researchSubsidy: bigint;
  magnitude: number | null;
  isMrc: boolean;
  /** Block-level MRC fee split (claims.mrc_foundation_fees / mrc_staker_fees). */
  mrcFoundationFees?: bigint;
  mrcStakerFees?: bigint;
}
/** One MRC paid alongside the staker's claim (a claim_mrcs row). */
export interface FlowMrc {
  cpid: string | null;
  /** Gross research subsidy minted for the claimant (fee not yet deducted). */
  researchSubsidy: bigint;
  /** Per-MRC fee; null on rows indexed before the fee column existed. */
  fee: bigint | null;
  magnitude: number | null;
  /** The claimant's known beacon addresses — fallback payout-vout matcher. */
  beaconAddresses?: string[];
}
export interface FlowContract { voutN?: number; kind: ContractKind; summary: string }

export interface FlowTx {
  txId: string;
  isCoinbase: boolean;
  isCoinstake: boolean;
  inputs: FlowInput[];
  outputs: FlowOutput[];
  claim?: FlowClaim | null; // present on the block's coinstake/coinbase
  mrcs?: FlowMrc[]; // MRCs paid by the coinstake (claim_mrcs rows)
  /** MSS registry state as of this block — addresses whose latest
   *  mandatory-sidestake event at or below this height is MANDATORY.
   *  Sidestakes themselves are derived from the coinstake outputs. */
  mandatorySidestakeAddresses?: string[];
  contracts?: FlowContract[]; // decoded OP_RETURN contracts
}

// ---- Helpers --------------------------------------------------------------

const MINTED: FlowEndpoint = { kind: 'minted', address: null, label: 'minted' };
const OPRETURN: FlowEndpoint = { kind: 'opreturn', address: null, label: 'OP_RETURN' };
// Gridcoin doesn't destroy fees — the block's staker collects them into
// the coinstake (miner.cpp `nReward += nFees`). So a standard tx's fee
// flows out to this shared "fees" node, and the coinstake shows the staker
// collecting the block's fees from it.
const FEES: FlowEndpoint = { kind: 'network', address: null, label: 'fees' };

const sum = (xs: bigint[]): bigint => xs.reduce((a, b) => a + b, 0n);

// An OP_RETURN / data-carrier output: no spendable recipient. The daemon
// reports these as script type `nulldata`. Keyed on the type (not an empty
// address) so the coinstake's empty marker output — vout 0, value 0, blank
// script, also address-less — is NOT mistaken for a data record.
function isData(o: FlowOutput): boolean {
  return o.scriptType === 'nulldata';
}

function addrEndpoint(address: string, label?: string): FlowEndpoint {
  return { kind: 'address', address, label };
}

// Source endpoint for a standard tx's outputs. UTXO doesn't pair specific
// inputs to specific outputs, so we model the inputs as one pool: the lone
// address when there's a single payer, otherwise an anonymous "N inputs".
function inputsEndpoint(inputAddrs: string[]): FlowEndpoint {
  if (inputAddrs.length === 1) return addrEndpoint(inputAddrs[0]);
  return { kind: 'inputs', address: null, label: `${inputAddrs.length} inputs` };
}

function dataFlow(o: FlowOutput, contract: FlowContract | undefined, source: FlowEndpoint): Flow {
  return {
    category: 'data',
    amount: o.value, // usually 0; a stamp-style burn would be non-zero
    from: source,
    to: OPRETURN,
    voutIdx: o.voutN,
    detail: {
      contract: contract
        ? { kind: contract.kind, summary: contract.summary }
        : { kind: 'unknown', summary: 'OP_RETURN data' },
    },
  };
}

// MRC payouts sit at the tail of the coinstake vout list (miner.cpp:
// CreateMRCRewards appends one output per claimant plus a single combined
// foundation-fee output; SplitCoinStakeOutput reattaches them after the
// stake splits and sidestakes). Identify those vouts so they carry the real
// recipient addresses and aren't mistaken for sidestakes.
interface MrcMatches { claimants: (FlowOutput | null)[]; foundation: FlowOutput | null; voutSet: Set<number> }
function matchMrcPayouts(
  outputs: FlowOutput[],
  mrcs: FlowMrc[],
  foundationFees: bigint,
  stakerFees: bigint,
): MrcMatches {
  const claimants: (FlowOutput | null)[] = mrcs.map(() => null);
  const voutSet = new Set<number>();
  let foundation: FlowOutput | null = null;
  if (mrcs.length === 0) return { claimants, foundation, voutSet };

  // Candidate pool: the last (claimants + foundation) spendable vouts.
  // MRC outputs are never at vout 0 (marker) or 1 (staker's first split).
  const spendable = outputs.filter((o) => o.voutN >= 2 && !isData(o) && o.value > 0n);
  const free = new Set(spendable.slice(-(mrcs.length + (foundationFees > 0n ? 1 : 0))));
  const take = (o: FlowOutput): FlowOutput => {
    free.delete(o);
    voutSet.add(o.voutN);
    return o;
  };

  // Foundation: single combined output, exact amount.
  if (foundationFees > 0n) {
    const hit = [...free].find((o) => o.value === foundationFees);
    if (hit) foundation = take(hit);
  }

  // Per-claimant net: exact when the fee was indexed; derivable from the
  // block-level split when the block carries a single MRC.
  const nets = mrcs.map((m) => {
    if (m.fee != null) return m.researchSubsidy - m.fee;
    return mrcs.length === 1 ? m.researchSubsidy - foundationFees - stakerFees : null;
  });
  mrcs.forEach((m, i) => {
    const net = nets[i];
    const hit = (net != null ? [...free].find((o) => o.value === net) : undefined)
      ?? [...free].find((o) => !!o.address && (m.beaconAddresses ?? []).includes(o.address));
    if (hit) claimants[i] = take(hit);
  });

  // Leftovers (multi-MRC rows without an indexed fee or beacon match):
  // pair by size — the MRC fee is a flat percentage, so net payout order
  // follows subsidy order.
  const restMrcs = mrcs.map((m, i) => ({ m, i }))
    .filter(({ i }) => claimants[i] === null)
    .sort((a, b) => (a.m.researchSubsidy < b.m.researchSubsidy ? 1 : -1));
  const restOuts = [...free].sort((a, b) => (a.value < b.value ? 1 : -1));
  restMrcs.forEach(({ i }, k) => {
    if (restOuts[k]) claimants[i] = take(restOuts[k]);
  });

  return { claimants, foundation, voutSet };
}

// ---- Categorizer ----------------------------------------------------------

export function categorizeTx(tx: FlowTx): TxFlow {
  const flows: Flow[] = [];
  const inputAddrs = [...new Set(tx.inputs.map((i) => i.address).filter((a): a is string => !!a))];
  const totalIn = sum(tx.inputs.map((i) => i.value));
  const totalOut = sum(tx.outputs.map((o) => o.value));

  const contractByVout = new Map<number, FlowContract>();
  const looseContracts: FlowContract[] = [];
  for (const c of tx.contracts ?? []) {
    if (typeof c.voutN === 'number') contractByVout.set(c.voutN, c);
    else looseContracts.push(c);
  }
  // OP_RETURN outputs in tx order, so unattributed contracts can be paired
  // positionally to the data outputs they were parsed from.
  const dataOuts = tx.outputs.filter(isData);
  const contractFor = (o: FlowOutput): FlowContract | undefined => contractByVout.get(o.voutN)
    ?? looseContracts[dataOuts.indexOf(o)];

  if (tx.isCoinstake) {
    // Proof-of-Stake. The staker spends their own UTXO(s) and gets the
    // principal back plus a freshly minted reward; sidestakes split a slice
    // of that reward to other addresses. We net the principal (it never
    // "moved") and surface only the minted value as new.
    const staker: FlowEndpoint = {
      kind: 'address', address: inputAddrs[0] ?? null, label: 'staker', isStaker: true,
    };
    if (totalIn > 0n) {
      flows.push({
        category: 'stake_return', amount: totalIn, from: staker, to: staker,
      });
    }

    const research = tx.claim?.researchSubsidy ?? 0n;
    const block = tx.claim?.blockSubsidy ?? 0n;
    const surplus = totalOut > totalIn ? totalOut - totalIn : 0n;
    if (research > 0n) {
      flows.push({
        category: 'mint_research',
        amount: research,
        from: MINTED,
        to: staker,
        detail: {
          cpid: tx.claim?.cpid ?? null,
          magnitude: tx.claim?.magnitude ?? null,
          // The staker's own subsidy is never an MRC — flow-level isMrc
          // marks MRC payouts, not "this block carries MRCs".
          isMrc: false,
        },
      });
    }
    if (block > 0n) {
      flows.push({
        category: 'mint_block', amount: block, from: MINTED, to: staker,
      });
    }

    // MRCs: research minted for OTHER researchers, paid out by this
    // coinstake. Each claimant gets subsidy − fee; the fee is minted too,
    // split between the foundation and the staker.
    const mrcs = tx.mrcs ?? [];
    const mrcFoundationFees = tx.claim?.mrcFoundationFees ?? 0n;
    const mrcStakerFees = tx.claim?.mrcStakerFees ?? 0n;
    const mrcMatch = matchMrcPayouts(tx.outputs, mrcs, mrcFoundationFees, mrcStakerFees);
    let mrcTotal = 0n;
    mrcs.forEach((m, i) => {
      const out = mrcMatch.claimants[i];
      // Matched vout value is ground truth; otherwise reconstruct the net.
      const amount = out?.value ?? (m.researchSubsidy - (m.fee ?? 0n));
      mrcTotal += amount;
      flows.push({
        category: 'mint_research',
        amount,
        from: MINTED,
        to: out ? addrEndpoint(out.address) : { kind: 'address', address: null, label: 'MRC claimant' },
        voutIdx: out?.voutN,
        detail: { cpid: m.cpid, magnitude: m.magnitude, isMrc: true },
      });
    });
    if (mrcs.length > 0 && mrcFoundationFees > 0n) {
      mrcTotal += mrcFoundationFees;
      flows.push({
        category: 'mrc_fee',
        amount: mrcFoundationFees,
        from: MINTED,
        to: mrcMatch.foundation
          ? addrEndpoint(mrcMatch.foundation.address)
          : { kind: 'address', address: null, label: 'foundation' },
        voutIdx: mrcMatch.foundation?.voutN,
      });
    }
    if (mrcs.length > 0 && mrcStakerFees > 0n) {
      mrcTotal += mrcStakerFees;
      flows.push({
        category: 'mrc_fee', amount: mrcStakerFees, from: MINTED, to: staker,
      });
    }

    if (research === 0n && block === 0n && mrcTotal === 0n && surplus > 0n) {
      // No claim but coins were minted — show the whole surplus as a
      // block reward rather than silently dropping it.
      flows.push({
        category: 'mint_block', amount: surplus, from: MINTED, to: staker,
      });
    } else {
      // Gridcoin rolls the block's transaction fees into the coinstake
      // output (miner.cpp: `nReward += nFees`), so the surplus beyond the
      // claimed subsidies and MRC payouts is fees the staker collected
      // from the block's other transactions — flowing TO the staker, not
      // destroyed.
      const collectedFees = surplus - (research + block + mrcTotal);
      if (collectedFees > 0n) {
        flows.push({
          category: 'fee', amount: collectedFees, from: FEES, to: staker,
        });
      }
    }

    // Sidestakes, derived from the coinstake outputs themselves: every
    // spendable extra (vout >= 2) that isn't an MRC payout and doesn't pay
    // the staker's own address (those are stake splits — returned
    // principal) left the staker's reward for someone else. This covers
    // pre-V13 local sidestakes and V13 MSS alike; the registry only
    // decides the mandatory/voluntary label. Books stay balanced: staker
    // keeps minted − Σ sidestakes.
    const stakerAddrs = new Set(inputAddrs);
    const vout1Addr = tx.outputs.find((o) => o.voutN === 1)?.address;
    if (vout1Addr) stakerAddrs.add(vout1Addr);
    const mandatory = new Set(tx.mandatorySidestakeAddresses ?? []);
    for (const o of tx.outputs) {
      if (o.voutN < 2 || isData(o) || o.value <= 0n || !o.address) continue;
      if (mrcMatch.voutSet.has(o.voutN)) continue;
      if (stakerAddrs.has(o.address)) continue; // stake split
      flows.push({
        category: 'sidestake',
        amount: o.value,
        from: staker,
        to: addrEndpoint(o.address),
        voutIdx: o.voutN,
        detail: { sidestakeKind: mandatory.has(o.address) ? 'mandatory' : 'voluntary' },
      });
    }

    // A coinstake can still carry an OP_RETURN (e.g. an MRC contract).
    for (const o of dataOuts) flows.push(dataFlow(o, contractFor(o), staker));
  } else if (tx.isCoinbase) {
    // Coinbase: no real inputs. Any value is freshly minted to the payout
    // address(es); in PoS blocks the coinbase is usually empty.
    for (const o of tx.outputs) {
      if (isData(o)) { flows.push(dataFlow(o, contractFor(o), MINTED)); continue; }
      if (o.value > 0n) {
        flows.push({
          category: 'mint_block', amount: o.value, from: MINTED, to: addrEndpoint(o.address), voutIdx: o.voutN,
        });
      }
    }
  } else {
    // Standard value transfer.
    const source = inputsEndpoint(inputAddrs);
    const inputSet = new Set(inputAddrs);
    for (const o of tx.outputs) {
      if (isData(o)) { flows.push(dataFlow(o, contractFor(o), source)); continue; }
      const isChange = !!o.address && inputSet.has(o.address);
      flows.push({
        category: isChange ? 'change' : 'transfer',
        amount: o.value,
        from: source,
        to: addrEndpoint(o.address),
        voutIdx: o.voutN,
      });
    }
    // Fee is implicit (inputs − outputs). Coinbase/coinstake have no fee in
    // this sense (they mint), matching the indexer's fee=0 for those.
    const fee = totalIn - totalOut;
    if (fee > 0n) {
      flows.push({
        category: 'fee', amount: fee, from: source, to: FEES,
      });
    }
  }

  let kind: TxFlow['kind'] = 'standard';
  if (tx.isCoinstake) kind = 'coinstake';
  else if (tx.isCoinbase) kind = 'coinbase';

  return {
    txId: tx.txId,
    kind,
    flows,
    totals: tallyTx(flows),
  };
}

function tallyTx(flows: Flow[]): TxFlow['totals'] {
  const t = {
    minted: 0n, moved: 0n, staked: 0n, sidestaked: 0n, fee: 0n, dataRecords: 0,
  };
  for (const f of flows) {
    switch (f.category) {
      case 'mint_block': case 'mint_research': case 'mrc_fee': t.minted += f.amount; break;
      case 'transfer': t.moved += f.amount; break;
      case 'stake_return': t.staked += f.amount; break;
      case 'sidestake': t.sidestaked += f.amount; break;
      case 'fee': t.fee += f.amount; break;
      case 'data': t.dataRecords += 1; break;
      default: break; // change is intentionally not tallied (it's noise)
    }
  }
  return t;
}

// ---- Block rollup ---------------------------------------------------------

const DATA_BUCKET: Record<ContractKind, keyof BlockFlowSummary['data']> = {
  stamp: 'stamps',
  vote: 'votes',
  beacon: 'beacons',
  poll: 'polls',
  project: 'projects',
  message: 'other',
  mrc: 'other',
  protocol: 'other',
  sidestake: 'other',
  unknown: 'other',
};

export function summarizeBlock(height: number, txFlows: TxFlow[]): BlockFlowSummary {
  const summary: BlockFlowSummary = {
    height,
    minted: {
      block: 0n, research: 0n, mrc: 0n, cpid: null, magnitude: null,
    },
    moved: 0n,
    staked: 0n,
    sidestaked: { total: 0n, recipients: 0 },
    data: {
      stamps: 0, votes: 0, beacons: 0, polls: 0, projects: 0, other: 0,
    },
    txCount: txFlows.length,
  };
  const recipients = new Set<string>();
  for (const tf of txFlows) {
    for (const f of tf.flows) {
      switch (f.category) {
        case 'mint_block': summary.minted.block += f.amount; break;
        case 'mrc_fee': summary.minted.mrc += f.amount; break;
        case 'mint_research':
          // MRC payouts roll up separately — minted.research is the
          // staker's own subsidy, and the claim CPID stays the staker's.
          if (f.detail?.isMrc) { summary.minted.mrc += f.amount; break; }
          summary.minted.research += f.amount;
          // One coinstake per block carries the claim, so first wins.
          if (!summary.minted.cpid && f.detail?.cpid) summary.minted.cpid = f.detail.cpid;
          if (summary.minted.magnitude == null && f.detail?.magnitude != null) {
            summary.minted.magnitude = f.detail.magnitude;
          }
          break;
        case 'transfer': summary.moved += f.amount; break;
        case 'stake_return': summary.staked += f.amount; break;
        case 'sidestake':
          summary.sidestaked.total += f.amount;
          if (f.to.address) recipients.add(f.to.address);
          break;
        case 'data': summary.data[DATA_BUCKET[f.detail?.contract?.kind ?? 'unknown']] += 1; break;
        default: break;
      }
    }
  }
  summary.sidestaked.recipients = recipients.size;
  return summary;
}

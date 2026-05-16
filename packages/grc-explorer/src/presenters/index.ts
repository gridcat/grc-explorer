import yayson from 'yayson';
import { halford2grc } from '../lib/halford';
import { Attributes } from './types';

const { Presenter } = yayson();

// Export a configured Presenter instance per resource. Each shapes a
// Prisma row into the JSON:API attributes dict the frontend consumes.
//
// Gotcha: BigInt round-trips through JSON.stringify don't work — we
// always render halford amounts as strings (stable up to 64-bit
// precision in JSON consumers).

export class StatusPresenter extends Presenter {
  static type = 'status';
}

export class BlockPresenter extends Presenter {
  static type = 'blocks';

  attributes(b: BlockRow): Attributes {
    return {
      height: b.height,
      hash: b.hash,
      prevHash: b.prev_hash,
      merkleRoot: b.merkle_root,
      time: b.time,
      version: b.n_version,
      difficulty: b.difficulty?.toString?.() ?? String(b.difficulty),
      size: b.size,
      txCount: b.tx_count,
      isPos: b.is_pos,
      isSuperblock: b.is_superblock,
      isMrc: b.is_mrc ?? false,
      minerAddress: b.miner_address,
      stakerCpid: b.staker_cpid,
      stakerName: b.staker_name ?? null,
      mint: halford2grc(b.mint),
      moneySupply: halford2grc(b.money_supply),
      valueMoved: halford2grc(b.value_moved ?? 0n),
      feeTotal: halford2grc(b.fee_total ?? 0n),
    };
  }

  id(b: BlockRow): string {
    return String(b.height);
  }

  selfLinks(b: BlockRow): string {
    return `/blocks/${b.height}`;
  }
}

export class TransactionPresenter extends Presenter {
  static type = 'transactions';

  attributes(t: TransactionRow): Attributes {
    return {
      txId: t.tx_id,
      blockHeight: t.block_height,
      blockHash: t.block_hash,
      time: t.time,
      size: t.size,
      fee: halford2grc(t.fee),
      vinCount: t.vin_count,
      voutCount: t.vout_count,
      totalIn: halford2grc(t.total_in),
      totalOut: halford2grc(t.total_out),
      isCoinbase: t.is_coinbase,
      isCoinstake: t.is_coinstake,
    };
  }

  id(t: TransactionRow): string {
    return t.tx_id;
  }

  selfLinks(t: TransactionRow): string {
    return `/transactions/${t.tx_id}`;
  }
}

export class AddressPresenter extends Presenter {
  static type = 'addresses';

  attributes(a: AddressRow): Attributes {
    return {
      address: a.address,
      balance: halford2grc(a.balance),
      totalReceived: halford2grc(a.total_received),
      totalSent: halford2grc(a.total_sent),
      txCount: a.tx_count,
      firstSeenBlock: a.first_seen_block,
      lastSeenBlock: a.last_seen_block,
      firstSeenTime: a.first_seen_time ?? null,
      lastSeenTime: a.last_seen_time ?? null,
      cpid: a.cpid ?? null,
    };
  }

  id(a: AddressRow): string {
    return a.address;
  }

  selfLinks(a: AddressRow): string {
    return `/addresses/${a.address}`;
  }
}

export class SuperblockPresenter extends Presenter {
  static type = 'superblocks';

  attributes(s: SuperblockRow): Attributes {
    return {
      height: s.height,
      quorumHash: s.quorum_hash,
      totalMagnitude: s.total_magnitude,
      cpidCount: s.cpid_count,
      projectCount: s.project_count,
      // Normalise the 0 sentinel from the migration default to null
      // so the frontend can branch cleanly: a known version (1-3) is
      // a number, "we don't know" is null. Never 0.
      contractVersion: s.contract_version && s.contract_version > 0
        ? s.contract_version
        : null,
    };
  }

  id(s: SuperblockRow): string {
    return String(s.height);
  }

  selfLinks(s: SuperblockRow): string {
    return `/superblocks/${s.height}`;
  }
}

export class ClaimPresenter extends Presenter {
  static type = 'claims';

  attributes(c: ClaimRow): Attributes {
    return {
      blockHeight: c.block_height,
      cpid: c.cpid,
      cpidName: c.cpid_name ?? null,
      miningId: c.mining_id,
      clientVersion: c.client_version,
      organization: c.organization,
      blockSubsidy: halford2grc(c.block_subsidy),
      researchSubsidy: halford2grc(c.research_subsidy),
      magnitude: c.magnitude,
      magnitudeUnit: c.magnitude_unit,
      isMrc: c.is_mrc,
    };
  }

  id(c: ClaimRow): string {
    return String(c.block_height);
  }
}

export class BeaconPresenter extends Presenter {
  static type = 'beacons';

  attributes(b: BeaconRow): Attributes {
    return {
      cpid: b.cpid,
      address: b.address,
      status: b.status,
      txId: b.tx_id,
      blockHeight: b.block_height,
      timestamp: b.timestamp,
      expiration: b.expiration,
      // Renewal-state derivations from the /beacons route enrichment
      // (see deriveRenewalState in routes/beacons.ts). Optional so older
      // callers persisting `BeaconRow` shapes directly still work.
      renewableUntil: b.renewable_until ?? null,
      mustReadvertise: b.must_readvertise ?? false,
      // Coerce migration-default empty string into 'unknown' so the
      // wire enum is closed — frontend doesn't need to handle '' as a
      // separate case from the four real values.
      authMethod: b.auth_method && b.auth_method !== '' ? b.auth_method : 'unknown',
    };
  }

  id(b: BeaconRow): string {
    return b.tx_id;
  }
}

export class PollPresenter extends Presenter {
  static type = 'polls';

  attributes(p: PollRow): Attributes {
    return {
      pollId: p.poll_id,
      title: p.title,
      question: p.question,
      url: p.url,
      pollType: p.poll_type,
      responseType: p.response_type,
      weightType: p.weight_type,
      startTime: p.start_time,
      endTime: p.end_time,
      blockHeight: p.block_height,
      claimTx: p.claim_tx,
      creatorAddress: p.creator_address,
      // `result` is optional — only attached on list responses. The
      // detail endpoint emits its own richer options/votes payload so
      // it doesn't bother. `null`-valued topLabel means the poll had
      // no votes recorded; the frontend renders that as "—".
      ...(p.result ? { result: p.result as unknown as Attributes[string] } : {}),
    };
  }

  id(p: PollRow): string {
    return p.poll_id;
  }

  selfLinks(p: PollRow): string {
    return `/polls/${p.poll_id}`;
  }
}

export class MempoolTxPresenter extends Presenter {
  static type = 'mempool_txs';

  attributes(m: MempoolTxRow): Attributes {
    return {
      txId: m.tx_id,
      firstSeen: m.first_seen,
      feeEstimate: halford2grc(m.fee_estimate),
      size: m.size,
      vinCount: m.vin_count,
      voutCount: m.vout_count,
      isMrc: m.is_mrc,
    };
  }

  id(m: MempoolTxRow): string {
    return m.tx_id;
  }
}

export class TxOutputPresenter extends Presenter {
  static type = 'tx_outputs';

  attributes(o: TxOutputRow): Attributes {
    return {
      txId: o.tx_id,
      voutN: o.vout_n,
      value: halford2grc(o.value),
      address: o.address,
      scriptType: o.script_type,
      isSpent: o.is_spent,
    };
  }

  id(o: TxOutputRow): string {
    return `${o.tx_id}:${o.vout_n}`;
  }
}

// Inline row shapes — the Prisma client generates these but we keep
// them as a TS-only contract on the presenter API surface so this file
// doesn't pull every model name.
interface BlockRow {
  height: number; hash: string; prev_hash: string; merkle_root: string;
  time: number; n_version: number; difficulty: unknown; size: number;
  tx_count: number; is_pos: boolean; is_superblock: boolean;
  miner_address: string | null; staker_cpid: string | null;
  mint: bigint; money_supply: bigint;
  // Joined from `claims.is_mrc` on the list query so the frontend can
  // tag MRC-bundled blocks alongside the existing PoS / Superblock
  // chips. Optional because not every code path that builds a
  // BlockPresenter input has a claim to JOIN against (block detail
  // path renders MRC info from a separate claim card).
  is_mrc?: boolean;
  // Per-block aggregates of user-moved value and fees, computed at
  // list time (excludes coinbase/coinstake). Optional for the same
  // reason as is_mrc — the block-detail path renders these via the
  // embedded transactions array, not from a presenter aggregate.
  value_moved?: bigint;
  fee_total?: bigint;
  // Server-side resolved BOINC display name for `staker_cpid`, so the
  // SSR seed renders names without a second /cpids/names round trip.
  // Optional: paths that don't enrich (or anonymous stakers) leave it
  // absent and the frontend falls back to the truncated CPID.
  staker_name?: string | null;
}
interface TransactionRow {
  tx_id: string; block_height: number; block_hash: string; time: number;
  size: number; fee: bigint; vin_count: number; vout_count: number;
  total_in: bigint; total_out: bigint; is_coinbase: boolean; is_coinstake: boolean;
}
interface AddressRow {
  address: string; balance: bigint; total_received: bigint; total_sent: bigint;
  tx_count: number; first_seen_block: number | null; last_seen_block: number | null;
  first_seen_time?: number | null; last_seen_time?: number | null;
  // Researcher CPID this address registered a beacon under, when
  // known (rich-list cross-link). Absent on paths that don't resolve.
  cpid?: string | null;
}
interface SuperblockRow {
  height: number; quorum_hash: string; total_magnitude: number;
  cpid_count: number; project_count: number;
  /** Daemon's `m_version` from SuperblockToJson (src/rpc/blockchain.cpp).
   *  V3 (activated at V13) carries per-project all-CPID total credit
   *  needed for AutoGreylist. Optional — pre-feature indexed rows
   *  come back as 0 (the migration-default sentinel) which the
   *  presenter normalises to null. */
  contract_version?: number;
}
interface ClaimRow {
  block_height: number; cpid: string | null; mining_id: string;
  client_version: string; organization: string;
  block_subsidy: bigint; research_subsidy: bigint;
  magnitude: number; magnitude_unit: number; is_mrc: boolean;
  // Server-side resolved BOINC display name for `cpid` (optional;
  // absent when not enriched or anonymous).
  cpid_name?: string | null;
}
interface BeaconRow {
  cpid: string; address: string; status: string;
  tx_id: string; block_height: number; timestamp: number; expiration: number;
  renewable_until?: number | null;
  must_readvertise?: boolean;
  /** Derived from BeaconPayload.m_version at parse time:
   *  legacy | v2_email_verify | v3_boinc_signed | unknown.
   *  Optional because pre-feature rows may still be empty string from
   *  the migration default — readers should treat '' as 'unknown'. */
  auth_method?: string;
}
interface PollResult {
  topLabel: string | null;
  topPctOfCast: number;
  totalVotes: number;
  totalWeightCast: string;
}
interface PollRow {
  poll_id: string; title: string; question: string;
  url: string | null; poll_type: string | null;
  response_type: string; weight_type: string;
  start_time: number; end_time: number; block_height: number;
  claim_tx: string; creator_address: string | null;
  result?: PollResult;
}
interface MempoolTxRow {
  tx_id: string; first_seen: number; fee_estimate: bigint;
  size: number; vin_count: number; vout_count: number;
  is_mrc: boolean;
}
interface TxOutputRow {
  tx_id: string; vout_n: number; value: bigint;
  address: string | null; script_type: string; is_spent: boolean;
}

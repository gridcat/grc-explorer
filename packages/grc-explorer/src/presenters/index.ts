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
}
interface TransactionRow {
  tx_id: string; block_height: number; block_hash: string; time: number;
  size: number; fee: bigint; vin_count: number; vout_count: number;
  total_in: bigint; total_out: bigint; is_coinbase: boolean; is_coinstake: boolean;
}
interface AddressRow {
  address: string; balance: bigint; total_received: bigint; total_sent: bigint;
  tx_count: number; first_seen_block: number | null; last_seen_block: number | null;
}
interface SuperblockRow {
  height: number; quorum_hash: string; total_magnitude: number;
  cpid_count: number; project_count: number;
}
interface ClaimRow {
  block_height: number; cpid: string | null; mining_id: string;
  client_version: string; organization: string;
  block_subsidy: bigint; research_subsidy: bigint;
  magnitude: number; magnitude_unit: number; is_mrc: boolean;
}
interface BeaconRow {
  cpid: string; address: string; status: string;
  tx_id: string; block_height: number; timestamp: number; expiration: number;
  renewable_until?: number | null;
  must_readvertise?: boolean;
}
interface PollRow {
  poll_id: string; title: string; question: string;
  url: string | null; poll_type: string | null;
  response_type: string; weight_type: string;
  start_time: number; end_time: number; block_height: number;
  claim_tx: string; creator_address: string | null;
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

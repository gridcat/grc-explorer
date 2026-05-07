import { EventEmitter } from 'events';

/**
 * Typed bus for in-process events. Cross-process delivery happens via
 * Redis pub/sub (see lib/fanout.ts) — anything emitted here is also
 * mirrored onto the matching Redis channel so api replicas pick it up.
 *
 * Topics use dotted namespacing. `address.<addr>.balance` and
 * `cpid.<cpid>.magnitude` carry their key in the topic name so SSE
 * clients can filter by exact match without payload inspection.
 */

export type ExplorerEvent =
  | { topic: 'block.new'; payload: BlockNewPayload }
  | { topic: 'block.tip'; payload: { tip_height: number; tip_hash: string } }
  | { topic: 'chain.reorg'; payload: ReorgPayload }
  | { topic: 'mempool.entered'; payload: MempoolEntryPayload }
  | { topic: 'mempool.exited'; payload: { tx_id: string; reason: 'confirmed' | 'evicted' } }
  | { topic: 'mempool.tick'; payload: { count: number; total_fees: string; total_size: number } }
  | { topic: 'mempool.fee_histogram'; payload: { buckets: Array<{ fee_per_kb: number; count: number }> } }
  | { topic: `address.${string}.balance`; payload: AddressBalancePayload }
  | { topic: `address.${string}.tx`; payload: { address: string; tx_id: string; height: number; delta: string } }
  | { topic: `cpid.${string}.magnitude`; payload: { cpid: string; magnitude: number; superblock_height: number } }
  | { topic: 'network.stats'; payload: NetworkStatsPayload }
  | { topic: 'metrics.tick'; payload: MetricsTickPayload }
  | { topic: 'metrics.daily'; payload: MetricsDailyPayload }
  | { topic: 'backfill.progress'; payload: { height: number; tip: number; pct: number } }
  | { topic: 'project.added'; payload: ProjectContractPayload }
  | { topic: 'project.removed'; payload: ProjectContractPayload };

export interface ProjectContractPayload {
  name: string;
  base_url: string;
  tx_id: string;
  block_height: number;
  time: number;
}

export interface BlockNewPayload {
  height: number;
  hash: string;
  prev_hash: string;
  time: number;
  tx_count: number;
  is_pos: boolean;
  is_superblock: boolean;
  miner_address: string | null;
  staker_cpid: string | null;
}

export interface ReorgPayload {
  fork_height: number;
  depth: number;
  abandoned_hashes: string[];
  new_hashes: string[];
}

export interface MempoolEntryPayload {
  tx_id: string;
  fee: string;
  size: number;
  vin_count: number;
  vout_count: number;
  first_seen: number;
}

export interface AddressBalancePayload {
  address: string;
  balance: string;
  delta: string;
  height: number;
  tx_id: string;
}

export interface NetworkStatsPayload {
  /** Daemon's chain tip. Null when the RPC has never succeeded and no
   *  prior cache exists — must NOT be faked from the latest indexed
   *  block, that makes the UI falsely report "caught up". */
  tip_height: number | null;
  tip_hash: string;
  difficulty: string;
  peer_count: number;
  mempool_size: number;
  // Older Gridcoin builds packed these as integers; current builds
  // return human strings like "v5.5.0.1-unk". Accept either.
  net_version: number | string;
  rpc_version: number | string;
}

export interface MetricsTickPayload {
  granularity: '5min' | '1h';
  bucket_ts: number;
  tx_count: number;
  value_moved: string;
  fee_total: string;
  block_count: number;
  research_subsidy_total: string;
  block_subsidy_total: string;
}

export interface MetricsDailyPayload {
  research_subsidy_24h: string;
  block_subsidy_24h: string;
  active_beacons: number;
  new_beacons_24h: number;
  expired_beacons_24h: number;
  researcher_share_pct: number;
  top_cpids: Array<{ cpid: string; magnitude: number; subsidy: string }>;
}

class TypedEmitter extends EventEmitter {
  publish<E extends ExplorerEvent>(event: E): void {
    this.emit(event.topic, event.payload);
    // Wildcard channels — `address.*` listeners get every address.* event
    // tagged with the original topic, so SSE filtering can match by prefix.
    const dot = event.topic.indexOf('.');
    if (dot > 0) {
      this.emit(`${event.topic.slice(0, dot)}.*`, event);
    }
  }
}

export const events = new TypedEmitter();

// Don't crash the process if a listener forgets to attach.
events.setMaxListeners(0);

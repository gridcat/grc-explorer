import { config } from '../../config';
import { maintenanceQuery as query, upsert } from '../../lib/db';
import { heavyRpc } from '../../lib/gridcoin';
import { log } from '../../lib/log';
import { getCursor, redis } from '../../lib/redis';
import { Outpoint, RpcVoteClaim, verifiedClaimAddresses } from '../../lib/voteClaim';

// Collects the addresses proven co-owned by poll votes into
// `vote_claim_addresses` (see lib/voteClaim.ts for why a verified vote
// claim is proof of ownership). The block JSON the indexer reads omits
// the claim, so each vote tx costs one `getvotingclaim` RPC; this job
// walks the indexed `votes` behind a Redis height watermark instead of
// slowing BlockWriter. From an unset watermark it starts at 0, so the
// first runs are the historical backfill.
//
// Reorgs/partial wipes: rows are rolled back via CHAIN_HEIGHT_TABLES; the
// watermark is clamped to the cursor and each tick re-reads the
// trailing MAX_REORG_DEPTH blocks, so replaced votes are picked up again
// (inserts are idempotent on the PK).
//
// Legacy (tx v1) votes carry no claim and are skipped.

const WATERMARK_KEY = 'vote_claims:watermark_height';
const HEIGHTS_PER_BATCH = 100;
const TICK_BUDGET_MS = 120_000;

interface VoteTx {
  txId: string;
  height: number;
  pollTxid: string;
  choices: number[];
  nTime: number;
  prevouts: Outpoint[];
}

type ClaimRpc = { getVotingClaim: (txId: string) => Promise<RpcVoteClaim> };

const NO_CLAIM = /legacy transaction not supported|contains no (voting )?contract/i;

export class VoteClaimJob {
  async tick(): Promise<void> {
    try {
      const cursor = await getCursor();
      if (!cursor || !Number.isFinite(cursor.height)) return;
      const hi = cursor.height;
      const stored = Number(await redis.get(WATERMARK_KEY));
      const watermark = Number.isFinite(stored) ? Math.min(stored, hi) : 0;
      let lo = Math.max(0, watermark - config.MAX_REORG_DEPTH);

      const startedAt = Date.now();
      let txs = 0;
      let linked = 0;
      let unverified = 0;
      while (lo < hi && Date.now() - startedAt < TICK_BUDGET_MS) {
        // eslint-disable-next-line no-await-in-loop
        const upper = await this.batchUpper(lo, hi);
        // eslint-disable-next-line no-await-in-loop
        const votes = await this.loadVotes(lo, upper);
        const rows: Array<{ tx_id: string; address: string; block_height: number }> = [];
        for (const v of votes) {
          // eslint-disable-next-line no-await-in-loop
          const claim = await this.fetchClaim(v.txId);
          if (!claim) continue;
          const addresses = verifiedClaimAddresses(claim, v, config.NETWORK);
          if (addresses.length === 0) unverified += 1;
          for (const address of addresses) rows.push({ tx_id: v.txId, address, block_height: v.height });
        }
        // eslint-disable-next-line no-await-in-loop
        if (rows.length > 0) await upsert('vote_claim_addresses', rows, { pk: ['tx_id', 'address'], onConflict: 'nothing' });
        // eslint-disable-next-line no-await-in-loop
        await redis.set(WATERMARK_KEY, String(upper));
        txs += votes.length;
        linked += rows.length;
        lo = upper;
      }
      if (txs > 0) {
        log.info(
          `VoteClaimJob: ${txs} vote tx(s) up to block ${lo}, ${linked} verified address claim(s), `
          + `${unverified} tx(s) without a verifiable claim (${Math.round((Date.now() - startedAt) / 1000)}s)`,
        );
      }
    } catch (err) {
      // Watermark only advances per completed batch → retried next tick.
      log.warn('VoteClaimJob.tick failed', err);
    }
  }

  // Upper bound of the next batch: the HEIGHTS_PER_BATCH-th vote-bearing
  // height above lo, or hi when fewer remain. Whole heights only, so a
  // batch never splits a block.
  private async batchUpper(lo: number, hi: number): Promise<number> {
    const rows = await query<{ h: number }>(
      `
        SELECT DISTINCT block_height AS h FROM votes
        WHERE block_height > $lo AND block_height <= $hi
        ORDER BY block_height
        LIMIT ${HEIGHTS_PER_BATCH}
      `,
      { lo, hi },
    );
    return rows.length < HEIGHTS_PER_BATCH ? hi : rows[rows.length - 1].h;
  }

  private async loadVotes(lo: number, upper: number): Promise<VoteTx[]> {
    const choiceRows = await query<{ tx_id: string; block_height: number; poll_id: string; choice_idx: number }>(
      `
        SELECT v.tx_id, v.block_height, v.poll_id, v.choice_idx
        FROM votes AS v
        JOIN transactions AS t ON t.tx_id = v.tx_id
        WHERE v.block_height > $lo AND v.block_height <= $upper AND t.n_version >= 2
      `,
      { lo, upper },
    );
    if (choiceRows.length === 0) return [];
    const byTx = new Map<string, VoteTx>();
    for (const r of choiceRows) {
      const v = byTx.get(r.tx_id) ?? {
        txId: r.tx_id, height: r.block_height, pollTxid: r.poll_id, choices: [], nTime: 0, prevouts: [],
      };
      v.choices.push(r.choice_idx);
      byTx.set(r.tx_id, v);
    }
    const ids = [...byTx.keys()];
    const [times, inputs] = await Promise.all([
      query<{ tx_id: string; t: number | string }>(
        'SELECT tx_id, UNIX_TIMESTAMP(time) AS t FROM transactions WHERE tx_id IN ($ids)',
        { ids },
      ),
      query<{ tx_id: string; prev_tx: string | null; prev_vout: number | null }>(
        'SELECT tx_id, prev_tx, prev_vout FROM tx_inputs WHERE tx_id IN ($ids) ORDER BY tx_id, vin_n',
        { ids },
      ),
    ]);
    // UNIX_TIMESTAMP comes back as a decimal string under the read contract.
    for (const r of times) byTx.get(r.tx_id)!.nTime = Number(r.t);
    for (const r of inputs) {
      if (r.prev_tx !== null && r.prev_vout !== null) {
        byTx.get(r.tx_id)!.prevouts.push({ txid: r.prev_tx, n: r.prev_vout });
      }
    }
    return [...byTx.values()];
  }

  // null when the tx has no claim to read; RPC failures propagate so the
  // batch (and the watermark) is retried.
  private async fetchClaim(txId: string): Promise<RpcVoteClaim | null> {
    try {
      return await (heavyRpc as unknown as ClaimRpc).getVotingClaim(txId);
    } catch (err) {
      if (NO_CLAIM.test(err instanceof Error ? err.message : String(err))) return null;
      throw err;
    }
  }
}

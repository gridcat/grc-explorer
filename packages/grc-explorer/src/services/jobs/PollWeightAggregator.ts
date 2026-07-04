import { query, run } from '../../lib/db';
import { HALFORD } from '../../lib/halford';
import { getTipAnchor } from '../../lib/indexerTip';
import { log } from '../../lib/log';
import { WEIGHT_TYPE } from '../indexer/ContractParser';
import { forkHeight } from '../network/ChainForks';

// Vote-weight + AV-W aggregator. For each poll it processes:
//   1. Find the latest superblock at-or-before poll.block_height
//      (snapshot magnitudes at the poll's start).
//   2. For each vote, look up the voter's balance at poll.block_height
//      via address_balance_history argMax, plus the voter's CPID
//      magnitude at the snapshot superblock.
//   3. Group vote rows by (voter_address, tx_id) so multi-choice
//      voters (one row per response) get a single `response_count`,
//      then compute response_weight per the canonical 5-branch
//      `GRC::CalculateWeight` from src/gridcoin/voting/result.cpp.
//      UPDATE each row's assigned weight in place.
//   4. Compute AV-W (eligible-balance + eligible-magnitude totals at
//      poll-start) and UPDATE the poll row with av_w_balance,
//      av_w_magnitude and the `magnitude_weight_factor` actually used.
//
// A cast vote's weight is a fixed snapshot (balance at the poll-start
// height, magnitude at the snapshot superblock) — none of it depends on
// the poll being closed. So we compute weights live for *active* polls
// too, recomputing each tick: re-weighting already-cast votes is
// idempotent, and the pass just folds in any newly-arrived votes. This
// matches the wallet, which shows live results while a poll is open.
//
// `weights_computed_at_height` doubles as the "finalised" sentinel: we
// only stamp it once a poll has *closed* (so the poll keeps getting
// recomputed while active, and gets exactly one final pass after close
// to catch votes cast in the last blocks before it ended).
//
// See `reference_gridcoin_voting_weight_rules.md` for the full
// canonical formula. The closed-backlog bucket is capped at
// POLLS_PER_TICK per pass so a backlog never monopolises the scheduler;
// the active bucket is uncapped (only ever a handful of polls open at
// once).
const POLLS_PER_TICK = 5;

// Magnitude-weight factor for BALANCE_AND_MAGNITUDE polls. The wallet
// (`src/gridcoin/voting/poll.cpp::ResolveMagnitudeWeightFactor`) hard-
// codes 100/567 for any poll before BlockV13Height; from V13 onward it
// reads the live `magnitudeweightfactor` protocol-registry entry. No
// V13+ poll has been created yet on either network, so we keep the
// pre-V13 constant and log a warning if we ever process a V13+ poll
// (the aggregator can be extended to walk the protocol registry then).
const MAG_FACTOR_NUM = 100n;
const MAG_FACTOR_DEN = 567n;

// V13 activation height comes from the canonical fork table so the
// audit-relevant heights live in exactly one place (see ChainForks.ts).
const V13_HEIGHT = forkHeight('v13') ?? Number.POSITIVE_INFINITY;

interface PollSnapshot {
  poll_id: string;
  block_height: number;
  weight_type: string;
  start_time: number;
}

interface ComputedPollAggregates {
  avwBalance: bigint;
  avwMagnitude: number;
  computedAtHeight: number;
  magnitudeWeightFactor: number;
}

interface VoteRow {
  poll_id: string;
  voter_address: string;
  voter_cpid: string | null;
  mining_id: string | null;
  choice_idx: number;
  weight: string;
  weight_balance: string;
  weight_magnitude: number;
  tx_id: string;
  block_height: number;
}

export class PollWeightAggregator {
  async tick(): Promise<void> {
    try {
      // Anchor "is this poll closed?" on the indexer cursor rather than
      // wall-clock: during a backfill the two diverge by years, and we
      // must not finalise a poll before the blocks carrying its final
      // votes have been indexed (see getTipAnchor / the cursor memory).
      const anchor = await getTipAnchor();

      // Two buckets:
      //  - Active polls (end after the cursor): recomputed every tick,
      //    uncapped, left un-finalised so the post-close pass still fires.
      //  - Closed backlog (ended, never finalised): computed once and
      //    stamped. Capped so a big backlog can't starve the scheduler.
      const [activePolls, closedBacklog] = await Promise.all([
        query<PollSnapshot>(
          `
            SELECT poll_id, block_height, weight_type,
                   UNIX_TIMESTAMP(start_time) AS start_time
            FROM polls
            WHERE end_time > FROM_UNIXTIME($anchor)
            ORDER BY end_time ASC
          `,
          { anchor },
        ),
        query<PollSnapshot>(
          `
            SELECT poll_id, block_height, weight_type,
                   UNIX_TIMESTAMP(start_time) AS start_time
            FROM polls
            WHERE end_time <= FROM_UNIXTIME($anchor)
              AND weights_computed_at_height IS NULL
            ORDER BY end_time ASC
            LIMIT ${POLLS_PER_TICK}
          `,
          { anchor },
        ),
      ]);
      if (activePolls.length === 0 && closedBacklog.length === 0) return;

      log.info(
        `PollWeightAggregator: ${activePolls.length} active + ${closedBacklog.length} closed poll(s)`,
      );
      // Active first (un-finalised: weights_computed_at_height stays NULL).
      for (const poll of activePolls) {
        // eslint-disable-next-line no-await-in-loop
        await this.processPoll(poll, false);
      }
      // Then the closed backlog (finalised: stamps weights_computed_at_height).
      for (const poll of closedBacklog) {
        // eslint-disable-next-line no-await-in-loop
        await this.processPoll(poll, true);
      }
    } catch (err) {
      log.warn('PollWeightAggregator.tick failed', err);
    }
  }

  private async processPoll(poll: PollSnapshot, finalize: boolean): Promise<void> {
    const startHeight = poll.block_height;

    // Latest superblock at-or-before poll start. Determines magnitude
    // snapshot for both AV-W eligible-magnitude total and per-voter
    // magnitude lookup.
    const sbRows = await query<{ height: number }>(
      `
        SELECT height FROM superblocks
        WHERE height <= $h
        ORDER BY height DESC LIMIT 1
      `,
      { h: startHeight },
    );
    const sbHeight = sbRows[0]?.height ?? null;

    // Three lookups in parallel: AV-W eligible balance, AV-W
    // eligible magnitude (depends on sbHeight), and the vote list.
    // None of these depend on each other — only the post-await
    // per-voter dictionary queries do.
    const [eligBalRows, eligMagRows, votes] = await Promise.all([
      query<{ total: string | null }>(
        `
          SELECT CAST(sum(bal) AS CHAR) AS total FROM (
            SELECT sum(delta) AS bal
            FROM address_balance_history
            WHERE valid_from_height <= $h
            GROUP BY address
            HAVING sum(delta) > 0
          ) AS t
        `,
        { h: startHeight },
      ),
      sbHeight !== null
        ? query<{ total: string | null }>(
          `
            SELECT CAST(sum(magnitude) AS CHAR) AS total FROM superblock_magnitudes
            WHERE superblock_height = $h
          `,
          { h: sbHeight },
        )
        : Promise.resolve([{ total: '0' }] as Array<{ total: string | null }>),
      query<VoteRow>(
        `
          SELECT poll_id, voter_address, voter_cpid, mining_id, choice_idx,
                 CAST(weight AS CHAR)         AS weight,
                 CAST(weight_balance AS CHAR) AS weight_balance,
                 weight_magnitude, tx_id, block_height
          FROM votes
          WHERE poll_id = $id
        `,
        { id: poll.poll_id },
      ),
    ]);
    const avwBalance = BigInt(eligBalRows[0]?.total ?? '0');
    const avwMagnitude = Number(eligMagRows[0]?.total ?? 0);
    if (votes.length === 0) {
      // No votes: just stamp weights_computed_at_height so the poll
      // doesn't keep coming back through the queue. The magnitude
      // factor we'd have used still goes into the row so an empty-
      // turnout poll page can render the same provenance as a voted
      // one.
      const magFactorAsFloat = Number(MAG_FACTOR_NUM) / Number(MAG_FACTOR_DEN);
      await this.markPollComputed(poll, {
        avwBalance,
        avwMagnitude,
        computedAtHeight: sbHeight ?? startHeight,
        magnitudeWeightFactor: magFactorAsFloat,
      }, finalize);
      return;
    }

    // Batch the per-voter balance + magnitude lookups.
    const voterAddresses = Array.from(new Set(votes.map((v) => v.voter_address).filter(Boolean)));
    const voterCpids = Array.from(new Set(
      votes.map((v) => v.voter_cpid).filter((c): c is string => typeof c === 'string' && c !== ''),
    ));

    // The per-voter balance and magnitude lookups are independent —
    // fire in parallel.
    const balByAddress = new Map<string, bigint>();
    const magByCpid = new Map<string, number>();
    const [balRows, magRows] = await Promise.all([
      voterAddresses.length > 0
        ? query<{ address: string; bal: string }>(
          `
            SELECT address, CAST(sum(delta) AS CHAR) AS bal
            FROM address_balance_history
            WHERE address IN ($addrs)
              AND valid_from_height <= $h
            GROUP BY address
          `,
          { addrs: voterAddresses, h: startHeight },
        )
        : Promise.resolve([] as Array<{ address: string; bal: string }>),
      voterCpids.length > 0 && sbHeight !== null
        ? query<{ cpid: string; magnitude: number }>(
          `
            SELECT cpid, magnitude FROM superblock_magnitudes
            WHERE superblock_height = $h
              AND cpid IN ($cpids)
          `,
          { h: sbHeight, cpids: voterCpids },
        )
        : Promise.resolve([] as Array<{ cpid: string; magnitude: number }>),
    ]);
    for (const row of balRows) balByAddress.set(row.address, BigInt(row.bal));
    for (const row of magRows) magByCpid.set(row.cpid, row.magnitude);

    // Pre-V13 polls use the hardcoded 100/567 factor. V13+ polls walk
    // the on-chain protocol registry for the `magnitudeweightfactor`
    // value effective at the poll's timestamp (see
    // `reference_gridcoin_voting_weight_rules.md`). The
    // protocol_entries table is populated by the contract parser; if
    // no entry exists for the key, fall back to the same default the
    // wallet uses (100/567 per chainparams' DefaultMagnitudeWeightFactor).
    const isPostV13 = poll.block_height >= V13_HEIGHT;
    let magFactorNum = MAG_FACTOR_NUM;
    let magFactorDen = MAG_FACTOR_DEN;
    if (isPostV13) {
      const registryFactor = await this.resolveMagnitudeWeightFactor(poll.start_time);
      if (registryFactor) {
        magFactorNum = registryFactor.num;
        magFactorDen = registryFactor.den;
      } else {
        log.warn(
          `PollWeightAggregator: poll ${poll.poll_id} is post-V13 but no \`magnitudeweightfactor\` registry entry was active at its timestamp — falling back to the wallet's DefaultMagnitudeWeightFactor (100/567)`,
        );
      }
    }
    const magFactorAsFloat = Number(magFactorNum) / Number(magFactorDen);

    // Group vote rows by (voter_address, tx_id) so a multi-choice
    // voter (one row per chosen response) gets the right response_count
    // for the canonical `/= response_count` divisor.
    const byGroup = new Map<string, VoteRow[]>();
    for (const v of votes) {
      const key = `${v.voter_address}|${v.tx_id}`;
      const arr = byGroup.get(key) ?? [];
      arr.push(v);
      byGroup.set(key, arr);
    }

    for (const group of byGroup.values()) {
      const responseCount = BigInt(group.length);
      if (responseCount === 0n) continue;
      const sample = group[0];
      const balance = balByAddress.get(sample.voter_address) ?? 0n;
      const magnitude: number = sample.voter_cpid
        ? (magByCpid.get(sample.voter_cpid) ?? 0)
        : 0;
      // Magnitude × 1 COIN = magnitude expressed in halford. The wallet
      // computes mag_weight in halford as
      //   magnitude_factor * magnitude.Scaled() / Magnitude::SCALE_FACTOR
      // which simplifies (since .Scaled() = magnitude × SCALE_FACTOR)
      // to magnitude_factor * magnitude. We carry magnitude × 1e8 here
      // so the bigint division mirrors C++'s int64 truncation exactly.
      const magnitudeHalford = BigInt(Math.round(magnitude * Number(HALFORD)));

      let responseWeight: bigint;
      switch (poll.weight_type) {
        case WEIGHT_TYPE.MAGNITUDE:
          responseWeight = magnitudeHalford / responseCount;
          break;
        case WEIGHT_TYPE.BALANCE:
          responseWeight = balance / responseCount;
          break;
        case WEIGHT_TYPE.MAGNITUDE_PLUS_BALANCE: {
          const magWeight = (magFactorNum * magnitudeHalford) / magFactorDen;
          responseWeight = (magWeight + balance) / responseCount;
          break;
        }
        case WEIGHT_TYPE.CPID_COUNT:
          // Per wallet: `response_weight = m_magnitude.Scaled() > 0` — a
          // 0/1 boolean, NOT divided by response_count. Each chosen
          // response gets the full 1.
          responseWeight = magnitude > 0 ? 1n : 0n;
          break;
        case WEIGHT_TYPE.PARTICIPANT_COUNT:
          // Per wallet: `response_weight = 1 * COIN`, NOT divided by
          // response_count. Each chosen response gets 1 GRC.
          responseWeight = HALFORD;
          break;
        default:
          log.warn(
            `PollWeightAggregator: unknown weight_type "${poll.weight_type}" on poll ${poll.poll_id}; assigning weight 0`,
          );
          responseWeight = 0n;
      }

      // Every row in this group (one per chosen response) shares the
      // computed weight/balance/magnitude; UPDATE them in one statement
      // keyed by the group's tx_id + the set of choice_idx it covers.
      // eslint-disable-next-line no-await-in-loop
      await run(
        `UPDATE votes
         SET weight = $weight, weight_balance = $wb, weight_magnitude = $wm
         WHERE tx_id = $tx AND choice_idx IN ($idxs)`,
        {
          weight: responseWeight,
          wb: balance,
          wm: magnitude,
          tx: sample.tx_id,
          idxs: group.map((v) => v.choice_idx),
        },
      );
    }
    await this.markPollComputed(poll, {
      avwBalance,
      avwMagnitude,
      computedAtHeight: sbHeight ?? startHeight,
      magnitudeWeightFactor: magFactorAsFloat,
    }, finalize);
    log.info(
      `PollWeightAggregator: poll ${poll.poll_id} ${finalize ? 'finalised' : 'live'} (${votes.length} votes, ${byGroup.size} voters, AV-W bal=${avwBalance}, mag=${avwMagnitude.toFixed(2)})`,
    );
  }

  /**
   * Walk the protocol-entries registry for the `magnitudeweightfactor`
   * value effective at a poll's timestamp. Mirrors the wallet's
   * `Poll::ResolveMagnitudeWeightFactor` (src/gridcoin/voting/poll.cpp):
   * find the most recent ACTIVE entry for the key whose `time` is at
   * or before the poll's start_time, and parse its value as `num/den`.
   *
   * Returns null if no entry is found — caller falls back to the
   * hardcoded default (100/567). The wallet itself clamps the result
   * to `[MinMagnitudeWeightFactor, MaxMagnitudeWeightFactor]` from
   * consensus params; those bounds aren't exposed via RPC so we don't
   * replicate the clamp here. A pathological registry entry would
   * produce a wrong-but-bounded weight, which we'd notice in the
   * weight column and can fix in a follow-up.
   */
  private async resolveMagnitudeWeightFactor(
    pollStartTime: number,
  ): Promise<{ num: bigint; den: bigint } | null> {
    const rows = await query<{ value: string | null }>(
      `
        SELECT \`value\`
        FROM protocol_entries
        WHERE \`key\` = 'magnitudeweightfactor'
          AND status = 'ACTIVE'
          AND time <= FROM_UNIXTIME($ts)
        ORDER BY time DESC
        LIMIT 1
      `,
      { ts: pollStartTime },
    );
    const raw = rows[0]?.value;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    // Wallet's Fraction::FromString accepts "num/den"; tolerate plain
    // decimal too in case future entries use that form.
    const slashMatch = raw.match(/^(-?\d+)\s*\/\s*(\d+)$/);
    if (slashMatch) {
      const num = BigInt(slashMatch[1]);
      const den = BigInt(slashMatch[2]);
      if (den === 0n) return null;
      return { num, den };
    }
    const asNumber = Number(raw);
    if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
    // Convert decimal to fraction with denominator 1e6 — good enough
    // for the factor's typical range (~0.1-1.0) without dragging in
    // a bignum-decimal library.
    return {
      num: BigInt(Math.round(asNumber * 1_000_000)),
      den: 1_000_000n,
    };
  }

  private async markPollComputed(
    poll: PollSnapshot,
    aggregates: ComputedPollAggregates,
    finalize: boolean,
  ): Promise<void> {
    const {
      avwBalance, avwMagnitude, computedAtHeight, magnitudeWeightFactor,
    } = aggregates;
    // Fill the deferred annotations in place. The freshly computed
    // magnitude_weight_factor wins over any prior value (re-run
    // scenario) because we have the canonical formula. AV-W and the
    // factor are written every pass (idempotent for an active poll);
    // `weights_computed_at_height` is only stamped on the finalising
    // (post-close) pass — leaving it NULL keeps an active poll in the
    // recompute set and guarantees a single final pass after it closes.
    await run(
      `UPDATE polls
       SET magnitude_weight_factor = $factor,
           av_w_balance = $bal,
           av_w_magnitude = $mag,
           weights_computed_at_height = $height
       WHERE poll_id = $id`,
      {
        factor: magnitudeWeightFactor,
        bal: avwBalance,
        mag: avwMagnitude,
        height: finalize ? computedAtHeight : null,
        id: poll.poll_id,
      },
    );
  }
}

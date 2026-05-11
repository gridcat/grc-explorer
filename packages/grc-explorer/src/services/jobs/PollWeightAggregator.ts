import { ch } from '../../lib/ch';
import { log } from '../../lib/log';
import { nextSeq } from '../../lib/redis';
import { WEIGHT_TYPE } from '../indexer/ContractParser';
import { CHAIN_FORKS } from '../network/ChainForks';
import { config } from '../../config';

// Vote-weight + AV-W aggregator. For every closed poll where
// `weights_computed_at_height` is still NULL:
//   1. Find the latest superblock at-or-before poll.block_height
//      (snapshot magnitudes at the poll's start).
//   2. For each vote, look up the voter's balance at poll.block_height
//      via address_balance_history argMax, plus the voter's CPID
//      magnitude at the snapshot superblock.
//   3. Group vote rows by (voter_address, tx_id) so multi-choice
//      voters (one row per response) get a single `response_count`,
//      then compute response_weight per the canonical 5-branch
//      `GRC::CalculateWeight` from src/gridcoin/voting/result.cpp.
//      Re-INSERT each row with bumped _seq + the assigned weight.
//      ReplacingMergeTree picks the latest version on read.
//   4. Compute AV-W (eligible-balance + eligible-magnitude totals at
//      poll-start) and re-INSERT the poll row with av_w_balance,
//      av_w_magnitude, weights_computed_at_height set, and the
//      `magnitude_weight_factor` actually used.
//
// See `reference_gridcoin_voting_weight_rules.md` for the full
// canonical formula. Capped at POLLS_PER_TICK polls per pass so a
// backlog never monopolises the scheduler.
const POLLS_PER_TICK = 5;
const HALFORD = 100_000_000n;

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
const V13_FORK = CHAIN_FORKS.find((f) => f.key === 'v13');
const V13_HEIGHT = config.NETWORK === 'testnet'
  ? (V13_FORK?.testnet ?? Number.POSITIVE_INFINITY)
  : (V13_FORK?.mainnet ?? Number.POSITIVE_INFINITY);

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
      // Find closed polls with no computed weights yet, ordered by
      // end_time ascending — process the oldest backlog first.
      const pollsResult = await ch.query({
        query: `
          SELECT poll_id, block_height, weight_type,
                 toUnixTimestamp(start_time) AS start_time
          FROM polls FINAL
          WHERE weights_computed_at_height IS NULL
            AND end_time <= now()
          ORDER BY end_time ASC
          LIMIT {n: UInt32}
        `,
        query_params: { n: POLLS_PER_TICK },
        format: 'JSONEachRow',
      });
      const polls = await pollsResult.json<PollSnapshot>();
      if (polls.length === 0) return;

      log.info(`PollWeightAggregator: processing ${polls.length} closed poll(s)`);
      for (const poll of polls) {
        // eslint-disable-next-line no-await-in-loop
        await this.processPoll(poll);
      }
    } catch (err) {
      log.warn('PollWeightAggregator.tick failed', err);
    }
  }

  private async processPoll(poll: PollSnapshot): Promise<void> {
    const startHeight = poll.block_height;

    // Latest superblock at-or-before poll start. Determines magnitude
    // snapshot for both AV-W eligible-magnitude total and per-voter
    // magnitude lookup.
    const sbResult = await ch.query({
      query: `
        SELECT height FROM superblocks FINAL
        WHERE height <= {h: UInt32}
        ORDER BY height DESC LIMIT 1
      `,
      query_params: { h: startHeight },
      format: 'JSONEachRow',
    });
    const sbHeight = (await sbResult.json<{ height: number }>())[0]?.height ?? null;

    // address_balance_history stores per-block deltas, so balance-at-height
    // is the cumulative sum.
    const [eligBalResult, eligMagResult] = await Promise.all([
      ch.query({
        query: `
          SELECT toString(sum(bal)) AS total FROM (
            SELECT sum(delta) AS bal
            FROM address_balance_history FINAL
            WHERE valid_from_height <= {h: UInt32}
            GROUP BY address
            HAVING bal > 0
          )
        `,
        query_params: { h: startHeight },
        format: 'JSONEachRow',
      }),
      sbHeight !== null
        ? ch.query({
          query: `
            SELECT toString(sum(magnitude)) AS total FROM superblock_magnitudes FINAL
            WHERE superblock_height = {h: UInt32}
          `,
          query_params: { h: sbHeight },
          format: 'JSONEachRow',
        }).then((r) => r.json<{ total: string | null }>())
        : Promise.resolve([{ total: '0' }] as Array<{ total: string | null }>),
    ]);
    const avwBalance = BigInt((await eligBalResult.json<{ total: string | null }>())[0]?.total ?? '0');
    const avwMagnitude = Number((eligMagResult)[0]?.total ?? 0);

    // Pull every vote on this poll.
    const voteResult = await ch.query({
      query: `
        SELECT poll_id, voter_address, voter_cpid, mining_id, choice_idx,
               toString(weight)         AS weight,
               toString(weight_balance) AS weight_balance,
               weight_magnitude, tx_id, block_height
        FROM votes FINAL
        WHERE poll_id = {id: String}
      `,
      query_params: { id: poll.poll_id },
      format: 'JSONEachRow',
    });
    const votes = await voteResult.json<VoteRow>();
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
      });
      return;
    }

    // Batch the per-voter balance + magnitude lookups.
    const voterAddresses = Array.from(new Set(votes.map((v) => v.voter_address).filter(Boolean)));
    const voterCpids = Array.from(new Set(
      votes.map((v) => v.voter_cpid).filter((c): c is string => typeof c === 'string' && c !== ''),
    ));

    const balByAddress = new Map<string, bigint>();
    if (voterAddresses.length > 0) {
      const r = await ch.query({
        query: `
          SELECT address, toString(sum(delta)) AS bal
          FROM address_balance_history FINAL
          WHERE address IN ({addrs: Array(String)})
            AND valid_from_height <= {h: UInt32}
          GROUP BY address
        `,
        query_params: { addrs: voterAddresses, h: startHeight },
        format: 'JSONEachRow',
      });
      for (const row of await r.json<{ address: string; bal: string }>()) {
        balByAddress.set(row.address, BigInt(row.bal));
      }
    }

    const magByCpid = new Map<string, number>();
    if (voterCpids.length > 0 && sbHeight !== null) {
      const r = await ch.query({
        query: `
          SELECT cpid, magnitude FROM superblock_magnitudes FINAL
          WHERE superblock_height = {h: UInt32}
            AND cpid IN ({cpids: Array(String)})
        `,
        query_params: { h: sbHeight, cpids: voterCpids },
        format: 'JSONEachRow',
      });
      for (const row of await r.json<{ cpid: string; magnitude: number }>()) {
        magByCpid.set(row.cpid, row.magnitude);
      }
    }

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

    const seq = await nextSeq();
    const updatedVotes: Array<Record<string, unknown>> = [];

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

      for (const v of group) {
        updatedVotes.push({
          poll_id: v.poll_id,
          voter_address: v.voter_address,
          voter_cpid: v.voter_cpid,
          mining_id: v.mining_id,
          choice_idx: v.choice_idx,
          weight: responseWeight.toString(),
          weight_balance: balance.toString(),
          weight_magnitude: magnitude,
          tx_id: v.tx_id,
          block_height: v.block_height,
          _seq: seq.toString(),
        });
      }
    }

    if (updatedVotes.length > 0) {
      await ch.insert({ table: 'votes', format: 'JSONEachRow', values: updatedVotes });
    }
    await this.markPollComputed(poll, {
      avwBalance,
      avwMagnitude,
      computedAtHeight: sbHeight ?? startHeight,
      magnitudeWeightFactor: magFactorAsFloat,
    });
    log.info(
      `PollWeightAggregator: poll ${poll.poll_id} done (${votes.length} votes, ${byGroup.size} voters, AV-W bal=${avwBalance}, mag=${avwMagnitude.toFixed(2)})`,
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
    const r = await ch.query({
      query: `
        SELECT value
        FROM protocol_entries FINAL
        WHERE key = 'magnitudeweightfactor'
          AND status = 'ACTIVE'
          AND time <= toDateTime({ts: UInt32})
        ORDER BY time DESC
        LIMIT 1
      `,
      query_params: { ts: pollStartTime },
      format: 'JSONEachRow',
    });
    const rows = await r.json<{ value: string | null }>();
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
  ): Promise<void> {
    const {
      avwBalance, avwMagnitude, computedAtHeight, magnitudeWeightFactor,
    } = aggregates;
    // Re-INSERT the poll row with the deferred annotations filled.
    // Need to read the rest of the poll's columns first since CH has
    // no UPDATE — supply the full row.
    const fullResult = await ch.query({
      query: `
        SELECT
          poll_id, title, question, url, poll_type, response_type, weight_type,
          toUnixTimestamp(start_time) AS start_time,
          toUnixTimestamp(end_time)   AS end_time,
          claim_tx, block_height, creator_address, magnitude_weight_factor
        FROM polls FINAL WHERE poll_id = {id: String} LIMIT 1
      `,
      query_params: { id: poll.poll_id },
      format: 'JSONEachRow',
    });
    const fullRows = await fullResult.json<{
      poll_id: string; title: string; question: string; url: string | null;
      poll_type: string | null; response_type: string; weight_type: string;
      start_time: number; end_time: number; claim_tx: string; block_height: number;
      creator_address: string | null; magnitude_weight_factor: number | null;
    }>();
    if (fullRows.length === 0) return;
    const f = fullRows[0];
    const seq = await nextSeq();
    await ch.insert({
      table: 'polls',
      format: 'JSONEachRow',
      values: [{
        poll_id: f.poll_id,
        title: f.title,
        question: f.question,
        url: f.url,
        poll_type: f.poll_type,
        response_type: f.response_type,
        weight_type: f.weight_type,
        start_time: f.start_time,
        end_time: f.end_time,
        claim_tx: f.claim_tx,
        block_height: f.block_height,
        creator_address: f.creator_address,
        // Persist the factor we actually applied so the /polls API
        // can show why a vote scored what it did. If the row had a
        // prior value (re-run scenario), the freshly computed value
        // wins because we have the canonical formula.
        magnitude_weight_factor: magnitudeWeightFactor,
        av_w_balance: avwBalance.toString(),
        av_w_magnitude: avwMagnitude,
        weights_computed_at_height: computedAtHeight,
        _seq: seq.toString(),
      }],
    });
  }
}

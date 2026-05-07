import { ch } from '../../lib/ch';
import { log } from '../../lib/log';
import { nextSeq } from '../../lib/redis';

// Vote-weight + AV-W aggregator. For every closed poll where
// `weights_computed_at_height` is still NULL:
//   1. Find the latest superblock at-or-before poll.block_height
//      (snapshot magnitudes at the poll's start).
//   2. For each vote, look up the voter's balance at poll.block_height
//      via address_balance_history argMax, plus the voter's CPID
//      magnitude at the snapshot superblock.
//   3. Compute weight per `weight_type` rule (Balance / Magnitude /
//      Magnitude+Balance), then re-INSERT the vote row with bumped
//      _seq and the new weight columns. ReplacingMergeTree picks the
//      latest version on read.
//   4. Compute AV-W (eligible-balance + eligible-magnitude totals at
//      poll-start) and re-INSERT the poll row with av_w_balance,
//      av_w_magnitude, weights_computed_at_height set.
//
// Capped at POLLS_PER_TICK polls per pass so a backlog never
// monopolises the scheduler.
const POLLS_PER_TICK = 5;
const HALFORD = 100_000_000n;

interface PollSnapshot {
  poll_id: string;
  block_height: number;
  weight_type: string;
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
          SELECT poll_id, block_height, weight_type
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
      // doesn't keep coming back through the queue.
      await this.markPollComputed(poll, avwBalance, avwMagnitude, sbHeight ?? startHeight);
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

    // Compute the new vote rows.
    const seq = await nextSeq();
    const updatedVotes = votes.map((v) => {
      const balance = balByAddress.get(v.voter_address) ?? 0n;
      const magnitude: number = v.voter_cpid ? (magByCpid.get(v.voter_cpid) ?? 0) : 0;
      const magnitudeAsHalford = BigInt(Math.round(magnitude * Number(HALFORD)));
      let weight: bigint;
      switch (poll.weight_type) {
        case 'Balance': weight = balance; break;
        case 'Magnitude': weight = magnitudeAsHalford; break;
        case 'Magnitude+Balance':
        case 'BalanceAndMagnitude': weight = balance + magnitudeAsHalford; break;
        default: weight = balance + magnitudeAsHalford;
      }
      return {
        poll_id: v.poll_id,
        voter_address: v.voter_address,
        voter_cpid: v.voter_cpid,
        mining_id: v.mining_id,
        choice_idx: v.choice_idx,
        weight: weight.toString(),
        weight_balance: balance.toString(),
        weight_magnitude: magnitude,
        tx_id: v.tx_id,
        block_height: v.block_height,
        _seq: seq.toString(),
      };
    });

    await ch.insert({ table: 'votes', format: 'JSONEachRow', values: updatedVotes });
    await this.markPollComputed(poll, avwBalance, avwMagnitude, sbHeight ?? startHeight);
    log.info(
      `PollWeightAggregator: poll ${poll.poll_id} done (${votes.length} votes, AV-W bal=${avwBalance}, mag=${avwMagnitude.toFixed(2)})`,
    );
  }

  private async markPollComputed(
    poll: PollSnapshot,
    avwBalance: bigint,
    avwMagnitude: number,
    computedAtHeight: number,
  ): Promise<void> {
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
        magnitude_weight_factor: f.magnitude_weight_factor,
        av_w_balance: avwBalance.toString(),
        av_w_magnitude: avwMagnitude,
        weights_computed_at_height: computedAtHeight,
        _seq: seq.toString(),
      }],
    });
  }
}

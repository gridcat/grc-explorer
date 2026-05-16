import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ch } from '../lib/ch';
import { ErrorModel } from '../lib/errors';
import { liveRpc } from '../lib/gridcoin';
import { halford2grc } from '../lib/halford';
import { hiddenPollIds, isHiddenPoll } from '../lib/hiddenPolls';
import { getTipAnchor } from '../lib/indexerTip';
import { log } from '../lib/log';
import { getPagination } from '../lib/pagination';
import { param } from '../lib/req';
import { withMeta } from '../lib/responseMeta';
import { tsToUnix } from '../lib/time';
import { PollPresenter } from '../presenters';
import { registerParamValidators } from '../lib/validators';

export const pollsRouter = Router();
registerParamValidators(pollsRouter);

interface PollRow {
  poll_id: string;
  title: string;
  question: string;
  url: string | null;
  poll_type: string | null;
  response_type: string;
  weight_type: string;
  start_time: number | string;
  end_time: number | string;
  claim_tx: string;
  block_height: number;
  creator_address: string | null;
  magnitude_weight_factor: number | null;
  av_w_balance: string | null;
  av_w_magnitude: number | null;
  weights_computed_at_height: number | null;
  result?: {
    topLabel: string | null;
    topPctOfCast: number;
    totalVotes: number;
    totalWeightCast: string;
  };
}

function presentPoll(p: PollRow) {
  return {
    ...p,
    start_time: tsToUnix(p.start_time) ?? 0,
    end_time: tsToUnix(p.end_time) ?? 0,
    av_w_balance: p.av_w_balance === null ? null : BigInt(p.av_w_balance),
  };
}

pollsRouter.get('/', async (req: Request, res: Response) => {
  const { offset, limit } = getPagination(req);
  const filterActive = req.query.active === '1';
  const now = await getTipAnchor();
  const hidden = hiddenPollIds();

  const conditions: string[] = [];
  const params: Record<string, unknown> = { limit, offset };
  if (filterActive) {
    conditions.push('start_time <= toDateTime({now: UInt32}) AND end_time >= toDateTime({now: UInt32})');
    params.now = now;
  }
  if (hidden.length > 0) {
    conditions.push('poll_id NOT IN ({hidden: Array(String)})');
    params.hidden = hidden;
  }
  const whereSql = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;

  const [rowsResult, countResult] = await Promise.all([
    ch.query({
      query: `
        SELECT
          poll_id, title, question, url, poll_type, response_type, weight_type,
          toUnixTimestamp(start_time) AS start_time,
          toUnixTimestamp(end_time)   AS end_time,
          claim_tx, block_height, creator_address, magnitude_weight_factor,
          toString(av_w_balance) AS av_w_balance,
          av_w_magnitude, weights_computed_at_height
        FROM polls FINAL ${whereSql}
        ORDER BY end_time DESC, start_time DESC
        LIMIT {limit: UInt32} OFFSET {offset: UInt32}
      `,
      query_params: params,
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `SELECT count() AS c FROM polls FINAL ${whereSql}`,
      query_params: params,
      format: 'JSONEachRow',
    }),
  ]);
  const rows = (await rowsResult.json<PollRow>()).map(presentPoll);
  const total = Number((await countResult.json<{ c: string | number }>())[0]?.c ?? 0);

  // Per-poll result aggregate. Two extra CH queries scoped to this
  // page's poll_ids — cheap (≤ 25 polls × ~5 options × ~handful of
  // votes per option on testnet, well under a second on mainnet's
  // larger but still bounded poll set). Computing the winner in
  // JS keeps the SQL simple: per-option sums, then argmax in code.
  const pollIds = rows.map((p) => p.poll_id);
  if (pollIds.length > 0) {
    const [tallyResult, optionsResult] = await Promise.all([
      ch.query({
        query: `
          SELECT poll_id, choice_idx,
                 toString(sum(weight)) AS option_weight,
                 toUInt32(count())     AS option_votes
          FROM votes FINAL
          WHERE poll_id IN ({ids: Array(String)})
          GROUP BY poll_id, choice_idx
        `,
        query_params: { ids: pollIds },
        format: 'JSONEachRow',
      }),
      ch.query({
        query: `
          SELECT poll_id, idx, label
          FROM poll_options FINAL
          WHERE poll_id IN ({ids: Array(String)})
        `,
        query_params: { ids: pollIds },
        format: 'JSONEachRow',
      }),
    ]);
    const tallyRows = await tallyResult.json<{
      poll_id: string; choice_idx: number; option_weight: string; option_votes: number;
    }>();
    const optionRows = await optionsResult.json<{ poll_id: string; idx: number; label: string }>();

    const labelByKey = new Map<string, string>();
    for (const o of optionRows) labelByKey.set(`${o.poll_id}:${o.idx}`, o.label);

    // Aggregate per poll: track top option by weight, total cast
    // weight, total vote count. BigInt arithmetic keeps the weight
    // sums exact across halford-precision values.
    interface Acc {
      topIdx: number | null;
      topWeight: bigint;
      totalWeight: bigint;
      totalVotes: number;
    }
    const byPoll = new Map<string, Acc>();
    for (const t of tallyRows) {
      const acc = byPoll.get(t.poll_id) ?? {
        topIdx: null, topWeight: 0n, totalWeight: 0n, totalVotes: 0,
      };
      const w = BigInt(t.option_weight);
      acc.totalWeight += w;
      acc.totalVotes += t.option_votes;
      if (w > acc.topWeight) {
        acc.topWeight = w;
        acc.topIdx = t.choice_idx;
      }
      byPoll.set(t.poll_id, acc);
    }

    for (const row of rows) {
      const acc = byPoll.get(row.poll_id);
      if (!acc || acc.totalWeight === 0n) {
        row.result = {
          topLabel: null, topPctOfCast: 0, totalVotes: acc?.totalVotes ?? 0, totalWeightCast: '0',
        };
        continue;
      }
      const topLabel = acc.topIdx === null
        ? null
        : labelByKey.get(`${row.poll_id}:${acc.topIdx}`) ?? null;
      const topPct = Number((acc.topWeight * 10000n) / acc.totalWeight) / 100;
      row.result = {
        topLabel,
        topPctOfCast: topPct,
        totalVotes: acc.totalVotes,
        totalWeightCast: halford2grc(acc.totalWeight),
      };
    }
  }

  const body = PollPresenter.render(rows, { meta: { count: total } });
  res.status(StatusCodes.OK).send(withMeta(body));
});

pollsRouter.get('/:poll_id', async (req: Request, res: Response) => {
  const pollId = param(req, 'poll_id');
  if (isHiddenPoll(pollId)) {
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Poll not found')],
    });
    return;
  }
  const pollResult = await ch.query({
    query: `
      SELECT
        poll_id, title, question, url, poll_type, response_type, weight_type,
        toUnixTimestamp(start_time) AS start_time,
        toUnixTimestamp(end_time)   AS end_time,
        claim_tx, block_height, creator_address, magnitude_weight_factor,
        toString(av_w_balance) AS av_w_balance,
        av_w_magnitude, weights_computed_at_height
      FROM polls FINAL WHERE poll_id = {id: String} LIMIT 1
    `,
    query_params: { id: pollId },
    format: 'JSONEachRow',
  });
  const pollRows = await pollResult.json<PollRow>();
  if (pollRows.length === 0) {
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Poll not found')],
    });
    return;
  }
  const poll = presentPoll(pollRows[0]);

  const [optResult, voteResult] = await Promise.all([
    ch.query({
      query: 'SELECT idx, label FROM poll_options FINAL WHERE poll_id = {id: String} ORDER BY idx ASC',
      query_params: { id: pollId },
      format: 'JSONEachRow',
    }),
    ch.query({
      query: `
        SELECT poll_id, voter_address, voter_cpid, mining_id, choice_idx,
               toString(weight)         AS weight,
               toString(weight_balance) AS weight_balance,
               weight_magnitude, tx_id, block_height
        FROM votes FINAL
        WHERE poll_id = {id: String}
        ORDER BY block_height DESC
      `,
      query_params: { id: pollId },
      format: 'JSONEachRow',
    }),
  ]);
  const options = await optResult.json<{ idx: number; label: string }>();
  const votes = await voteResult.json<{
    voter_address: string; voter_cpid: string | null; mining_id: string | null;
    choice_idx: number; weight: string; weight_balance: string; weight_magnitude: number;
    tx_id: string; block_height: number;
  }>();

  // Block-time lookup for vote rows.
  const heights = Array.from(new Set(votes.map((v) => v.block_height)));
  const timeByHeight = new Map<number, number>();
  if (heights.length > 0) {
    const r = await ch.query({
      query: 'SELECT height, toUnixTimestamp(time) AS time FROM blocks FINAL WHERE height IN ({hs: Array(UInt32)})',
      query_params: { hs: heights },
      format: 'JSONEachRow',
    });
    for (const b of await r.json<{ height: number; time: number }>()) {
      timeByHeight.set(b.height, b.time);
    }
  }

  const tally = new Map<number, { count: number; weight: bigint }>();
  for (const v of votes) {
    const entry = tally.get(v.choice_idx) ?? { count: 0, weight: 0n };
    entry.count += 1;
    entry.weight += BigInt(v.weight);
    tally.set(v.choice_idx, entry);
  }
  const totalWeightCast = Array.from(tally.values()).reduce((acc, e) => acc + e.weight, 0n);

  const avwBalance = poll.av_w_balance ?? 0n;
  const avwMagnitudeAsHalford = poll.av_w_magnitude
    ? BigInt(Math.round(poll.av_w_magnitude * 100_000_000))
    : 0n;
  const avwCombined = (() => {
    switch (poll.weight_type) {
      case 'Balance': return avwBalance;
      case 'Magnitude': return avwMagnitudeAsHalford;
      case 'Magnitude+Balance':
      case 'BalanceAndMagnitude': return avwBalance + avwMagnitudeAsHalford;
      default: return avwBalance + avwMagnitudeAsHalford;
    }
  })();

  res.status(StatusCodes.OK).send(withMeta(PollPresenter.render(poll), {
    options: options.map((o) => {
      const t = tally.get(o.idx);
      const weight = t?.weight ?? 0n;
      const pctOfCast = totalWeightCast > 0n
        ? Number((weight * 10000n) / totalWeightCast) / 100
        : 0;
      const pctOfAvw = avwCombined > 0n
        ? Number((weight * 10000n) / avwCombined) / 100
        : 0;
      return {
        idx: o.idx,
        label: o.label,
        voteCount: t?.count ?? 0,
        voteWeight: halford2grc(weight),
        pctOfCast,
        pctOfAvw,
      };
    }),
    votes: votes.map((v) => ({
      txId: v.tx_id,
      voterAddress: v.voter_address || null,
      voterCpid: v.voter_cpid,
      miningId: v.mining_id,
      choiceIdx: v.choice_idx,
      weight: halford2grc(BigInt(v.weight)),
      weightBalance: halford2grc(BigInt(v.weight_balance)),
      weightMagnitude: v.weight_magnitude,
      blockHeight: v.block_height,
      time: timeByHeight.get(v.block_height) ?? null,
    })),
    voteTotal: votes.length,
    totalWeightCast: halford2grc(totalWeightCast),
    avwBalance: halford2grc(avwBalance),
    avwMagnitude: poll.av_w_magnitude ?? 0,
    avwCombined: halford2grc(avwCombined),
    weightsComputed: poll.weights_computed_at_height !== null,
  }));
});

// Verify-claim proxy. Forwards to the daemon's `getvotingclaim` RPC so
// the heavy signature validation stays in the wallet code. Falls back
// to the raw vote contract for legacy (v1) votes which the daemon
// rejects because they have no claim signature.
pollsRouter.get('/votes/:tx_id/claim', async (req: Request, res: Response) => {
  const txId = param(req, 'tx_id');
  try {
    const claim = await (liveRpc as unknown as { getVotingClaim: (id: string) => Promise<unknown> })
      .getVotingClaim(txId);
    res.status(StatusCodes.OK).send({ data: claim, meta: { source: 'getvotingclaim' } });
    return;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isLegacy = /legacy transaction not supported/i.test(message);
    if (!isLegacy) {
      log.info(`getVotingClaim ${txId} unavailable: ${message}`);
      res.status(StatusCodes.NOT_FOUND).send({
        data: null,
        meta: { unavailableReason: 'daemon_error', daemonMessage: message },
      });
      return;
    }
  }

  try {
    const tx = await (liveRpc as unknown as {
      getRawTransaction: (
        id: string, verbose: number | boolean,
      ) => Promise<{
        txid: string;
        time?: number;
        blockhash?: string;
        contracts?: Array<{ version?: number; type?: string; action?: string; body?: unknown }>;
      } | null>;
    }).getRawTransaction(txId, 1);

    const voteContract = tx?.contracts?.find((c) => c.type === 'vote');
    if (!voteContract) {
      res.status(StatusCodes.NOT_FOUND).send({
        data: null,
        meta: {
          unavailableReason: 'legacy_vote_no_claim_signature',
          daemonMessage: 'Legacy transaction not supported',
          fallbackMessage: 'Daemon does not return a vote contract for this txid',
        },
      });
      return;
    }
    res.status(StatusCodes.OK).send({
      data: {
        txid: tx?.txid,
        time: tx?.time,
        blockhash: tx?.blockhash,
        contract: voteContract,
      },
      meta: { source: 'getrawtransaction', legacyVote: true },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.info(`legacy vote fallback ${txId} failed: ${message}`);
    res.status(StatusCodes.NOT_FOUND).send({
      data: null,
      meta: { unavailableReason: 'daemon_error', daemonMessage: message },
    });
  }
});

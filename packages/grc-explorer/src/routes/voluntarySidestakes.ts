import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { query } from '../lib/db';
import { halford2grc } from '../lib/halford';
import { getTipAnchor } from '../lib/indexerTip';
import { withMeta } from '../lib/responseMeta';
import { MSS_INTERVAL_JOIN } from '../lib/sidestakeKind';

export const voluntarySidestakesRouter = Router();

// Recipients of voluntary sidestakes: coinstake outputs a staker
// configured in their own wallet, i.e. every captured sidestake whose
// recipient was NOT in the mandatory registry at that height. Powers
// the /sidestakes page. Top recipients by all-time amount; the table
// only changes when a PoS block lands, so a 60s memo is plenty.
const RECIPIENTS_LIMIT = 100;
const RECIPIENTS_TTL_MS = 60_000;
let recipientsCache: { body: unknown; expiresAt: number } | null = null;

interface RecipientRow {
  address: string;
  total_paid: string;
  payout_count: number;
  amount_24h: string;
  count_24h: number;
  first_height: number;
  last_height: number;
  last_time: number;
}

voluntarySidestakesRouter.get('/', async (_req: Request, res: Response) => {
  const now = Date.now();
  if (recipientsCache && now < recipientsCache.expiresAt) {
    res.status(StatusCodes.OK).send(recipientsCache.body);
    return;
  }
  const since = (await getTipAnchor()) - 24 * 3600;
  const rows = await query<RecipientRow>(
    `
      SELECT
        cs.address                                                                                        AS address,
        CAST(sum(cs.amount) AS CHAR)                                                                      AS total_paid,
        CAST(count(*) AS UNSIGNED)                                                                        AS payout_count,
        CAST(coalesce(SUM(CASE WHEN cs.time >= FROM_UNIXTIME($since) THEN cs.amount ELSE 0 END), 0) AS CHAR) AS amount_24h,
        CAST(SUM(CASE WHEN cs.time >= FROM_UNIXTIME($since) THEN 1 ELSE 0 END) AS UNSIGNED)                  AS count_24h,
        min(cs.block_height)                                                                              AS first_height,
        max(cs.block_height)                                                                              AS last_height,
        UNIX_TIMESTAMP(max(cs.time))                                                                      AS last_time
      FROM coinstake_sidestakes cs
      ${MSS_INTERVAL_JOIN}
      WHERE mss.address IS NULL
      GROUP BY cs.address
      ORDER BY sum(cs.amount) DESC, cs.address
      LIMIT ${RECIPIENTS_LIMIT}
    `,
    { since },
  );
  const body = withMeta({
    data: rows.map((r) => ({
      type: 'voluntary_sidestake_recipients',
      id: r.address,
      attributes: {
        address: r.address,
        totalPaid: halford2grc(BigInt(r.total_paid)),
        payoutCount: Number(r.payout_count),
        amount24h: halford2grc(BigInt(r.amount_24h)),
        count24h: Number(r.count_24h),
        firstBlockHeight: Number(r.first_height),
        lastBlockHeight: Number(r.last_height),
        lastTime: Number(r.last_time),
      },
    })),
  });
  recipientsCache = { body, expiresAt: now + RECIPIENTS_TTL_MS };
  res.status(StatusCodes.OK).send(body);
});

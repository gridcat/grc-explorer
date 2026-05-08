import express, { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ErrorModel } from '../lib/errors';
import { param } from '../lib/req';
import { sseSubscribeLimiter } from '../middleware/rateLimit';
import { registerParamValidators } from '../lib/validators';
import {
  EventsService, MAX_TOPICS_PER_STREAM, MAX_TOPIC_LENGTH,
} from '../services/sse/EventsService';

export const eventsRouter = Router();
registerParamValidators(eventsRouter);

/**
 * GET /events — open the SSE stream. Returns the stream id in the
 * `hello` event so the client can target subsequent subscribe calls.
 */
eventsRouter.get('/', (req: Request, res: Response) => {
  // SSE streams are long-lived by design; the global `requestTimeout`
  // (audit P0 #5) would tear them down after 30s. Disable per-socket.
  req.socket.setTimeout(0);
  res.writeHead(StatusCodes.OK, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx response buffering
  });
  res.flushHeaders();

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const result = EventsService.getInstance().addClient(res, ip);
  if (!result.ok) {
    // Caller already saw 200 + the SSE headers; send a closing frame
    // explaining the rejection rather than dropping silently. Browser
    // EventSource will emit an `error` event the page can show.
    const reason = result.reason === 'total' ? 'server at capacity' : 'too many open streams from your IP';
    res.write(`event: rejected\ndata: ${JSON.stringify({ reason })}\n\n`);
    res.end();
    return;
  }
  req.on('close', () => {
    EventsService.getInstance().removeClient(result.id);
  });
});

/**
 * POST /events/:streamId/subscribe — replace a stream's topic set.
 * Body: { topics: string[] }. Wildcards `address.*` and `cpid.*`
 * accepted. Body capped at 8 KB and topic count / length capped per
 * `MAX_TOPICS_PER_STREAM` and `MAX_TOPIC_LENGTH` (audit P0 #4).
 */
eventsRouter.post(
  '/:streamId/subscribe',
  sseSubscribeLimiter,
  express.json({ limit: '8kb' }),
  (req: Request, res: Response) => {
    const raw = Array.isArray(req.body?.topics) ? req.body.topics : null;
    if (!raw) {
      res.status(StatusCodes.BAD_REQUEST).send({
        errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Missing topics array')],
      });
      return;
    }
    const topics = raw
      .filter((t: unknown): t is string => typeof t === 'string' && t.length > 0 && t.length <= MAX_TOPIC_LENGTH)
      .slice(0, MAX_TOPICS_PER_STREAM);
    const ok = EventsService.getInstance().subscribe(param(req, 'streamId'), topics);
    if (!ok) {
      res.status(StatusCodes.NOT_FOUND).send({
        errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Stream not found')],
      });
      return;
    }
    res.status(StatusCodes.NO_CONTENT).end();
  },
);

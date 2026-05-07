import { Request, Response, Router } from 'express';
import { StatusCodes } from 'http-status-codes';
import { ErrorModel } from '../lib/errors';
import { param } from '../lib/req';
import { sseSubscribeLimiter } from '../middleware/rateLimit';
import { EventsService } from '../services/sse/EventsService';

export const eventsRouter = Router();

/**
 * GET /events — open the SSE stream. Returns the stream id in the
 * `hello` event so the client can target subsequent subscribe calls.
 */
eventsRouter.get('/', (req: Request, res: Response) => {
  res.writeHead(StatusCodes.OK, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // disable nginx response buffering
  });
  res.flushHeaders();

  const id = EventsService.getInstance().addClient(res);
  req.on('close', () => {
    EventsService.getInstance().removeClient(id);
  });
});

/**
 * POST /events/:streamId/subscribe — replace a stream's topic set.
 * Body: { topics: string[] }. Wildcards `address.*` and `cpid.*`
 * accepted.
 */
eventsRouter.post('/:streamId/subscribe', sseSubscribeLimiter, (req: Request, res: Response) => {
  const topics = Array.isArray(req.body?.topics) ? req.body.topics.filter((t: unknown) => typeof t === 'string') : null;
  if (!topics) {
    res.status(StatusCodes.BAD_REQUEST).send({
      errors: [new ErrorModel(StatusCodes.BAD_REQUEST, 'Missing topics array')],
    });
    return;
  }
  const ok = EventsService.getInstance().subscribe(param(req, 'streamId'), topics);
  if (!ok) {
    res.status(StatusCodes.NOT_FOUND).send({
      errors: [new ErrorModel(StatusCodes.NOT_FOUND, 'Stream not found')],
    });
    return;
  }
  res.status(StatusCodes.NO_CONTENT).end();
});

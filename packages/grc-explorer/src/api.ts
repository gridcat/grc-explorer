import express, { NextFunction, Request, Response } from 'express';
import HttpStatus from 'http-status-codes';
import morgan from 'morgan';
import packageJson from '../package.json';
import { config } from './config';
import { ErrorModel } from './lib/errors';
import { log } from './lib/log';
import { requestContextMiddleware } from './lib/requestContext';
import { readsLimiter, searchLimiter } from './middleware/rateLimit';
import { addressesRouter } from './routes/addresses';
import { beaconsRouter } from './routes/beacons';
import { blocksRouter } from './routes/blocks';
import { blocksArchiveRouter } from './routes/blocksArchive';
import { cpidsRouter } from './routes/cpids';
import { eventsRouter } from './routes/events';
import { mempoolRouter } from './routes/mempool';
import { mrcRequestsRouter } from './routes/mrcRequests';
import { metricsRouter } from './routes/metrics';
import { networkRouter } from './routes/network';
import { pollsRouter } from './routes/polls';
import { projectsRouter } from './routes/projects';
import { searchRouter } from './routes/search';
import { statusRouter } from './routes/status';
import { superblocksRouter } from './routes/superblocks';
import { transactionsRouter } from './routes/transactions';

export const app = express();

// Trust the configured number of proxy hops so req.ip reflects the
// real client when running behind nginx — the per-IP rate limiters
// depend on this. Default 1 (single upstream).
app.set('trust proxy', config.TRUST_PROXY_HOPS);
app.set('port', config.PORT);

// Express 5 changed the default query parser from `qs` (extended) to
// `querystring` (simple). The simple parser stores `?page[size]=10`
// as the flat key `req.query['page[size]']` and leaves `req.query.page`
// undefined, which silently broke every paginated route's
// `getPagination()` helper (page.size → undefined → falls back to the
// default limit of 25, ignoring whatever the client requested).
// Restore Express 4 / JSON:API-friendly nested parsing.
app.set('query parser', 'extended');

// AsyncLocalStorage carrier for the request's AbortSignal. Every
// downstream CH call reads it via the wrapper in lib/ch.ts so client
// disconnects propagate as query cancellations (audit P0 #6).
app.use(requestContextMiddleware);

app.use(express.json({ type: 'application/vnd.api+json' }));
app.use(express.json());
app.disable('x-powered-by');

if (!config.isTesting) {
  app.use(morgan('combined'));
}

app.use((_req, res, next) => {
  res.header('Content-Type', 'application/vnd.api+json; charset=utf-8');
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header(
    'Access-Control-Allow-Headers',
    'Accept,DNT,X-CustomHeader,Keep-Alive,User-Agent,'
    + 'X-Requested-With,If-Modified-Since,Cache-Control,Content-Type',
  );
  // Helmet-equivalent headers (audit P0 #9). The API only returns JSON
  // so framing protection is DENY (it's never legitimately embeddable),
  // referrer is no-referrer (no leak of internal paths to upstream
  // RPC errors etc.), and `Cross-Origin-Resource-Policy: same-site`
  // keeps the API responses out of cross-site `<img>` / `<script>`
  // smuggling vectors. HSTS is set at the edge nginx, not here.
  res.header('X-Content-Type-Options', 'nosniff');
  res.header('X-Frame-Options', 'DENY');
  res.header('Referrer-Policy', 'no-referrer');
  res.header('Cross-Origin-Resource-Policy', 'same-site');
  next();
});

// During the ClickHouse migration these routes still call Prisma and
// would 500 on every request. Short-circuit to a clean 503 while their
// per-route ports land in subsequent Phase 2 chunks. /status and
// /events are kept live (status reads no DB; SSE fanout is already
// CH-native via the indexer's emitter).
const phase2Migrating = (_req: Request, res: Response): void => {
  res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
    errors: [{
      status: '503',
      title: 'Endpoint migrating to ClickHouse',
      detail: 'This endpoint is being ported to the new storage layer. '
        + 'Retry once the next migration chunk lands.',
    }],
  });
};

app.use('/status', statusRouter);
// Archive routes mounted on a sibling path so they don't shadow
// /blocks/:height. The frontend exposes them as /blocks/YYYY[/MM[/DD]]
// via SSR pages that fan out to this internal API.
app.use('/blocks/archive', readsLimiter, blocksArchiveRouter);
app.use('/blocks', readsLimiter, blocksRouter);
app.use('/network', readsLimiter, networkRouter);
app.use('/transactions', readsLimiter, transactionsRouter);
app.use('/addresses', readsLimiter, addressesRouter);
app.use('/mempool', readsLimiter, mempoolRouter);
app.use('/mrc-requests', readsLimiter, mrcRequestsRouter);
app.use('/superblocks', readsLimiter, superblocksRouter);
app.use('/cpids', readsLimiter, cpidsRouter);
app.use('/polls', readsLimiter, pollsRouter);
app.use('/projects', readsLimiter, projectsRouter);
app.use('/beacons', readsLimiter, beaconsRouter);
app.use('/metrics', readsLimiter, metricsRouter);
app.use('/search', searchLimiter, searchRouter);

// 503 fallback retained for any future route that lands ahead of its
// CH port — every existing route now talks to ClickHouse.
void phase2Migrating;
// SSE endpoints don't go through the readsLimiter — long-lived
// connections would burn the bucket on connection establishment
// rather than the actual request rate. Subscription POSTs have their
// own limiter inside the events router.
app.use('/events', eventsRouter);

app.use((req, res) => {
  log.warn(`Not found URL: ${req.url}`);
  res.status(HttpStatus.NOT_FOUND).send({
    errors: [new ErrorModel(HttpStatus.NOT_FOUND, HttpStatus.getStatusText(HttpStatus.NOT_FOUND))],
  });
});

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log.error(`Internal server error: ${err.stack ?? err.message}`);
  res.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
    errors: [new ErrorModel(
      HttpStatus.INTERNAL_SERVER_ERROR,
      HttpStatus.getStatusText(HttpStatus.INTERNAL_SERVER_ERROR),
    )],
  });
});

export function startApi(): import('http').Server | null {
  if (config.isTesting) return null;
  const server = app.listen(app.get('port'), () => {
    log.info(`${packageJson.name} is running on port ${app.get('port')} (network=${config.NETWORK})`);
  });
  // Audit P0 #5. Defaults are slowloris-friendly:
  //   headersTimeout    Infinity → finite ceiling on header receive
  //   requestTimeout    0        → finite ceiling on full request
  //   keepAliveTimeout  5 s      → too short for SSR keep-alive,
  //                                bump so nginx upstream connections
  //                                stop being torn down between hits
  //   maxConnections    none     → cap total open sockets so a flood
  //                                can't exhaust ephemeral ports
  // SSE responses override per-route via `res.setTimeout(0)` if the
  // stream needs to live past `requestTimeout`.
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 10_000;
  server.maxConnections = 5_000;
  return server;
}

import type { IncomingMessage } from 'http';
import {
  PAGE_TTL, SETTLED_DEPTH, cacheControl, clientHeaders, depthTtl,
} from '../src/lib/ssr';

describe('cacheControl', () => {
  it('lets shared caches hold the page but keeps browsers revalidating', () => {
    expect(cacheControl(PAGE_TTL.address))
      .toBe('public, max-age=0, s-maxage=60, stale-while-revalidate=300');
  });
});

describe('depthTtl', () => {
  it('treats a block at the settled depth as settled, one short of it as fresh', () => {
    expect(depthTtl(SETTLED_DEPTH)).toBe(PAGE_TTL.settled);
    expect(depthTtl(SETTLED_DEPTH - 1)).toBe(PAGE_TTL.fresh);
  });
});

describe('clientHeaders', () => {
  const req = (headers: Record<string, string | string[]>, remoteAddress?: string) => ({
    headers,
    socket: { remoteAddress },
  } as unknown as IncomingMessage);

  it('forwards the first X-Forwarded-For entry and the visitor user agent', () => {
    expect(clientHeaders(req({ 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'user-agent': 'Mozilla/5.0' }, '192.168.16.1')))
      .toEqual({ 'X-Forwarded-For': '203.0.113.9', 'User-Agent': 'Mozilla/5.0' });
  });

  it('falls back to the socket peer when nothing was forwarded', () => {
    expect(clientHeaders(req({}, '192.168.16.1'))).toEqual({ 'X-Forwarded-For': '192.168.16.1' });
  });

  it('sends nothing it does not have', () => {
    expect(clientHeaders(req({}))).toEqual({});
  });
});

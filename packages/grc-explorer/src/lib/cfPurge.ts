import { config } from '../config';
import { log } from './log';

const PURGE_TIMEOUT_MS = 10_000;

// Cloudflare edge-cache purge, used on chain reorg. The explorer serves
// immutable, deeply-confirmed pages with long edge TTLs; a reorg rewrites
// blocks/txs near the tip, so any cached page covering the rolled-back
// range must be evicted or the edge would keep serving the abandoned
// chain. Reorgs are rare (a few/day at most) and shallow, so we purge the
// whole zone — simpler and always-correct vs. enumerating exact URLs, and
// the cache refills from the corrected origin on the next request.
//
// No-op unless both CF_API_TOKEN and CF_ZONE_ID are configured (dev, or no
// CDN in front). Best-effort: a purge failure is logged, never thrown into
// the reorg path — a stale edge is far less bad than a wedged indexer.
export async function purgeReorgCache(fromHeight: number): Promise<void> {
  const token = config.CF_API_TOKEN;
  const zone = config.CF_ZONE_ID;
  if (!token || !zone) {
    log.debug?.(`CF purge skipped (not configured) for reorg from ${fromHeight}`);
    return;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PURGE_TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ purge_everything: true }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`CF purge HTTP ${res.status}`);
    log.info(`CF cache purged after reorg from height ${fromHeight}`);
  } catch (err) {
    log.warn(`CF cache purge failed after reorg from ${fromHeight}`, err);
  } finally {
    clearTimeout(timer);
  }
}

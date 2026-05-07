import { config } from '../config';
import packageJson from '../../package.json';

/**
 * Wrap a response body with our standard meta envelope and merge
 * any top-level extras (e.g. `transactions: [...]`, `claim`, `vins`)
 * into the response root.
 *
 *   body  — the JSON:API document (data, included, etc.).
 *   extra — additional top-level keys the route wants to expose.
 *           Live alongside `data`, NOT nested under `meta`.
 *
 * `meta.network` is always set so a client that thinks it's talking
 * to mainnet can refuse to render testnet data and vice versa
 * (see plan §7).
 */
export function withMeta(body: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const meta = {
    network: config.NETWORK,
    version: packageJson.version,
    ...((body.meta as Record<string, unknown> | undefined) ?? {}),
  };
  return { ...body, ...extra, meta };
}

import { config } from '../config';

/**
 * Hardcoded poll-id deny-list, scoped per network. Listed polls are
 * filtered out of the polls list, return 404 from the detail endpoint,
 * and are stripped from search results — without removing the
 * underlying rows from MySQL or Meili (they remain available for any
 * downstream consumer that hits the DB directly).
 *
 * Use sparingly. Prefer fixing data at the source over hiding it; this
 * exists for the rare case of testnet-only spam / malformed contracts
 * we don't want to surface to casual visitors.
 */
const HIDDEN_BY_NETWORK: Record<string, ReadonlySet<string>> = {
  testnet: new Set<string>([
    '847c1bbb9766aff28c337d37b0a58269f4af483b84c1981ebfcabe7a52a13a16',
  ]),
  mainnet: new Set<string>([]),
};

const HIDDEN_POLL_IDS: ReadonlySet<string> = HIDDEN_BY_NETWORK[config.NETWORK] ?? new Set<string>();

export function isHiddenPoll(pollId: string): boolean {
  return HIDDEN_POLL_IDS.has(pollId);
}

export function hiddenPollIds(): string[] {
  return Array.from(HIDDEN_POLL_IDS);
}

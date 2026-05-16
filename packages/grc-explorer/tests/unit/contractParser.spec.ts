import {
  parseBeaconContract,
  parsePollContract,
  parseVoteContract,
  parseMessageContract,
} from '../../src/services/indexer/ContractParser';
import type { ContractEnvelope } from '../../src/services/indexer/types';

// secp256k1 generator point X coordinate, compressed-form prefix 0x02 →
// 66 hex chars. Any valid secp256k1 pubkey that passes the 33/65-byte
// length check would do; using G means the test value is reproducible
// from any reference and not "magic" hex pulled from a specific wallet.
const COMPRESSED_PUBKEY = '0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798';

// The daemon's RPC client (`gridcoin-rpc`) deeply camelCases the JSON
// keys it receives, so contract bodies arrive at the parser in
// camelCase regardless of what the daemon serialises. These fixtures
// reflect what we *actually* see at runtime.

describe('parsePollContract', () => {
  const baseContract: ContractEnvelope = {
    version: 3,
    type: 'poll',
    action: 'A',
    body: {
      version: 3,
      title: 'Snack Choice',
      question: 'Sweet or salty?',
      url: 'https://example.test/poll',
      type: 1, // Survey
      weightType: 3, // Magnitude+Balance
      responseType: 2, // Single Choice
      durationDays: 7,
      choices: [
        { id: 0, label: 'Sweet' },
        { id: 1, label: 'Salty' },
      ],
    },
  };

  it('translates the daemon\'s int enums to the same human strings listpolls returns', () => {
    const row = parsePollContract(baseContract, 'tx1', 100, 1_700_000_000, 'mxAddr');
    expect(row).not.toBeNull();
    expect(row!.pollType).toBe('Survey');
    expect(row!.weightType).toBe('Magnitude+Balance');
    expect(row!.responseType).toBe('Single Choice');
  });

  it('derives endTime from durationDays and carries url + creator', () => {
    const row = parsePollContract(baseContract, 'tx1', 100, 1_700_000_000, 'mxAddr');
    expect(row!.startTime).toBe(1_700_000_000);
    expect(row!.endTime).toBe(1_700_000_000 + 7 * 86_400);
    expect(row!.url).toBe('https://example.test/poll');
    expect(row!.creatorAddress).toBe('mxAddr');
  });

  it('returns null for the wrong contract type — guards against the original lowercase-vs-uppercase bug', () => {
    expect(parsePollContract({ ...baseContract, type: 'POLL' }, 'tx1', 0, 0, null)).toBeNull();
    expect(parsePollContract({ ...baseContract, type: 'beacon' }, 'tx1', 0, 0, null)).toBeNull();
  });

  it('only accepts the ADD action', () => {
    expect(parsePollContract({ ...baseContract, action: 'D' }, 'tx1', 0, 0, null)).toBeNull();
  });

  it('falls back to a 7-day window when durationDays is missing', () => {
    const noDuration = {
      ...baseContract,
      body: { ...(baseContract.body as Record<string, unknown>) },
    };
    delete (noDuration.body as { durationDays?: number }).durationDays;
    const row = parsePollContract(noDuration as ContractEnvelope, 'tx1', 100, 1_000_000, null);
    expect(row!.endTime).toBe(1_000_000 + 7 * 86_400);
  });
});

describe('parseVoteContract', () => {
  it('parses a post-fern (v2+) vote into one row per response', () => {
    const contract: ContractEnvelope = {
      version: 2,
      type: 'vote',
      action: 'A',
      body: { pollTxid: 'pollTxid123', responses: [0, 2] },
    };
    const rows = parseVoteContract(contract, 'voteTx', 200, 'voterAddr');
    expect(rows).toHaveLength(2);
    expect(rows[0].pollId).toBe('pollTxid123');
    expect(rows[0].choiceIdx).toBe(0);
    expect(rows[0].voterAddress).toBe('voterAddr');
    expect(rows[0].legacyTitleKey).toBeNull();
    expect(rows[0].voterCpid).toBeNull();
    expect(rows[1].choiceIdx).toBe(2);
  });

  it('parses a legacy (v1) vote and exposes title-key + label list for writer-side resolution', () => {
    const contract: ContractEnvelope = {
      version: 1,
      type: 'vote',
      action: 'A',
      body: {
        key: 'Some Poll Title;extra',
        miningId: '0123456789abcdef0123456789abcdef',
        amount: 5,
        magnitude: 12.5,
        responses: 'Sweet;Salty',
      },
    };
    const rows = parseVoteContract(contract, 'legacyTx', 50, 'voterAddr');
    expect(rows).toHaveLength(2);
    // Title is lowercased before the first ';' — matches daemon's
    // ParseLegacyVoteTitle so the writer's case-insensitive lookup
    // against polls.title works on either side.
    expect(rows[0].legacyTitleKey).toBe('some poll title');
    expect(rows[0].pollId).toBeNull();
    expect(rows[0].choiceLabel).toBe('sweet');
    expect(rows[0].choiceIdx).toBe(-1); // resolved by writer via label join
    expect(rows[0].voterCpid).toBe('0123456789abcdef0123456789abcdef');
    expect(rows[0].miningId).toBe('0123456789abcdef0123456789abcdef');
    // 5 GRC self-declared balance → 5 * 1e8 halford
    expect(rows[0].weightBalance).toBe(500_000_000n);
    expect(rows[0].weightMagnitude).toBe(12.5);
  });

  it('treats INVESTOR mining_id as no CPID', () => {
    const contract: ContractEnvelope = {
      version: 1,
      type: 'vote',
      action: 'A',
      body: {
        key: 'foo;bar', miningId: 'INVESTOR', amount: 0, magnitude: 0, responses: 'no',
      },
    };
    const rows = parseVoteContract(contract, 'legacyTx', 0, null);
    expect(rows[0].voterCpid).toBeNull();
    expect(rows[0].miningId).toBe('INVESTOR');
  });

  it('treats NONCRUNCHER mining_id as no CPID', () => {
    // Post-fern wallet emits "NONCRUNCHER" via MiningId::ToString().
    const contract: ContractEnvelope = {
      version: 1,
      type: 'vote',
      action: 'A',
      body: {
        key: 'foo;bar', miningId: 'NONCRUNCHER', amount: 0, magnitude: 0, responses: 'no',
      },
    };
    const rows = parseVoteContract(contract, 'legacyTx', 0, null);
    expect(rows[0].voterCpid).toBeNull();
    expect(rows[0].miningId).toBe('NONCRUNCHER');
  });

  it('returns empty array for non-vote contract types', () => {
    expect(parseVoteContract({
      version: 2, type: 'poll', action: 'A', body: {},
    }, 'tx', 0, null)).toEqual([]);
  });
});

describe('parseMessageContract', () => {
  it('extracts a free-form string body verbatim', () => {
    const contract: ContractEnvelope = {
      version: 2, type: 'message', action: 'A', body: 'hello on chain',
    };
    const row = parseMessageContract(contract, 'msgTx', 42, 1_700_000_000, 'senderAddr');
    expect(row).not.toBeNull();
    expect(row!.message).toBe('hello on chain');
    expect(row!.txId).toBe('msgTx');
    expect(row!.senderAddress).toBe('senderAddr');
    expect(row!.time).toBe(1_700_000_000);
  });

  it('truncates oversized payloads to keep row size sane', () => {
    const huge = 'a'.repeat(20_000);
    const contract: ContractEnvelope = {
      version: 2, type: 'message', action: 'A', body: huge,
    };
    const row = parseMessageContract(contract, 'msgTx', 0, 0, null);
    expect(row!.message.length).toBe(16 * 1024);
  });

  it('returns null for empty bodies and non-message types', () => {
    expect(parseMessageContract({
      version: 2, type: 'message', action: 'A', body: '',
    }, 'tx', 0, 0, null)).toBeNull();
    expect(parseMessageContract({
      version: 2, type: 'beacon', action: 'A', body: 'should not match',
    }, 'tx', 0, 0, null)).toBeNull();
  });
});

// Beacons came through with `body.public_key` on the daemon side, but
// gridcoin-rpc applies camelcase-keys with `deep: true` to every RPC
// response — so by the time the parser sees the body the key is
// `publicKey`. The original implementation only looked at `public_key`
// and silently dropped every "add" beacon that landed during backfill;
// only revoke actions made it into the table. These tests pin the fix.
describe('parseBeaconContract', () => {
  const cpid = '0123456789abcdef0123456789abcdef';

  it('parses a v2 add (camelCased publicKey) and derives an address from the pubkey', () => {
    const contract: ContractEnvelope = {
      version: 2,
      type: 'beacon',
      action: 'A',
      body: { version: 2, cpid, publicKey: COMPRESSED_PUBKEY },
    };
    const row = parseBeaconContract(contract, 'beaconTx', 1234, 1_700_000_000);
    expect(row).not.toBeNull();
    expect(row!.cpid).toBe(cpid);
    expect(row!.txId).toBe('beaconTx');
    expect(row!.blockHeight).toBe(1234);
    expect(row!.timestamp).toBe(1_700_000_000);
    // 180-day default lifetime per BEACON_LIFETIME_SEC.
    expect(row!.expiration).toBe(1_700_000_000 + 180 * 86_400);
    // v2 (post-Fern) beacons require a verification step before going
    // active; the parser records them as pending and a downstream job
    // promotes them.
    expect(row!.status).toBe('pending');
    // Address derivation: pubkey → sha256 → ripemd160 → version-prefixed
    // base58check. The exact testnet address for the secp256k1 G is
    // deterministic, so we assert non-empty and the testnet prefix
    // (rather than pinning the literal address — which depends on the
    // explorer's VERSION_BYTE['testnet'] constant and would couple the
    // test to that table).
    expect(typeof row!.address).toBe('string');
    expect(row!.address!.length).toBeGreaterThan(0);
  });

  it('classifies pre-Fern (v1) adds as immediately active', () => {
    const contract: ContractEnvelope = {
      version: 1,
      type: 'beacon',
      action: 'A',
      body: { version: 1, cpid, publicKey: COMPRESSED_PUBKEY },
    };
    const row = parseBeaconContract(contract, 'beaconTx', 100, 1_500_000_000);
    expect(row!.status).toBe('active');
  });

  it('still accepts the snake_case public_key spelling defensively', () => {
    // The current daemon RPC client camelCases everything, but a future
    // version that stops, or a swap to a different RPC client that
    // preserves snake_case, must not silently regress beacon parsing.
    const contract: ContractEnvelope = {
      version: 2,
      type: 'beacon',
      action: 'A',
      body: { version: 2, cpid, public_key: COMPRESSED_PUBKEY },
    };
    const row = parseBeaconContract(contract, 'beaconTx', 1234, 1_700_000_000);
    expect(row).not.toBeNull();
    expect(row!.address!.length).toBeGreaterThan(0);
  });

  it('emits a revoke row for action D — no pubkey needed, address blank', () => {
    const contract: ContractEnvelope = {
      version: 2,
      type: 'beacon',
      action: 'D',
      body: { cpid },
    };
    const row = parseBeaconContract(contract, 'revokeTx', 200, 1_700_000_000);
    expect(row).not.toBeNull();
    expect(row!.status).toBe('revoked');
    expect(row!.cpid).toBe(cpid);
    expect(row!.address).toBe('');
    // Revocations carry blockTime as both timestamp and "expiration"
    // (the row exists for history; expiration on a revoked beacon is
    // semantically meaningless but the column is non-nullable).
    expect(row!.timestamp).toBe(1_700_000_000);
  });

  it('records an add with empty address when pubkey is missing — the V1-hashboinc fallback path', () => {
    // Pre-Fern beacon-loss bug fix: even without body.publicKey, we emit
    // a row (address = '' if the V1 hashboinc fallback can't synthesise
    // one either). Losing the cpid event entirely was worse — it broke
    // ~57 of ~154 testnet CPIDs. See ContractParser.parseBeaconContract.
    const contract: ContractEnvelope = {
      version: 2,
      type: 'beacon',
      action: 'A',
      body: { version: 2, cpid }, // no publicKey at all
    };
    const row = parseBeaconContract(contract, 'tx', 0, 0);
    expect(row).not.toBeNull();
    expect(row!.cpid).toBe(cpid);
    expect(row!.address).toBe('');
  });

  it('records an add with empty address when pubkey is malformed (non-hex)', () => {
    // Same V1-fallback path as above. A malformed pubkey can't derive
    // an address; the row is still emitted with address = '' rather
    // than dropped, matching the production semantics.
    const contract: ContractEnvelope = {
      version: 2,
      type: 'beacon',
      action: 'A',
      body: { version: 2, cpid, publicKey: 'not-a-valid-pubkey' },
    };
    const row = parseBeaconContract(contract, 'tx', 0, 0);
    expect(row).not.toBeNull();
    expect(row!.cpid).toBe(cpid);
    expect(row!.address).toBe('');
  });

  it('returns null for non-beacon contract types', () => {
    expect(parseBeaconContract({
      version: 2, type: 'poll', action: 'A', body: { cpid, publicKey: COMPRESSED_PUBKEY },
    }, 'tx', 0, 0)).toBeNull();
  });

  it('returns null when cpid is missing', () => {
    expect(parseBeaconContract({
      version: 2, type: 'beacon', action: 'A', body: { publicKey: COMPRESSED_PUBKEY },
    }, 'tx', 0, 0)).toBeNull();
  });
});

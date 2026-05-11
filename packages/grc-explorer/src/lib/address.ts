import { createHash } from 'node:crypto';

/**
 * Pubkey → Gridcoin address derivation.
 *
 * Standard Bitcoin-derivative algorithm:
 *   1. SHA-256 over the raw pubkey bytes
 *   2. RIPEMD-160 over step 1's output (the "hash160")
 *   3. Prepend the network-specific version byte
 *   4. Append the first 4 bytes of double-SHA-256 over (version + hash160)
 *      — the Base58Check checksum
 *   5. Base58 encode the resulting 25 bytes
 *
 * Used by the indexer to derive a beacon's address from the pubkey
 * the daemon emits in BeaconToJson — the daemon doesn't include the
 * address in the contract payload, so the block-walker computes it.
 *
 * Gridcoin address version bytes (from chainparams.cpp):
 *   - Mainnet PUBKEY_ADDRESS = 62 → addresses start with 'S'
 *   - Testnet PUBKEY_ADDRESS = 111 → addresses start with 'm'/'n'
 *     (same as Bitcoin testnet)
 */

export type Network = 'mainnet' | 'testnet';

// Pubkey-hash (P2PKH) version bytes from src/chainparams.cpp.
const PUBKEY_VERSION_BYTE: Record<Network, number> = {
  mainnet: 62,
  testnet: 111,
};

// Script-hash (P2SH) version bytes from src/chainparams.cpp. No P2SH
// outputs currently exist on chain, but `isValidAddress` accepts them
// so a future P2SH-using payload doesn't get silently rejected.
const SCRIPT_VERSION_BYTE: Record<Network, number> = {
  mainnet: 85,
  testnet: 196,
};

// Back-compat alias for the original PUBKEY-only export name.
const VERSION_BYTE = PUBKEY_VERSION_BYTE;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX = new Map<string, number>(
  Array.from(BASE58_ALPHABET, (c, i) => [c, i]),
);

/**
 * Derive a P2PKH address from the hex-encoded public key the daemon
 * emits in beacon contract bodies. Returns null if the input doesn't
 * look like a hex pubkey — caller should treat that as "skip this row"
 * rather than asserting (one malformed contract shouldn't crash the
 * whole indexer pass).
 */
export function pubkeyToAddress(pubkeyHex: string, network: Network): string | null {
  if (!pubkeyHex || typeof pubkeyHex !== 'string') return null;
  // Pubkeys are hex; reject anything else early so a typo'd contract
  // body doesn't end up in CH as a malformed address.
  if (!/^[0-9a-fA-F]+$/.test(pubkeyHex)) return null;
  // 33 bytes (compressed) or 65 bytes (uncompressed). Anything else
  // isn't a real secp256k1 pubkey.
  if (pubkeyHex.length !== 66 && pubkeyHex.length !== 130) return null;

  const pubkey = Buffer.from(pubkeyHex, 'hex');
  const sha = createHash('sha256').update(pubkey).digest();
  const hash160 = createHash('ripemd160').update(sha).digest();

  const versionByte = VERSION_BYTE[network];
  const versioned = Buffer.concat([Buffer.from([versionByte]), hash160]);
  const checksum = createHash('sha256')
    .update(createHash('sha256').update(versioned).digest())
    .digest()
    .subarray(0, 4);
  const payload = Buffer.concat([versioned, checksum]);

  return base58Encode(payload);
}

/**
 * Standard Base58 encoding (Bitcoin alphabet, no padding). Treats the
 * input as a big-endian integer; leading zero bytes encode as '1'.
 *
 * Pure-JS implementation rather than a dep — the algorithm is short,
 * stable since 2009, and avoids a transitive supply-chain risk on the
 * indexer's hot path.
 */
function base58Encode(bytes: Buffer): string {
  if (bytes.length === 0) return '';

  // Count leading zero bytes — each becomes a '1' in the output.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;

  // Convert to base 58 via repeated division. Using BigInt keeps the
  // implementation trivial (no manual bignum); the input is at most
  // 25 bytes for an address payload, so performance is fine.
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);

  const out: string[] = [];
  while (n > 0n) {
    const r = Number(n % 58n);
    n /= 58n;
    out.push(BASE58_ALPHABET[r]);
  }
  for (let i = 0; i < zeros; i += 1) out.push('1');

  return out.reverse().join('');
}

/**
 * Decode a Base58Check string and verify its trailing 4-byte checksum.
 * Returns `{ version, hash160 }` on success, `null` on any decode or
 * checksum failure. Same algorithm as Bitcoin / Gridcoin uses — leading
 * '1' chars decode to zero bytes, the rest are bignum-converted, and
 * the last 4 bytes must equal the first 4 bytes of double-SHA256 over
 * the remainder.
 */
function base58CheckDecode(s: string): { version: number; hash160: Buffer } | null {
  if (!s || typeof s !== 'string') return null;

  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros += 1;

  let n = 0n;
  for (let i = zeros; i < s.length; i += 1) {
    const idx = BASE58_INDEX.get(s[i]);
    if (idx === undefined) return null;
    n = n * 58n + BigInt(idx);
  }

  const bytes: number[] = [];
  while (n > 0n) {
    bytes.push(Number(n & 0xffn));
    n >>= 8n;
  }
  for (let i = 0; i < zeros; i += 1) bytes.push(0);
  bytes.reverse();
  const buf = Buffer.from(bytes);

  // Address payloads are 1 version byte + 20 hash bytes + 4 checksum bytes = 25.
  if (buf.length !== 25) return null;

  const payload = buf.subarray(0, 21);
  const checksum = buf.subarray(21, 25);
  const expected = createHash('sha256')
    .update(createHash('sha256').update(payload).digest())
    .digest()
    .subarray(0, 4);
  if (!checksum.equals(expected)) return null;

  return { version: payload[0], hash160: payload.subarray(1) };
}

/**
 * True if `s` is a syntactically-valid Gridcoin address (P2PKH or P2SH)
 * for the given network — checksum verified, version byte recognised.
 * Use this on any address string the explorer didn't itself derive (e.g.
 * V1-beacon legacy payloads, user input) before persisting.
 */
export function isValidAddress(s: string, network: Network): boolean {
  const decoded = base58CheckDecode(s);
  if (!decoded) return false;
  return (
    decoded.version === PUBKEY_VERSION_BYTE[network]
    || decoded.version === SCRIPT_VERSION_BYTE[network]
  );
}

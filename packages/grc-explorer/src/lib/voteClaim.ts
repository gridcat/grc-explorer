import { createHash, createPublicKey, verify } from 'node:crypto';
import { Network, pubkeyToAddress } from './address';

// Verification of the balance claims inside a Gridcoin vote contract.
//
// A balance-weighted vote carries one AddressClaim per wallet address
// holding coins at vote time: { public key, signature, claimed
// outpoints } (src/gridcoin/voting/claims.h). Each signature commits to
// the vote's poll, its responses, the tx's nTime and every vin prevout
// (PackVoteMessage, voting/result.cpp), so a claim can't be lifted into
// another tx. A verified claim proves that whoever built this tx held
// that address's key, so the co-ownership is certain rather than
// inferred.
//
// Vote claims are NOT consensus-checked (PollRegistry::Validate returns
// true for votes; the wallet verifies at tally time), so anything read
// off-chain must pass verifyAddressClaim before it is trusted.
//
// The daemon's block JSON omits the claim; `getvotingclaim <txid>`
// returns it, and gridcoin-rpc camelCases the keys on the way through
// (`balance_claim` → `balanceClaim`, `public_key` → `publicKey`), which
// is the RpcVoteClaim shape below. The library's own VotingClaim type
// (`addressClaim`) doesn't match what arrives.

export interface RpcAddressClaim {
  publicKey: string;
  signature: string;
  outpoints: Array<{ txid: string; offset: number }>;
}

export interface RpcVoteClaim {
  version?: number;
  balanceClaim?: RpcAddressClaim[];
}

export interface Outpoint {
  txid: string;
  n: number;
}

export interface VoteMessageInput {
  pollTxid: string;
  responses: number[]; // choice offsets in the order the vote lists them
  nTime: number; // tx nTime (transactions.time), not the block time
  prevouts: Outpoint[]; // every vin prevout, in vin order
}

// SPKI DER prefixes wrapping a raw secp256k1 point so node:crypto can
// import it (compressed 33 B / uncompressed 65 B).
const SPKI_PREFIX_33 = Buffer.from('3036301006072a8648ce3d020106052b8104000a032200', 'hex');
const SPKI_PREFIX_65 = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');

const sha256 = (b: Buffer): Buffer => createHash('sha256').update(b).digest();

// Bitcoin CompactSize.
function compactSize(n: number): Buffer {
  if (n < 0xfd) return Buffer.from([n]);
  if (n <= 0xffff) {
    const b = Buffer.alloc(3);
    b[0] = 0xfd;
    b.writeUInt16LE(n, 1);
    return b;
  }
  const b = Buffer.alloc(5);
  b[0] = 0xfe;
  b.writeUInt32LE(n, 1);
  return b;
}

const isHash = (s: string): boolean => /^[0-9a-fA-F]{64}$/.test(s);

// uint256 serializes as its raw bytes: the reverse of the display hex.
function serializeOutpoint(o: Outpoint): Buffer {
  const n = Buffer.alloc(4);
  n.writeUInt32LE(o.n);
  return Buffer.concat([Buffer.from(o.txid, 'hex').reverse(), n]);
}

export function packVoteMessage(m: VoteMessageInput): Buffer {
  const nTime = Buffer.alloc(4);
  nTime.writeUInt32LE(m.nTime);
  return Buffer.concat([
    Buffer.from(m.pollTxid, 'hex').reverse(),
    compactSize(m.responses.length),
    Buffer.from(m.responses),
    nTime,
    ...m.prevouts.map(serializeOutpoint),
  ]);
}

// HashClaim (claims.cpp): double-SHA256 of `message << outpoints`, where
// both are length-prefixed vectors. Verifies with the claim's own key;
// node:crypto applies the second SHA-256 itself, so it gets the first.
export function verifyAddressClaim(claim: RpcAddressClaim, message: Buffer): boolean {
  try {
    const pub = Buffer.from(claim.publicKey, 'hex');
    let prefix: Buffer;
    if (pub.length === 33) prefix = SPKI_PREFIX_33;
    else if (pub.length === 65) prefix = SPKI_PREFIX_65;
    else return false;
    if (!Array.isArray(claim.outpoints) || claim.outpoints.length === 0) return false;
    if (!claim.outpoints.every((o) => isHash(o.txid) && Number.isInteger(o.offset))) return false;

    const payload = Buffer.concat([
      compactSize(message.length),
      message,
      compactSize(claim.outpoints.length),
      ...claim.outpoints.map((o) => serializeOutpoint({ txid: o.txid, n: o.offset })),
    ]);
    const key = createPublicKey({
      key: Buffer.concat([prefix, pub]), format: 'der', type: 'spki',
    });
    return verify('sha256', sha256(payload), key, Buffer.from(claim.signature, 'hex'));
  } catch {
    // Malformed key / signature bytes → not a valid claim.
    return false;
  }
}

// Responses are stored per choice without their position in the vote,
// so the original order is recovered by trying candidates: ascending
// first (what the GUI produces), then every permutation for small
// multi-choice votes. A vote whose order isn't found yields no links.
const MAX_PERMUTED_RESPONSES = 5;

function* responseOrders(sortedChoices: number[]): Generator<number[]> {
  yield sortedChoices;
  if (sortedChoices.length < 2 || sortedChoices.length > MAX_PERMUTED_RESPONSES) return;
  const permute = function* permute(rest: number[], acc: number[]): Generator<number[]> {
    if (rest.length === 0) {
      yield acc;
      return;
    }
    for (let i = 0; i < rest.length; i += 1) {
      yield* permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]]);
    }
  };
  for (const p of permute(sortedChoices, [])) {
    if (p.some((v, i) => v !== sortedChoices[i])) yield p;
  }
}

// Addresses of every claim in the vote that verifies. The first claim
// fixes the response order (all claims sign the same message); the
// rest are checked against that message. Returns [] when no claim
// verifies under any candidate order.
export function verifiedClaimAddresses(
  claim: RpcVoteClaim,
  vote: Omit<VoteMessageInput, 'responses'> & { choices: number[] },
  network: Network,
): string[] {
  const claims = Array.isArray(claim.balanceClaim) ? claim.balanceClaim : [];
  if (claims.length === 0 || !isHash(vote.pollTxid)) return [];
  const sorted = [...vote.choices].sort((a, b) => a - b);
  for (const responses of responseOrders(sorted)) {
    const message = packVoteMessage({ ...vote, responses });
    const valid = claims.filter((c) => verifyAddressClaim(c, message));
    if (valid.length > 0) {
      const addresses = valid
        .map((c) => pubkeyToAddress(c.publicKey, network))
        .filter((a): a is string => a !== null);
      return [...new Set(addresses)];
    }
  }
  return [];
}

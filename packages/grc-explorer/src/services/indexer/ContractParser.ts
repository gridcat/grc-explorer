import { config } from '../../config';
import { grc2halford, sumHalford } from '../../lib/halford';
import { isValidAddress, pubkeyToAddress } from '../../lib/address';
import { log } from '../../lib/log';
import {
  ContractEnvelope, VerboseBlock, BlockTx, Vout,
} from './types';

/**
 * Pure transformation: a verbose=2 block + the prev-tx address/value
 * lookup table → flat row sets ready for Prisma. No I/O lives here so
 * the parser is unit-testable against fixture JSON without touching
 * the daemon or the database.
 *
 * Input vin address resolution (`prevOutputs`) is supplied by the
 * caller — during forward-only backfill it's a single SQL JOIN against
 * tx_outputs; for mempool we fall back to getrawtransaction.
 */

export type PrevOutputsLookup = (prevTx: string, prevVout: number) => { address: string | null; value: bigint } | null;

// Wallet sentinels emitted by `MiningId::ToString()` (src/gridcoin/cpid.cpp)
// for a claim that carries no CPID. Pre-fern blocks emit "INVESTOR";
// post-fern blocks emit "NONCRUNCHER". Any claim whose miningId matches
// must store a NULL cpid downstream — otherwise the literal sentinel
// ends up in the `cpid` column and the staker is misclassified as a
// researcher. Direct literal compare keeps the indexer hot path tight
// (~3M claims during a full backfill).
function isNoncruncherMiningId(miningId: string | null | undefined): boolean {
  return miningId === 'INVESTOR' || miningId === 'NONCRUNCHER';
}

export interface ParsedBlock {
  block: ParsedBlockRow;
  transactions: ParsedTransactionRow[];
  txOutputs: ParsedTxOutputRow[];
  txInputs: ParsedTxInputRow[];
  /** Per-address net delta for this block. Apply atomically to addresses + address_tx. */
  addressDeltas: Map<string, AddressDelta>;
  claim?: ParsedClaimRow;
  /** Per-CPID MRC payouts in v12+ blocks (empty otherwise). */
  claimMrcs: ParsedClaimMrcRow[];
  /** MRC request txs found in this block (the tx side, not the
   *  payout side — pair with `claimMrcs` via cpid + block_height). */
  mrcRequests: ParsedMrcRequestRow[];
  superblock?: ParsedSuperblockRow;
  superblockMagnitudes: ParsedSuperblockMagnitudeRow[];
  /** Per-project RAC breakdown for this superblock. */
  superblockProjects: ParsedSuperblockProjectRow[];
  beacons: ParsedBeaconRow[];
  polls: ParsedPollRow[];
  votes: ParsedVoteRow[];
  messages: ParsedMessageRow[];
  projectContracts: ParsedProjectContractRow[];
  /** On-chain mandatory-sidestake events (ADD/REMOVE) — protocol-
   *  driven allocations of a fraction of the CoinStake reward to
   *  designated addresses (Gridcoin Foundation etc.), activated at
   *  V13. Empty on pre-V13 blocks. */
  sidestakeContracts: ParsedSidestakeContractRow[];
  /** Coinstake vouts at index >= 2 on V13+ PoS blocks. These are the
   *  raw "extra outputs" on a coinstake; whether each one is an MSS
   *  payout vs a local-sidestake is determined at query time by
   *  joining the address against the mandatory_sidestakes registry.
   *  Empty on pre-V13 blocks (the daemon rejects MSS contracts so
   *  the registry there is empty anyway). */
  coinstakeSidestakes: ParsedCoinstakeSidestakeRow[];
  /** On-chain protocol-registry events (ADD/REMOVE) — the source of
   *  truth for any V13+ `magnitudeweightfactor` lookup the poll
   *  aggregator does. */
  protocolEntries: ParsedProtocolEntryRow[];
  /** Net contributions toward the metric_buckets rollup. */
  metrics: ParsedMetricsContribution;
}

export interface ParsedClaimMrcRow {
  blockHeight: number;
  cpid: string;
  miningId: string;
  clientVersion: string;
  researchSubsidy: bigint;
  magnitude: number;
  payToAddress: string | null;
}

// One row per MRC request transaction. Pending while the tx sits in
// mempool (block_height/blockTime null), confirmed when the carrying
// block lands.
export interface ParsedMrcRequestRow {
  txId: string;
  // m_version of the MRC body (1 today; future-versioned).
  version: number;
  cpid: string;
  clientVersion: string;
  organization: string;
  researchSubsidy: bigint;
  feeOffered: bigint;
  magnitude: number;
  magnitudeUnit: number;
  lastBlockHash: string;
  // Base64 ECDSA signature the wallet emits in MRCToJson.
  signature: string;
  payToAddress: string | null;
  firstSeen: number;
  blockHeight: number | null;
  blockTime: number | null;
}

export interface ParsedBlockRow {
  height: number;
  hash: string;
  prevHash: string;
  merkleRoot: string;
  time: number;
  nVersion: number;
  difficulty: string;
  size: number;
  txCount: number;
  isPos: boolean;
  minerAddress: string | null;
  stakerCpid: string | null;
  isSuperblock: boolean;
  /** Halford. Per-block emission. */
  mint: bigint;
  /** Halford. Cumulative supply at this block. */
  moneySupply: bigint;
  /** PoW nonce. Meaningless for PoS blocks (zero or unset upstream)
   *  but captured for early-chain forensics. */
  nonce: number;
  /** Compact difficulty as the daemon's "%08x" hex form. The derived
   *  `difficulty` Float64 already in this row is the human view; this
   *  is the canonical consensus representation. */
  bits: string;
}

export interface ParsedTransactionRow {
  txId: string;
  blockHeight: number;
  blockHash: string;
  time: number;
  size: number;
  fee: bigint;
  vinCount: number;
  voutCount: number;
  totalIn: bigint;
  totalOut: bigint;
  isCoinbase: boolean;
  isCoinstake: boolean;
  indexInBlk: number;
  /** Daemon-supplied BOINC proof hash; null when the tx isn't a
   *  researcher coinstake (the daemon returns an empty string or
   *  all-zeros in that case). */
  hashboinc: string | null;
  /** tx.nVersion. 1 today on most txs; V14-aware wallets emit 2,
   *  which is what enables BIP68 sequence-lock validation on the
   *  vin's nSequence. */
  nVersion: number;
  /** tx.nLockTime. 0 = no lock (vast majority); non-zero combined
   *  with a BIP65 OP_CHECKLOCKTIMEVERIFY in the script = locked. */
  nLockTime: number;
}

export interface ParsedTxOutputRow {
  txId: string;
  voutN: number;
  value: bigint;
  address: string | null;
  scriptType: string;
  scriptHex: string;
  /** Multisig threshold the daemon's scriptPubKey JSON exposes for
   *  P2SH / native multisig (`reqSigs`). 0 when the script isn't
   *  multisig — single-sig P2PKH, OP_RETURN, etc. */
  reqSigs: number;
}

export interface ParsedTxInputRow {
  txId: string;
  vinN: number;
  prevTx: string;
  prevVout: number;
  address: string | null;
  value: bigint | null;
  /** Raw scriptSig hex from the daemon's vin.scriptSig.hex. For
   *  P2SH-wrapped outputs (HTLCs, multisigs, anything that hides a
   *  redeemScript) the *last push* of this hex IS the redeemScript,
   *  which is where V14 HTLC bytes (OP_CLTV = 0xb1, OP_CSV = 0xb2)
   *  surface. Empty when the daemon didn't emit (coinbase inputs,
   *  some witness-only paths, anything pre-feature-deploy). */
  scriptSigHex: string;
  /** nSequence per BIP68. 0xffffffff = "no sequence lock" (default).
   *  Any other value on a V14+ tx means sequence-locked. Captured
   *  so the tx detail page can flag locked inputs once V14 is live. */
  sequence: number;
  // True when this vin re-claims a UTXO already spent by an earlier
  // tx (Halford-era kernel-reuse coinstakes are the known case). Set
  // by PhantomSpendDetector between parseBlock and applyBlocks; the
  // debit is cancelled in the block's addressDeltas at the same time
  // so address_balance_history stays consistent with the daemon's
  // UTXO-set view.
  isPhantomSpend?: boolean;
}

export interface AddressDelta {
  address: string;
  delta: bigint;
  received: bigint;
  sent: bigint;
  txIds: Set<string>;
}

export interface ParsedClaimRow {
  blockHeight: number;
  cpid: string | null;
  miningId: string;
  clientVersion: string;
  organization: string;
  blockSubsidy: bigint;
  researchSubsidy: bigint;
  magnitude: number;
  magnitudeUnit: number;
  quorumHash: string | null;
  quorumAddress: string | null;
  signature: string;
  isMrc: boolean;
  mrcTxMapSize: number;
  // Per-block split of all bundled MRCs' bid fees: foundation share
  // (chain-defined) + staker incentive. Both halford. Zero on
  // pre-MRC blocks and on MRC-eligible blocks that bundled none.
  mrcFoundationFees: bigint;
  mrcStakerFees: bigint;
}

export interface ParsedSuperblockRow {
  height: number;
  quorumHash: string;
  totalMagnitude: number;
  cpidCount: number;
  projectCount: number;
  payloadSize: number;
  /** Superblock contract version from the daemon's SuperblockToJson
   *  (`m_version`, src/rpc/blockchain.cpp). v3 (activated at V13)
   *  carries per-project all-CPID total_credit needed for the
   *  AutoGreylist Zero-Credit-Days math. Older superblocks emit
   *  v1/v2 — we still index them, just without that field populated. */
  contractVersion: number;
}

export interface ParsedSuperblockMagnitudeRow {
  superblockHeight: number;
  cpid: string;
  magnitude: number;
}

export interface ParsedSuperblockProjectRow {
  superblockHeight: number;
  projectName: string;
  averageRac: number;
  rac: number;
  totalCredit: number;
}

export interface ParsedBeaconRow {
  cpid: string;
  address: string;
  status: 'pending' | 'active' | 'expired' | 'revoked';
  txId: string;
  blockHeight: number;
  timestamp: number;
  expiration: number;
  /** Auth method derived from the BeaconPayload `m_version` field
   *  (daemon's BeaconToJson at src/rpc/rawtransaction.cpp:~146):
   *    v1 → 'legacy'             (pre-Fern, hashboinc-derived address)
   *    v2 → 'v2_email_verify'    (Fern, email-verification flow)
   *    v3 → 'v3_boinc_signed'    (V14, RSA-SHA512 ownership proof)
   *    *  → 'unknown'
   *  Distinct from the contract-envelope version (which is the
   *  outer Contract::m_version). For beacons the two usually track
   *  each other but the source of truth for "what auth backed this
   *  beacon" is the inner BeaconPayload version. */
  authMethod: 'legacy' | 'v2_email_verify' | 'v3_boinc_signed' | 'unknown';
}

export interface ParsedProjectContractRow {
  projectName: string;
  /// 'add' on whitelist registration; 'remove' on de-list. Lower-case
  /// terminal values for table-friendly enum semantics.
  action: 'add' | 'remove';
  baseUrl: string;
  contractVersion: number;
  txId: string;
  blockHeight: number;
  time: number;
}

/**
 * A single coinstake vout at index ≥ 2 on a V13+ PoS block. The
 * indexer captures these unconditionally for V13+ PoS blocks; the
 * MSS-payout view in the API is built by joining `coinstake_sidestakes`
 * against `mandatory_sidestakes FINAL WHERE status='MANDATORY' AND
 * block_height <= the payout's height`. Outputs that don't match
 * the registry are local (voluntary) sidestakes — also useful, hence
 * the "capture all extras, classify at read time" approach.
 */
export interface ParsedCoinstakeSidestakeRow {
  blockHeight: number;
  voutIdx: number;
  txId: string;
  address: string;
  amount: bigint;
  time: number;
}

/**
 * On-chain mandatory-sidestake event. The Gridcoin daemon's
 * SideStakePayloadToJson (src/rpc/rawtransaction.cpp) emits the body as
 * `{ address, allocation, description, status }`, where `allocation` is
 * a percent (Allocation::ToPercent()) and `status` is the stringified
 * MandatorySideStakeStatus enum ('MANDATORY' or 'DELETED'). Action `A`
 * is an add/update of the registry entry; `D` is a removal.
 */
export interface ParsedSidestakeContractRow {
  address: string;
  /// 'A' (add/update) or 'D' (delete) — raw contract action code.
  action: 'A' | 'D';
  /// Daemon-stringified status. 'MANDATORY' on add, 'DELETED' on
  /// remove. Stored as-is so the table mirrors what the chain says
  /// rather than our interpretation.
  status: 'MANDATORY' | 'DELETED';
  /// Percent of CoinStake reward to allocate. 25.0 = 25%. Sum across
  /// all active entries is capped at 25% by consensus.
  allocationPct: number;
  description: string;
  contractVersion: number;
  txId: string;
  blockHeight: number;
  time: number;
}

/**
 * On-chain protocol-registry event. The wallet's `ProtocolRegistry`
 * (src/gridcoin/protocol.cpp) replays every ADD/REMOVE in chain order
 * to maintain a key→value map. The most audit-relevant key for the
 * explorer is `magnitudeweightfactor` (V13+ poll weighting factor).
 */
export interface ParsedProtocolEntryRow {
  key: string;
  value: string;
  /// ACTIVE on add, DELETED on remove — matches the wallet's
  /// `ProtocolEntryStatus` enum string names.
  status: 'ACTIVE' | 'DELETED';
  contractVersion: number;
  txId: string;
  previousHash: string;
  blockHeight: number;
  time: number;
}

export interface ParsedPollRow {
  pollId: string;
  title: string;
  question: string;
  url: string | null;
  pollType: string | null;
  responseType: string;
  weightType: string;
  startTime: number;
  endTime: number;
  claimTx: string;
  blockHeight: number;
  /// Resolved from the poll-creation tx's first vin via the parser's
  /// `prevOutputs` lookup. Null only if the lookup failed (rare).
  creatorAddress: string | null;
  options: Array<{ idx: number; label: string }>;
}

export interface ParsedVoteRow {
  /**
   * For post-fern (v2+) votes this is the poll txid the voter chose, set
   * directly from the contract body. For legacy (v1) votes the body
   * carries only the lowercased poll *title* (in `legacyTitleKey`); the
   * poll_id is resolved by `BlockWriter` against our `polls` table — if
   * the resolution misses (poll not yet indexed at write time), the row
   * is skipped and the next backfill / `PollRescanner` pass will pick
   * it up.
   */
  pollId: string | null;
  /** Lowercase poll title — set for legacy votes only. Null for post-fern. */
  legacyTitleKey: string | null;
  voterAddress: string;
  /// CPID for legacy votes (carried in the contract body). Post-fern
  /// votes leave this null and rely on the post-commit `getvotingclaim`
  /// enrichment job.
  voterCpid: string | null;
  miningId: string | null;
  /** Numeric idx for post-fern votes. -1 when we have only label text (legacy). */
  choiceIdx: number;
  /** Lowercase choice label — populated for legacy votes whose body only carries label strings. */
  choiceLabel: string | null;
  weight: bigint;
  /** Per-vote balance the voter declared at the time of casting. Halford. Legacy only. */
  weightBalance: bigint;
  /** Per-vote magnitude the voter declared at the time of casting. Legacy only. */
  weightMagnitude: number;
  txId: string;
  blockHeight: number;
}

export interface ParsedMessageRow {
  txId: string;
  blockHeight: number;
  time: number;
  senderAddress: string | null;
  message: string;
}

export interface ParsedMetricsContribution {
  txCount: number;
  valueMoved: bigint;
  feeTotal: bigint;
  blockCount: number;
  researchSubsidy: bigint;
  blockSubsidy: bigint;
  newBeacons: number;
  isResearcherBlock: boolean;
  isInvestorBlock: boolean;
  activeAddresses: number;
}

// Lowercased to match `Contract::Type::ToString` (contract.cpp:785).
const POLL_TYPE = 'poll';
const VOTE_TYPE = 'vote';
const BEACON_TYPE = 'beacon';
const MESSAGE_TYPE = 'message';
const PROJECT_TYPE = 'project';
const MRC_TYPE = 'mrc';
const PROTOCOL_TYPE = 'protocol';
const SIDESTAKE_TYPE = 'sidestake';

// MySQL TEXT can hold ~64KB; on-chain message contracts can be at most
// the size of a tx contract field but we still cap to keep the row size
// reasonable and avoid blowing the row limit on weird oversized blobs.
const MESSAGE_MAX_LEN = 16 * 1024;

const ADD_ACTION = 'A'; // contract action codes per Gridcoin source
const REMOVE_ACTION = 'D';

// Mirrors Gridcoin's PollWeightType / PollResponseType / PollType enums in
// `voting/fwd.h`, paired with the human-readable strings emitted by
// `Poll::WeightTypeToString` / `Poll::ResponseTypeToString` / the
// untranslated branch of `Poll::PollTypeToString` in `voting/poll.cpp`.
// `listpolls` returns the strings; block contracts return the ints — we
// normalise to the string form here so both code paths produce identical
// `polls.weight_type` / `polls.response_type` values.
// Named exports tied 1:1 to the canonical Gridcoin `PollWeightType`
// enum (src/gridcoin/voting/fwd.h). Consumers branch on these instead
// of inline string literals so a future rename here is a compile error
// across the codebase rather than a silently-broken switch arm.
export const WEIGHT_TYPE = {
  MAGNITUDE: 'Magnitude',
  BALANCE: 'Balance',
  MAGNITUDE_PLUS_BALANCE: 'Magnitude+Balance',
  CPID_COUNT: 'CPID Count',
  PARTICIPANT_COUNT: 'Participant Count',
} as const;

const POLL_WEIGHT_TYPES: readonly string[] = [
  '',
  WEIGHT_TYPE.MAGNITUDE,
  WEIGHT_TYPE.BALANCE,
  WEIGHT_TYPE.MAGNITUDE_PLUS_BALANCE,
  WEIGHT_TYPE.CPID_COUNT,
  WEIGHT_TYPE.PARTICIPANT_COUNT,
];
const POLL_RESPONSE_TYPES: readonly string[] = [
  '', 'Yes/No/Abstain', 'Single Choice', 'Multiple Choice',
];
const POLL_TYPES: readonly string[] = [
  '', 'Survey', 'Project Listing', 'Protocol Development', 'Governance', 'Marketing', 'Outreach', 'Community',
];

function pollWeightTypeName(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && raw >= 0 && raw < POLL_WEIGHT_TYPES.length) {
    return POLL_WEIGHT_TYPES[raw];
  }
  return '';
}

function pollResponseTypeName(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' && raw >= 0 && raw < POLL_RESPONSE_TYPES.length) {
    return POLL_RESPONSE_TYPES[raw];
  }
  return '';
}

function pollTypeName(raw: unknown): string | null {
  if (typeof raw === 'string') return raw || null;
  if (typeof raw === 'number' && raw >= 0 && raw < POLL_TYPES.length) {
    const name = POLL_TYPES[raw];
    return name || null;
  }
  return null;
}

function pickPrimaryAddress(vout: Vout): string | null {
  const addrs = vout.scriptPubKey.addresses;
  if (addrs && addrs.length > 0) return addrs[0];
  return null;
}

function isCoinbaseTx(tx: BlockTx): boolean {
  return tx.vin.length === 1 && typeof tx.vin[0].coinbase === 'string';
}

const ZERO_HASH_64 = '0'.repeat(64);
const HEX_64_RE = /^[0-9a-f]{64}$/;

function resolvePrevHash(block: VerboseBlock): string {
  if (block.height === 0) return ZERO_HASH_64;
  return HEX_64_RE.test(block.previousblockhash ?? '')
    ? block.previousblockhash!
    : ZERO_HASH_64;
}

/**
 * True when the block's daemon-emitted `flags` string asserts PoS. The
 * wallet sets this from `block.IsProofOfStake()` (rpc/blockchain.cpp),
 * which is the canonical source of truth — preferring this over the
 * presence of `block.signature` avoids the failure mode where an empty
 * signature ('' vs absent) on a PoS block silently misclassifies.
 */
function blockFlagsAssertPoS(flags: string | undefined): boolean {
  return typeof flags === 'string' && flags.includes('proof-of-stake');
}

/**
 * Coinstake-shape check (matches Gridcoin C++ `IsCoinStake`): tx[1]
 * with `vout[0].value === 0` followed by the staker payout(s). This
 * is the shape used post-PoSv2; pre-PoSv2 / pre-Fern testnet blocks
 * may not match. The caller cross-checks against `block.flags` so a
 * shape mismatch on a PoS-flagged block still gets classified.
 */
function hasCoinstakeShape(tx: BlockTx, indexInBlock: number): boolean {
  if (indexInBlock !== 1) return false;
  if (tx.vin.length === 0) return false;
  if (tx.vout.length < 2) return false;
  return tx.vout[0].value === 0;
}

/**
 * Accumulate one input/output leg into an address's running delta.
 *
 * `countInOut` toggles the received/sent side. Normally true: every
 * output to the address adds to `received`, every input adds to `sent`
 * (the standard explorer convention, which counts change). False for
 * coinstake legs: a coinstake recirculates the staker's own principal
 * back to the same address every block it stakes, so counting it gross
 * would book the whole stake as both received and sent on every stake
 * and inflate a long-running staker's lifetime totals into the
 * millions. Coinstake received/sent are instead applied once, netted
 * per address, after the leg walk. `delta` (the true balance) is the
 * same either way — only the received/sent view differs.
 */
function bumpDelta(
  map: Map<string, AddressDelta>,
  address: string | null,
  signedDelta: bigint,
  txId: string,
  isReceive: boolean,
  countInOut: boolean = true,
): void {
  if (!address) return;
  let entry = map.get(address);
  if (!entry) {
    entry = {
      address,
      delta: 0n,
      received: 0n,
      sent: 0n,
      txIds: new Set(),
    };
    map.set(address, entry);
  }
  entry.delta += signedDelta;
  if (countInOut) {
    if (isReceive) entry.received += signedDelta > 0n ? signedDelta : 0n;
    else entry.sent += signedDelta < 0n ? -signedDelta : 0n;
  }
  entry.txIds.add(txId);
}

// Beacon lifecycle constants from src/gridcoin/beacon.h (verbatim
// arithmetic): MAX_AGE is the total lifetime, RENEWAL_AGE is when the
// renewable window opens (the owner can submit a renewal contract
// without re-advertising), RETENTION_AGE applies to PendingBeacon
// rows that didn't get verified by the next superblock and should be
// dropped. The daemon's BeaconToJson doesn't emit an explicit
// expiration so we compute it from registration block time.
//
// Pre-v11 beacons (`contract.version <= 1`) cannot be renewed at all
// per the wallet's `beacon.cpp:~869` guard — they must be entirely
// re-advertised. The explorer doesn't currently surface a "renewable"
// state in the routes, so RENEWAL_AGE / RETENTION_AGE are defined
// here for future use by /beacons UI work without forcing a second
// constants pass.
export const BEACON_MAX_AGE_SEC = 60 * 60 * 24 * 30 * 6; // 15,552,000s ≈ 180d
export const BEACON_RENEWAL_AGE_SEC = 60 * 60 * 24 * 30 * 5; // 12,960,000s ≈ 150d
export const BEACON_RETENTION_AGE_SEC = 60 * 60 * 24 * 3; // 259,200s = 3d

// Pre-Fern (V1) beacons live on-chain in the legacy hashboinc payload
// as `BASE64(HEX(CPIDV2);HEX(RANDOM);BASE58(ADDRESS)[;HEX(PUBKEY)])`.
// The daemon's BeaconToJson emits an empty `public_key` for these
// because its parser only retains the optional 4th segment — the
// address (segment 2) is dropped server-side. To preserve V1 beacons
// in the index we recover the address directly from hashboinc.
const MV_PATTERN = /<MV>([^<]+)<\/MV>/;

function parseLegacyV1Address(hashboinc: string): string | null {
  const m = hashboinc.match(MV_PATTERN);
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1], 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = decoded.split(';');
  if (parts.length < 3) return null;
  const candidate = parts[2];
  // Full Base58Check validation — checksum + version byte. Without
  // this a malformed V1 payload would land in CH with a syntactically
  // valid-looking address that can't be looked up against any wallet.
  if (!isValidAddress(candidate, config.NETWORK)) return null;
  return candidate;
}

export function parseBeaconContract(
  contract: ContractEnvelope,
  txId: string,
  blockHeight: number,
  blockTime: number,
  hashboinc: string | null,
): ParsedBeaconRow | null {
  if (contract.type !== BEACON_TYPE) return null;

  // Daemon's BeaconToJson (rawtransaction.cpp ~140) emits the body as
  // `{ version, cpid, public_key }` for `add` actions; revocations
  // carry only the cpid. The address is not in the payload — for V2+
  // we derive it from the pubkey, for V1 we recover it from hashboinc.
  //
  // Important: gridcoin-rpc applies `camelcase-keys` with `deep: true`
  // to every response (see node_modules/gridcoin-rpc/dist/RPCBase.js),
  // so the daemon's snake_case `public_key` arrives at this layer as
  // `publicKey`. We accept both spellings defensively in case a future
  // gridcoin-rpc version stops camelcasing or a different RPC client
  // is swapped in.
  const body = contract.body as {
    cpid?: string;
    publicKey?: string;
    public_key?: string;
    version?: number;
  };
  // CPIDs are MD5 hashes — case is incidental in their hex form.
  // BOINC publishes them lowercase and the wallet's RPC emission can
  // be mixed-case; normalise here so every table stores the canonical
  // form and downstream queries don't need case-tolerance wrappers.
  const cpid = typeof body.cpid === 'string' ? body.cpid.toLowerCase() : null;
  if (!cpid) return null;

  if (contract.action === REMOVE_ACTION) {
    // Revoke action — daemon emits cpid only. We can't derive a fresh
    // address here (no pubkey), so the row's `address` stays empty;
    // the row exists primarily to mark a revocation event in the
    // history, which a downstream UI can join against the prior
    // active registration's address by cpid. `authMethod` doesn't
    // apply to a revocation (no new credential is being added), so
    // record 'unknown' — the UI shouldn't surface it on revoked rows.
    return {
      cpid,
      address: '',
      status: 'revoked',
      txId,
      blockHeight,
      timestamp: blockTime,
      expiration: blockTime,
      authMethod: 'unknown',
    };
  }

  // Add action. Try V2+ pubkey-derived address first; fall back to the
  // V1 hashboinc address for pre-Fern beacons (where body.public_key is
  // empty). Without the V1 fallback every pre-Fern add silently dropped
  // — that lost ~57 of the ~154 currently-active CPIDs on testnet.
  let pubkeyHex = '';
  if (typeof body.publicKey === 'string') pubkeyHex = body.publicKey;
  else if (typeof body.public_key === 'string') pubkeyHex = body.public_key;
  let address = pubkeyHex ? pubkeyToAddress(pubkeyHex, config.NETWORK) : null;
  if (!address && hashboinc) {
    address = parseLegacyV1Address(hashboinc);
  }
  // Still no address (truly malformed wire data, or hashboinc absent).
  // Record the row anyway with an empty address — losing the cpid event
  // is worse than recording it without an address. The page can render
  // these as "address unknown" and history is preserved.
  if (!address) address = '';

  // Pre-Fern beacons activated immediately on registration; post-Fern
  // start as `pending` and require a separate verification step. The
  // contract envelope's `version` distinguishes the eras (v1 = pre-
  // Fern; v2+ = Fern and later). A later post-commit job can flip a
  // pending row to `active` when it sees the matching verification —
  // that's a follow-up; for now we record what we know at write time.
  const isPreFern = (typeof contract.version === 'number' ? contract.version : 1) <= 1;
  const status: 'pending' | 'active' = isPreFern ? 'active' : 'pending';

  // BeaconPayload.m_version → auth_method. Source: src/gridcoin/beacon.h
  // (the BeaconPayload class). v3 (activated at V14) is the new
  // BOINC-server-signed RSA-SHA512 ownership-proof flow; v2 is the
  // Fern-era email-verification flow; v1 is pre-Fern hashboinc.
  // Fall back to deriving from the contract envelope version if the
  // body version is missing for any reason.
  let beaconVer: number;
  if (typeof body.version === 'number') beaconVer = body.version;
  else if (typeof contract.version === 'number') beaconVer = contract.version;
  else beaconVer = 1;
  let authMethod: ParsedBeaconRow['authMethod'];
  if (beaconVer >= 3) authMethod = 'v3_boinc_signed';
  else if (beaconVer === 2) authMethod = 'v2_email_verify';
  else if (beaconVer <= 1) authMethod = 'legacy';
  else authMethod = 'unknown';

  return {
    cpid,
    address,
    status,
    txId,
    blockHeight,
    timestamp: blockTime,
    expiration: blockTime + BEACON_MAX_AGE_SEC,
    authMethod,
  };
}

/**
 * Parse a `type: "sidestake"` contract — the on-chain set/clear of a
 * mandatory sidestake destination. The daemon's
 * SideStakePayloadToJson (src/rpc/rawtransaction.cpp) emits the body
 * as `{ address, allocation, description, status }`, where
 * `allocation` is a percent (Allocation::ToPercent()) and `status` is
 * the stringified MandatorySideStakeStatus ('MANDATORY' or 'DELETED').
 *
 * These contracts only count post-V13; the daemon rejects them on
 * earlier blocks so they won't reach the indexer in the first place.
 * We don't gate by height here — if the daemon emitted it, we index
 * it; the registry-of-active-entries view at query time can filter
 * by status/height as needed.
 */
export function parseSidestakeContract(
  contract: ContractEnvelope,
  txId: string,
  blockHeight: number,
  blockTime: number,
): ParsedSidestakeContractRow | null {
  if (contract.type !== SIDESTAKE_TYPE) return null;
  if (contract.action !== ADD_ACTION && contract.action !== REMOVE_ACTION) return null;

  const body = contract.body as {
    address?: string;
    allocation?: number | string;
    description?: string;
    status?: string;
  };
  const address = typeof body.address === 'string' ? body.address.trim() : '';
  if (!address) return null;

  // Allocation arrives as a percent; tolerate either number or string
  // delivery to defend against any future JSON typing tweak.
  let allocationPct = 0;
  if (typeof body.allocation === 'number') allocationPct = body.allocation;
  else if (typeof body.allocation === 'string') allocationPct = Number(body.allocation);
  if (!Number.isFinite(allocationPct) || allocationPct < 0) allocationPct = 0;

  const description = typeof body.description === 'string' ? body.description : '';

  // Status comes pre-stringified from the daemon. Coerce to the two
  // values we expect; anything unexpected becomes the action-derived
  // default so we don't store junk.
  const rawStatus = typeof body.status === 'string' ? body.status.toUpperCase() : '';
  const action: 'A' | 'D' = contract.action === ADD_ACTION ? 'A' : 'D';
  let status: 'MANDATORY' | 'DELETED';
  if (rawStatus === 'MANDATORY' || rawStatus === 'DELETED') {
    status = rawStatus;
  } else {
    status = action === 'A' ? 'MANDATORY' : 'DELETED';
  }

  const contractVersion = typeof contract.version === 'number' ? contract.version : 3;

  return {
    address,
    action,
    status,
    allocationPct,
    description,
    contractVersion,
    txId,
    blockHeight,
    time: blockTime,
  };
}

export function parseProjectContract(
  contract: ContractEnvelope,
  txId: string,
  blockHeight: number,
  blockTime: number,
): ParsedProjectContractRow | null {
  if (contract.type !== PROJECT_TYPE) return null;
  if (contract.action !== ADD_ACTION && contract.action !== REMOVE_ACTION) return null;

  // Daemon's ProjectToJson (rawtransaction.cpp) emits the body as
  // `{ version, name, url }`. gdpr_controls / requires_external_adapter /
  // public_key live in the daemon's in-memory ProjectEntry but NOT in
  // the contract body, so we can't recover them from chain — they
  // arrive only via `listprojects`. The base_url here is the
  // BOINC project's URL with the magic `@` placeholder; we keep it
  // verbatim so consumers can render or strip as they wish.
  const body = contract.body as { name?: string; url?: string; version?: number };
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return null;
  const baseUrl = typeof body.url === 'string' ? body.url : '';
  const contractVersion = typeof contract.version === 'number' ? contract.version : 1;
  return {
    projectName: name,
    action: contract.action === ADD_ACTION ? 'add' : 'remove',
    baseUrl,
    contractVersion,
    txId,
    blockHeight,
    time: blockTime,
  };
}

/**
 * Parse a `type: "protocol"` contract — the on-chain set/clear of a
 * protocol-registry key/value pair. Action `A` (ADD) sets the key;
 * action `D` (DELETE) clears it. The wallet replays these in order
 * to maintain `ProtocolRegistry::m_protocol_entries`; downstream code
 * (e.g. `Poll::ResolveMagnitudeWeightFactor` for V13+ polls) walks
 * the history chain via `TryLastBeforeTimestamp(key, ts)` to find
 * the value effective at a given timestamp.
 *
 * The daemon's protocol contract body (verified against
 * `src/gridcoin/protocol.cpp::ProtocolEntryPayload`) emits the key
 * and value plus the chain pointers (`hash`, `previous_hash`) that
 * track each key's history. We persist all fields so the aggregator
 * can do exact "value at timestamp" lookups without replaying.
 */
export function parseProtocolEntryContract(
  contract: ContractEnvelope,
  txId: string,
  blockHeight: number,
  blockTime: number,
): ParsedProtocolEntryRow | null {
  if (contract.type !== PROTOCOL_TYPE) return null;
  if (contract.action !== ADD_ACTION && contract.action !== REMOVE_ACTION) return null;

  const body = contract.body as {
    key?: string;
    value?: string;
    previous_hash?: string;
    previousHash?: string;
  };
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) return null;
  const value = typeof body.value === 'string' ? body.value : '';
  // Accept either camelCase or snake_case — same gridcoin-rpc
  // camelcase-keys quirk we defend against on beacon payloads.
  let previousHash = ZERO_HASH_64;
  if (typeof body.previousHash === 'string') previousHash = body.previousHash;
  else if (typeof body.previous_hash === 'string') previousHash = body.previous_hash;
  const contractVersion = typeof contract.version === 'number' ? contract.version : 1;
  return {
    key,
    value,
    status: contract.action === ADD_ACTION ? 'ACTIVE' : 'DELETED',
    contractVersion,
    txId,
    previousHash,
    blockHeight,
    time: blockTime,
  };
}

export function parsePollContract(
  contract: ContractEnvelope,
  txId: string,
  blockHeight: number,
  blockTime: number,
  creatorAddress: string | null,
): ParsedPollRow | null {
  if (contract.type !== POLL_TYPE) return null;
  if (contract.action !== ADD_ACTION) return null;
  const body = contract.body as {
    title?: string;
    question?: string;
    url?: string;
    type?: number | string;
    // Daemon emits the enum as an int in `PollPayloadToJson`; legacy v1
    // polls round-trip through `ConvertFromLegacy` and surface here too,
    // so the same shape covers post-fern and pre-fern alike.
    responseType?: number | string;
    weightType?: number | string;
    durationDays?: number;
    choices?: Array<{ id: number; label: string }>;
  };
  const durationDays = typeof body.durationDays === 'number' ? body.durationDays : 7;
  return {
    pollId: txId,
    title: typeof body.title === 'string' ? body.title : '',
    question: typeof body.question === 'string' ? body.question : '',
    url: typeof body.url === 'string' && body.url.length > 0 ? body.url.slice(0, 512) : null,
    pollType: pollTypeName(body.type),
    responseType: pollResponseTypeName(body.responseType),
    weightType: pollWeightTypeName(body.weightType),
    startTime: blockTime,
    endTime: blockTime + durationDays * 24 * 60 * 60,
    claimTx: txId,
    blockHeight,
    creatorAddress,
    options: Array.isArray(body.choices)
      ? body.choices.map((c) => ({ idx: c.id, label: c.label }))
      : [],
  };
}

/**
 * Daemon's `MessagePayloadToJson` (rawtransaction.cpp:174) returns the
 * message string verbatim as the `body` field — no wrapping object, no
 * structured fields. Legacy v1 messages round-trip through
 * `Contract::Body::ConvertFromLegacy` to the same shape. We pull the
 * plaintext, the sender's address (resolved from vin[0]), and the block
 * timestamp; nothing else needs storing because there's no protocol
 * meaning to a MESSAGE contract beyond "this string is on chain".
 */
export function parseMessageContract(
  contract: ContractEnvelope,
  txId: string,
  blockHeight: number,
  blockTime: number,
  senderAddress: string | null,
): ParsedMessageRow | null {
  if (contract.type !== MESSAGE_TYPE) return null;
  // body is a raw string for MESSAGE contracts — but be defensive about
  // daemons that ever wrap it.
  let raw = '';
  if (typeof contract.body === 'string') raw = contract.body;
  else if (contract.body && typeof contract.body === 'object') raw = JSON.stringify(contract.body);
  const message = raw.slice(0, MESSAGE_MAX_LEN);
  if (message.length === 0) return null;
  return {
    txId,
    blockHeight,
    time: blockTime,
    senderAddress,
    message,
  };
}

// MRC request body, camelCased by gridcoin-rpc. Some fields use
// numeric-as-string in older daemons, so research_subsidy / fee can
// arrive as either number or string — `grc2halford` accepts both
// without a Number() round-trip (which would silently truncate the
// 8-decimal halford precision past ~15 significant digits).
interface MrcRequestBody {
  version?: number;
  cpid?: string;
  clientVersion?: string;
  organization?: string;
  researchSubsidy?: number | string;
  fee?: number | string;
  magnitude?: number;
  magnitudeUnit?: number;
  lastBlockHash?: string;
  signature?: string;
}

export function parseMrcContract(
  contract: ContractEnvelope,
  txId: string,
  firstSeen: number,
  payToAddress: string | null,
  blockHeight: number | null,
  blockTime: number | null,
): ParsedMrcRequestRow | null {
  if (contract.type !== MRC_TYPE) return null;
  const body = contract.body as MrcRequestBody;
  // Per `m_mining_id.Which() == MiningId::Kind::CPID` in the wallet's
  // SerializationOp, only CPID-kind MRCs carry research_subsidy and
  // fee on the wire. Non-CPID (INVESTOR) MRCs can't accrue rewards
  // and would surface here with cpid not matching the canonical 32-hex
  // shape; reject them so the table stays uniform.
  const cpid = typeof body.cpid === 'string' ? body.cpid.toLowerCase() : '';
  if (!/^[0-9a-f]{32}$/.test(cpid)) return null;
  return {
    txId,
    version: typeof body.version === 'number' && Number.isFinite(body.version) ? body.version : 1,
    cpid,
    clientVersion: typeof body.clientVersion === 'string' ? body.clientVersion : '',
    organization: typeof body.organization === 'string' ? body.organization : '',
    researchSubsidy: body.researchSubsidy != null ? grc2halford(body.researchSubsidy) : 0n,
    feeOffered: body.fee != null ? grc2halford(body.fee) : 0n,
    magnitude: typeof body.magnitude === 'number' && Number.isFinite(body.magnitude) ? body.magnitude : 0,
    magnitudeUnit: typeof body.magnitudeUnit === 'number' && Number.isFinite(body.magnitudeUnit) ? body.magnitudeUnit : 0,
    lastBlockHash: typeof body.lastBlockHash === 'string' ? body.lastBlockHash : '',
    signature: typeof body.signature === 'string' ? body.signature : '',
    payToAddress,
    firstSeen,
    blockHeight,
    blockTime,
  };
}

export function parseVoteContract(
  contract: ContractEnvelope,
  txId: string,
  blockHeight: number,
  voterAddress: string | null,
): ParsedVoteRow[] {
  if (contract.type !== VOTE_TYPE) return [];
  const isLegacy = typeof contract.version === 'number' && contract.version < 2;
  const addr = voterAddress ?? '';

  if (!isLegacy) {
    // Post-fern (v2+) vote: `{ poll_txid, responses[] }`.
    // Per-vote weight is computed later by `PollWeightAggregator` against
    // the bitemporal balance/magnitude history at the poll's start
    // height — depends on the poll's weight_type rule, which we don't
    // have here.
    const body = contract.body as { pollTxid?: string; responses?: Array<number | string> };
    if (!body.pollTxid || !Array.isArray(body.responses)) return [];
    return body.responses.map((r) => ({
      pollId: String(body.pollTxid),
      legacyTitleKey: null,
      voterAddress: addr,
      voterCpid: null,
      miningId: null,
      choiceIdx: typeof r === 'number' ? r : Number(r) || 0,
      choiceLabel: null,
      weight: 0n,
      weightBalance: 0n,
      weightMagnitude: 0,
      txId,
      blockHeight,
    }));
  }

  // Legacy (v1) vote: `{ key, mining_id, amount, magnitude, responses }`.
  // - `key` carries the poll title before the first `;` (lowercased).
  //   We can't resolve to a poll_id here without a DB lookup; the writer
  //   does that join.
  // - `responses` is a `;`-delimited string of *labels*. We split into
  //   per-choice rows and let the writer map labels → idx via
  //   `poll_options.label`.
  // - `amount` and `magnitude` are the voter's self-declared snapshot
  //   at vote time. They populate `weight_balance` / `weight_magnitude`
  //   directly — for legacy polls there's no aggregator pass needed.
  const body = contract.body as {
    key?: string;
    miningId?: string;
    amount?: number;
    magnitude?: number;
    responses?: string;
  };
  if (!body.key || typeof body.responses !== 'string') return [];
  const legacyTitleKey = body.key.split(';')[0]?.trim().toLowerCase() ?? null;
  if (!legacyTitleKey) return [];
  const labels = body.responses.split(';').map((s) => s.trim()).filter(Boolean);
  if (labels.length === 0) return [];

  const miningId = typeof body.miningId === 'string' ? body.miningId : null;
  // The legacy `mining_id` is either a CPID (32-hex) or one of the
  // wallet's noncruncher sentinels (pre-fern "INVESTOR", post-fern
  // "NONCRUNCHER"). Investor votes carry no CPID; the table column
  // stays null. CPIDs are MD5 hashes — lowercase is canonical.
  const voterCpid = miningId && !isNoncruncherMiningId(miningId) ? miningId.toLowerCase() : null;
  const weightBalance = grc2halford(body.amount ?? 0);
  const weightMagnitude = typeof body.magnitude === 'number' && Number.isFinite(body.magnitude)
    ? body.magnitude
    : 0;

  return labels.map((label) => ({
    pollId: null, // resolved by writer via legacyTitleKey → polls.title (lowercased)
    legacyTitleKey,
    voterAddress: addr,
    voterCpid,
    miningId,
    choiceIdx: -1, // resolved by writer via choiceLabel → poll_options.label
    choiceLabel: label.toLowerCase(),
    // Combined weight comes from poll's weight_type rule; for now mirror
    // the most natural per-poll interpretation. The aggregator (or a
    // legacy-aware reconciler) refines this once the poll's weight_type
    // is known via the writer's join.
    weight: weightBalance + grc2halford(weightMagnitude),
    weightBalance,
    weightMagnitude,
    txId,
    blockHeight,
  }));
}

/**
 * Parse one verbose=2 block into row sets ready for the writer.
 *
 * `prevOutputs` resolves vin addresses+values; the caller must seed
 * with everything in this block's predecessors. During backfill the
 * writer runs all blocks in height order so seeding is one indexed
 * SELECT against tx_outputs.
 */
interface PosMinerInfo {
  isPos: boolean;
  minerAddress: string | null;
  stakerCpid: string | null;
}

// PoS detection + miner/staker resolution. Prefer the daemon's `flags`
// string ("proof-of-stake") since `block.IsProofOfStake()` (the
// canonical wallet-side source) emits it directly. Cross-check
// `block.signature` and the tx[1] coinstake shape so a future
// header-shape drift surfaces loudly rather than mis-classifying
// blocks into is_pos filtering everywhere.
function detectPosAndMiner(block: VerboseBlock): PosMinerInfo {
  const flagsPos = blockFlagsAssertPoS(block.flags);
  const sigPos = !!block.signature;
  const shapePos = block.tx.length > 1 && hasCoinstakeShape(block.tx[1], 1);
  const isPos = flagsPos || (sigPos && shapePos);
  if (flagsPos !== sigPos) {
    log.warn(
      `block ${block.height} PoS flag vs signature disagree (classified by flag)`,
      {
        hash: block.hash, flagsPos, sigPos, shapePos,
      },
    );
  } else if (flagsPos !== shapePos) {
    log.debug(
      `block ${block.height} PoS flag vs coinstake-shape disagree (classified by flag)`,
      {
        hash: block.hash, flagsPos, shapePos,
      },
    );
  }

  let minerAddress: string | null = null;
  let stakerCpid: string | null = null;
  if (isPos) {
    // PoS staker = vout[1] of tx[1] (the coinstake). vout[0] is the
    // empty marker; tx[0] is the coinbase placeholder for PoS blocks.
    const coinstake = block.tx[1];
    if (coinstake && coinstake.vout[1]) {
      minerAddress = pickPrimaryAddress(coinstake.vout[1]);
    }
  } else if (block.tx[0] && block.tx[0].vout[0]) {
    minerAddress = pickPrimaryAddress(block.tx[0].vout[0]);
  }
  if (block.claim?.miningId && !isNoncruncherMiningId(block.claim.miningId)) {
    // MD5 hex, canonical lowercase.
    stakerCpid = block.claim.miningId.toLowerCase();
  }
  return { isPos, minerAddress, stakerCpid };
}

// V13+ coinstake "extras": vout[idx >= 2] on a PoS coinstake. These
// are the mandatory and/or voluntary sidestakes the staker appended.
// Pre-V13 consensus didn't allow MSS, so we skip capture there (local
// sidestakes do exist pre-V13 but the explorer doesn't surface them).
function extractCoinstakeSidestakes(block: VerboseBlock, isPos: boolean): ParsedCoinstakeSidestakeRow[] {
  if (!isPos || block.version < 13) return [];
  const coinstake = block.tx[1];
  if (!coinstake) return [];
  const out: ParsedCoinstakeSidestakeRow[] = [];
  for (let idx = 2; idx < coinstake.vout.length; idx += 1) {
    const vout = coinstake.vout[idx];
    const addr = pickPrimaryAddress(vout);
    if (!addr) continue;
    // Daemon emits `value` in GRC; convert to halford so the amount
    // field stays unit-consistent with the rest of the pipeline.
    const amount = typeof vout.value === 'number' ? grc2halford(vout.value) : 0n;
    if (amount <= 0n) continue;
    out.push({
      blockHeight: block.height,
      voutIdx: idx,
      txId: coinstake.txid,
      address: addr,
      amount,
      time: block.time,
    });
  }
  return out;
}

// Block-level row. Pure shape-mapping over the daemon's getblock
// response — no I/O, no side effects beyond the supply-anomaly warn
// for the first ~12 blocks of a chain where the daemon hasn't yet
// reconstructed early-block supply.
function buildBlockRow(block: VerboseBlock, info: PosMinerInfo): ParsedBlockRow {
  if (
    block.height > 0
    && (block.moneySupply === undefined || block.moneySupply === 0)
    && typeof block.mint === 'number'
    && block.mint > 0
  ) {
    log.warn(
      `block ${block.height} has mint=${block.mint} but moneySupply=0 — daemon hasn't reconstructed early-block supply`,
      { hash: block.hash },
    );
  }
  return {
    height: block.height,
    hash: block.hash,
    // FixedString(64) NUL-pads empty strings, and NULs in the hex
    // break HTML parsing (SSR hydration on /block/0). Genesis is the
    // only block that legitimately has no previousblockhash; we
    // substitute zero-hash only there. For any other height, surface
    // the daemon's response verbatim (or empty if hex-validation
    // fails, which is the canonical signal something upstream is wrong).
    prevHash: resolvePrevHash(block),
    merkleRoot: block.merkleroot,
    time: block.time,
    nVersion: block.version,
    difficulty: String(block.difficulty),
    size: block.size,
    txCount: block.tx.length,
    isPos: info.isPos,
    minerAddress: info.minerAddress,
    stakerCpid: info.stakerCpid,
    isSuperblock: block.isSuperBlock,
    // The daemon emits both `mint` (this-block emission) and
    // `moneySupply` (cumulative supply after this block) as GRC
    // numbers. Persist as halford. The wallet's main.cpp:~140-152
    // reconstructs supply for nHeight < 12 when the stored value is
    // missing/zero; the warn above surfaces any case where that
    // hasn't fired before RPC serialisation.
    mint: typeof block.mint === 'number' ? grc2halford(block.mint) : 0n,
    moneySupply: typeof block.moneySupply === 'number' ? grc2halford(block.moneySupply) : 0n,
    nonce: typeof block.nonce === 'number' ? block.nonce : 0,
    bits: typeof block.bits === 'string' ? block.bits : '00000000',
  };
}

interface TransactionsBundle {
  transactions: ParsedTransactionRow[];
  txOutputs: ParsedTxOutputRow[];
  txInputs: ParsedTxInputRow[];
  addressDeltas: Map<string, AddressDelta>;
  beacons: ParsedBeaconRow[];
  polls: ParsedPollRow[];
  votes: ParsedVoteRow[];
  messages: ParsedMessageRow[];
  projectContracts: ParsedProjectContractRow[];
  sidestakeContracts: ParsedSidestakeContractRow[];
  protocolEntries: ParsedProtocolEntryRow[];
  mrcRequests: ParsedMrcRequestRow[];
  valueMoved: bigint;
  feeTotal: bigint;
}

// Per-tx fold. Walks block.tx once, accumulating every per-row
// collection plus the block-level value/fee totals. Pure given the
// `prevOutputs` lookup; all mutation happens on locally-owned arrays
// that get returned in the bundle. Exported (alongside parseBlock) so
// the coinstake net accounting can be unit-tested directly.
export function processTransactions(
  block: VerboseBlock,
  isPos: boolean,
  prevOutputs: PrevOutputsLookup,
): TransactionsBundle {
  const transactions: ParsedTransactionRow[] = [];
  const txOutputs: ParsedTxOutputRow[] = [];
  const txInputs: ParsedTxInputRow[] = [];
  const addressDeltas = new Map<string, AddressDelta>();
  const beacons: ParsedBeaconRow[] = [];
  const polls: ParsedPollRow[] = [];
  const votes: ParsedVoteRow[] = [];
  const messages: ParsedMessageRow[] = [];
  const projectContracts: ParsedProjectContractRow[] = [];
  const sidestakeContracts: ParsedSidestakeContractRow[] = [];
  const protocolEntries: ParsedProtocolEntryRow[] = [];
  const mrcRequests: ParsedMrcRequestRow[] = [];
  let valueMoved = 0n;
  let feeTotal = 0n;

  block.tx.forEach((tx, indexInBlk) => {
    const isCoinbase = isCoinbaseTx(tx);
    // Coinstake = tx[1] on a PoS-flagged block. Block-level
    // flag-vs-shape disagreements are already logged above.
    const isCoinstake = isPos && indexInBlk === 1 && !isCoinbase;

    const outValues = tx.vout.map((v) => grc2halford(v.value));
    const totalOut = sumHalford(outValues);

    let totalIn = 0n;
    // First resolved vin address feeds poll/vote/message attribution
    // below. Captured during the vin walk to avoid an O(N²) post-scan
    // of `txInputs` on busy blocks.
    let senderAddress: string | null = null;
    // Coinstake-only: per-address input/output sums for the net pass.
    const csIn = isCoinstake ? new Map<string, bigint>() : null;
    const csOut = isCoinstake ? new Map<string, bigint>() : null;
    tx.vin.forEach((vin, vinN) => {
      if (typeof vin.coinbase === 'string') return;
      if (typeof vin.txid !== 'string' || typeof vin.vout !== 'number') return;
      const resolved = prevOutputs(vin.txid, vin.vout);
      const value = resolved?.value ?? null;
      const address = resolved?.address ?? null;
      txInputs.push({
        txId: tx.txid,
        vinN,
        prevTx: vin.txid,
        prevVout: vin.vout,
        address,
        value,
        scriptSigHex: vin.scriptSig?.hex ?? '',
        // The daemon's RPC serialises `sequence` as a signed 32-bit
        // int, so `0xffffffff` arrives as `-1`. CH's `UInt32` rejects
        // negative literals; `>>> 0` is the standard JS idiom to
        // reinterpret the int32 bit pattern as uint32.
        sequence: typeof vin.sequence === 'number' ? vin.sequence >>> 0 : 0xffffffff,
      });
      if (value != null) totalIn += value;
      if (address) {
        if (senderAddress === null) senderAddress = address;
        bumpDelta(addressDeltas, address, -(value ?? 0n), tx.txid, false, !isCoinstake);
        if (csIn) csIn.set(address, (csIn.get(address) ?? 0n) + (value ?? 0n));
      }
    });

    tx.vout.forEach((vout) => {
      const address = pickPrimaryAddress(vout);
      const value = grc2halford(vout.value);
      txOutputs.push({
        txId: tx.txid,
        voutN: vout.n,
        value,
        address,
        scriptType: vout.scriptPubKey.type,
        scriptHex: vout.scriptPubKey.hex,
        reqSigs: typeof vout.scriptPubKey.reqSigs === 'number'
          ? vout.scriptPubKey.reqSigs
          : 0,
      });
      if (address) {
        bumpDelta(addressDeltas, address, value, tx.txid, true, !isCoinstake);
        if (csOut) csOut.set(address, (csOut.get(address) ?? 0n) + value);
      }
    });

    // Coinstake: apply received/sent as ONE net figure per address.
    // Positive net is real inflow (block reward, a sidestake/MRC payout
    // this address received); negative net is value the staker
    // redirected away and counts as sent. The staker's own principal
    // returning to itself nets to zero and stops inflating lifetime
    // totals. `delta` was already accumulated by the !countInOut bumps.
    if (csIn && csOut) {
      const applyNet = (a: string, net: bigint): void => {
        const entry = addressDeltas.get(a);
        if (!entry || net === 0n) return;
        if (net > 0n) entry.received += net;
        else entry.sent += -net;
      };
      for (const [a, out] of csOut) applyNet(a, out - (csIn.get(a) ?? 0n));
      // Inputs-only addresses (no output back) — csOut already covered
      // every address that had an output, so skip those here.
      for (const [a, inv] of csIn) if (!csOut.has(a)) applyNet(a, -inv);
    }

    // Fee = inputs - outputs for non-generator txs. Coinbase + coinstake
    // mint new coins, so their "fee" is meaningless and we record 0.
    // Real transactions can't physically have a negative fee — that
    // would mean the tx mints coins, which only coinbase/coinstake do.
    // If we arrive here with `totalOut > totalIn` for a non-coinbase /
    // non-coinstake tx, the classification heuristic missed something
    // (early-testnet pre-fern emissions, for example, where vout[0] of
    // a coinstake isn't zero). Clamp to 0 so the bucket rollups can't
    // go negative — without this, `metric_buckets.fee_total` carried
    // -688 K GRC of phantom "fees" that the MoneyFlow chart rendered
    // as a sea of red.
    const rawFee = isCoinbase || isCoinstake ? 0n : totalIn - totalOut;
    const fee = rawFee > 0n ? rawFee : 0n;
    feeTotal += fee;
    if (!isCoinbase && !isCoinstake) valueMoved += totalOut;

    // Strip the daemon's "no BOINC proof" sentinels — empty string
    // and all-zeros 64-hex are both used in practice, depending on
    // wallet version. Storing those as NULL keeps the indexed column
    // small and lets Meili's null-filtering skip non-staking rows.
    const rawHashboinc = typeof tx.hashboinc === 'string' ? tx.hashboinc.trim() : '';
    const isAllZeroHash = /^0+$/.test(rawHashboinc);
    const hashboinc = rawHashboinc.length > 0 && !isAllZeroHash ? rawHashboinc : null;

    transactions.push({
      txId: tx.txid,
      blockHeight: block.height,
      blockHash: block.hash,
      time: tx.time,
      // Daemon emits per-tx `size` on the verbose getblock /
      // getblocksbatch response (verified on v5.5.0.1 across the chain).
      // Fallback to 0 keeps the row out of the fee-percentile MV
      // without breaking ingestion if a future daemon revision drops it.
      size: typeof tx.size === 'number' ? tx.size : 0,
      fee,
      vinCount: tx.vin.length,
      voutCount: tx.vout.length,
      totalIn,
      totalOut,
      isCoinbase,
      isCoinstake,
      indexInBlk,
      hashboinc,
      nVersion: typeof tx.version === 'number' ? tx.version : 1,
      nLockTime: typeof tx.locktime === 'number' ? tx.locktime : 0,
    });

    // First non-OP_RETURN output's address — for MRC requests this
    // is typically the requester's own change address (Gridcoin pays
    // the MRC out to the same address the request was funded from).
    const firstPayoutAddress = tx.vout.find(
      (v) => v.scriptPubKey.type !== 'nulldata' && (v.scriptPubKey.addresses?.length ?? 0) > 0,
    )?.scriptPubKey.addresses?.[0] ?? null;

    tx.contracts?.forEach((contract) => {
      const beacon = parseBeaconContract(contract, tx.txid, block.height, block.time, hashboinc);
      if (beacon) beacons.push(beacon);
      const poll = parsePollContract(contract, tx.txid, block.height, block.time, senderAddress);
      if (poll) polls.push(poll);
      votes.push(...parseVoteContract(contract, tx.txid, block.height, senderAddress));
      const msg = parseMessageContract(contract, tx.txid, block.height, block.time, senderAddress);
      if (msg) messages.push(msg);
      const project = parseProjectContract(contract, tx.txid, block.height, block.time);
      if (project) projectContracts.push(project);
      const sidestake = parseSidestakeContract(contract, tx.txid, block.height, block.time);
      if (sidestake) sidestakeContracts.push(sidestake);
      const protocolEntry = parseProtocolEntryContract(contract, tx.txid, block.height, block.time);
      if (protocolEntry) protocolEntries.push(protocolEntry);
      const mrc = parseMrcContract(
        contract,
        tx.txid,
        block.time,
        firstPayoutAddress,
        block.height,
        block.time,
      );
      if (mrc) mrcRequests.push(mrc);
    });
  });

  return {
    transactions,
    txOutputs,
    txInputs,
    addressDeltas,
    beacons,
    polls,
    votes,
    messages,
    projectContracts,
    sidestakeContracts,
    protocolEntries,
    mrcRequests,
    valueMoved,
    feeTotal,
  };
}

function buildClaim(block: VerboseBlock): ParsedClaimRow | undefined {
  if (!block.claim) return undefined;
  return {
    blockHeight: block.height,
    // Lowercase the CPID — MD5 hex is case-insensitive and we store
    // the canonical form everywhere downstream. Noncruncher sentinels
    // ("INVESTOR" pre-fern, "NONCRUNCHER" post-fern) are not CPIDs;
    // store NULL so investor blocks aren't miscounted as researchers.
    cpid: isNoncruncherMiningId(block.claim.miningId) ? null : block.claim.miningId.toLowerCase(),
    miningId: block.claim.miningId,
    clientVersion: block.claim.clientVersion,
    organization: block.claim.organization,
    blockSubsidy: grc2halford(block.claim.blockSubsidy),
    researchSubsidy: grc2halford(block.claim.researchSubsidy),
    magnitude: block.claim.magnitude,
    magnitudeUnit: block.claim.magnitudeUnit,
    quorumHash: block.claim.quorumHash || null,
    quorumAddress: block.claim.quorumAddress || null,
    signature: block.claim.signature,
    isMrc: (block.claim.mMrcTxMapSize ?? 0) > 0,
    mrcTxMapSize: block.claim.mMrcTxMapSize ?? 0,
    // Block-level MRC fee splits — emitted by the daemon on the
    // verbose getblock as `mrc_foundation_fees` / `mrc_staker_fees`
    // (camelCased by gridcoin-rpc). Values are GRC; convert here.
    mrcFoundationFees: grc2halford(block.mrcFoundationFees ?? 0),
    mrcStakerFees: grc2halford(block.mrcStakerFees ?? 0),
  };
}

// v12+ MRC payouts. Each entry is one researcher being paid alongside
// the staker in the same block. Daemon shape varies slightly across
// versions (camelCase vs snake_case, missing fields on pre-final
// builds) — be permissive about both, dedupe within the block so a
// daemon glitch can't crash the block-write.
function buildClaimMrcs(block: VerboseBlock): ParsedClaimMrcRow[] {
  const claimMrcs: ParsedClaimMrcRow[] = [];
  if (!Array.isArray(block.claim?.mrcs)) return claimMrcs;
  const seen = new Set<string>();
  for (const m of block.claim!.mrcs!) {
    const cpidRaw = m.cpid ?? m.miningId ?? m.mining_id;
    if (!cpidRaw || isNoncruncherMiningId(cpidRaw)) continue;
    // MD5 hex, canonical lowercase.
    const cpid = cpidRaw.toLowerCase();
    if (seen.has(cpid)) continue;
    seen.add(cpid);
    const subsidyRaw = m.researchSubsidy ?? m.research_subsidy ?? 0;
    const researchSubsidy = grc2halford(typeof subsidyRaw === 'number' ? subsidyRaw : String(subsidyRaw));
    claimMrcs.push({
      blockHeight: block.height,
      cpid,
      miningId: m.miningId ?? m.mining_id ?? cpid,
      clientVersion: m.clientVersion ?? m.client_version ?? '',
      researchSubsidy,
      magnitude: typeof m.magnitude === 'number' ? m.magnitude : 0,
      payToAddress: m.payToAddress ?? m.pay_to_address ?? null,
    });
  }
  return claimMrcs;
}

interface SuperblockBundle {
  superblock: ParsedSuperblockRow | undefined;
  magnitudes: ParsedSuperblockMagnitudeRow[];
  projects: ParsedSuperblockProjectRow[];
}

function buildSuperblock(block: VerboseBlock, claim: ParsedClaimRow | undefined): SuperblockBundle {
  if (!block.superblock || !block.isSuperBlock) {
    return { superblock: undefined, magnitudes: [], projects: [] };
  }
  const magnitudesEntries = Object.entries(block.superblock.magnitudes ?? {});
  const totalMagnitude = magnitudesEntries.reduce((acc, [, m]) => acc + (typeof m === 'number' ? m : 0), 0);
  const projectEntries = Object.entries(block.superblock.projects ?? {});
  // The daemon's SuperblockToJson (rpc/blockchain.cpp:~144) doesn't
  // emit the superblock's convergence hash directly — by chain
  // convention the staker copies `superblock.GetHash()` into their
  // sibling claim as `quorumHash`. Reading from the claim is the
  // canonical RPC-side source. If a SB ever lands without a matching
  // claim (shouldn't happen on chain) we record empty and log.
  const quorumHash = claim?.quorumHash ?? '';
  if (!quorumHash) {
    log.warn(
      `superblock at block ${block.height} has no sibling claim.quorumHash`,
      { hash: block.hash },
    );
  }
  const sbAny = block.superblock as { version?: number };
  const contractVersion = typeof sbAny.version === 'number' ? sbAny.version : 0;
  const superblock: ParsedSuperblockRow = {
    height: block.height,
    quorumHash,
    totalMagnitude,
    cpidCount: magnitudesEntries.length,
    projectCount: projectEntries.length,
    payloadSize: 0,
    contractVersion,
  };
  const magnitudes = magnitudesEntries.map(([cpid, magnitude]) => ({
    superblockHeight: block.height,
    // MD5 hex, canonical lowercase.
    cpid: cpid.toLowerCase(),
    magnitude: typeof magnitude === 'number' ? magnitude : 0,
  }));
  const projects = projectEntries.map(([projectName, p]) => {
    const proj = (p ?? {}) as { averageRac?: unknown; rac?: unknown; totalCredit?: unknown };
    return {
      superblockHeight: block.height,
      projectName: projectName.slice(0, 64),
      averageRac: Number(proj.averageRac) || 0,
      rac: Number(proj.rac) || 0,
      totalCredit: Number(proj.totalCredit) || 0,
    };
  });
  return { superblock, magnitudes, projects };
}

export function parseBlock(
  block: VerboseBlock,
  prevOutputs: PrevOutputsLookup,
): ParsedBlock {
  const posMiner = detectPosAndMiner(block);
  const coinstakeSidestakes = extractCoinstakeSidestakes(block, posMiner.isPos);
  const blockRow = buildBlockRow(block, posMiner);
  const tx = processTransactions(block, posMiner.isPos, prevOutputs);
  const claim = buildClaim(block);
  const claimMrcs = buildClaimMrcs(block);
  const sb = buildSuperblock(block, claim);

  const metrics: ParsedMetricsContribution = {
    txCount: tx.transactions.length,
    valueMoved: tx.valueMoved,
    feeTotal: tx.feeTotal,
    blockCount: 1,
    researchSubsidy: claim?.researchSubsidy ?? 0n,
    blockSubsidy: claim?.blockSubsidy ?? 0n,
    newBeacons: tx.beacons.filter((b) => b.status === 'active').length,
    isResearcherBlock: posMiner.isPos && posMiner.stakerCpid !== null,
    isInvestorBlock: posMiner.isPos && posMiner.stakerCpid === null,
    activeAddresses: tx.addressDeltas.size,
  };

  return {
    block: blockRow,
    transactions: tx.transactions,
    txOutputs: tx.txOutputs,
    txInputs: tx.txInputs,
    addressDeltas: tx.addressDeltas,
    claim,
    claimMrcs,
    mrcRequests: tx.mrcRequests,
    superblock: sb.superblock,
    superblockMagnitudes: sb.magnitudes,
    superblockProjects: sb.projects,
    beacons: tx.beacons,
    polls: tx.polls,
    votes: tx.votes,
    messages: tx.messages,
    projectContracts: tx.projectContracts,
    sidestakeContracts: tx.sidestakeContracts,
    coinstakeSidestakes,
    protocolEntries: tx.protocolEntries,
    metrics,
  };
}

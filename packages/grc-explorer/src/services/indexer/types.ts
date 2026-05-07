/**
 * Types describing the verbose=2 getblock JSON the daemon returns,
 * after the gridcoin-rpc client has camelCased the keys (see
 * gridcoin-rpc/dist/RPCBase.js — `camelcase-keys` is applied to every
 * response with `deep: true`). Field names mirror the C++ pushKV calls
 * in src/rpc/blockchain.cpp + src/rpc/rawtransaction.cpp.
 *
 * These extend the base types from gridcoin-rpc with explorer-specific
 * fields the published .d.ts is missing (in particular, the verbose=2
 * BlockTX has `contracts` even though the package's BlockTX interface
 * omits it).
 */

export interface ScriptPubKey {
  asm: string;
  hex: string;
  type: string;
  reqSigs?: number;
  addresses?: string[];
}

export interface Vin {
  txid?: string;
  vout?: number;
  coinbase?: string;
  scriptSig?: { asm: string; hex: string };
  sequence: number;
}

export interface Vout {
  value: number; // GRC, before halford conversion
  n: number;
  scriptPubKey: ScriptPubKey;
}

export interface ContractEnvelope {
  version: number;
  type: string;
  action: string;
  body: Record<string, unknown>;
}

export interface BlockTx {
  txid: string;
  version: number;
  time: number;
  locktime: number;
  hashboinc: string;
  contracts: ContractEnvelope[];
  vin: Vin[];
  vout: Vout[];
  /** Serialized tx size in bytes. The Gridcoin daemon's verbose
   *  getblock (and getblocksbatch / getblockbynumber) emits this on
   *  every tx — verified live against v5.5.0.1 across early PoW and
   *  modern PoS heights. Optional only as a defensive safety net for
   *  any future daemon shape change; current parser falls back to 0
   *  when missing, which keeps the row out of the fee-percentile MV. */
  size?: number;
}

/**
 * Per-MRC entry inside a v12+ block.claim. Field names mirror the C++
 * MRCContract serialisation (see Gridcoin-Research's MRC.cpp). Older
 * builds may omit `pay_to_address`; some emit `mining_id` separately
 * from `cpid`. We keep both optional so the parser can be permissive.
 */
export interface MrcJson {
  cpid?: string;
  miningId?: string;
  mining_id?: string;
  clientVersion?: string;
  client_version?: string;
  researchSubsidy?: number | string;
  research_subsidy?: number | string;
  magnitude?: number;
  payToAddress?: string;
  pay_to_address?: string;
}

export interface ClaimJson {
  version: number;
  miningId: string;
  clientVersion: string;
  organization: string;
  blockSubsidy: number;
  researchSubsidy: number;
  magnitude: number;
  magnitudeUnit: number;
  signature: string;
  quorumHash: string;
  quorumAddress: string;
  mMrcTxMapSize?: number;
  mrcs?: MrcJson[];
}

export interface SuperblockJson {
  version: number;
  /** keyed by cpid → magnitude */
  magnitudes: Record<string, number>;
  projects: Record<string, { averageRac: number; rac: number; totalCredit: number }>;
  beacons?: unknown[];
}

export interface VerboseBlock {
  hash: string;
  confirmations: number;
  size: number;
  height: number;
  version: number;
  merkleroot: string;
  mint?: number;
  moneySupply?: number;
  time: number;
  nonce: number;
  bits: string;
  difficulty: number;
  blocktrust: string;
  chaintrust: string;
  previousblockhash?: string;
  nextblockhash?: string;
  flags: string;
  proofhash: string;
  entropybit: number;
  modifier: string;
  tx: BlockTx[];
  signature?: string;
  claim: ClaimJson;
  superblock?: SuperblockJson;
  feesCollected: number;
  mrcFoundationFees?: number;
  mrcStakerFees?: number;
  isSuperBlock: boolean;
  isContract: boolean;
}

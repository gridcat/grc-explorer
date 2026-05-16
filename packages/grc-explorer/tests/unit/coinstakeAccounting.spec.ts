import { describe, it, expect } from 'vitest';
import { processTransactions } from '../../src/services/indexer/ContractParser';
import { grc2halford } from '../../src/lib/halford';
import type { VerboseBlock, BlockTx, Vout } from '../../src/services/indexer/types';

// Minimal fixtures — processTransactions only touches tx/vin/vout +
// block.{height,hash,time}; claim/contracts are optional and omitted.

function vout(value: number, n: number, address: string | null): Vout {
  return {
    value,
    n,
    scriptPubKey: {
      asm: '', hex: '', type: address ? 'pubkeyhash' : 'nonstandard',
      reqSigs: address ? 1 : 0,
      addresses: address ? [address] : [],
    },
  };
}

function tx(txid: string, vin: BlockTx['vin'], vouts: Vout[]): BlockTx {
  return {
    txid, version: 1, time: 0, locktime: 0, hashboinc: '',
    contracts: [], vin, vout: vouts, size: 0,
  };
}

function block(txs: BlockTx[]): VerboseBlock {
  return {
    hash: 'b'.repeat(64), height: 100, time: 1_700_000_000, tx: txs,
  } as unknown as VerboseBlock;
}

const STAKER = 'S_staker';
const SIDE = 'S_sidestake';
const A = 'A_addr';
const B = 'B_addr';

describe('coinstake-aware received/sent accounting', () => {
  it('nets the staker principal out — only the reward counts as received', () => {
    // Staker spends a 1000 GRC UTXO; coinstake returns 1008 to the
    // staker (1000 principal + 8 reward) and a 2 GRC sidestake to SIDE.
    const prev = (t: string, v: number) => (t === 'p0' && v === 0
      ? { address: STAKER, value: grc2halford(1000) }
      : null);

    const b = block([
      tx('cb', [{ coinbase: '00', sequence: 0 }], [vout(0, 0, null)]),
      tx('cs',
        [{ txid: 'p0', vout: 0, sequence: 0 }],
        [vout(0, 0, null), vout(1008, 1, STAKER), vout(2, 2, SIDE)]),
    ]);

    const { addressDeltas } = processTransactions(b, true, prev);
    const s = addressDeltas.get(STAKER)!;
    const side = addressDeltas.get(SIDE)!;

    // Balance is exact regardless of accounting mode.
    expect(s.delta).toBe(grc2halford(1008) - grc2halford(1000)); // +8
    // Only the +8 reward is "received"; the 1000 principal that
    // recirculated to itself is netted out, not booked gross.
    expect(s.received).toBe(grc2halford(8));
    expect(s.sent).toBe(0n);
    // The sidestake recipient genuinely received 2.
    expect(side.received).toBe(grc2halford(2));
    expect(side.sent).toBe(0n);
    expect(side.delta).toBe(grc2halford(2));
  });

  it('books a negative coinstake net as sent (staker redirected value out)', () => {
    const prev = (t: string) => (t === 'p1'
      ? { address: STAKER, value: grc2halford(1000) }
      : null);
    const b = block([
      tx('cb', [{ coinbase: '00', sequence: 0 }], [vout(0, 0, null)]),
      tx('cs',
        [{ txid: 'p1', vout: 0, sequence: 0 }],
        // 990 back to staker, 20 to a sidestake (total out 1010 > 1000 in).
        [vout(0, 0, null), vout(990, 1, STAKER), vout(20, 2, SIDE)]),
    ]);
    const s = processTransactions(b, true, prev).addressDeltas.get(STAKER)!;
    expect(s.delta).toBe(grc2halford(990) - grc2halford(1000)); // -10
    expect(s.received).toBe(0n);
    expect(s.sent).toBe(grc2halford(10)); // net 990-1000
  });

  it('leaves ordinary (non-coinstake) txs on gross accounting — change still counted', () => {
    // Not a PoS block, so tx[0] is a normal payment, not a coinstake.
    const prev = (t: string) => (t === 'pa'
      ? { address: A, value: grc2halford(100) }
      : null);
    const b = block([
      tx('pay',
        [{ txid: 'pa', vout: 0, sequence: 0 }],
        [vout(30, 0, B), vout(70, 1, A)]), // 30 to B, 70 change back to A
    ]);
    const { addressDeltas } = processTransactions(b, false, prev);
    const a = addressDeltas.get(A)!;
    const recipient = addressDeltas.get(B)!;
    expect(a.sent).toBe(grc2halford(100));    // full input, gross
    expect(a.received).toBe(grc2halford(70)); // change still counted (convention)
    expect(a.delta).toBe(grc2halford(70) - grc2halford(100)); // -30
    expect(recipient.received).toBe(grc2halford(30));
  });
});

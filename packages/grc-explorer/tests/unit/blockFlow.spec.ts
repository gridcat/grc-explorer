import {
  categorizeTx, summarizeBlock, FlowTx, TxFlow,
} from '../../src/lib/blockFlow';
import { grc2halford as g } from '../../src/lib/halford';

const GRC = 100_000_000n; // 1 GRC in halford
const cGRC = GRC / 100n; // 0.01 GRC — keeps fractional fixtures single-op (lint)

// Minimal FlowTx builder with sensible defaults.
function tx(over: Partial<FlowTx>): FlowTx {
  return {
    txId: 'tx',
    isCoinbase: false,
    isCoinstake: false,
    inputs: [],
    outputs: [],
    ...over,
  };
}

const cat = (tf: TxFlow, c: string) => tf.flows.filter((f) => f.category === c);
const one = (tf: TxFlow, c: string) => {
  const f = cat(tf, c);
  expect(f).toHaveLength(1);
  return f[0];
};

describe('categorizeTx — standard payment', () => {
  const tf = categorizeTx(tx({
    txId: 'pay',
    inputs: [{ address: 'Alice', value: 100n * GRC }],
    outputs: [
      {
        voutN: 0, value: 50n * GRC, address: 'Bob', scriptType: 'pubkeyhash',
      },
      {
        voutN: 1, value: 4999n * cGRC, address: 'Alice', scriptType: 'pubkeyhash',
      },
    ],
  }));

  it('splits transfer, change, and fee', () => {
    expect(tf.kind).toBe('standard');
    expect(one(tf, 'transfer')).toMatchObject({ amount: 50n * GRC, to: { address: 'Bob' } });
    expect(one(tf, 'change')).toMatchObject({ amount: 4999n * cGRC, to: { address: 'Alice' } });
    expect(one(tf, 'fee')).toMatchObject({ amount: cGRC, to: { kind: 'network' } });
  });

  it('tallies moved + fee, not change', () => {
    expect(tf.totals.moved).toBe(50n * GRC);
    expect(tf.totals.fee).toBe(cGRC);
  });
});

describe('categorizeTx — coinstake (PoS reward)', () => {
  const tf = categorizeTx(tx({
    txId: 'cs',
    isCoinstake: true,
    inputs: [{ address: 'Staker', value: 1000n * GRC }],
    outputs: [
      {
        voutN: 0, value: 0n, address: '', scriptType: 'nonstandard',
      },
      {
        voutN: 1, value: 1002n * GRC, address: 'Staker', scriptType: 'pubkey',
      },
    ],
    claim: {
      cpid: 'abc', blockSubsidy: 50n * cGRC, researchSubsidy: 150n * cGRC, magnitude: 142, isMrc: false,
    },
  }));

  it('nets principal as stake_return and mints reward to the staker', () => {
    expect(tf.kind).toBe('coinstake');
    expect(one(tf, 'stake_return')).toMatchObject({ amount: 1000n * GRC, from: { isStaker: true }, to: { isStaker: true } });
    expect(one(tf, 'mint_research')).toMatchObject({
      amount: 150n * cGRC,
      from: { kind: 'minted' },
      detail: { cpid: 'abc', magnitude: 142 },
    });
    expect(one(tf, 'mint_block')).toMatchObject({ amount: 50n * cGRC, from: { kind: 'minted' } });
  });

  it('does not mistake the empty marker output for a data record', () => {
    expect(cat(tf, 'data')).toHaveLength(0);
    expect(tf.totals.dataRecords).toBe(0);
  });

  it('minted total equals block + research subsidy', () => {
    expect(tf.totals.minted).toBe(2n * GRC);
    expect(tf.totals.staked).toBe(1000n * GRC);
  });
});

describe('categorizeTx — coinstake collecting block fees', () => {
  // Gridcoin adds the block's tx fees into the coinstake output, so the
  // surplus beyond the claimed subsidies (here 0.3 GRC) flows to the staker.
  const tf = categorizeTx(tx({
    txId: 'cs-fee',
    isCoinstake: true,
    inputs: [{ address: 'Staker', value: 1000n * GRC }],
    outputs: [
      {
        voutN: 0, value: 0n, address: '', scriptType: 'nonstandard',
      },
      {
        voutN: 1, value: 100230n * cGRC, address: 'Staker', scriptType: 'pubkey',
      }, // 1002.3 = 1000 principal + 2 subsidy + 0.3 fees
    ],
    claim: {
      cpid: 'abc', blockSubsidy: 50n * cGRC, researchSubsidy: 150n * cGRC, magnitude: 142, isMrc: false,
    },
  }));

  it('routes collected fees to the staker, not a dead sink', () => {
    const f = one(tf, 'fee');
    expect(f).toMatchObject({ amount: 30n * cGRC, from: { kind: 'network' }, to: { isStaker: true } });
  });

  it('does not double-count fees as minted', () => {
    expect(tf.totals.minted).toBe(2n * GRC); // subsidies only
    expect(tf.totals.fee).toBe(30n * cGRC);
  });
});

describe('categorizeTx — coinstake with sidestake', () => {
  const tf = categorizeTx(tx({
    txId: 'cs-side',
    isCoinstake: true,
    inputs: [{ address: 'Staker', value: 1000n * GRC }],
    outputs: [
      {
        voutN: 0, value: 0n, address: '', scriptType: 'nonstandard',
      },
      {
        voutN: 1, value: 100180n * cGRC, address: 'Staker', scriptType: 'pubkey',
      },
      {
        voutN: 2, value: 20n * cGRC, address: 'DevFund', scriptType: 'pubkeyhash',
      },
    ],
    claim: {
      cpid: 'abc', blockSubsidy: 50n * cGRC, researchSubsidy: 150n * cGRC, magnitude: 142, isMrc: false,
    },
  }));

  it('routes the sidestake from the staker to the recipient', () => {
    expect(one(tf, 'sidestake')).toMatchObject({
      amount: 20n * cGRC,
      from: { isStaker: true },
      to: { address: 'DevFund' },
      detail: { sidestakeKind: 'voluntary' },
    });
  });

  it('keeps the books balanced: minted = staker-retained + sidestaked', () => {
    expect(tf.totals.minted).toBe(2n * GRC);
    expect(tf.totals.sidestaked).toBe(20n * cGRC);
    expect(tf.totals.minted - tf.totals.sidestaked).toBe(180n * cGRC);
  });
});

describe('categorizeTx — coinbase', () => {
  it('emits nothing for an empty PoS coinbase', () => {
    const tf = categorizeTx(tx({
      txId: 'cb',
      isCoinbase: true,
      inputs: [{ address: null, value: 0n }],
      outputs: [{
        voutN: 0, value: 0n, address: '', scriptType: 'nonstandard',
      }],
    }));
    expect(tf.kind).toBe('coinbase');
    expect(tf.flows).toHaveLength(0);
  });

  it('mints to the payout address when the coinbase carries value', () => {
    const tf = categorizeTx(tx({
      txId: 'cb2',
      isCoinbase: true,
      inputs: [{ address: null, value: 0n }],
      outputs: [{
        voutN: 0, value: 10n * GRC, address: 'Miner', scriptType: 'pubkeyhash',
      }],
    }));
    expect(one(tf, 'mint_block')).toMatchObject({ amount: 10n * GRC, to: { address: 'Miner' } });
  });
});

describe('categorizeTx — OP_RETURN data', () => {
  const tf = categorizeTx(tx({
    txId: 'stamp',
    inputs: [{ address: 'Alice', value: 10n * GRC }],
    outputs: [
      {
        voutN: 0, value: 999n * cGRC, address: 'Alice', scriptType: 'pubkeyhash',
      },
      {
        voutN: 1, value: 0n, address: '', scriptType: 'nulldata',
      },
    ],
    contracts: [{ voutN: 1, kind: 'stamp', summary: 'SHA-256 document timestamp' }],
  }));

  it('decodes the contract on the data output', () => {
    expect(one(tf, 'data')).toMatchObject({ amount: 0n, to: { kind: 'opreturn' }, detail: { contract: { kind: 'stamp' } } });
    expect(tf.totals.dataRecords).toBe(1);
  });
});

describe('categorizeTx — coinstake without a claim', () => {
  it('shows the minted surplus as a block reward', () => {
    const tf = categorizeTx(tx({
      txId: 'cs-noclaim',
      isCoinstake: true,
      inputs: [{ address: 'Staker', value: 1000n * GRC }],
      outputs: [
        {
          voutN: 0, value: 0n, address: '', scriptType: 'nonstandard',
        },
        {
          voutN: 1, value: 1001n * GRC, address: 'Staker', scriptType: 'pubkey',
        },
      ],
    }));
    expect(cat(tf, 'mint_research')).toHaveLength(0);
    expect(one(tf, 'mint_block')).toMatchObject({ amount: 1n * GRC });
  });
});

describe('summarizeBlock', () => {
  it('rolls up a PoS block with a payment and a stamp', () => {
    const coinstake = categorizeTx(tx({
      txId: 'cs',
      isCoinstake: true,
      inputs: [{ address: 'Staker', value: 1000n * GRC }],
      outputs: [
        {
          voutN: 0, value: 0n, address: '', scriptType: 'nonstandard',
        },
        {
          voutN: 1, value: 1002n * GRC, address: 'Staker', scriptType: 'pubkey',
        },
      ],
      claim: {
        cpid: 'abc', blockSubsidy: 50n * cGRC, researchSubsidy: 150n * cGRC, magnitude: 142, isMrc: false,
      },
    }));
    const payment = categorizeTx(tx({
      txId: 'pay',
      inputs: [{ address: 'Alice', value: 100n * GRC }],
      outputs: [{
        voutN: 0, value: 50n * GRC, address: 'Bob', scriptType: 'pubkeyhash',
      }],
    }));
    const stamp = categorizeTx(tx({
      txId: 'stamp',
      inputs: [{ address: 'Carol', value: 1n * GRC }],
      outputs: [{
        voutN: 0, value: 0n, address: '', scriptType: 'nulldata',
      }],
      contracts: [{ kind: 'stamp', summary: 'doc' }],
    }));

    const s = summarizeBlock(1_900_000, [coinstake, payment, stamp]);
    expect(s.txCount).toBe(3);
    expect(s.minted).toMatchObject({
      block: 50n * cGRC, research: 150n * cGRC, cpid: 'abc', magnitude: 142,
    });
    expect(s.moved).toBe(50n * GRC);
    expect(s.staked).toBe(1000n * GRC);
    expect(s.data.stamps).toBe(1);
  });

  it('counts distinct sidestake recipients', () => {
    const mk = (staker: string) => categorizeTx(tx({
      txId: staker,
      isCoinstake: true,
      inputs: [{ address: staker, value: 100n * GRC }],
      outputs: [
        {
          voutN: 1, value: 10050n * cGRC, address: staker, scriptType: 'pubkey',
        },
        {
          voutN: 2, value: 50n * cGRC, address: 'Fund', scriptType: 'pubkeyhash',
        },
      ],
      claim: {
        cpid: null, blockSubsidy: GRC, researchSubsidy: 0n, magnitude: null, isMrc: false,
      },
      mandatorySidestakeAddresses: ['Fund'],
    }));
    const s = summarizeBlock(1, [mk('S1'), mk('S2')]);
    expect(s.sidestaked.total).toBe(GRC); // 0.5 + 0.5
    expect(s.sidestaked.recipients).toBe(1); // same 'Fund' both times
  });
});

describe('categorizeTx — coinstake paying MRCs (mainnet block 3584156 shape)', () => {
  // Real numbers: staker claims 10.40481480 research + 10 block; one MRC
  // mints 151.57773139 for another CPID, of which 47.13569435 is the fee
  // (37.70855548 foundation + 9.42713887 staker). The 0.001 left over is
  // the block's actual collected tx fees.
  const tf = categorizeTx(tx({
    txId: 'cs-mrc',
    isCoinstake: true,
    inputs: [{ address: 'Staker', value: g('12339.75254048') }],
    outputs: [
      {
        voutN: 0, value: 0n, address: '', scriptType: 'nonstandard',
      },
      {
        voutN: 1, value: g('12369.58549415'), address: 'Staker', scriptType: 'pubkey',
      },
      {
        voutN: 2, value: g('37.70855548'), address: 'Foundation', scriptType: 'scripthash',
      },
      {
        voutN: 3, value: g('104.44203704'), address: 'MrcClaimant', scriptType: 'pubkeyhash',
      },
    ],
    claim: {
      cpid: 'staker-cpid',
      blockSubsidy: 10n * GRC,
      researchSubsidy: g('10.40481480'),
      magnitude: 140,
      isMrc: true,
      mrcFoundationFees: g('37.70855548'),
      mrcStakerFees: g('9.42713887'),
    },
    mrcs: [{
      cpid: 'mrc-cpid', researchSubsidy: g('151.57773139'), fee: g('47.13569435'), magnitude: 0,
    }],
  }));

  it('keeps the staker\'s own subsidies intact', () => {
    expect(one(tf, 'mint_block')).toMatchObject({ amount: 10n * GRC, to: { isStaker: true } });
    const own = cat(tf, 'mint_research').find((f) => !f.detail?.isMrc);
    expect(own).toMatchObject({ amount: g('10.40481480'), to: { isStaker: true }, detail: { cpid: 'staker-cpid' } });
  });

  it('pays the MRC claimant their net subsidy at the matched vout', () => {
    const mrc = cat(tf, 'mint_research').find((f) => f.detail?.isMrc);
    expect(mrc).toMatchObject({
      amount: g('104.44203704'),
      from: { kind: 'minted' },
      to: { address: 'MrcClaimant' },
      voutIdx: 3,
      detail: { cpid: 'mrc-cpid', isMrc: true },
    });
  });

  it('splits the MRC fee between the foundation and the staker', () => {
    const fees = cat(tf, 'mrc_fee');
    expect(fees).toHaveLength(2);
    expect(fees).toContainEqual(expect.objectContaining({
      amount: g('37.70855548'), to: expect.objectContaining({ address: 'Foundation' }), voutIdx: 2,
    }));
    expect(fees).toContainEqual(expect.objectContaining({
      amount: g('9.42713887'), to: expect.objectContaining({ isStaker: true }),
    }));
  });

  it('leaves only the true collected tx fees as the residual', () => {
    expect(one(tf, 'fee')).toMatchObject({ amount: g('0.001'), from: { kind: 'network' }, to: { isStaker: true } });
  });

  it('books the whole MRC mint as minted', () => {
    // 10.40481480 + 10 + 151.57773139 (claimant net + both fee shares)
    expect(tf.totals.minted).toBe(g('171.98254619'));
  });

  it('rolls MRCs up separately and keeps the staker\'s claim CPID', () => {
    const s = summarizeBlock(3_584_156, [tf]);
    expect(s.minted).toMatchObject({
      block: 10n * GRC, research: g('10.40481480'), mrc: g('151.57773139'), cpid: 'staker-cpid', magnitude: 140,
    });
  });
});

describe('categorizeTx — MRC rows indexed before the fee column', () => {
  it('derives a single MRC\'s net payout from the block-level fee split', () => {
    const tf = categorizeTx(tx({
      txId: 'cs-mrc-nofee',
      isCoinstake: true,
      inputs: [{ address: 'Staker', value: 1000n * GRC }],
      outputs: [
        {
          voutN: 0, value: 0n, address: '', scriptType: 'nonstandard',
        },
        {
          voutN: 1, value: 1013n * GRC, address: 'Staker', scriptType: 'pubkey',
        }, // principal + 10 block + 3 staker fee share
        {
          voutN: 2, value: 12n * GRC, address: 'Foundation', scriptType: 'scripthash',
        },
        {
          voutN: 3, value: 135n * GRC, address: 'MrcClaimant', scriptType: 'pubkeyhash',
        }, // 150 subsidy − 15 fee
      ],
      claim: {
        cpid: null,
        blockSubsidy: 10n * GRC,
        researchSubsidy: 0n,
        magnitude: null,
        isMrc: true,
        mrcFoundationFees: 12n * GRC,
        mrcStakerFees: 3n * GRC,
      },
      mrcs: [{
        cpid: 'mrc-cpid', researchSubsidy: 150n * GRC, fee: null, magnitude: 12,
      }],
    }));
    const mrc = one(tf, 'mint_research');
    expect(mrc).toMatchObject({ amount: 135n * GRC, to: { address: 'MrcClaimant' }, detail: { isMrc: true } });
    expect(cat(tf, 'fee')).toHaveLength(0); // investor staker, books balance exactly
    expect(cat(tf, 'mint_block')).toHaveLength(1); // no surplus-fallback double-mint
  });

  it('matches multi-MRC payouts by beacon address', () => {
    const tf = categorizeTx(tx({
      txId: 'cs-mrc-beacons',
      isCoinstake: true,
      inputs: [{ address: 'Staker', value: 1000n * GRC }],
      outputs: [
        {
          voutN: 0, value: 0n, address: '', scriptType: 'nonstandard',
        },
        {
          voutN: 1, value: 1013n * GRC, address: 'Staker', scriptType: 'pubkey',
        },
        {
          voutN: 2, value: 12n * GRC, address: 'Foundation', scriptType: 'scripthash',
        },
        {
          voutN: 3, value: 90n * GRC, address: 'AddrA', scriptType: 'pubkeyhash',
        },
        {
          voutN: 4, value: 45n * GRC, address: 'AddrB', scriptType: 'pubkeyhash',
        },
      ],
      claim: {
        cpid: null,
        blockSubsidy: 10n * GRC,
        researchSubsidy: 0n,
        magnitude: null,
        isMrc: true,
        mrcFoundationFees: 12n * GRC,
        mrcStakerFees: 3n * GRC,
      },
      mrcs: [
        {
          cpid: 'cpid-a', researchSubsidy: 100n * GRC, fee: null, magnitude: 5, beaconAddresses: ['AddrA'],
        },
        {
          cpid: 'cpid-b', researchSubsidy: 50n * GRC, fee: null, magnitude: 3, beaconAddresses: ['AddrB'],
        },
      ],
    }));
    const mrcFlows = cat(tf, 'mint_research');
    expect(mrcFlows).toContainEqual(expect.objectContaining({
      amount: 90n * GRC, to: expect.objectContaining({ address: 'AddrA' }), detail: expect.objectContaining({ cpid: 'cpid-a' }),
    }));
    expect(mrcFlows).toContainEqual(expect.objectContaining({
      amount: 45n * GRC, to: expect.objectContaining({ address: 'AddrB' }), detail: expect.objectContaining({ cpid: 'cpid-b' }),
    }));
    expect(cat(tf, 'fee')).toHaveLength(0);
  });
});

describe('categorizeTx — MRC vouts are not sidestakes', () => {
  // Sidestakes are derived from the coinstake outputs; MRC payout vouts
  // must not be double-reported as sidestakes alongside their MRC flows.
  it('synthesizes only the genuine sidestake, not the MRC payouts', () => {
    const tf = categorizeTx(tx({
      txId: 'cs-mrc-v13',
      isCoinstake: true,
      inputs: [{ address: 'Staker', value: 1000n * GRC }],
      outputs: [
        {
          voutN: 0, value: 0n, address: '', scriptType: 'nonstandard',
        },
        {
          voutN: 1, value: 1015n * GRC, address: 'Staker', scriptType: 'pubkey',
        }, // principal + 5 research + 10 block + 2 staker fee − 2 sidestaked
        {
          voutN: 2, value: 2n * GRC, address: 'DevFund', scriptType: 'pubkeyhash',
        },
        {
          voutN: 3, value: 8n * GRC, address: 'Foundation', scriptType: 'scripthash',
        },
        {
          voutN: 4, value: 90n * GRC, address: 'MrcClaimant', scriptType: 'pubkeyhash',
        },
      ],
      claim: {
        cpid: 'abc',
        blockSubsidy: 10n * GRC,
        researchSubsidy: 5n * GRC,
        magnitude: 9,
        isMrc: true,
        mrcFoundationFees: 8n * GRC,
        mrcStakerFees: 2n * GRC,
      },
      mrcs: [{
        cpid: 'mrc-cpid', researchSubsidy: 100n * GRC, fee: 10n * GRC, magnitude: 7,
      }],
    }));
    expect(one(tf, 'sidestake')).toMatchObject({ amount: 2n * GRC, to: { address: 'DevFund' } });
    const mrc = cat(tf, 'mint_research').find((f) => f.detail?.isMrc);
    expect(mrc).toMatchObject({ amount: 90n * GRC, to: { address: 'MrcClaimant' }, voutIdx: 4 });
    expect(cat(tf, 'mrc_fee')).toContainEqual(expect.objectContaining({
      amount: 8n * GRC, to: expect.objectContaining({ address: 'Foundation' }), voutIdx: 3,
    }));
    expect(cat(tf, 'fee')).toHaveLength(0); // books balance exactly — no residual
  });
});

describe('categorizeTx — coinstake sidestake synthesis', () => {
  it('nets same-address stake splits into the principal, never a sidestake', () => {
    // mainnet 3999946 shape: the staker splits the stake — vout 2 pays
    // their own address — before the sidestakes.
    const tf = categorizeTx(tx({
      txId: 'cs-split',
      isCoinstake: true,
      inputs: [{ address: 'Staker', value: 8000n * GRC }],
      outputs: [
        {
          voutN: 0, value: 0n, address: '', scriptType: 'nonstandard',
        },
        {
          voutN: 1, value: 4004n * GRC, address: 'Staker', scriptType: 'pubkey',
        },
        {
          voutN: 2, value: 4004n * GRC, address: 'Staker', scriptType: 'pubkey',
        },
        {
          voutN: 3, value: 2n * GRC, address: 'Fund', scriptType: 'pubkeyhash',
        },
      ],
      claim: {
        cpid: null, blockSubsidy: 10n * GRC, researchSubsidy: 0n, magnitude: null, isMrc: false,
      },
      mandatorySidestakeAddresses: ['Fund'],
    }));
    expect(one(tf, 'sidestake')).toMatchObject({
      amount: 2n * GRC, to: { address: 'Fund' }, detail: { sidestakeKind: 'mandatory' },
    });
    expect(tf.totals.sidestaked).toBe(2n * GRC); // the 4004 split is NOT sidestaked
  });

  it('surfaces pre-V13 voluntary sidestakes from the outputs (mainnet 3725931 shape)', () => {
    // Investor staker donates the whole 10 GRC block reward via a local
    // sidestake — no registry, no coinstake_sidestakes row, v12 block.
    const tf = categorizeTx(tx({
      txId: 'cs-v12-side',
      isCoinstake: true,
      inputs: [{ address: 'Staker', value: g('4301.34421173') }],
      outputs: [
        {
          voutN: 0, value: 0n, address: '', scriptType: 'nonstandard',
        },
        {
          voutN: 1, value: g('4301.34421173'), address: 'Staker', scriptType: 'pubkey',
        },
        {
          voutN: 2, value: 10n * GRC, address: 'Charity', scriptType: 'pubkeyhash',
        },
      ],
      claim: {
        cpid: null, blockSubsidy: 10n * GRC, researchSubsidy: 0n, magnitude: null, isMrc: false,
      },
    }));
    expect(one(tf, 'sidestake')).toMatchObject({
      amount: 10n * GRC, to: { address: 'Charity' }, detail: { sidestakeKind: 'voluntary' },
    });
    expect(one(tf, 'mint_block')).toMatchObject({ amount: 10n * GRC, to: { isStaker: true } });
    expect(cat(tf, 'fee')).toHaveLength(0); // books: reward minted then sidestaked away
  });
});

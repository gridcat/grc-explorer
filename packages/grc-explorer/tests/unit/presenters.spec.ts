import { BlockPresenter, TransactionPresenter } from '../../src/presenters';

// Pins the JSON:API envelope yayson produces. The presenters are the
// only consumer of yayson in the backend, and nothing else exercised
// them at runtime when the dependency moved from 3.x to 4.x.

const block = {
  height: 1000000,
  hash: 'a'.repeat(64),
  prev_hash: 'b'.repeat(64),
  merkle_root: 'c'.repeat(64),
  time: 1700000000,
  n_version: 12,
  difficulty: 3.5,
  size: 512,
  tx_count: 2,
  is_pos: true,
  is_superblock: false,
  miner_address: 'S1234567890abcdefghijklmnopqrstuv',
  staker_cpid: null,
  mint: 150000000n,
  money_supply: 46000000000000000n,
};

describe('presenters (yayson)', () => {
  it('renders a single row as a JSON:API resource with id, attributes and self link', () => {
    const body = BlockPresenter.render(block) as {
      data: { type: string; id: string; attributes: Record<string, unknown>; links: { self: string } };
    };
    expect(body.data.type).toBe('blocks');
    expect(body.data.id).toBe('1000000');
    expect(body.data.attributes.mint).toBe('1.5');
    expect(body.data.attributes.stakerName).toBeNull();
    expect(body.data.links.self).toBe('/blocks/1000000');
  });

  it('renders a list with meta and survives JSON.stringify (no BigInt leaks)', () => {
    const body = BlockPresenter.render([block, { ...block, height: 1000001 }], { meta: { count: 2 } }) as {
      data: Array<{ id: string }>; meta: { count: number };
    };
    expect(body.data.map((d) => d.id)).toEqual(['1000000', '1000001']);
    expect(body.meta.count).toBe(2);
    expect(() => JSON.stringify(body)).not.toThrow();
  });

  it('renders the transaction self link and fee as a GRC string', () => {
    const tx = {
      tx_id: 'd'.repeat(64),
      block_height: 1,
      block_hash: 'e'.repeat(64),
      time: 1,
      size: 1,
      fee: 100000n,
      vin_count: 1,
      vout_count: 1,
      total_in: 0n,
      total_out: 0n,
      is_coinbase: false,
      is_coinstake: true,
    };
    const body = TransactionPresenter.render(tx) as {
      data: { id: string; attributes: { fee: string }; links?: { self: string } };
    };
    expect(body.data.id).toBe('d'.repeat(64));
    expect(body.data.attributes.fee).toBe('0.001');
    expect(body.data.links?.self).toBe(`/transactions/${'d'.repeat(64)}`);
  });
});

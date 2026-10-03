import express from 'express';
import request from 'supertest';
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

// GET /addresses/:a bounds the linked-wallets/combined block with a
// deadline and answers `linkedDeferred: true` past it; GET
// /addresses/:a/linked returns the block, joining a still-running
// computation instead of starting a second one.

const ADDR = 'mhn6H1ygPYnQ7nhgyVNz9Bwd2DCwqnh9V8';
const SIBLING = 'mfiy9sc2QEZZCK3WMUMZjNfrdRA6gXzRhr';

const clusterDelay = { ms: 0 };
const getClustersForAddresses = vi.fn(async (seed: string[]) => {
  await new Promise((r) => { setTimeout(r, clusterDelay.ms); });
  return seed;
});

vi.mock('../../src/lib/cluster', () => ({ getClustersForAddresses }));
vi.mock('../../src/lib/db', () => ({
  query: vi.fn(async (sql: string) => {
    if (sql.includes('SELECT DISTINCT cpid')) return [{ cpid: 'c'.repeat(32) }];
    if (sql.includes('GROUP BY cpid, address')) {
      return [{
        cpid: 'c'.repeat(32), address: SIBLING, beacon_count: 1, staked_blocks: 0, mrc_payouts: 0, first_height: 1, last_height: 2,
      }];
    }
    return [];
  }),
}));
vi.mock('../../src/lib/addressState', () => ({
  getWallet: vi.fn(async (address: string) => ({
    address, balance: 100n, totalReceived: 100n, totalSent: 0n, txCount: 1, firstSeenBlock: 1, lastSeenBlock: 2,
  })),
  getWalletBalances: vi.fn(async (addrs: string[]) => new Map(addrs.map((a) => [a, 100n]))),
  getRichList: vi.fn(),
  getWalletCount: vi.fn(),
}));
vi.mock('../../src/lib/supply', () => ({
  getMoneySupplyRaw: vi.fn(async () => 1_000_000n),
  sharePct: (part: bigint, supply: bigint) => Number((part * 10_000n) / supply) / 100,
}));
vi.mock('../../src/lib/indexerTip', () => ({
  getBlockTimes: vi.fn(async () => new Map()),
  getTipAnchor: vi.fn(),
}));

const { addressesRouter } = await import('../../src/routes/addresses');
const app = express().use('/addresses', addressesRouter);

describe('GET /addresses/:address linked deadline', () => {
  beforeEach(() => {
    getClustersForAddresses.mockClear();
    clusterDelay.ms = 0;
  });

  it('inlines the linked block when it is fast', async () => {
    const r = await request(app).get(`/addresses/${ADDR}`);
    expect(r.status).toBe(200);
    expect(r.body.linkedDeferred).toBeUndefined();
    expect(r.body.linkedWallets.map((w: { address: string }) => w.address)).toEqual([SIBLING]);
    expect(r.body.combinedCount).toBe(2);
  });

  it('defers a slow block and serves it from /linked without recomputing', async () => {
    clusterDelay.ms = 3_500;
    const t0 = Date.now();
    const r = await request(app).get(`/addresses/${ADDR}`);
    expect(Date.now() - t0).toBeLessThan(3_400);
    expect(r.status).toBe(200);
    expect(r.body.linkedDeferred).toBe(true);
    expect(r.body.linkedWallets).toBeUndefined();
    expect(r.body.data.attributes.balance).toBeDefined();

    const linked = await request(app).get(`/addresses/${ADDR}/linked`);
    expect(linked.status).toBe(200);
    expect(linked.body.combinedCount).toBe(2);
    expect(linked.body.linkedCpids).toEqual(['c'.repeat(32)]);
    expect(getClustersForAddresses).toHaveBeenCalledTimes(1);
  }, 10_000);
});

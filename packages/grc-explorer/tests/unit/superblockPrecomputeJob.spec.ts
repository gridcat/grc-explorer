import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

// SuperblockPrecomputeJob rewrites only the stored payloads whose
// superblock height moved, and does nothing until a new superblock lands.

const state = {
  cursor: { status: 'live' } as { status: string } | null,
  newestSuperblock: 0 as number | null,
  stored: new Map<string, number>(),
  history: [] as Array<{ height: number; date: string }>,
};

const writePrecomputed = vi.fn(async (key: string, h: number) => { state.stored.set(key, h); });
const deletePrecomputed = vi.fn(async (keys: string[]) => { keys.forEach((k) => state.stored.delete(k)); });
const buildSeries = vi.fn(async () => []);
const buildResearchersHistory = vi.fn(async () => state.history);

vi.mock('../../src/lib/redis', () => ({ getCursor: vi.fn(async () => state.cursor) }));
vi.mock('../../src/lib/db', () => ({
  maintenanceQuery: vi.fn(async () => [{ h: state.newestSuperblock }]),
}));
vi.mock('../../src/lib/researchersHistory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/lib/researchersHistory')>()),
  buildResearchersHistory,
  buildSeries,
  readPrecomputedHeights: vi.fn(async () => new Map(state.stored)),
  writePrecomputed,
  deletePrecomputed,
}));

const { SuperblockPrecomputeJob } = await import('../../src/services/jobs/SuperblockPrecomputeJob');

const sb = (height: number, date: string) => ({ height, date });

describe('SuperblockPrecomputeJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.cursor = { status: 'live' };
    state.stored = new Map();
    state.history = [sb(100, '2024-12-30'), sb(200, '2025-01-02'), sb(300, '2025-06-01')];
    state.newestSuperblock = 300;
  });

  it('builds every key on first run', async () => {
    await new SuperblockPrecomputeJob().tick();
    expect([...state.stored.entries()].sort()).toEqual([
      ['researchers:history', 300],
      ['researchers:series:chain', 300],
      ['researchers:series:year:2024', 100],
      ['researchers:series:year:2025', 300],
    ]);
    expect(buildSeries).toHaveBeenCalledWith(0, 100, 300, 30);
    expect(buildSeries).toHaveBeenCalledWith(2024, 100, 100, 30);
    expect(buildSeries).toHaveBeenCalledWith(2025, 200, 300, 30);
  });

  it('does nothing while the stored history matches the newest superblock', async () => {
    const job = new SuperblockPrecomputeJob();
    await job.tick();
    vi.clearAllMocks();
    await job.tick();
    expect(buildResearchersHistory).not.toHaveBeenCalled();
    expect(writePrecomputed).not.toHaveBeenCalled();
  });

  it('rebuilds only the history, chain and current year on a new superblock', async () => {
    const job = new SuperblockPrecomputeJob();
    await job.tick();
    vi.clearAllMocks();
    state.history = [...state.history, sb(400, '2025-06-02')];
    state.newestSuperblock = 400;
    await job.tick();
    expect(writePrecomputed.mock.calls.map((c) => c[0]).sort()).toEqual([
      'researchers:history',
      'researchers:series:chain',
      'researchers:series:year:2025',
    ]);
  });

  it('writes nothing when the rollup still shows the previous superblock', async () => {
    const job = new SuperblockPrecomputeJob();
    await job.tick();
    vi.clearAllMocks();
    state.newestSuperblock = 400; // superblock row in, researcher stats not rebuilt yet
    await job.tick();
    expect(writePrecomputed).not.toHaveBeenCalled();
  });

  it('deletes years that disappeared after a reorg or wipe', async () => {
    const job = new SuperblockPrecomputeJob();
    await job.tick();
    state.history = [sb(100, '2024-12-30')];
    state.newestSuperblock = 100;
    await job.tick();
    expect(deletePrecomputed).toHaveBeenLastCalledWith(['researchers:series:year:2025']);
    expect(state.stored.get('researchers:history')).toBe(100);
  });

  it('skips while the indexer is not live', async () => {
    state.cursor = { status: 'backfilling' };
    await new SuperblockPrecomputeJob().tick();
    expect(buildResearchersHistory).not.toHaveBeenCalled();
    expect(writePrecomputed).not.toHaveBeenCalled();
  });
});

import { describe, it, expect } from 'vitest';
import {
  legacySuperblockProjectName,
  superblockProjectRenames,
} from '../../src/migrations/0025_superblock_project_names';

describe('legacySuperblockProjectName', () => {
  it('reproduces the stored form of camelCased + lowercased daemon names', () => {
    expect(legacySuperblockProjectName('TN-Grid')).toBe('tngrid');
    expect(legacySuperblockProjectName('World_Community_Grid')).toBe('worldcommunitygrid');
    expect(legacySuperblockProjectName('SRBase')).toBe('srbase');
    expect(legacySuperblockProjectName('asteroids@home')).toBe('asteroids@home');
  });
});

describe('superblockProjectRenames', () => {
  it('maps old stored names to project_contracts names', () => {
    const renames = superblockProjectRenames(['tn-grid', 'world_community_grid', 'srbase', 'odlk1']);
    expect([...renames]).toEqual([
      ['tngrid', 'tn-grid'],
      ['worldcommunitygrid', 'world_community_grid'],
    ]);
  });

  it('skips names whose old form is ambiguous', () => {
    const renames = superblockProjectRenames(['tn-grid', 'tn_grid', 'world_community_grid']);
    expect([...renames]).toEqual([['worldcommunitygrid', 'world_community_grid']]);
  });
});

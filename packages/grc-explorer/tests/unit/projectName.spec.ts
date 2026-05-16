import { describe, it, expect } from 'vitest';
import { normalizeProjectName } from '../../src/lib/projectName';

describe('normalizeProjectName', () => {
  it('collapses the case twins seen on-chain and in user.gz', () => {
    expect(normalizeProjectName('Moowrap')).toBe('moowrap');
    expect(normalizeProjectName('moowrap')).toBe('moowrap');
    expect(normalizeProjectName('MilkyWay@home')).toBe('milkyway@home');
    expect(normalizeProjectName('milkyway@home')).toBe('milkyway@home');
    expect(normalizeProjectName('NFS@Home')).toBe('nfs@home');
    expect(normalizeProjectName('Asteroids@home')).toBe('asteroids@home');
  });

  it('is idempotent', () => {
    const once = normalizeProjectName('World_Community_Grid');
    expect(normalizeProjectName(once)).toBe(once);
  });

  it('trims surrounding whitespace as well as casing', () => {
    expect(normalizeProjectName('  Rosetta@home \t')).toBe('rosetta@home');
  });

  it('preserves the rest of the string verbatim (no slug rewriting)', () => {
    // Only case + edge whitespace change; @, digits, separators stay.
    expect(normalizeProjectName('NumberFields@home')).toBe('numberfields@home');
    expect(normalizeProjectName('odlk1')).toBe('odlk1');
  });
});

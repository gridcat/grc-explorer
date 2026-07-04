import { describe, it, expect } from 'vitest';
import { compile } from '../../src/lib/db';

// `compile` is the param compiler that replaces DuckDB's $name binding +
// listValue() array wrapping with mysql2 positional `?` + in-place array
// expansion. It's the one piece of non-trivial pure logic in the MariaDB
// layer, and every ported query depends on it, so pin its behaviour.

describe('compile', () => {
  it('passes SQL through untouched when there are no params', () => {
    expect(compile('SELECT 1')).toEqual({ text: 'SELECT 1', values: [] });
  });

  it('substitutes named params in order of appearance', () => {
    const { text, values } = compile(
      'SELECT * FROM blocks WHERE height = $h AND hash = $hash',
      { h: 5, hash: 'abc' },
    );
    expect(text).toBe('SELECT * FROM blocks WHERE height = ? AND hash = ?');
    expect(values).toEqual([5, 'abc']);
  });

  it('repeats a value once per occurrence of the same named param', () => {
    const { text, values } = compile(
      'WHERE a >= $h AND b <= $h',
      { h: 9 },
    );
    expect(text).toBe('WHERE a >= ? AND b <= ?');
    expect(values).toEqual([9, 9]);
  });

  it('expands an array param to a comma list of placeholders (IN-list)', () => {
    const { text, values } = compile(
      'WHERE poll_id IN ($ids)',
      { ids: ['a', 'b', 'c'] },
    );
    expect(text).toBe('WHERE poll_id IN (?, ?, ?)');
    expect(values).toEqual(['a', 'b', 'c']);
  });

  it('expands an empty array to NULL so IN (NULL) matches nothing', () => {
    const { text, values } = compile('WHERE x IN ($ids)', { ids: [] });
    expect(text).toBe('WHERE x IN (NULL)');
    expect(values).toEqual([]);
  });

  it('supports positional $1-style params from an array', () => {
    const { text, values } = compile('VALUES ($1, $2)', [10n, 'x']);
    expect(text).toBe('VALUES (?, ?)');
    expect(values).toEqual([10n, 'x']);
  });

  it('binds null and bigint values through unchanged', () => {
    const { values } = compile('SET a = $a, b = $b', { a: null, b: 123456789012345678n });
    expect(values).toEqual([null, 123456789012345678n]);
  });
});

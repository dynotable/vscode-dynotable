import {describe, expect, it} from 'vitest';
import type {RunResult} from '../../src/protocol';
import {renderTable} from './table';

const result = (
  columns: string[],
  rows: Array<Record<string, unknown>>,
  executedStatement = 'SELECT * FROM "t"'
): RunResult => ({
  columns,
  rows,
  returnedRows: rows.length,
  totalRows: rows.length,
  truncated: false,
  approximateBytes: 0,
  elapsedMs: 12,
  executedStatement,
  effectiveRowCap: 1000
});

const plain = (width: number) => ({width, color: false});

describe('renderTable', () => {
  it('prints the statement, a box table with a right-aligned numeric column, and the summary', () => {
    const rows = [
      {id: 1, name: 'Ann'},
      {id: 10, name: 'Bo'}
    ];
    expect(renderTable(result(['id', 'name'], rows), plain(120))).toBe(
      [
        'SELECT * FROM "t"',
        '┌────┬──────┐',
        '│ id │ name │',
        '├────┼──────┤',
        '│  1 │ Ann  │',
        '│ 10 │ Bo   │',
        '└────┴──────┘',
        '2 of 2 rows · 12 ms',
        ''
      ].join('\n')
    );
  });

  it('cuts the widest column with … until the table fits the width', () => {
    const rows = [{id: 1, note: 'a fairly long note that will not fit'}];
    expect(renderTable(result(['id', 'note'], rows), plain(30))).toBe(
      [
        'SELECT * FROM "t"',
        '┌────┬───────────────────────┐',
        '│ id │ note                  │',
        '├────┼───────────────────────┤',
        '│  1 │ a fairly long note t… │',
        '└────┴───────────────────────┘',
        '1 of 1 rows · 12 ms',
        ''
      ].join('\n')
    );
  });

  // Cutting every column to a few characters would print a table nobody can read.
  it('stops cutting at 8 characters and prints wider than the terminal', () => {
    const columns = 'abcdefghijklmnopqrst'.split('');
    const row = Object.fromEntries(columns.map((column) => [column, 'abcdefghijkl']));
    const lines = renderTable(result(columns, [row]), plain(80)).split('\n');
    expect(lines[4]).toBe(`${'│ abcdefg… '.repeat(20)}│`);
    expect(lines.slice(1, 6).map((line) => line.length)).toEqual([221, 221, 221, 221, 221]);
  });

  it('writes null, missing, a tagged value, a boolean and a list as the grid does', () => {
    const rows = [{a: null, c: {N: '1.10'}, d: true, e: [1, 'x']}];
    expect(renderTable(result(['a', 'b', 'c', 'd', 'e'], rows), plain(120))).toBe(
      [
        'SELECT * FROM "t"',
        '┌──────┬───┬──────────────┬──────┬─────────┐',
        '│ a    │ b │ c            │ d    │ e       │',
        '├──────┼───┼──────────────┼──────┼─────────┤',
        '│ null │   │ {"N":"1.10"} │ true │ [1,"x"] │',
        '└──────┴───┴──────────────┴──────┴─────────┘',
        '1 of 1 rows · 12 ms',
        ''
      ].join('\n')
    );
  });

  // Data and the statement come from the table: an escape sequence must not reach the terminal.
  it('makes control characters visible in cells, column names and the statement', () => {
    const rows = [{'n\x1b[31m': 'a\x1bb\rc\td\ne\x7ff\x9bg'}];
    const statement = 'SELECT \x1b[2J*\r\nFROM "t"';
    expect(renderTable(result(['n\x1b[31m'], rows, statement), plain(120))).toBe(
      [
        'SELECT \\x1b[2J*',
        '┌────────────────────────┐',
        '│ n\\x1b[31m              │',
        '├────────────────────────┤',
        '│ a\\x1bb␍c⇥d⏎e\\x7ff\\x9bg │',
        '└────────────────────────┘',
        '1 of 1 rows · 12 ms',
        ''
      ].join('\n')
    );
  });

  it('counts an emoji as one character and never cuts it in half', () => {
    const rows = [{x: '😀😀😀😀😀😀😀😀😀😀'}];
    expect(renderTable(result(['x'], rows), plain(12))).toBe(
      [
        'SELECT * FROM "t"',
        '┌──────────┐',
        '│ x        │',
        '├──────────┤',
        '│ 😀😀😀😀😀😀😀… │',
        '└──────────┘',
        '1 of 1 rows · 12 ms',
        ''
      ].join('\n')
    );
  });

  it('prints no table for a result with no columns', () => {
    expect(renderTable(result([], []), plain(120))).toBe(
      'SELECT * FROM "t"\n0 of 0 rows · 12 ms\n'
    );
  });

  it('with color, makes the header bold and the borders and null cells dim', () => {
    const [bold, dim, off] = ['\x1b[1m', '\x1b[2m', '\x1b[0m'];
    const bar = `${dim}│${off}`;
    expect(
      renderTable(result(['id', 'name'], [{id: 1, name: null}]), {width: 120, color: true})
    ).toBe(
      [
        'SELECT * FROM "t"',
        `${dim}┌────┬──────┐${off}`,
        `${bar} ${bold}id${off} ${bar} ${bold}name${off} ${bar}`,
        `${dim}├────┼──────┤${off}`,
        `${bar}  1 ${bar} ${dim}null${off} ${bar}`,
        `${dim}└────┴──────┘${off}`,
        '1 of 1 rows · 12 ms',
        ''
      ].join('\n')
    );
  });
});

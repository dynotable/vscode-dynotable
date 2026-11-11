import {describe, expect, it} from 'vitest';
import {
  type Cell,
  cellKind,
  cellMatches,
  compareCells,
  distinctValues,
  inValueSet,
  isNumericColumn,
  totals
} from './grid-model';

const missing: Cell = {text: '', kind: 'missing'};
const cellsOf = (...values: unknown[]): Cell[] =>
  values.map((value) => (value === missing ? missing : cellKind({v: value}, 'v')));

/** The texts of the cells that are not empty, in the order a column sort gives. */
const sorted = (cells: Cell[]) => {
  const numeric = isNumericColumn(cells);
  return cells
    .filter((cell) => cell.kind !== 'missing' && cell.kind !== 'null')
    .toSorted((a, b) => compareCells(a, b, numeric))
    .map((cell) => cell.text);
};

describe('cellKind', () => {
  const row = {
    'o.orderId': 'A',
    o: {orderId: 'B'},
    nothing: null,
    qty: 9,
    paid: true,
    exact: {N: '12345678901234567890.1'}
  };

  it.each([
    // Every row inherits `toString`: a plain `row[column]` would print a function.
    ['toString', {text: '', kind: 'missing'}],
    ['nothing', {text: 'null', kind: 'null'}],
    ['qty', {text: '9', kind: 'number'}],
    // A path reader would answer "B".
    ['o.orderId', {text: 'A', kind: 'string'}],
    // A boolean is text: it must not count as a number or render dimmed as JSON.
    ['paid', {text: 'true', kind: 'string'}],
    // A tagged exact number must not become a lossy number.
    ['exact', {text: '{"N":"12345678901234567890.1"}', kind: 'json'}]
  ])('reads %j', (column, expected) => {
    expect(cellKind(row, column)).toEqual(expected);
  });
});

describe('column sort', () => {
  // A text sort puts "10" before "9"; a null cell must not make the column text.
  it('sorts a column of numbers and nulls as numbers', () => {
    expect(sorted(cellsOf(10, null, 9))).toEqual(['9', '10']);
  });

  // `Number('a')` is NaN, which breaks a numeric sort.
  it('sorts a column of numbers and strings as text', () => {
    expect(sorted(cellsOf(9, 'a', 10))).toEqual(['10', '9', 'a']);
  });
});

describe('cellMatches', () => {
  // An ASCII-only fold misses a non-ASCII letter.
  it('ignores case, non-ASCII letters too', () => {
    expect(cellMatches('ÄRGER', 'ärg')).toBe(true);
    expect(cellMatches('ärger', 'ÄRG')).toBe(true);
  });
});

describe('column value filter', () => {
  // The `(empty)` entry is a flag, not a text: a string that reads "null" or "(empty)" is a value.
  it('lists the values in sort order and keeps the empty entry apart from the texts', () => {
    const cells = cellsOf('b', missing, '(empty)', null, 'null', 'a', 'b');
    expect(distinctValues(cells)).toEqual({empty: true, values: ['(empty)', 'a', 'b', 'null']});
    expect(distinctValues(cellsOf(10, 9))).toEqual({empty: false, values: ['9', '10']});

    const onlyEmpty = {empty: true, values: new Set<string>()};
    expect(
      cellsOf(missing, null, 'null', '(empty)').map((cell) => inValueSet(cell, onlyEmpty))
    ).toEqual([true, true, false, false]);
    const onlyNullText = {empty: false, values: new Set(['null'])};
    expect(cellsOf(null, 'null').map((cell) => inValueSet(cell, onlyNullText))).toEqual([
      false,
      true
    ]);
  });
});

describe('totals', () => {
  // Count takes every value; the string "10" and a tagged number are not numbers, so Avg divides by 3.
  it('counts the values and sums only the numbers', () => {
    expect(totals(cellsOf(10, missing, null, '10', {N: '10'}, 20, 30))).toBe(
      'Count 5 · Sum 60 · Avg 20 · Min 10 · Max 30'
    );
  });

  // A double sum gives 0.6000000000000001 in one order and 0.6 in the other.
  it('sums exactly, in any order', () => {
    expect(totals(cellsOf(0.1, 0.2, 0.3))).toContain(' · Sum 0.6 · ');
    expect(totals(cellsOf(0.3, 0.2, 0.1))).toContain(' · Sum 0.6 · ');
  });

  // `String(1e-7)` is "1e-7": a parser without the exponent form reads 1.
  it('reads a number in exponent form', () => {
    expect(totals(cellsOf(1e-7, 0.1))).toContain(' · Sum 0.1000001 · ');
  });

  it('divides the average without rounding', () => {
    expect(totals(cellsOf(1, 2))).toBe('Count 2 · Sum 3 · Avg 1.5 · Min 1 · Max 2');
  });

  // Sum 0 and Avg NaN would show for a column of text.
  it('gives no totals without a number', () => {
    expect(totals(cellsOf('a', null))).toBeUndefined();
  });
});

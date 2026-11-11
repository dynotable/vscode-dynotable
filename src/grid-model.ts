export type CellKind = 'missing' | 'null' | 'number' | 'string' | 'json';

export interface Cell {
  text: string;
  kind: CellKind;
}

/** A column filter: `empty` stands for the `missing` and `null` cells. */
export interface ValueSet {
  empty: boolean;
  values: Set<string>;
}

/**
 * A column is a literal key, never a path: `o.orderId` is one key. An inherited key such as
 * `toString` is not a value. A tagged value such as `{"N": …}` stays `json`, so its exact text never
 * becomes a lossy number.
 */
export function cellKind(row: Record<string, unknown>, column: string): Cell {
  if (!Object.hasOwn(row, column)) return {text: '', kind: 'missing'};
  const value = row[column];
  if (value === null) return {text: 'null', kind: 'null'};
  if (typeof value === 'number') return {text: String(value), kind: 'number'};
  if (typeof value === 'string') return {text: value, kind: 'string'};
  if (typeof value === 'boolean') return {text: String(value), kind: 'string'};
  return {text: JSON.stringify(value), kind: 'json'};
}

const isEmpty = (cell: Cell) => cell.kind === 'missing' || cell.kind === 'null';

export function isNumericColumn(cells: Cell[]): boolean {
  return cells.every((cell) => isEmpty(cell) || cell.kind === 'number');
}

/** The ascending order of two cells that are not empty. */
export function compareCells(a: Cell, b: Cell, numeric: boolean): number {
  if (numeric) return Number(a.text) - Number(b.text);
  return a.text < b.text ? -1 : a.text > b.text ? 1 : 0;
}

export function cellMatches(text: string, query: string): boolean {
  return text.toLowerCase().includes(query.toLowerCase());
}

export function inValueSet(cell: Cell, filter: ValueSet): boolean {
  return isEmpty(cell) ? filter.empty : filter.values.has(cell.text);
}

/** `empty`: the column has a `missing` or `null` cell. `values`: in the column's sort order. */
export function distinctValues(cells: Cell[]): {empty: boolean; values: string[]} {
  const byText = new Map<string, Cell>();
  for (const cell of cells)
    if (!isEmpty(cell) && !byText.has(cell.text)) byText.set(cell.text, cell);
  const numeric = isNumericColumn(cells);
  return {
    empty: cells.some(isEmpty),
    values: [...byText.values()]
      .toSorted((a, b) => compareCells(a, b, numeric))
      .map((cell) => cell.text)
  };
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/;

/** `String(n)` as an exact mantissa and a count of decimal places. */
function decimalOf(n: number): {mantissa: bigint; scale: number} {
  const [, sign = '', whole = '', fraction = '', exponent = '0'] = DECIMAL.exec(String(n)) ?? [];
  const digits = BigInt(`${sign}${whole}${fraction}`);
  const scale = fraction.length - Number(exponent);
  return scale >= 0
    ? {mantissa: digits, scale}
    : {mantissa: digits * 10n ** BigInt(-scale), scale: 0};
}

/** The exact decimal sum of the numbers as `String(n)` writes them, so the order does not matter. */
export function exactSum(numbers: number[]): string {
  let mantissa = 0n;
  let scale = 0;
  for (const n of numbers) {
    const term = decimalOf(n);
    if (term.scale > scale) {
      mantissa *= 10n ** BigInt(term.scale - scale);
      scale = term.scale;
    }
    mantissa += term.mantissa * 10n ** BigInt(scale - term.scale);
  }
  const negative = mantissa < 0n;
  const digits = (negative ? -mantissa : mantissa).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** The status line of the selected cells of one column, or `undefined` when none is a `number`. */
export function totals(cells: Cell[]): string | undefined {
  const numbers = cells.filter((cell) => cell.kind === 'number').map((cell) => Number(cell.text));
  if (numbers.length === 0) return undefined;
  const sum = Number(exactSum(numbers));
  return [
    `Count ${cells.filter((cell) => !isEmpty(cell)).length}`,
    `Sum ${sum}`,
    `Avg ${sum / numbers.length}`,
    `Min ${Math.min(...numbers)}`,
    `Max ${Math.max(...numbers)}`
  ].join(' · ');
}

/** The header also holds the sort mark and the filter icon. */
const HEADER_EXTRA = 3;
const PADDING = 2;

/** A column width in characters. */
export function fitWidth(headerLength: number, cellLengths: number[]): number {
  return (
    cellLengths.reduce((width, length) => Math.max(width, length), headerLength + HEADER_EXTRA) +
    PADDING
  );
}

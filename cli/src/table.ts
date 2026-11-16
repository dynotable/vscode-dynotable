import {cellKind, isEmpty, isNumericColumn, MISSING, type Cell} from '../../src/grid-model';
import type {RunResult} from '../../src/protocol';
import {summary} from '../../src/results-model';
import {visible} from './display';

/** The table options for a stdout: colour only on a terminal, and not when `NO_COLOR` is set. */
export function tableOptions(
  stdout: {columns?: number; isTTY?: boolean},
  env: Readonly<Record<string, string | undefined>>
): TableOptions {
  return {width: stdout.columns || 120, color: stdout.isTTY === true && !env.NO_COLOR};
}

export interface TableOptions {
  /** The terminal's width in characters. */
  width: number;
  /** Bold header, dim borders and dim empty cells. */
  color: boolean;
}

/** A column is not cut below this width: past it the table prints wider and the terminal wraps. */
const MIN_CUT = 8;

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const OFF = '\x1b[0m';

/** Widths count code points, so a cut never splits a surrogate pair. Wide CJK characters misalign. */
const length = (text: string) => [...text].length;
const plain = (text: string) => text;

/** `text` cut to `width` with a closing `…`, styled, then padded to `width`. */
function fit(text: string, width: number, right: boolean, style: (text: string) => string): string {
  const points = [...text];
  const cut = points.length <= width ? text : `${points.slice(0, width - 1).join('')}…`;
  const space = ' '.repeat(width - length(cut));
  return right ? space + style(cut) : style(cut) + space;
}

interface Column {
  name: string;
  cells: Cell[];
  numeric: boolean;
  width: number;
}

/** The widest column loses one character at a time until the table fits or no column is wide. */
function shrink(table: Column[], width: number): void {
  const tableWidth = () => table.reduce((sum, column) => sum + column.width + 3, 1);
  while (table.length > 0 && tableWidth() > width) {
    const widest = table.reduce((a, b) => (b.width > a.width ? b : a));
    if (widest.width <= MIN_CUT) break;
    widest.width -= 1;
  }
}

/**
 * The text `dynotable-lsp run --zed` prints: the first line of the executed statement, a box table
 * of the rows, then the summary. Data never reaches the terminal unmapped.
 */
export function renderTable(result: RunResult, {width, color}: TableOptions): string {
  const paint = (style: string, text: string) => (color && text ? style + text + OFF : text);
  const bold = (text: string) => paint(BOLD, text);
  const dim = (text: string) => paint(DIM, text);
  const lines: string[] = [];
  const [statement = ''] = result.executedStatement.split(/\r?\n/);
  if (statement) lines.push(visible(statement));

  if (result.columns.length > 0) {
    const table: Column[] = result.columns.map((column) => {
      const name = visible(column);
      const cells = result.rows.map((row) => {
        const cell = cellKind(row, column);
        return {...cell, text: visible(cell.text)};
      });
      const widest = cells.reduce((w, cell) => Math.max(w, length(cell.text)), length(name));
      return {name, cells, numeric: isNumericColumn(cells), width: widest};
    });
    shrink(table, width);
    const bar = paint(DIM, '│');
    const border = (left: string, middle: string, right: string) =>
      paint(DIM, left + table.map((column) => '─'.repeat(column.width + 2)).join(middle) + right);
    const line = (texts: string[]) => `${bar} ${texts.join(` ${bar} `)} ${bar}`;

    lines.push(border('┌', '┬', '┐'));
    lines.push(line(table.map((column) => fit(column.name, column.width, false, bold))));
    lines.push(border('├', '┼', '┤'));
    result.rows.forEach((_, r) => {
      const texts = table.map((column) => {
        const cell = column.cells[r] ?? MISSING;
        return fit(cell.text, column.width, column.numeric, isEmpty(cell) ? dim : plain);
      });
      lines.push(line(texts));
    });
    lines.push(border('└', '┴', '┘'));
  }
  lines.push(summary(result));
  return `${lines.join('\n')}\n`;
}

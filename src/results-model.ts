import {randomBytes} from 'node:crypto';
import {cellKind, prettyText, type Cell} from './grid-model';
import type {RunResult} from './protocol';

export interface ResultView {
  kind: 'result';
  /** The id of the run that produced the result. The webview keeps its view state per id. */
  resultId: string;
  summary: string;
  columns: string[];
  /** One cell per column, per row. */
  cells: Cell[][];
}

export type View =
  | {kind: 'empty'}
  | {kind: 'running'; runId: string}
  | {kind: 'cancelled'}
  | ResultView;

/** Host → webview. */
export interface RenderMessage {
  type: 'render';
  view: View;
}

export type CopyFormat = 'csv' | 'tsv' | 'json' | 'markdown';

/**
 * Row and column fields are indices into `result.rows` and `result.columns`, in the grid's view
 * order. The host builds each copy from the stored result.
 */
export type CopyMessage =
  | {type: 'copy'; resultId: string; format: 'csv' | 'json'}
  | {
      type: 'copySelection';
      resultId: string;
      format: CopyFormat;
      rows: number[];
      columns: number[];
      header: boolean;
    }
  | {type: 'copyValue'; resultId: string; row: number; column: number; pretty: boolean}
  | {type: 'copyColumn'; resultId: string; column: number; rows: number[]}
  | {type: 'copyColumnName'; resultId: string; column: number};

/** Webview → host. Anything else is dropped. */
export type PanelMessage =
  | {type: 'ready'}
  | {type: 'cancel'; runId: string}
  | CopyMessage
  | {type: 'export'; resultId: string};

const isIndex = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0;
const isIndexList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length > 0 && value.every(isIndex);
const isCopyFormat = (value: unknown): value is CopyFormat =>
  value === 'csv' || value === 'tsv' || value === 'json' || value === 'markdown';

/** Each case builds a new object, so no extra field reaches the host. */
function parseResultMessage(
  message: Record<string, unknown>,
  resultId: string
): PanelMessage | undefined {
  const {format, rows, columns, header, row, column, pretty} = message;
  switch (message.type) {
    case 'copy':
      return format === 'csv' || format === 'json' ? {type: 'copy', resultId, format} : undefined;
    case 'copySelection':
      return isCopyFormat(format) &&
        isIndexList(rows) &&
        isIndexList(columns) &&
        typeof header === 'boolean'
        ? {type: 'copySelection', resultId, format, rows, columns, header}
        : undefined;
    case 'copyValue':
      return isIndex(row) && isIndex(column) && typeof pretty === 'boolean'
        ? {type: 'copyValue', resultId, row, column, pretty}
        : undefined;
    case 'copyColumn':
      return isIndex(column) && isIndexList(rows)
        ? {type: 'copyColumn', resultId, column, rows}
        : undefined;
    case 'copyColumnName':
      return isIndex(column) ? {type: 'copyColumnName', resultId, column} : undefined;
    case 'export':
      return {type: 'export', resultId};
    default:
      return undefined;
  }
}

export function parseMessage(value: unknown): PanelMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'ready':
      return {type: 'ready'};
    case 'cancel':
      return typeof message.runId === 'string' ? {type: 'cancel', runId: message.runId} : undefined;
    default:
      return typeof message.resultId === 'string'
        ? parseResultMessage(message, message.resultId)
        : undefined;
  }
}

/** `totalRows` null means unknown: the returned count never stands in for it. */
export function summary(result: RunResult): string {
  const {returnedRows, totalRows, truncated, effectiveRowCap, itemsScanned, elapsedMs} = result;
  const parts = [
    totalRows === null
      ? `${returnedRows} ${returnedRows === 1 ? 'row' : 'rows'}`
      : `${returnedRows} of ${totalRows} rows`
  ];
  if (truncated) {
    parts.push(
      totalRows === null
        ? `limited to ${effectiveRowCap} rows, total unknown`
        : `limited to ${effectiveRowCap} rows`
    );
  }
  if (itemsScanned !== undefined) parts.push(`${itemsScanned} items scanned`);
  parts.push(`${elapsedMs} ms`);
  return parts.join(' · ');
}

export function resultView(result: RunResult, resultId: string): ResultView {
  return {
    kind: 'result',
    resultId,
    summary: summary(result),
    columns: result.columns,
    cells: result.rows.map((row) => result.columns.map((column) => cellKind(row, column)))
  };
}

const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r\n]/;

/** The parser checks that an index is a whole number, not that it is in range: a bad one throws. */
function at<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new RangeError(`No item at index ${index}.`);
  return item;
}

/**
 * With `guard`, a spreadsheet would run a cell that starts with a formula character, unless it is a
 * plain number. The guard comes before the quoting.
 */
function csvField(text: string, delimiter: string, guard: boolean): string {
  const guarded = guard && FORMULA_START.test(text) && !NUMBER.test(text) ? `'${text}` : text;
  return guarded.includes(delimiter) || /["\r\n]/.test(guarded)
    ? `"${guarded.replaceAll('"', '""')}"`
    : guarded;
}

function valueText(row: Record<string, unknown>, column: string): string {
  return cellKind(row, column).text;
}

function delimitedText(
  result: RunResult,
  rows: number[],
  columns: number[],
  header: boolean,
  delimiter: string,
  guard: boolean
): string {
  const names = columns.map((column) => at(result.columns, column));
  const lines = rows.map((row) => names.map((name) => valueText(at(result.rows, row), name)));
  if (header) lines.unshift(names);
  return lines
    .map((line) => line.map((text) => csvField(text, delimiter, guard)).join(delimiter))
    .join('\r\n');
}

/**
 * The bytes of `JSON.stringify(objects, null, 2)`, written by hand: a JavaScript object would move
 * integer-like keys such as `"2024"` first and would lose a `__proto__` key.
 */
export function jsonText(result: RunResult, rows: number[], columns: number[]): string {
  if (rows.length === 0) return '[]';
  const names = columns.map((column) => at(result.columns, column));
  const objects = rows.map((index) => {
    const row = at(result.rows, index);
    const members = names
      .filter((name) => Object.hasOwn(row, name))
      .map(
        (name) =>
          `    ${JSON.stringify(name)}: ${JSON.stringify(row[name], null, 2).replaceAll('\n', '\n    ')}`
      );
    return members.length === 0 ? '  {}' : `  {\n${members.join(',\n')}\n  }`;
  });
  return `[\n${objects.join(',\n')}\n]`;
}

function markdownCell(text: string): string {
  return text
    .replaceAll('\\', '\\\\')
    .replaceAll('|', '\\|')
    .replaceAll(/\r\n|\r|\n/g, ' ');
}

const markdownLine = (texts: string[]) => `| ${texts.map(markdownCell).join(' | ')} |`;

function markdownTable(result: RunResult, rows: number[], columns: number[]): string {
  const names = columns.map((column) => at(result.columns, column));
  return [
    markdownLine(names),
    `| ${names.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => markdownLine(names.map((name) => valueText(at(result.rows, row), name))))
  ].join('\n');
}

/** Plain text, not CSV, so it has no formula guard. */
export function columnText(result: RunResult, column: number, rows: number[]): string {
  const name = at(result.columns, column);
  return rows.map((row) => valueText(at(result.rows, row), name)).join('\n');
}

/** `header` applies to CSV and TSV only. TSV is for a paste into a grid, so it has no guard. */
export function formatText(
  result: RunResult,
  rows: number[],
  columns: number[],
  format: CopyFormat,
  header: boolean
): string {
  switch (format) {
    case 'csv':
      return delimitedText(result, rows, columns, header, ',', true);
    case 'tsv':
      return delimitedText(result, rows, columns, header, '\t', false);
    case 'json':
      return jsonText(result, rows, columns);
    case 'markdown':
      return markdownTable(result, rows, columns);
  }
}

/** Every row and column in query order, with the header. */
export function allText(result: RunResult, format: CopyFormat): string {
  return formatText(result, [...result.rows.keys()], [...result.columns.keys()], format, true);
}

export function toJson(result: RunResult): string {
  return JSON.stringify(result.rows, null, 2);
}

export const FORMAT_NAMES: Record<CopyFormat, string> = {
  csv: 'CSV',
  tsv: 'TSV',
  json: 'JSON',
  markdown: 'Markdown'
};

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** The status bar reads `$(name)` as an icon. */
const statusName = (name: string) => name.replaceAll('$(', '\\$(');

export function savedStatus(rows: number, fileName: string): string {
  return `Saved ${plural(rows, 'row', 'rows')} to ${statusName(fileName)}.`;
}

/** The text and the status bar message of a copy. An index out of range throws a `RangeError`. */
export function copyText(result: RunResult, message: CopyMessage): {text: string; status: string} {
  switch (message.type) {
    case 'copy':
      return {
        text: message.format === 'csv' ? allText(result, 'csv') : toJson(result),
        status: `Copied ${plural(result.rows.length, 'row', 'rows')} as ${FORMAT_NAMES[message.format]}.`
      };
    case 'copySelection': {
      const {rows, columns, format, header} = message;
      return {
        text: formatText(result, rows, columns, format, header),
        status: `Copied ${plural(rows.length, 'row', 'rows')} as ${FORMAT_NAMES[format]}.`
      };
    }
    case 'copyValue': {
      const {row, column, pretty} = message;
      const cell = cellKind(at(result.rows, row), at(result.columns, column));
      return {
        text: pretty ? prettyText(cell.text, cell.kind) : cell.text,
        status: 'Copied the value.'
      };
    }
    case 'copyColumn': {
      const {column, rows} = message;
      return {
        text: columnText(result, column, rows),
        status: `Copied ${plural(rows.length, 'value', 'values')} of ${statusName(at(result.columns, column))}.`
      };
    }
    case 'copyColumnName':
      return {text: at(result.columns, message.column), status: 'Copied the column name.'};
  }
}

/**
 * The script and the style are inline and carry a nonce that is new for each render, so the policy
 * needs no `unsafe-inline` and no source host.
 */
export function renderHtml(script: string): string {
  const nonce = randomBytes(16).toString('base64');
  const policy = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style nonce="${nonce}">${STYLE}</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}">${script}</script>
</body>
</html>`;
}

const STYLE = `
html, body, #root { height: 100%; }
body { margin: 0; padding: 0 8px 8px; box-sizing: border-box; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); background: var(--vscode-editor-background); user-select: none; }
#root { display: flex; flex-direction: column; }
.bar { display: flex; gap: 8px; align-items: center; padding: 8px 0; }
.summary { flex: 1; color: var(--vscode-descriptionForeground); }
button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 2px 8px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
.grid { flex: 1; min-height: 0; overflow: auto; }
.grid:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.measure { position: absolute; visibility: hidden; white-space: pre; font-family: var(--vscode-editor-font-family); }
table { table-layout: fixed; border-collapse: separate; border-spacing: 0; font-family: var(--vscode-editor-font-family); }
th, td { padding: 2px 6px; border-right: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
th { position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background); cursor: pointer; }
.head { display: flex; align-items: center; }
.head .name { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.sort, .filter { flex: none; }
.sort { margin-left: 4px; }
.resize { position: absolute; top: 0; right: 0; width: 5px; height: 100%; cursor: col-resize; }
tbody tr:nth-child(even) { --stripe: var(--vscode-keybindingTable-rowsBackground, var(--vscode-list-hoverBackground)); background: var(--stripe); }
td { background: var(--hl, transparent); }
.rownum { position: sticky; left: 0; z-index: 1; background: var(--vscode-editor-background); color: var(--vscode-editorLineNumber-foreground); text-align: right; }
th.rownum { z-index: 3; cursor: default; }
td.null, td.json { color: var(--vscode-descriptionForeground); }
td.number { text-align: right; }
.pinned { position: sticky; z-index: 1; background: var(--vscode-editor-background); }
th.pinned { z-index: 3; }
td.match { --hl: var(--vscode-editor-findMatchHighlightBackground); }
td.selected { --hl: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground, inherit); }
.grid:focus td.selected { --hl: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
td.pinned, td.rownum { background: linear-gradient(var(--hl, transparent), var(--hl, transparent)), linear-gradient(var(--stripe, transparent), var(--stripe, transparent)), var(--vscode-editor-background); }
td.focused { outline: 1px solid var(--vscode-list-focusOutline, var(--vscode-focusBorder)); outline-offset: -1px; }
input { user-select: text; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
input.find { width: 160px; padding: 2px 4px; }
label { display: flex; gap: 4px; align-items: center; }
.note, .totals { color: var(--vscode-descriptionForeground); }
.totals { padding-top: 4px; }
.filter { margin-left: 4px; padding: 0 2px; color: var(--vscode-descriptionForeground); }
.filter:hover { color: var(--vscode-foreground); }
.filter.active { color: var(--vscode-focusBorder); }
.menu, .popup { position: fixed; z-index: 10; padding: 4px 0; color: var(--vscode-menu-foreground); background: var(--vscode-menu-background); border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border, transparent)); box-shadow: 0 2px 8px var(--vscode-widget-shadow); }
.menu:focus { outline: none; }
.menu .item { padding: 2px 16px; cursor: default; }
.menu .item:hover, .menu .item.active { color: var(--vscode-menu-selectionForeground); background: var(--vscode-menu-selectionBackground); }
.menu .item[aria-disabled="true"] { opacity: 0.5; background: none; }
.menu .separator { margin: 4px 0; border-top: 1px solid var(--vscode-menu-separatorBackground); }
.popup { display: flex; flex-direction: column; gap: 4px; padding: 6px; }
.popup .values { max-height: 240px; overflow: auto; }
.popup label[hidden] { display: none; }
.actions { display: flex; gap: 8px; justify-content: flex-end; }
dialog { max-width: 80vw; max-height: 80vh; color: var(--vscode-foreground); background: var(--vscode-editorWidget-background); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border)); }
dialog::backdrop { background: var(--vscode-widget-shadow); }
dialog .title { font-weight: bold; margin-bottom: 8px; }
pre.viewer { user-select: text; max-height: 60vh; overflow: auto; margin: 0 0 8px; font-family: var(--vscode-editor-font-family); white-space: pre-wrap; word-break: break-word; }
.tok-key { color: var(--vscode-debugTokenExpression-name); }
.tok-string { color: var(--vscode-debugTokenExpression-string); }
.tok-number { color: var(--vscode-debugTokenExpression-number); }
.tok-literal { color: var(--vscode-debugTokenExpression-boolean); }
table.record { margin-bottom: 8px; }
table.record th { position: static; cursor: default; }
table.record .value { max-width: 480px; overflow: hidden; text-overflow: ellipsis; }
`;

import {randomBytes} from 'node:crypto';
import {cellKind} from './grid-model';
import type {RunResult} from './protocol';

export interface ResultView {
  kind: 'result';
  summary: string;
  columns: string[];
  /** One text per column, per row. */
  cells: string[][];
  executedStatement: string;
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

/** Webview → host. Anything else is dropped. */
export type PanelMessage =
  | {type: 'ready'}
  | {type: 'cancel'; runId: string}
  | {type: 'copy'; format: 'csv' | 'json'};

export function parseMessage(value: unknown): PanelMessage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const message = value as Record<string, unknown>;
  switch (message.type) {
    case 'ready':
      return {type: 'ready'};
    case 'cancel':
      return typeof message.runId === 'string' ? {type: 'cancel', runId: message.runId} : undefined;
    case 'copy':
      return message.format === 'csv' || message.format === 'json'
        ? {type: 'copy', format: message.format}
        : undefined;
    default:
      return undefined;
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

export function resultView(result: RunResult): ResultView {
  return {
    kind: 'result',
    summary: summary(result),
    columns: result.columns,
    cells: result.rows.map((row) => result.columns.map((column) => cellKind(row, column).text)),
    executedStatement: result.executedStatement
  };
}

const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r\n]/;

export type CopyFormat = 'csv' | 'tsv' | 'json' | 'markdown';

/** The callers check the indices, so a bad one here is a bug. */
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

export function valueText(row: Record<string, unknown>, column: string): string {
  return cellKind(row, column).text;
}

export function delimitedText(
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

export function markdownTable(result: RunResult, rows: number[], columns: number[]): string {
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

export function toJson(result: RunResult): string {
  return JSON.stringify(result.rows, null, 2);
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
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
.bar { display: flex; gap: 8px; align-items: center; margin-bottom: 8px; }
.summary { flex: 1; color: var(--vscode-descriptionForeground); }
button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: none; padding: 2px 8px; cursor: pointer; }
button:hover { background: var(--vscode-button-hoverBackground); }
pre { font-family: var(--vscode-editor-font-family); white-space: pre-wrap; margin: 0 0 8px; color: var(--vscode-descriptionForeground); }
table { border-collapse: collapse; font-family: var(--vscode-editor-font-family); }
th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; text-align: left; vertical-align: top; white-space: pre; }
th { position: sticky; top: 0; background: var(--vscode-editor-background); }
`;

import {randomBytes} from 'node:crypto';
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

/**
 * A column is a literal key, never a path: `o.orderId` is one key. An inherited key such as
 * `toString` is not a value. Exact decimals arrive as text and stay text.
 */
function cellText(row: Record<string, unknown>, column: string): string {
  if (!Object.hasOwn(row, column)) return '';
  const value = row[column];
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function resultView(result: RunResult): ResultView {
  return {
    kind: 'result',
    summary: summary(result),
    columns: result.columns,
    cells: result.rows.map((row) => result.columns.map((column) => cellText(row, column))),
    executedStatement: result.executedStatement
  };
}

const NUMBER = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const FORMULA_START = /^[=+\-@\t\r\n]/;

/** A spreadsheet runs a cell that starts with a formula character, unless it is a plain number. */
function csvField(text: string): string {
  const guarded = FORMULA_START.test(text) && !NUMBER.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

export function toCsv(result: RunResult): string {
  const lines = [result.columns, ...resultView(result).cells];
  return lines.map((line) => line.map(csvField).join(',')).join('\r\n');
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

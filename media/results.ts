/**
 * The results webview. It builds every node with `textContent`: column names and cells are data
 * from the user's tables, never markup. Runtime styles go through CSSOM only: the CSP blocks inline
 * style attributes.
 */
import {
  columnSizingFeature,
  constructTable,
  createSortedRowModel,
  rowSortingFeature,
  tableFeatures,
  type ColumnDef,
  type Table
} from '@tanstack/table-core';
import {storeReactivityBindings} from '@tanstack/table-core/store-reactivity-bindings';
import {
  compareCells,
  fitWidth,
  isEmpty,
  isNumericColumn,
  prettyText,
  type Cell
} from '../src/grid-model';
import type {PanelMessage, ResultView, View} from '../src/results-model';

declare function acquireVsCodeApi(): {postMessage(message: PanelMessage): void};

const host = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;

const features = tableFeatures({
  coreReactivityFeature: storeReactivityBindings(),
  rowSortingFeature,
  columnSizingFeature,
  sortedRowModel: createSortedRowModel()
});

interface GridRow {
  cells: Cell[];
}

/** The view state of one result. A new `resultId` gets a new one, so all of it resets. */
interface Grid {
  view: ResultView;
  table: Table<typeof features, GridRow>;
  rowNumberWidth: number;
}

let grid: Grid | undefined;
/** It holds the DOM focus for the grid, so a table rebuild keeps it. */
let scrollBox: HTMLElement | undefined;
/** The `resultId` of the result on screen; `undefined` while another kind is shown. */
let shownResultId: string | undefined;

const MIN_WIDTH = 60;
const MAX_WIDTH = 400;
const TOOLTIP_LENGTH = 2000;
const MISSING: Cell = {text: '', kind: 'missing'};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  text?: string,
  className?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function button(text: string, message: PanelMessage): HTMLButtonElement {
  const node = element('button', text);
  node.addEventListener('click', () => host.postMessage(message));
  return node;
}

let measuredCharWidth: number | undefined;

/** jsdom has no layout and measures 0. */
function charWidth(): number {
  if (measuredCharWidth === undefined) {
    const probe = element('span', '0000000000', 'measure');
    document.body.append(probe);
    measuredCharWidth = probe.getBoundingClientRect().width / 10 || 8;
    probe.remove();
  }
  return measuredCharWidth;
}

function createGrid(view: ResultView): Grid {
  const width = charWidth();
  const columnSizing: Record<string, number> = {};
  const columns: ColumnDef<typeof features, GridRow>[] = view.columns.map((name, index) => {
    const cells = view.cells.map((row) => row[index] ?? MISSING);
    const numeric = isNumericColumn(cells);
    const chars = fitWidth(
      name.length,
      cells.map((cell) => cell.text.length)
    );
    columnSizing[String(index)] = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, chars * width));
    return {
      id: String(index),
      header: name,
      accessorFn: (row: GridRow) => {
        const cell = row.cells[index];
        return cell && !isEmpty(cell) ? cell : undefined;
      },
      sortUndefined: 'last',
      sortDescFirst: false,
      sortFn: (a, b, id) => compareCells(a.getValue<Cell>(id), b.getValue<Cell>(id), numeric)
    };
  });
  const table = constructTable({
    features,
    columns,
    data: view.cells.map((cells) => ({cells})),
    enableMultiSort: false,
    initialState: {columnSizing}
  });
  const digits = String(view.cells.length).length;
  return {view, table, rowNumberWidth: (Math.max(digits, 2) + 2) * width};
}

const SORT_MARK = {asc: '▲', desc: '▼'};

/** Runs on a sort, filter, order, visibility or pin change only. */
function rebuildTable(): void {
  if (!grid || !scrollBox) return;
  const {table, view, rowNumberWidth} = grid;
  const headers = table.getHeaderGroups()[0]?.headers ?? [];

  const colgroup = element('colgroup');
  const rowNumberCol = element('col');
  rowNumberCol.style.width = `${rowNumberWidth}px`;
  colgroup.append(rowNumberCol);

  const headRow = element('tr');
  headRow.append(element('th', undefined, 'rownum'));
  for (const header of headers) {
    const {column} = header;
    const col = element('col');
    col.style.width = `${column.getSize()}px`;
    colgroup.append(col);
    const sorted = column.getIsSorted();
    const th = element('th');
    th.dataset.column = column.id;
    th.append(
      element('span', view.columns[Number(column.id)] ?? '', 'name'),
      element('span', sorted ? SORT_MARK[sorted] : '', 'sort')
    );
    th.addEventListener('click', (event) => {
      column.getToggleSortingHandler()?.(event);
      rebuildTable();
    });
    headRow.append(th);
  }
  const thead = element('thead');
  thead.append(headRow);

  const tbody = element('tbody');
  table.getRowModel().rows.forEach((row, position) => {
    const tr = element('tr');
    tr.dataset.row = String(row.index);
    tr.append(element('td', String(position + 1), 'rownum'));
    for (const {column} of headers) {
      const cell = row.original.cells[Number(column.id)] ?? MISSING;
      const td = element('td', cell.text, cell.kind);
      td.dataset.row = String(row.index);
      td.dataset.column = column.id;
      tr.append(td);
    }
    tbody.append(tr);
  });

  const node = element('table');
  node.style.width = `${rowNumberWidth + table.getTotalSize()}px`;
  node.append(colgroup, thead, tbody);
  scrollBox.replaceChildren(node);
}

/** A JSON cell's tooltip is built on the first hover, not for every cell up front. */
function showTooltip(event: MouseEvent): void {
  const td = (event.target as Element).closest('td.json');
  if (!(td instanceof HTMLElement) || td.title || !grid) return;
  const cell = grid.view.cells[Number(td.dataset.row)]?.[Number(td.dataset.column)];
  if (cell) td.title = prettyText(cell.text, 'json').slice(0, TOOLTIP_LENGTH);
}

function renderResult(bar: HTMLElement, view: ResultView): void {
  if (grid?.view.resultId !== view.resultId) grid = createGrid(view);
  bar.append(
    element('span', view.summary, 'summary'),
    button('Copy CSV', {type: 'copy', resultId: view.resultId, format: 'csv'}),
    button('Copy JSON', {type: 'copy', resultId: view.resultId, format: 'json'}),
    button('Export…', {type: 'export', resultId: view.resultId})
  );
  if (view.columns.length === 0) {
    root.append(element('p', 'No rows.'));
    return;
  }
  scrollBox = element('div', undefined, 'grid');
  scrollBox.tabIndex = 0;
  scrollBox.addEventListener('mouseover', showTooltip);
  root.append(scrollBox);
  rebuildTable();
}

/**
 * Every menu, popup and dialog lives under `root`, so a render that changes the kind or the
 * `resultId` closes them all; one that changes neither keeps the DOM. The grid state outlives
 * `running` and `cancelled` renders and resets only on a new `resultId`.
 */
function render(view: View): void {
  const resultId = view.kind === 'result' ? view.resultId : undefined;
  if (resultId !== undefined && resultId === shownResultId) return;
  shownResultId = resultId;
  const bar = element('div', undefined, 'bar');
  root.replaceChildren(bar);
  scrollBox = undefined;
  switch (view.kind) {
    case 'empty':
      bar.append(element('span', 'Run a statement to see its rows here.', 'summary'));
      return;
    case 'running':
      bar.append(
        element('span', 'Running…', 'summary'),
        button('Cancel', {type: 'cancel', runId: view.runId})
      );
      return;
    case 'cancelled':
      bar.append(element('span', 'The run was cancelled.', 'summary'));
      return;
    case 'result':
      renderResult(bar, view);
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as {type?: unknown; view?: View} | null;
  if (data?.type === 'render' && data.view) render(data.view);
});

// A hidden panel drops its document; on show it loads anew and asks for the current view.
host.postMessage({type: 'ready'});

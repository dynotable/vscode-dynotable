/**
 * The results webview. It builds every node with `textContent`: column names and cells are data
 * from the user's tables, never markup. Runtime styles go through CSSOM only: the CSP blocks inline
 * style attributes.
 */
import {
  columnFilteringFeature,
  columnOrderingFeature,
  columnPinningFeature,
  columnSizingFeature,
  columnVisibilityFeature,
  constructTable,
  createFilteredRowModel,
  createSortedRowModel,
  globalFilteringFeature,
  rowSortingFeature,
  tableFeatures,
  type Column,
  type ColumnDef,
  type Table
} from '@tanstack/table-core';
import {storeReactivityBindings} from '@tanstack/table-core/store-reactivity-bindings';
import {
  cellMatches,
  compareCells,
  fitWidth,
  isEmpty,
  isNumericColumn,
  prettyText,
  selectionCells,
  totals,
  type Cell,
  type GridSelection
} from '../src/grid-model';
import type {PanelMessage, ResultView, View} from '../src/results-model';

declare function acquireVsCodeApi(): {postMessage(message: PanelMessage): void};

const host = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;

const features = tableFeatures({
  coreReactivityFeature: storeReactivityBindings(),
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  columnOrderingFeature,
  columnVisibilityFeature,
  columnPinningFeature,
  columnSizingFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel()
});

interface GridRow {
  cells: Cell[];
}

/** An original row index and a column index, so a cell keeps its place through a sort or a move. */
interface Point {
  row: number;
  column: number;
}

/** A fresh object on each change: a visibility change re-runs the filter only on a new value. */
interface FindFilter {
  query: string;
}

/** The view state of one result. A new `resultId` gets a new one, so all of it resets. */
interface Grid {
  view: ResultView;
  table: Table<typeof features, GridRow>;
  rowNumberWidth: number;
  selection: GridSelection;
  focus?: Point;
  anchor?: Point;
  query: string;
  /** The shown rows (original indices) and visible columns (indices), in view order. */
  viewRows: number[];
  viewColumns: number[];
}

interface Drag {
  kind: 'resize' | 'reorder';
  column: string;
  startX: number;
  startWidth: number;
  moved: boolean;
}

let grid: Grid | undefined;
/** It holds the DOM focus for the grid, so a table rebuild keeps it. */
let scrollBox: HTMLElement | undefined;
/** The `resultId` of the result on screen; `undefined` while another kind is shown. */
let shownResultId: string | undefined;
/** The Filter rows checkbox keeps its state while the document lives. */
let filterRows = false;
let findInput: HTMLInputElement | undefined;
let findTimer: ReturnType<typeof setTimeout> | undefined;
let rowsNote: HTMLElement | undefined;
let totalsLine: HTMLElement | undefined;
let drag: Drag | undefined;
/** Set by a drag that moved, so the click that follows its mouseup does not sort. */
let suppressClick = false;

/** On macOS a Ctrl-click is a right-click, so Cmd adds there. */
const MAC = navigator.platform.startsWith('Mac');
const addModifier = (event: MouseEvent | KeyboardEvent) => (MAC ? event.metaKey : event.ctrlKey);

const MIN_WIDTH = 60;
const MAX_WIDTH = 400;
const TOOLTIP_LENGTH = 2000;
const MISSING: Cell = {text: '', kind: 'missing'};
const FIND_DELAY = 150;
const DRAG_THRESHOLD = 4;
const ARROWS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1]
};

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

function action(text: string, run: () => void): HTMLButtonElement {
  const node = element('button', text);
  node.addEventListener('click', run);
  return node;
}

const button = (text: string, message: PanelMessage) =>
  action(text, () => host.postMessage(message));

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
    globalFilterFn: (row, id, filter: FindFilter) =>
      cellMatches(row.original.cells[Number(id)]?.text ?? '', filter.query),
    // The default reads the first row's value, and skips a column whose first cell is missing.
    getColumnCanGlobalFilter: (column) =>
      (column as unknown as Column<typeof features, GridRow>).getIsVisible(),
    initialState: {columnSizing}
  });
  const digits = String(view.cells.length).length;
  return {
    view,
    table,
    rowNumberWidth: (Math.max(digits, 2) + 2) * width,
    selection: {rows: new Set(), columns: new Set(), wholeRows: false},
    query: '',
    viewRows: [],
    viewColumns: []
  };
}

const cellAt = (row: number, column: number): Cell => grid?.view.cells[row]?.[column] ?? MISSING;

/** The item itself when shown, else the closest shown one in the old order. */
function nearest(order: number[], item: number, shown: number[]): number | undefined {
  const visible = new Set(shown);
  if (visible.has(item)) return item;
  const at = order.indexOf(item);
  for (let distance = 1; distance < order.length; distance++)
    for (const candidate of [order[at + distance], order[at - distance]])
      if (candidate !== undefined && visible.has(candidate)) return candidate;
  return shown[0];
}

function keepFocusShown(oldRows: number[], oldColumns: number[]): void {
  if (!grid?.focus) return;
  const row = nearest(oldRows, grid.focus.row, grid.viewRows);
  const column = nearest(oldColumns, grid.focus.column, grid.viewColumns);
  if (row === undefined || column === undefined) {
    grid.selection = {rows: new Set(), columns: new Set(), wholeRows: false};
    grid.focus = undefined;
    grid.anchor = undefined;
  } else grid.focus = {row, column};
}

/** Sticky header and pinned columns: scroll padding keeps a revealed cell out from under them. */
function layoutSticky(): void {
  if (!grid || !scrollBox) return;
  let left = grid.rowNumberWidth;
  for (const column of grid.table.getStartVisibleLeafColumns()) {
    for (const node of scrollBox.querySelectorAll<HTMLElement>(
      `.pinned[data-column="${column.id}"]`
    ))
      node.style.left = `${left}px`;
    left += column.getSize();
  }
  scrollBox.style.scrollPaddingLeft = `${left}px`;
  const headerHeight = scrollBox.querySelector('thead')?.getBoundingClientRect().height ?? 0;
  scrollBox.style.scrollPaddingTop = `${headerHeight}px`;
}

function totalsText(): string | undefined {
  const focus = grid?.focus;
  if (!grid || !focus) return undefined;
  const {rows, columns} = selectionCells(grid.selection, grid.viewRows, grid.viewColumns);
  if (rows.length < 2 || !columns.includes(focus.column)) return undefined;
  return totals(rows.map((row) => cellAt(row, focus.column)));
}

/** Focus, selection and find marks change classes only; the table is not rebuilt. */
function paint(): void {
  if (!grid || !scrollBox) return;
  const {selection, focus, query} = grid;
  for (const td of scrollBox.querySelectorAll<HTMLElement>('td[data-column]')) {
    const row = Number(td.dataset.row);
    const column = Number(td.dataset.column);
    td.classList.toggle(
      'selected',
      selection.rows.has(row) && (selection.wholeRows || selection.columns.has(column))
    );
    td.classList.toggle('focused', focus?.row === row && focus.column === column);
    td.classList.toggle('match', query !== '' && cellMatches(cellAt(row, column).text, query));
  }
  if (totalsLine) {
    const text = totalsText();
    totalsLine.textContent = text ?? '';
    totalsLine.hidden = text === undefined;
  }
}

const SORT_MARK = {asc: '▲', desc: '▼'};

/** Runs on a sort, filter, order, visibility or pin change only. */
function rebuildTable(): void {
  if (!grid || !scrollBox) return;
  const {table, view, rowNumberWidth} = grid;
  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const rows = table.getRowModel().rows;

  const colgroup = element('colgroup');
  const rowNumberCol = element('col');
  rowNumberCol.style.width = `${rowNumberWidth}px`;
  colgroup.append(rowNumberCol);

  const headRow = element('tr');
  headRow.append(element('th', undefined, 'rownum'));
  for (const header of headers) {
    const {column} = header;
    const col = element('col');
    col.dataset.column = column.id;
    col.style.width = `${column.getSize()}px`;
    colgroup.append(col);
    const sorted = column.getIsSorted();
    const th = element('th', undefined, column.getIsPinned() ? 'pinned' : undefined);
    th.dataset.column = column.id;
    th.append(
      element('span', view.columns[Number(column.id)] ?? '', 'name'),
      element('span', sorted ? SORT_MARK[sorted] : '', 'sort'),
      element('span', undefined, 'resize')
    );
    th.addEventListener('click', (event) => {
      if (suppressClick) return;
      column.getToggleSortingHandler()?.(event);
      rebuildTable();
    });
    headRow.append(th);
  }
  const thead = element('thead');
  thead.append(headRow);

  const tbody = element('tbody');
  rows.forEach((row, position) => {
    const tr = element('tr');
    tr.dataset.row = String(row.index);
    tr.append(element('td', String(position + 1), 'rownum'));
    for (const {column} of headers) {
      const cell = row.original.cells[Number(column.id)] ?? MISSING;
      const td = element('td', cell.text, cell.kind);
      if (column.getIsPinned()) td.classList.add('pinned');
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

  const oldRows = grid.viewRows;
  const oldColumns = grid.viewColumns;
  grid.viewRows = rows.map((row) => row.index);
  grid.viewColumns = headers.map((header) => Number(header.column.id));
  keepFocusShown(oldRows, oldColumns);
  if (rowsNote) {
    const shown = table.getFilteredRowModel().rows.length;
    const all = table.getPreFilteredRowModel().rows.length;
    rowsNote.textContent = shown < all ? `${shown} of ${all} rows shown` : '';
    rowsNote.hidden = shown >= all;
  }
  layoutSticky();
  paint();
}

const between = (order: number[], a: number, b: number) => {
  const from = order.indexOf(a);
  const to = order.indexOf(b);
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
};

/** The anchor, when it is still shown; else the given point. */
function anchorOr(point: Point): Point {
  const anchor = grid?.anchor;
  return anchor && grid?.viewRows.includes(anchor.row) && grid.viewColumns.includes(anchor.column)
    ? anchor
    : point;
}

/** `extend` selects the range from the anchor; `add` keeps the old selection. */
function selectCell(point: Point, extend: boolean, add: boolean): void {
  if (!grid) return;
  const from = extend ? anchorOr(point) : point;
  const rows = between(grid.viewRows, from.row, point.row);
  const columns = between(grid.viewColumns, from.column, point.column);
  if (add) {
    for (const row of rows) grid.selection.rows.add(row);
    for (const column of columns) grid.selection.columns.add(column);
  } else grid.selection = {rows: new Set(rows), columns: new Set(columns), wholeRows: false};
  grid.focus = point;
  if (!extend) grid.anchor = point;
  paint();
}

function selectRow(row: number, extend: boolean, add: boolean): void {
  if (!grid) return;
  const focusColumn = grid.focus?.column;
  const column =
    focusColumn !== undefined && grid.viewColumns.includes(focusColumn)
      ? focusColumn
      : grid.viewColumns[0];
  if (column === undefined) return;
  const point = {row, column};
  const rows = between(grid.viewRows, (extend ? anchorOr(point) : point).row, row);
  if (add) {
    for (const each of rows) grid.selection.rows.add(each);
    grid.selection.wholeRows = true;
  } else grid.selection = {rows: new Set(rows), columns: new Set(), wholeRows: true};
  grid.focus = point;
  if (!extend) grid.anchor = point;
  paint();
}

function selectAll(): void {
  const [row] = grid?.viewRows ?? [];
  const [column] = grid?.viewColumns ?? [];
  if (!grid || row === undefined || column === undefined) return;
  grid.selection = {rows: new Set(grid.viewRows), columns: new Set(), wholeRows: true};
  grid.focus ??= {row, column};
  grid.anchor ??= grid.focus;
  paint();
}

/** A sticky pinned cell never leaves the padded zone, so it scrolls vertically only. */
function reveal(point: Point): void {
  const td = scrollBox?.querySelector(`td[data-row="${point.row}"][data-column="${point.column}"]`);
  if (!scrollBox || !td) return;
  if (td.classList.contains('pinned')) {
    const left = scrollBox.scrollLeft;
    td.scrollIntoView({block: 'nearest'});
    scrollBox.scrollLeft = left;
  } else td.scrollIntoView({block: 'nearest', inline: 'nearest'});
}

const clamp = (at: number, length: number) => Math.min(length - 1, Math.max(0, at));

function moveFocus(rowStep: number, columnStep: number, extend: boolean): void {
  if (!grid) return;
  const {viewRows, viewColumns, focus} = grid;
  const rowAt = focus ? clamp(viewRows.indexOf(focus.row) + rowStep, viewRows.length) : 0;
  const columnAt = focus
    ? clamp(viewColumns.indexOf(focus.column) + columnStep, viewColumns.length)
    : 0;
  const row = viewRows[rowAt];
  const column = viewColumns[columnAt];
  if (row === undefined || column === undefined) return;
  selectCell({row, column}, extend, false);
  reveal({row, column});
}

function setFindFilter(): void {
  if (!grid) return;
  const filter: FindFilter | undefined =
    filterRows && grid.query !== '' ? {query: grid.query} : undefined;
  grid.table.setGlobalFilter(filter);
}

function applyQuery(query: string): void {
  clearTimeout(findTimer);
  findTimer = undefined;
  if (!grid) return;
  grid.query = query;
  if (filterRows) {
    setFindFilter();
    rebuildTable();
  } else paint();
}

function clearQuery(): void {
  if (findInput) findInput.value = '';
  applyQuery('');
}

/** Moves the focused cell to the next match in view order, from the focused cell, and wraps. */
function step(direction: 1 | -1): void {
  if (findTimer !== undefined && findInput) applyQuery(findInput.value);
  if (!grid || grid.query === '') return;
  const {viewRows, viewColumns, focus, query} = grid;
  const width = viewColumns.length;
  const total = viewRows.length * width;
  const start = focus
    ? viewRows.indexOf(focus.row) * width + viewColumns.indexOf(focus.column)
    : direction > 0
      ? -1
      : total;
  for (let offset = 1; offset <= total; offset++) {
    const at = (((start + direction * offset) % total) + total) % total;
    const row = viewRows[Math.floor(at / width)];
    const column = viewColumns[at % width];
    if (row !== undefined && column !== undefined && cellMatches(cellAt(row, column).text, query)) {
      selectCell({row, column}, false, false);
      reveal({row, column});
      return;
    }
  }
}

function findControls(query: string): HTMLElement[] {
  const input = element('input', undefined, 'find');
  input.placeholder = 'Find';
  input.value = query;
  input.addEventListener('input', () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(() => applyQuery(input.value), FIND_DELAY);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') clearQuery();
  });
  findInput = input;

  const box = element('input');
  box.type = 'checkbox';
  box.checked = filterRows;
  box.addEventListener('change', () => {
    filterRows = box.checked;
    setFindFilter();
    rebuildTable();
  });
  const label = element('label');
  label.append(box, 'Filter rows');

  rowsNote = element('span', undefined, 'note');
  rowsNote.hidden = true;
  return [
    input,
    action('Previous', () => step(-1)),
    action('Next', () => step(1)),
    label,
    rowsNote
  ];
}

function resize(id: string, width: number): void {
  if (!grid || !scrollBox) return;
  grid.table.setColumnSizing((old) => ({...old, [id]: width}));
  const col = scrollBox.querySelector<HTMLElement>(`col[data-column="${id}"]`);
  if (col) col.style.width = `${width}px`;
  const node = scrollBox.querySelector('table');
  if (node) node.style.width = `${grid.rowNumberWidth + grid.table.getTotalSize()}px`;
  layoutSticky();
}

/** Moves `source` to the place of `target`: after it when it moves right, before it when left. */
function moved(ids: string[], source: string, target: string): string[] {
  const out = ids.filter((id) => id !== source);
  out.splice(ids.indexOf(target), 0, source);
  return out;
}

/** Pinned columns come first whatever `columnOrder` says, so each group reorders on its own. */
function reorder(source: string, target: string): void {
  if (!grid) return;
  const {table, view} = grid;
  const pinned = table.atoms.columnPinning?.get().start ?? [];
  if (pinned.includes(source) !== pinned.includes(target)) return;
  if (pinned.includes(source))
    table.setColumnPinning((old) => ({...old, start: moved(old.start, source, target)}));
  else {
    const order = table.atoms.columnOrder?.get() ?? [];
    const ids = view.columns.map((_, index) => String(index));
    const full = [
      ...order.filter((id) => ids.includes(id)),
      ...ids.filter((id) => !order.includes(id))
    ];
    table.setColumnOrder(moved(full, source, target));
  }
  rebuildTable();
}

function startDrag(event: MouseEvent): void {
  const target = event.target as Element;
  const th = target.closest('th[data-column]');
  const column = th instanceof HTMLElement ? th.dataset.column : undefined;
  if (event.button !== 0 || !grid || column === undefined) return;
  drag = {
    kind: target.closest('.resize') ? 'resize' : 'reorder',
    column,
    startX: event.clientX,
    startWidth: grid.table.getColumn(column)?.getSize() ?? MIN_WIDTH,
    moved: false
  };
}

function onGridClick(event: MouseEvent): void {
  const td = (event.target as Element).closest('td');
  const row = Number(td?.parentElement?.dataset.row);
  if (!td || Number.isNaN(row)) return;
  if (td.classList.contains('rownum')) selectRow(row, event.shiftKey, addModifier(event));
  else selectCell({row, column: Number(td.dataset.column)}, event.shiftKey, addModifier(event));
}

function onGridKey(event: KeyboardEvent): void {
  const arrow = ARROWS[event.key];
  if (arrow) {
    event.preventDefault();
    moveFocus(arrow[0], arrow[1], event.shiftKey);
  } else if (addModifier(event) && event.key.toLowerCase() === 'a') {
    event.preventDefault();
    selectAll();
  } else if (event.key === 'Escape') clearQuery();
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
  bar.append(element('span', view.summary, 'summary'));
  if (view.columns.length > 0) bar.append(...findControls(grid.query));
  bar.append(
    button('Copy CSV', {type: 'copy', resultId: view.resultId, format: 'csv'}),
    button('Copy JSON', {type: 'copy', resultId: view.resultId, format: 'json'}),
    button('Export…', {type: 'export', resultId: view.resultId})
  );
  if (view.columns.length === 0) {
    root.append(element('p', 'No rows.'));
    return;
  }
  const box = element('div', undefined, 'grid');
  box.tabIndex = 0;
  box.addEventListener('mouseover', showTooltip);
  // No preventDefault: `user-select: none` already stops text selection.
  box.addEventListener('mousedown', (event) => {
    box.focus({preventScroll: true});
    startDrag(event);
  });
  box.addEventListener('click', onGridClick);
  box.addEventListener('keydown', onGridKey);
  scrollBox = box;
  totalsLine = element('div', undefined, 'totals');
  totalsLine.hidden = true;
  root.append(box, totalsLine);
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
  findInput = undefined;
  rowsNote = undefined;
  totalsLine = undefined;
  drag = undefined;
  clearTimeout(findTimer);
  findTimer = undefined;
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

/**
 * VS Code cancels the Cmd/Ctrl+C keydown in the frame and runs `execCommand('copy')`, so copy runs
 * from this event. Elsewhere than the grid, the native copy (find field, viewer) goes on.
 */
document.addEventListener('copy', (event) => {
  if (!grid || !scrollBox || document.activeElement !== scrollBox) return;
  event.preventDefault();
  const {rows, columns} = selectionCells(grid.selection, grid.viewRows, grid.viewColumns);
  const [row] = rows;
  const [column] = columns;
  if (row === undefined || column === undefined) return;
  const {resultId} = grid.view;
  host.postMessage(
    rows.length === 1 && columns.length === 1
      ? {type: 'copyValue', resultId, row, column, pretty: false}
      : {type: 'copySelection', resultId, format: 'tsv', rows, columns, header: false}
  );
});

document.addEventListener('keydown', (event) => {
  if (findInput && addModifier(event) && event.key.toLowerCase() === 'f') {
    event.preventDefault();
    findInput.focus();
    findInput.select();
  }
});

document.addEventListener('mousemove', (event) => {
  if (!drag) return;
  // The button came up outside the frame.
  if (event.buttons === 0) {
    drag = undefined;
    return;
  }
  const distance = event.clientX - drag.startX;
  if (drag.kind === 'resize') {
    drag.moved ||= distance !== 0;
    resize(drag.column, Math.max(MIN_WIDTH, drag.startWidth + distance));
  } else drag.moved ||= Math.abs(distance) >= DRAG_THRESHOLD;
});

document.addEventListener('mouseup', (event) => {
  const done = drag;
  drag = undefined;
  if (!done?.moved) return;
  suppressClick = true;
  setTimeout(() => {
    suppressClick = false;
  });
  const th = event.target instanceof Element ? event.target.closest('th[data-column]') : null;
  const target = th instanceof HTMLElement ? th.dataset.column : undefined;
  if (done.kind === 'reorder' && target !== undefined && target !== done.column)
    reorder(done.column, target);
});

window.addEventListener('blur', () => {
  drag = undefined;
});

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as {type?: unknown; view?: View} | null;
  if (data?.type === 'render' && data.view) render(data.view);
});

// A hidden panel drops its document; on show it loads anew and asks for the current view.
host.postMessage({type: 'ready'});

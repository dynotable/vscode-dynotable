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
  distinctValues,
  emptySelection,
  fitWidth,
  inValueSet,
  isEmpty,
  isNumericColumn,
  isSelected,
  jsonTokens,
  MISSING,
  prettyText,
  selectionCells,
  totals,
  type Cell,
  type GridSelection,
  type ValueSet
} from '../src/grid-model';
import type {CopyFormat, PanelMessage, ResultView, View} from '../src/results-model';

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
  table: Table<typeof features, Cell[]>;
  /** The `fitWidth` sizes, for Reset Column Widths. */
  fitSizing: Record<string, number>;
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
/** Enables Previous and Next only while the find field holds a query. */
let syncSteps = () => {};
let rowsNote: HTMLElement | undefined;
let totalsLine: HTMLElement | undefined;
let drag: Drag | undefined;
/** Set by a drag that moved, so the click that follows its mouseup does not sort. */
let suppressClick = false;
/** The open menu or column filter popup; at most one is open. */
let popup: HTMLElement | undefined;
let dialog: HTMLDialogElement | undefined;
/** The column whose filter popup this mousedown closed, so the click on its icon does not reopen it. */
let closedFilter: string | undefined;

/** On macOS a Ctrl-click is a right-click, so Cmd adds there. */
const MAC = navigator.platform.startsWith('Mac');
const addModifier = (event: MouseEvent | KeyboardEvent) => (MAC ? event.metaKey : event.ctrlKey);

const MIN_WIDTH = 60;
const MAX_WIDTH = 400;
const TOOLTIP_LENGTH = 2000;
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

/** For the main action of a popup or dialog only. */
function primary(node: HTMLButtonElement): HTMLButtonElement {
  node.classList.add('primary');
  return node;
}

const SVG = 'http://www.w3.org/2000/svg';

function arrowIcon(direction: 'up' | 'down'): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute(
    'd',
    direction === 'up' ? 'M8.5 13.5V3M4 7.5 8.5 3 13 7.5' : 'M8.5 2.5V13M4 8.5 8.5 13 13 8.5'
  );
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  svg.append(path);
  return svg;
}

function iconAction(label: string, icon: SVGSVGElement, run: () => void): HTMLButtonElement {
  const node = element('button', undefined, 'icon');
  node.title = label;
  node.setAttribute('aria-label', label);
  node.append(icon);
  node.addEventListener('click', run);
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
  const columns: ColumnDef<typeof features, Cell[]>[] = view.columns.map((name, index) => {
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
      accessorFn: (row: Cell[]) => {
        const cell = row[index];
        return cell && !isEmpty(cell) ? cell : undefined;
      },
      sortUndefined: 'last',
      sortDescFirst: false,
      sortFn: (a, b, id) => compareCells(a.getValue<Cell>(id), b.getValue<Cell>(id), numeric),
      filterFn: (row, id, filter: ValueSet) =>
        inValueSet(row.original[Number(id)] ?? MISSING, filter)
    };
  });
  const table = constructTable({
    features,
    columns,
    data: view.cells,
    enableMultiSort: false,
    globalFilterFn: (row, id, filter: FindFilter) =>
      cellMatches(row.original[Number(id)]?.text ?? '', filter.query),
    // The default reads the first row's value, and skips a column whose first cell is missing.
    getColumnCanGlobalFilter: (column) =>
      (column as unknown as Column<typeof features, Cell[]>).getIsVisible(),
    initialState: {columnSizing}
  });
  const digits = String(view.cells.length).length;
  return {
    view,
    table,
    fitSizing: columnSizing,
    rowNumberWidth: (Math.max(digits, 2) + 2) * width,
    selection: emptySelection(),
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
    grid.selection = emptySelection();
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
    td.classList.toggle('selected', isSelected(selection, row, column));
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
  // The view order. `getVisibleLeafColumns()` does not put the pinned columns first; this does.
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
    // Only the name shrinks, so a narrow column keeps its sort mark and filter icon.
    const head = element('div', undefined, 'head');
    head.append(
      element('span', view.columns[Number(column.id)] ?? '', 'name'),
      element('span', sorted ? SORT_MARK[sorted] : '', 'sort'),
      filterIcon(column.id, column.getIsFiltered())
    );
    th.append(head, element('span', undefined, 'resize'));
    th.addEventListener('click', (event) => {
      if (suppressClick || (event.target as Element).closest('.resize')) return;
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
      const cell = row.original[Number(column.id)] ?? MISSING;
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

/**
 * `extend` selects the range from the anchor, else from the focused cell; `add` keeps the old
 * selection.
 */
function select(point: Point, extend: boolean, add: boolean, wholeRows: boolean): void {
  if (!grid) return;
  const from = extend ? anchorOr(grid.focus ?? point) : point;
  const rows = between(grid.viewRows, from.row, point.row);
  const columns = wholeRows ? [] : between(grid.viewColumns, from.column, point.column);
  if (add) {
    for (const row of rows) grid.selection.rows.add(row);
    for (const column of columns) grid.selection.columns.add(column);
    grid.selection.wholeRows ||= wholeRows;
  } else grid.selection = {rows: new Set(rows), columns: new Set(columns), wholeRows};
  grid.focus = point;
  grid.anchor = from;
  paint();
}

const selectCell = (point: Point, extend: boolean, add: boolean) =>
  select(point, extend, add, false);

function selectRow(row: number, extend: boolean, add: boolean): void {
  const focusColumn = grid?.focus?.column;
  const column =
    focusColumn !== undefined && grid?.viewColumns.includes(focusColumn)
      ? focusColumn
      : grid?.viewColumns[0];
  if (column !== undefined) select({row, column}, extend, add, true);
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
  syncSteps();
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
  const previous = iconAction('Previous Match (Shift+Enter)', arrowIcon('up'), () => step(-1));
  const next = iconAction('Next Match (Enter)', arrowIcon('down'), () => step(1));
  const input = element('input', undefined, 'find');
  input.placeholder = 'Find';
  input.value = query;
  syncSteps = () => {
    previous.disabled = next.disabled = input.value === '';
  };
  syncSteps();
  input.addEventListener('input', () => {
    syncSteps();
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

  const {box, label} = checkbox('Filter rows', filterRows);
  box.addEventListener('change', () => {
    filterRows = box.checked;
    setFindFilter();
    rebuildTable();
  });

  rowsNote = element('span', undefined, 'note');
  rowsNote.hidden = true;
  return [input, previous, next, label, rowsNote];
}

/** A width change keeps the table; it updates the widths, the table width and the sticky offsets. */
function applyWidths(): void {
  if (!grid || !scrollBox) return;
  const {table} = grid;
  for (const col of scrollBox.querySelectorAll<HTMLElement>('col[data-column]'))
    col.style.width = `${table.getColumn(col.dataset.column ?? '')?.getSize() ?? MIN_WIDTH}px`;
  const node = scrollBox.querySelector('table');
  if (node) node.style.width = `${grid.rowNumberWidth + table.getTotalSize()}px`;
  layoutSticky();
}

function resize(id: string, width: number): void {
  grid?.table.setColumnSizing((old) => ({...old, [id]: width}));
  applyWidths();
}

/** Moves `source` to the place of `target`: after it when it moves right, before it when left. */
function moved(ids: string[], source: string, target: string): string[] {
  const out = ids.filter((id) => id !== source);
  out.splice(ids.indexOf(target), 0, source);
  return out;
}

/** Every column id in `columnOrder` order; an empty `columnOrder` means definition order. */
function fullOrder(current: Grid): string[] {
  const order = current.table.atoms.columnOrder?.get() ?? [];
  const ids = current.view.columns.map((_, index) => String(index));
  return [...order.filter((id) => ids.includes(id)), ...ids.filter((id) => !order.includes(id))];
}

/**
 * Pinned columns come first, in `columnPinning.start` order, whatever `columnOrder` says. So a move
 * inside the pinned group writes `start`, and a move across the group boundary is refused.
 */
function reorder(source: string, target: string): void {
  if (!grid) return;
  const {table} = grid;
  const pinned = table.atoms.columnPinning?.get().start ?? [];
  if (pinned.includes(source) !== pinned.includes(target)) return;
  if (pinned.includes(source))
    table.setColumnPinning((old) => ({...old, start: moved(old.start, source, target)}));
  else table.setColumnOrder(moved(fullOrder(grid), source, target));
  rebuildTable();
}

function startDrag(event: MouseEvent): void {
  const target = event.target as Element;
  const th = target.closest('th[data-column]');
  const column = th instanceof HTMLElement ? th.dataset.column : undefined;
  if (event.button !== 0 || !grid || column === undefined || target.closest('.filter')) return;
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
  } else if (event.key === 'Enter' && event.shiftKey && grid?.focus) {
    event.preventDefault();
    openViewer(grid.focus);
  } else if (event.key === 'Escape') {
    if (popup) closePopup();
    else clearQuery();
  }
}

/** A JSON cell's tooltip is built on the first hover, not for every cell up front. */
function showTooltip(event: MouseEvent): void {
  const td = (event.target as Element).closest('td.json');
  if (!(td instanceof HTMLElement) || td.title || !grid) return;
  const cell = cellAt(Number(td.dataset.row), Number(td.dataset.column));
  td.title = prettyText(cell.text, 'json').slice(0, TOOLTIP_LENGTH);
}

const columnName = (column: number) => grid?.view.columns[column] ?? '';

/** The position of an original row in the view, 1…N. */
const rowNumber = (row: number) => (grid?.viewRows.indexOf(row) ?? -1) + 1;

function closePopup(): void {
  if (!popup) return;
  popup.remove();
  popup = undefined;
  if (scrollBox?.isConnected) scrollBox.focus({preventScroll: true});
}

/** Chromium fires `close` later, so the node goes now. */
function closeDialog(): void {
  const open = dialog;
  dialog = undefined;
  open?.close();
  open?.remove();
}

/** A render that changes the kind or the `resultId` closes everything, with no focus move. */
function closeAll(): void {
  popup?.remove();
  popup = undefined;
  closeDialog();
}

/** Fixed at the given point, moved left and up when it would leave the window. */
function placePopup(node: HTMLElement, x: number, y: number): void {
  closePopup();
  root.append(node);
  const {width, height} = node.getBoundingClientRect();
  node.style.left = `${Math.max(0, Math.min(x, window.innerWidth - width))}px`;
  node.style.top = `${Math.max(0, Math.min(y, window.innerHeight - height))}px`;
  popup = node;
}

interface MenuItem {
  label: string;
  run: () => void;
  disabled?: boolean;
}

function openMenu(entries: (MenuItem | 'separator')[], x: number, y: number): void {
  const menu = element('div', undefined, 'menu');
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;
  const items: HTMLElement[] = [];
  for (const entry of entries) {
    if (entry === 'separator') {
      menu.append(element('div', undefined, 'separator'));
      continue;
    }
    const item = element('div', entry.label, 'item');
    item.setAttribute('role', 'menuitem');
    if (entry.disabled) item.setAttribute('aria-disabled', 'true');
    else {
      item.addEventListener('click', () => {
        closePopup();
        entry.run();
      });
      items.push(item);
    }
    menu.append(item);
  }
  let active = -1;
  menu.addEventListener('keydown', (event) => {
    const move = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (move !== 0 && items.length > 0) {
      event.preventDefault();
      active =
        active < 0
          ? move > 0
            ? 0
            : items.length - 1
          : (active + move + items.length) % items.length;
      items.forEach((item, index) => item.classList.toggle('active', index === active));
      items[active]?.scrollIntoView({block: 'nearest'});
    } else if (event.key === 'Enter') {
      event.preventDefault();
      items[active]?.click();
    } else if (event.key === 'Escape') closePopup();
  });
  placePopup(menu, x, y);
  menu.focus();
}

/** One dialog at a time: opening one closes the one before. */
function openDialog(title: string, body: HTMLElement, buttons: HTMLButtonElement[]): void {
  closePopup();
  closeDialog();
  const node = element('dialog');
  const actions = element('div', undefined, 'actions');
  actions.append(
    ...buttons,
    action('Close', () => node.close())
  );
  body.classList.add('body');
  node.append(element('div', title, 'title'), body, actions);
  // Esc closes a modal dialog natively and fires `close` too.
  node.addEventListener('close', () => {
    node.remove();
    if (dialog !== node) return;
    dialog = undefined;
    if (scrollBox?.isConnected) scrollBox.focus({preventScroll: true});
  });
  root.append(node);
  dialog = node;
  node.showModal();
}

function openViewer(point: Point): void {
  if (!grid) return;
  const {row, column} = point;
  const cell = cellAt(row, column);
  const pretty = prettyText(cell.text, cell.kind);
  const body = element('pre', undefined, 'viewer');
  if (cell.kind === 'json' || pretty !== cell.text)
    for (const token of jsonTokens(pretty))
      body.append(
        token.kind === 'space' ? token.text : element('span', token.text, `tok-${token.kind}`)
      );
  else body.textContent = pretty;
  openDialog(`${columnName(column)} · row ${rowNumber(row)}`, body, [
    primary(
      button('Copy', {type: 'copyValue', resultId: grid.view.resultId, row, column, pretty: true})
    )
  ]);
}

function openRecord(row: number): void {
  if (!grid) return;
  const table = element('table', undefined, 'record');
  const head = element('tr');
  head.append(element('th', 'Column'), element('th', 'Value'));
  table.append(head);
  for (const column of grid.viewColumns) {
    const cell = cellAt(row, column);
    // An auto-layout table ignores a cell's max-width, so the width goes on a block in the cell.
    const value = element('td', undefined, cell.kind);
    value.append(element('div', cell.text, 'value'));
    value.addEventListener('dblclick', () => openViewer({row, column}));
    const tr = element('tr');
    tr.append(element('td', columnName(column)), value);
    table.append(tr);
  }
  // A table does not scroll itself, so a block around it does.
  const box = element('div');
  box.append(table);
  openDialog(`Row ${rowNumber(row)}`, box, []);
}

/** Visibility does not re-run the global filter, so a fresh filter value forces it. */
function refilter(current: Grid): void {
  current.table.setGlobalFilter((old: FindFilter | undefined) => old && {...old});
}

/** A hidden column's filter would hide rows that the user cannot see the reason for. */
function hideColumns(ids: string[]): void {
  if (!grid) return;
  grid.table.setColumnVisibility((old) => ({
    ...old,
    ...Object.fromEntries(ids.map((id) => [id, false]))
  }));
  grid.table.setColumnFilters((old) => old.filter((filter) => !ids.includes(filter.id)));
  refilter(grid);
  rebuildTable();
}

function showAllColumns(): void {
  if (!grid) return;
  grid.table.setColumnVisibility({});
  refilter(grid);
  rebuildTable();
}

function sortBy(id: string, desc: boolean | undefined): void {
  grid?.table.setSorting(desc === undefined ? [] : [{id, desc}]);
  rebuildTable();
}

/** `column.pin(false)` puts the column back at its old `columnOrder` place; Unpin puts it first. */
function pin(id: string, pinned: boolean): void {
  if (!grid) return;
  const column = grid.table.getColumn(id);
  if (pinned) column?.pin('start');
  else {
    column?.pin(false);
    grid.table.setColumnOrder([id, ...fullOrder(grid).filter((each) => each !== id)]);
  }
  rebuildTable();
}

function selectColumn(column: number): void {
  const [row] = grid?.viewRows ?? [];
  if (!grid || row === undefined) return;
  grid.selection = {rows: new Set(grid.viewRows), columns: new Set([column]), wholeRows: false};
  grid.focus = {row, column};
  grid.anchor = grid.focus;
  paint();
}

function resetWidths(): void {
  if (!grid) return;
  grid.table.setColumnSizing(grid.fitSizing);
  applyWidths();
}

const hideItem = (current: Grid, column: number): MenuItem => ({
  label: 'Hide Column',
  run: () => hideColumns([String(column)]),
  disabled: current.viewColumns.length <= 1
});

const showAllItem = (current: Grid): MenuItem => ({
  label: 'Show All Columns',
  run: showAllColumns,
  disabled: current.viewColumns.length === current.view.columns.length
});

function copyColumnItem(current: Grid, column: number): MenuItem {
  const {resultId} = current.view;
  return {
    label: 'Copy Column',
    run: () => host.postMessage({type: 'copyColumn', resultId, column, rows: current.viewRows}),
    disabled: current.viewRows.length === 0
  };
}

function openCellMenu(point: Point, x: number, y: number): void {
  if (!grid) return;
  const current = grid;
  const {resultId} = current.view;
  const {row, column} = point;
  const copySelection = (format: Exclude<CopyFormat, 'tsv'>) => () => {
    const {rows, columns} = selectionCells(
      current.selection,
      current.viewRows,
      current.viewColumns
    );
    if (rows.length > 0)
      host.postMessage({type: 'copySelection', resultId, format, rows, columns, header: true});
  };
  openMenu(
    [
      {
        label: 'Copy Value',
        run: () => host.postMessage({type: 'copyValue', resultId, row, column, pretty: false})
      },
      {label: 'Copy Selection as CSV', run: copySelection('csv')},
      {label: 'Copy Selection as JSON', run: copySelection('json')},
      {label: 'Copy Selection as Markdown', run: copySelection('markdown')},
      copyColumnItem(current, column),
      'separator',
      hideItem(current, column),
      showAllItem(current),
      'separator',
      {label: 'Record View', run: () => openRecord(row)}
    ],
    x,
    y
  );
}

function openHeaderMenu(id: string, x: number, y: number): void {
  if (!grid) return;
  const column = Number(id);
  const {resultId} = grid.view;
  const pinned = Boolean(grid.table.getColumn(id)?.getIsPinned());
  const others = grid.viewColumns.filter((each) => each !== column).map(String);
  openMenu(
    [
      {
        label: 'Copy Column Name',
        run: () => host.postMessage({type: 'copyColumnName', resultId, column})
      },
      copyColumnItem(grid, column),
      {
        label: 'Select Column',
        run: () => selectColumn(column),
        disabled: grid.viewRows.length === 0
      },
      'separator',
      {label: 'Sort Ascending', run: () => sortBy(id, false)},
      {label: 'Sort Descending', run: () => sortBy(id, true)},
      {label: 'Clear Sort', run: () => sortBy(id, undefined)},
      'separator',
      pinned
        ? {label: 'Unpin Column', run: () => pin(id, false)}
        : {label: 'Pin Column', run: () => pin(id, true)},
      hideItem(grid, column),
      {label: 'Hide Other Columns', run: () => hideColumns(others)},
      showAllItem(grid),
      {label: 'Reset Column Widths', run: resetWidths}
    ],
    x,
    y
  );
}

/** A right-click on an unselected cell selects only that cell; inside the selection, it keeps it. */
function onContextMenu(event: MouseEvent): void {
  const target = event.target as Element;
  const th = target.closest('th[data-column]');
  const td = target.closest('td[data-column]');
  if (!grid) return;
  if (th instanceof HTMLElement) {
    event.preventDefault();
    openHeaderMenu(th.dataset.column ?? '', event.clientX, event.clientY);
  } else if (td instanceof HTMLElement) {
    event.preventDefault();
    const point = {row: Number(td.dataset.row), column: Number(td.dataset.column)};
    if (isSelected(grid.selection, point.row, point.column)) {
      grid.focus = point;
      paint();
    } else selectCell(point, false, false);
    openCellMenu(point, event.clientX, event.clientY);
  } else if (target.closest('.rownum')) event.preventDefault();
}

function setColumnFilter(id: string, filter: ValueSet | undefined): void {
  grid?.table.getColumn(id)?.setFilterValue(filter);
  closePopup();
  rebuildTable();
}

function checkbox(
  text: string,
  checked: boolean
): {box: HTMLInputElement; label: HTMLLabelElement} {
  const box = element('input');
  box.type = 'checkbox';
  box.checked = checked;
  const label = element('label');
  label.append(box, element('span', text));
  return {box, label};
}

/**
 * The `(empty)` entry has no `value`: it stands for the `missing` and `null` cells, so a string
 * cell that reads `(empty)` is a value of its own.
 */
interface FilterEntry {
  box: HTMLInputElement;
  label: HTMLLabelElement;
  text: string;
  value?: string;
}

function openFilter(id: string, x: number, y: number): void {
  const column = grid?.table.getColumn(id);
  if (!grid || !column) return;
  const index = Number(id);
  const {empty, values} = distinctValues(grid.view.cells.map((row) => row[index] ?? MISSING));
  const current = column.getFilterValue() as ValueSet | undefined;
  const entries: FilterEntry[] = [];
  if (empty) entries.push({...checkbox('(empty)', current?.empty ?? true), text: '(empty)'});
  for (const value of values)
    entries.push({...checkbox(value, current?.values.has(value) ?? true), text: value, value});
  // A long value is cut with an ellipsis; the tooltip shows all of it.
  for (const entry of entries) entry.label.title = entry.text;

  const shown = () => entries.filter((entry) => !entry.label.hidden);
  const all = checkbox('Select All', false);
  const syncAll = () => {
    all.box.checked = shown().length > 0 && shown().every((entry) => entry.box.checked);
  };
  all.box.addEventListener('change', () => {
    for (const entry of shown()) entry.box.checked = all.box.checked;
  });
  const search = element('input');
  search.placeholder = 'Search';
  search.addEventListener('input', () => {
    for (const entry of entries) entry.label.hidden = !cellMatches(entry.text, search.value);
    syncAll();
  });
  const list = element('div', undefined, 'values');
  list.append(...entries.map((entry) => entry.label));
  list.addEventListener('change', syncAll);
  syncAll();

  const apply = action('Apply', () => {
    if (entries.every((entry) => entry.box.checked)) setColumnFilter(id, undefined);
    else
      setColumnFilter(id, {
        empty: entries.some((entry) => entry.value === undefined && entry.box.checked),
        values: new Set(
          entries.flatMap((entry) =>
            entry.value !== undefined && entry.box.checked ? [entry.value] : []
          )
        )
      });
  });
  const actions = element('div', undefined, 'actions');
  actions.append(
    primary(apply),
    action('Clear', () => setColumnFilter(id, undefined))
  );

  const node = element('div', undefined, 'popup');
  node.dataset.filter = id;
  node.append(search, all.label, list, actions);
  node.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closePopup();
  });
  placePopup(node, x, y);
  search.focus();
}

function filterIcon(id: string, filtered: boolean): HTMLElement {
  const icon = element('span', '▿', filtered ? 'filter active' : 'filter');
  icon.title = 'Filter';
  icon.addEventListener('click', (event) => {
    event.stopPropagation();
    if (closedFilter === id) return;
    const {left, bottom} = icon.getBoundingClientRect();
    openFilter(id, left, bottom);
  });
  return icon;
}

function renderResult(bar: HTMLElement, view: ResultView): void {
  if (grid?.view.resultId !== view.resultId) grid = createGrid(view);
  const summary = element('span', view.summary, 'summary');
  summary.title = view.summary;
  bar.append(summary);
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
  box.addEventListener('dblclick', (event) => {
    const td = (event.target as Element).closest('td[data-column]');
    if (td instanceof HTMLElement)
      openViewer({row: Number(td.dataset.row), column: Number(td.dataset.column)});
  });
  box.addEventListener('contextmenu', onContextMenu);
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
  closeAll();
  const bar = element('div', undefined, 'bar');
  root.replaceChildren(bar);
  scrollBox = undefined;
  findInput = undefined;
  syncSteps = () => {};
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

document.addEventListener('mousedown', (event) => {
  closedFilter = undefined;
  if (popup && !(event.target instanceof Node && popup.contains(event.target))) {
    closedFilter = popup.dataset.filter;
    closePopup();
  }
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

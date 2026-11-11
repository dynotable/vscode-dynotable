// @vitest-environment jsdom
import {beforeAll, describe, expect, it} from 'vitest';
import type {Cell} from '../src/grid-model';
import type {PanelMessage, ResultView, View} from '../src/results-model';

const posted: PanelMessage[] = [];

const render = (view: View) =>
  window.dispatchEvent(new MessageEvent('message', {data: {type: 'render', view}}));

const header = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('th[data-column]')].find(
    (th) => th.querySelector('.name')?.textContent === name
  );

/** The shown texts of one column, top to bottom. */
const columnTexts = (column: number) =>
  [...document.querySelectorAll(`td[data-column="${column}"]`)].map((td) => td.textContent);

const number = (n: number): Cell => ({text: String(n), kind: 'number'});

/** Text order sorts `10` before `2`; only a numeric sort gives 2, 9, 10. */
const amounts = (resultId: string): ResultView => ({
  kind: 'result',
  resultId,
  summary: '5 rows',
  columns: ['amount'],
  cells: [
    [number(10)],
    [{text: 'null', kind: 'null'}],
    [number(9)],
    [{text: '', kind: 'missing'}],
    [number(2)]
  ]
});

const text = (value: string): Cell => ({text: value, kind: 'string'});

/** The `note` column's first cell is missing. The amounts are not in sort order. */
const people = (resultId: string): ResultView => ({
  kind: 'result',
  resultId,
  summary: '3 rows',
  columns: ['name', 'note', 'amount'],
  cells: [
    [text('Ann'), {text: '', kind: 'missing'}, number(30)],
    [text('Bob'), text('vip'), number(10)],
    [text('Cy'), text('new'), number(20)]
  ]
});

const cell = (row: number, column: number) =>
  document.querySelector(`td[data-row="${row}"][data-column="${column}"]`) as HTMLElement;

const mouse = (target: EventTarget, type: string, init: MouseEventInit = {}) =>
  target.dispatchEvent(new MouseEvent(type, {bubbles: true, cancelable: true, ...init}));

const keydown = (target: EventTarget, init: KeyboardEventInit) => {
  const event = new KeyboardEvent('keydown', {bubbles: true, cancelable: true, ...init});
  target.dispatchEvent(event);
  return event;
};

const copy = () => {
  const event = new Event('copy', {cancelable: true});
  document.dispatchEvent(event);
  return event;
};

const scrollBox = () => document.querySelector('.grid') as HTMLElement;
const findField = () => document.querySelector('input.find') as HTMLInputElement;
const headerNames = () =>
  [...document.querySelectorAll('th[data-column] .name')].map((node) => node.textContent);

const contextMenu = (target: Element) => mouse(target, 'contextmenu', {clientX: 5, clientY: 5});
const menuItem = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.menu [role="menuitem"]')].find(
    (node) => node.textContent === label
  ) as HTMLElement;
const choose = (target: Element, label: string) => {
  contextMenu(target);
  menuItem(label).click();
};
const disabled = (label: string) => menuItem(label).getAttribute('aria-disabled') === 'true';
const rowNumber = (row: number) =>
  document.querySelector(`tr[data-row="${row}"] td.rownum`) as HTMLElement;
const dialogButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(
    (node) => node.textContent === label
  ) as HTMLButtonElement;
const openFilter = (name: string) =>
  ((header(name) as HTMLElement).querySelector('.filter') as HTMLElement).click();
const filterOption = (label: string) =>
  [...document.querySelectorAll('.popup label')]
    .find((node) => node.textContent === label)
    ?.querySelector('input') as HTMLInputElement;
const popupButton = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('.popup button')].find(
    (node) => node.textContent === label
  ) as HTMLButtonElement;

beforeAll(async () => {
  Object.assign(globalThis, {
    acquireVsCodeApi: () => ({postMessage: (message: PanelMessage) => posted.push(message)})
  });
  // jsdom has no layout, so no scrollIntoView, and no modal dialogs.
  Element.prototype.scrollIntoView = () => {};
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    if (!this.open) return;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  document.body.innerHTML = '<div id="root"></div>';
  await import('./results');
});

describe('results webview', () => {
  // A hidden panel drops its document; without this, it shows nothing when shown again.
  it('asks the host for the current view when it loads', () => {
    expect(posted[0]).toEqual({type: 'ready'});
  });

  it('renders a hostile column name and cell as text', () => {
    const hostile = '<img src=x onerror="alert(1)">';
    render({
      kind: 'result',
      resultId: 'hostile',
      summary: hostile,
      columns: [hostile],
      cells: [[{text: hostile, kind: 'string'}]]
    });
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(document.querySelector('th[data-column] .name')?.textContent).toBe(hostile);
    expect(document.querySelector('td[data-column]')?.textContent).toBe(hostile);
  });

  it('renders an empty result with no grid', () => {
    render({kind: 'result', resultId: 'empty', summary: '0 rows', columns: [], cells: []});
    expect(document.querySelector('table')).toBeNull();
    expect(document.body.textContent).toContain('No rows.');
  });

  // The host copies only from the result the id names, so a stale button copies nothing.
  it('copies and exports with the id of the result it shows', () => {
    render({kind: 'result', resultId: 'copy-1', summary: '0 rows', columns: [], cells: []});
    const buttons = [...document.querySelectorAll('button')];
    buttons.find((node) => node.textContent === 'Copy CSV')?.click();
    buttons.find((node) => node.textContent === 'Copy JSON')?.click();
    buttons.find((node) => node.textContent === 'Export…')?.click();
    expect(posted.slice(-3)).toEqual([
      {type: 'copy', resultId: 'copy-1', format: 'csv'},
      {type: 'copy', resultId: 'copy-1', format: 'json'},
      {type: 'export', resultId: 'copy-1'}
    ]);
  });

  it('sorts a numeric column ascending, then descending with the empty cells last', () => {
    render(amounts('sort'));
    header('amount')?.click();
    expect(columnTexts(0)).toEqual(['2', '9', '10', 'null', '']);
    header('amount')?.click();
    expect(columnTexts(0)).toEqual(['10', '9', '2', 'null', '']);
  });

  // The host renders `running` before each run ends; a failed run restores the old result.
  it('keeps the sort across a running render and resets it for a new result', () => {
    render(amounts('kept'));
    header('amount')?.click();
    render({kind: 'running', runId: 'r1'});
    render(amounts('kept'));
    expect(columnTexts(0)).toEqual(['2', '9', '10', 'null', '']);
    render(amounts('next'));
    expect(columnTexts(0)).toEqual(['10', 'null', '9', '', '2']);
  });

  // VS Code runs the native copy for Cmd/Ctrl+C. The grid must take it and Cmd/Ctrl+A only while it
  // has the focus, so a copy or a select-all in the find field still works. jsdom reports no
  // platform, so the add modifier is Ctrl.
  it('takes copy and select-all only while the grid has the focus', () => {
    render(people('keys'));
    mouse(cell(0, 0), 'click');
    mouse(cell(1, 0), 'click', {shiftKey: true});
    findField().focus();
    const count = posted.length;
    expect(copy().defaultPrevented).toBe(false);
    expect(posted).toHaveLength(count);
    expect(keydown(findField(), {key: 'a', ctrlKey: true}).defaultPrevented).toBe(false);

    scrollBox().focus();
    expect(copy().defaultPrevented).toBe(true);
    expect(posted.at(-1)).toEqual({
      type: 'copySelection',
      resultId: 'keys',
      format: 'tsv',
      rows: [0, 1],
      columns: [0],
      header: false
    });
    expect(keydown(scrollBox(), {key: 'a', ctrlKey: true}).defaultPrevented).toBe(true);
  });

  // A drag ends in a click on the header; without the guard it sorts. A guard that is never
  // cleared stops the next real sort.
  it('resizes and reorders by drag without a sort, then sorts on the next click', async () => {
    render(people('drag'));
    mouse(header('amount')?.querySelector('.resize') as Element, 'mousedown', {
      clientX: 100,
      buttons: 1
    });
    mouse(document, 'mousemove', {clientX: 150, buttons: 1});
    mouse(header('amount') as Element, 'mouseup', {clientX: 150});
    mouse(header('amount') as Element, 'click');
    expect((document.querySelector('col[data-column="2"]') as HTMLElement).style.width).toBe(
      '138px'
    );
    expect((document.querySelector('table') as HTMLElement).style.width).toBe('314px');
    expect(columnTexts(2)).toEqual(['30', '10', '20']);

    mouse(header('name') as Element, 'mousedown', {clientX: 10, buttons: 1});
    mouse(document, 'mousemove', {clientX: 200, buttons: 1});
    mouse(header('amount') as Element, 'mouseup', {clientX: 200});
    expect(headerNames()).toEqual(['note', 'amount', 'name']);
    await new Promise((resolve) => setTimeout(resolve));
    mouse(header('amount') as Element, 'click');
    expect(columnTexts(2)).toEqual(['10', '20', '30']);
  });

  // TanStack's default global filter skips a column whose first cell is missing, so it would hide
  // every row.
  it('filters rows on a column whose first cell is missing', () => {
    render(people('filter'));
    const filterRows = document.querySelector('input[type="checkbox"]') as HTMLInputElement;
    filterRows.click();
    findField().value = 'vip';
    findField().dispatchEvent(new Event('input'));
    keydown(findField(), {key: 'Enter'});
    expect(columnTexts(0)).toEqual(['Bob']);
    expect(document.querySelector('.note')?.textContent).toBe('1 of 3 rows shown');
    filterRows.click();
  });

  it('shows the totals for two selected numbers of the focused column, not for one', () => {
    render(people('totals'));
    const line = document.querySelector('.totals') as HTMLElement;
    mouse(cell(0, 2), 'click');
    mouse(cell(1, 2), 'click', {shiftKey: true});
    expect(line.hidden).toBe(false);
    expect(line.textContent).toBe('Count 2 · Sum 40 · Avg 20 · Min 10 · Max 30');
    mouse(cell(0, 2), 'click');
    expect(line.hidden).toBe(true);
  });

  // Every copy names original rows and column indices in view order. A copy that sent view
  // positions, or columns in definition order, would copy other cells than the ones shown.
  it('copies the shown cells by original row and column through sort, hide, reorder and pin', () => {
    render({
      kind: 'result',
      resultId: 'wiring',
      summary: '3 rows',
      columns: ['o.orderId', 'name', 'amount', 'note'],
      cells: [
        [text('A1'), text('Ann'), number(30), text('x')],
        [text('B2'), text('Bob'), number(10), text('y')],
        [text('C3'), text('Cy'), number(20), {text: '{"k":1}', kind: 'json'}]
      ]
    });
    header('amount')?.click();
    header('amount')?.click();
    choose(header('note') as Element, 'Hide Column');
    mouse(header('name') as Element, 'mousedown', {clientX: 10, buttons: 1});
    mouse(document, 'mousemove', {clientX: 200, buttons: 1});
    mouse(header('o.orderId') as Element, 'mouseup', {clientX: 200});
    choose(header('amount') as Element, 'Pin Column');
    expect(headerNames()).toEqual(['amount', 'name', 'o.orderId']);

    mouse(cell(0, 2), 'click');
    mouse(cell(2, 1), 'click', {shiftKey: true});
    scrollBox().focus();
    copy();
    expect(posted.at(-1)).toEqual({
      type: 'copySelection',
      resultId: 'wiring',
      format: 'tsv',
      rows: [0, 2],
      columns: [2, 1],
      header: false
    });

    mouse(cell(1, 0), 'click');
    copy();
    expect(posted.at(-1)).toEqual({
      type: 'copyValue',
      resultId: 'wiring',
      row: 1,
      column: 0,
      pretty: false
    });

    choose(header('o.orderId') as Element, 'Copy Column');
    expect(posted.at(-1)).toEqual({
      type: 'copyColumn',
      resultId: 'wiring',
      column: 0,
      rows: [0, 2, 1]
    });
    choose(header('o.orderId') as Element, 'Copy Column Name');
    expect(posted.at(-1)).toEqual({type: 'copyColumnName', resultId: 'wiring', column: 0});

    keydown(scrollBox(), {key: 'Enter', shiftKey: true});
    dialogButton('Copy').click();
    expect(posted.at(-1)).toEqual({
      type: 'copyValue',
      resultId: 'wiring',
      row: 1,
      column: 0,
      pretty: true
    });
    dialogButton('Close').click();

    mouse(rowNumber(0), 'click');
    mouse(rowNumber(2), 'click', {shiftKey: true});
    header('amount')?.click();
    scrollBox().focus();
    copy();
    expect(posted.at(-1)).toEqual({
      type: 'copySelection',
      resultId: 'wiring',
      format: 'tsv',
      rows: [0, 2],
      columns: [2, 1, 0],
      header: false
    });
  });

  // A right-click that kept an old selection elsewhere would copy cells the user did not point at;
  // one that dropped the selection would make the menu copy one cell only.
  it('copies the right-clicked cell, or the selection that holds it, from the cell menu', () => {
    render(people('menu-copy'));
    choose(cell(1, 0), 'Copy Selection as CSV');
    expect(posted.at(-1)).toEqual({
      type: 'copySelection',
      resultId: 'menu-copy',
      format: 'csv',
      rows: [1],
      columns: [0],
      header: true
    });

    mouse(cell(0, 0), 'click');
    mouse(cell(1, 1), 'click', {shiftKey: true});
    contextMenu(cell(1, 1));
    const menu = document.querySelector('.menu') as HTMLElement;
    keydown(menu, {key: 'ArrowDown'});
    keydown(menu, {key: 'ArrowDown'});
    keydown(menu, {key: 'Enter'});
    expect(posted.at(-1)).toEqual({
      type: 'copySelection',
      resultId: 'menu-copy',
      format: 'csv',
      rows: [0, 1],
      columns: [0, 1],
      header: true
    });
    expect(document.querySelector('.menu')).toBeNull();
  });

  // A filter left on a hidden column hides rows for a reason the user cannot see.
  it('clears a hidden column filter and disables the menu items that have nothing to act on', () => {
    render(people('column-filter'));
    openFilter('name');
    filterOption('Bob').click();
    popupButton('Apply').click();
    expect(columnTexts(0)).toEqual(['Ann', 'Cy']);
    choose(header('name') as Element, 'Hide Column');
    expect(columnTexts(2)).toEqual(['30', '10', '20']);

    openFilter('amount');
    filterOption('10').click();
    popupButton('Apply').click();
    expect(columnTexts(2)).toEqual(['30', '20']);
    openFilter('amount');
    filterOption('Select All').click();
    popupButton('Apply').click();
    expect(columnTexts(2)).toEqual(['30', '10', '20']);
    expect(header('amount')?.querySelector('.filter')?.classList.contains('active')).toBe(false);

    openFilter('amount');
    filterOption('Select All').click();
    popupButton('Apply').click();
    expect(columnTexts(2)).toEqual([]);
    contextMenu(header('amount') as Element);
    expect(disabled('Copy Column')).toBe(true);

    render(amounts('one-column'));
    contextMenu(cell(0, 0));
    expect(disabled('Hide Column')).toBe(true);
    contextMenu(header('amount') as Element);
    expect(disabled('Hide Column')).toBe(true);
  });

  it('renders a hostile column name and JSON value as text in every popup', () => {
    // No quotes, so the JSON text holds the markup as it is.
    const hostile = '<img src=x onerror=alert(1)>';
    const json = '{"x":"<img src=x onerror=alert(1)>"}';
    render({
      kind: 'result',
      resultId: 'hostile-popups',
      summary: '1 row',
      columns: [hostile],
      cells: [[{text: json, kind: 'json'}]]
    });
    mouse(cell(0, 0), 'mouseover');
    expect(cell(0, 0).title).toContain(hostile);

    mouse(cell(0, 0), 'dblclick');
    const viewer = document.querySelector('dialog') as HTMLDialogElement;
    expect(viewer.querySelector('.title')?.textContent).toBe(`${hostile} · row 1`);
    expect(viewer.querySelector('pre')?.textContent).toContain(hostile);
    dialogButton('Close').click();

    openFilter(hostile);
    expect(filterOption(json)).toBeDefined();
    keydown(document.querySelector('.popup') as Element, {key: 'Escape'});

    choose(cell(0, 0), 'Record View');
    const record = [...document.querySelectorAll('dialog table.record td')].map(
      (td) => td.textContent
    );
    expect(record).toEqual([hostile, json]);
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });

  // An action in a popup left open on old content would act on the new result.
  it('closes the dialog and the menu when a new result renders', () => {
    render(people('popups-a'));
    mouse(cell(0, 0), 'dblclick');
    const viewer = document.querySelector('dialog') as HTMLDialogElement;
    contextMenu(cell(1, 0));
    expect(viewer.open).toBe(true);
    expect(document.querySelector('.menu')).not.toBeNull();
    render(people('popups-b'));
    expect(viewer.open).toBe(false);
    expect(viewer.isConnected).toBe(false);
    expect(document.querySelector('.menu')).toBeNull();
  });

  // The host acts only on the run the cancel names.
  it('cancels with the run id of the run it shows', () => {
    render({kind: 'running', runId: 'r7'});
    document.querySelector('button')?.click();
    expect(posted.at(-1)).toEqual({type: 'cancel', runId: 'r7'});
  });
});

// @vitest-environment jsdom
import {beforeAll, describe, expect, it} from 'vitest';
import type {PanelMessage, View} from '../src/results-model';

const posted: PanelMessage[] = [];

const render = (view: View) =>
  window.dispatchEvent(new MessageEvent('message', {data: {type: 'render', view}}));

beforeAll(async () => {
  Object.assign(globalThis, {
    acquireVsCodeApi: () => ({postMessage: (message: PanelMessage) => posted.push(message)})
  });
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
    expect(document.querySelector('th')?.textContent).toBe(hostile);
    expect(document.querySelector('td')?.textContent).toBe(hostile);
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

  // The host acts only on the run the cancel names.
  it('cancels with the run id of the run it shows', () => {
    render({kind: 'running', runId: 'r7'});
    document.querySelector('button')?.click();
    expect(posted.at(-1)).toEqual({type: 'cancel', runId: 'r7'});
  });
});

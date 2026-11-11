/**
 * The results webview. It builds every node with `textContent`: column names and cells are data
 * from the user's tables, never markup.
 */
import type {PanelMessage, View} from '../src/results-model';

declare function acquireVsCodeApi(): {postMessage(message: PanelMessage): void};

const host = acquireVsCodeApi();
const root = document.getElementById('root') as HTMLElement;

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

function render(view: View): void {
  const bar = element('div', undefined, 'bar');
  root.replaceChildren(bar);
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
    case 'result': {
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
      const head = element('tr');
      head.append(...view.columns.map((column) => element('th', column)));
      const thead = element('thead');
      thead.append(head);
      const body = element('tbody');
      for (const row of view.cells) {
        const tr = element('tr');
        tr.append(...row.map((cell) => element('td', cell.text)));
        body.append(tr);
      }
      const table = element('table');
      table.append(thead, body);
      root.append(table);
    }
  }
}

window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data as {type?: unknown; view?: View} | null;
  if (data?.type === 'render' && data.view) render(data.view);
});

// A hidden panel drops its document; on show it loads anew and asks for the current view.
host.postMessage({type: 'ready'});

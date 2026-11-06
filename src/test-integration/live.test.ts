import {strict as assert} from 'node:assert';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {beforeEach, describe, it} from 'mocha';
import * as vscode from 'vscode';
import type {Node} from '../explorer-model';
import type {WireError} from '../protocol';
import {
  api,
  channelText,
  explorerGroup as group,
  extension,
  quickPicks,
  show,
  sleep,
  toasts,
  waitFor,
  waitForStatus
} from './harness';

/** The name or slug of a roster row with no app window open on it. */
const PROFILE = process.env.DYNOTABLE_LIVE_PROFILE ?? '';
/** Large enough that a run is still in flight when its cancel arrives. */
const LARGE_TABLE = process.env.DYNOTABLE_LIVE_LARGE_TABLE ?? '';
const CANCELLED = 'The run was cancelled before it finished.';
/** Seeded tables: `orders` has `customerId`, `status` and `orderId`. */
const ORDERS = 'orders';
const CUSTOMERS = 'customers';

/** Filled by the explorer test. */
const found = {table: '', index: ''};

const sentence = (file: string) =>
  (JSON.parse(readFileSync(join(extension().extensionPath, 'contract', file), 'utf8')) as WireError)
    .message;

const run = () => vscode.commands.executeCommand('dynotable.run');
const execute = <T>(command: string, ...args: unknown[]) =>
  vscode.commands.executeCommand<T>(command, ...args);
const result = async () => {
  const view = (await api()).panel.view();
  return view.kind === 'result' ? view : assert.fail(`the panel shows ${view.kind}`);
};
const diagnostics = async (uri: vscode.Uri) => {
  await waitFor('diagnostics', () => vscode.languages.getDiagnostics(uri).length > 0);
  return vscode.languages.getDiagnostics(uri);
};
/** The library logs each request the server answered with an error. */
const failedRequests = (since: number) =>
  channelText
    .slice(since)
    .filter((text) => /^Request \S+ failed/.test(text))
    .map((text) => text.split('\n')[0]);
const children = async (node?: Node) => (await api()).explorer.children(node);

/** A buffer and where to ask. */
interface Cell {
  text: string;
  at?: number[];
}
type Probe = (uri: vscode.Uri, at: vscode.Position) => Thenable<unknown>;

const PROBES: Record<string, Probe> = {
  completionProvider: (uri, at) =>
    execute<vscode.CompletionList>('vscode.executeCompletionItemProvider', uri, at).then(
      (list) => list.items
    ),
  codeActionProvider: (uri) =>
    execute('vscode.executeCodeActionProvider', uri, new vscode.Range(0, 0, 9, 0)),
  codeLensProvider: (uri) => execute('vscode.executeCodeLensProvider', uri),
  hoverProvider: (uri, at) => execute('vscode.executeHoverProvider', uri, at),
  inlayHintProvider: (uri) =>
    execute('vscode.executeInlayHintProvider', uri, new vscode.Range(0, 0, 9, 0)),
  documentFormattingProvider: (uri) =>
    execute('vscode.executeFormatDocumentProvider', uri, {tabSize: 2, insertSpaces: true}),
  definitionProvider: (uri, at) => execute('vscode.executeDefinitionProvider', uri, at),
  documentHighlightProvider: (uri, at) => execute('vscode.executeDocumentHighlights', uri, at),
  renameProvider: (uri, at) =>
    execute<vscode.WorkspaceEdit>('vscode.executeDocumentRenameProvider', uri, at, 'z').then(
      (edit) => edit.entries()
    )
};

/**
 * VS Code adds word-based completion and textual highlights when the server gives none, so those
 * two must show something only the server knows.
 */
function answers(key: string, answer: unknown, text: string): boolean {
  if (!Array.isArray(answer) || answer.length === 0) return false;
  if (key === 'completionProvider') {
    return (answer as vscode.CompletionItem[]).some(
      ({label}) => !text.includes(typeof label === 'string' ? label : label.label)
    );
  }
  if (key === 'documentHighlightProvider') {
    return (answer as vscode.DocumentHighlight[]).some(
      ({kind}) => kind !== vscode.DocumentHighlightKind.Text
    );
  }
  return true;
}

const SUFFIX: Record<string, string> = {
  sql: '.dynotable.sql',
  partiql: '.partiql',
  opensearch: '.opensearch'
};

type Cells = Record<string, Cell | 'none'> & {diagnostics: Cell};

/**
 * Per dialect, a buffer that gets a non-empty answer, or `none` where the spec gives none:
 * formatting is not offered for PartiQL, definition, highlight and rename read SQL table aliases
 * only, and an OpenSearch query gets no lens and no inlay hint. `diagnostics` holds a mistake that
 * has a quick fix.
 */
function cellsOf(index: string): Record<string, Cells> {
  const alias = {text: `select o.orderId from "${ORDERS}" o where o.status = 'x'`, at: [0, 7]};
  const where = {text: `SELECT * FROM "${ORDERS}" WHERE `, at: [0, 29]};
  const commaJoin = {text: `SELECT * FROM "${ORDERS}" o, "${CUSTOMERS}" c`};
  const like = {text: `SELECT * FROM "${ORDERS}" WHERE "status" LIKE 'a%'`};
  const table = {text: `SELECT * FROM "${ORDERS}"`, at: [0, 15]};
  const misspelt = {text: `// dynotable: index=${index}\n{"query":{"mtach":{"status":"x"}}}`};
  const match = `// dynotable: index=${index}\n{"query":{"match":{"status":"x"}}}`;
  return {
    sql: {
      diagnostics: commaJoin,
      completionProvider: where,
      codeActionProvider: commaJoin,
      codeLensProvider: alias,
      hoverProvider: alias,
      inlayHintProvider: alias,
      documentFormattingProvider: alias,
      definitionProvider: alias,
      documentHighlightProvider: alias,
      renameProvider: alias
    },
    partiql: {
      diagnostics: like,
      completionProvider: where,
      codeActionProvider: like,
      codeLensProvider: table,
      hoverProvider: table,
      inlayHintProvider: table,
      documentFormattingProvider: 'none',
      definitionProvider: 'none',
      documentHighlightProvider: 'none',
      renameProvider: 'none'
    },
    opensearch: {
      diagnostics: misspelt,
      // Inside the field name: the index mapping's fields.
      completionProvider: {text: match, at: [1, 22]},
      codeActionProvider: misspelt,
      codeLensProvider: 'none',
      // On the clause name.
      hoverProvider: {text: match, at: [1, 12]},
      inlayHintProvider: 'none',
      documentFormattingProvider: {text: match},
      definitionProvider: 'none',
      documentHighlightProvider: 'none',
      renameProvider: 'none'
    }
  };
}

describe('live', () => {
  beforeEach(() => {
    toasts.length = 0;
  });

  // Runs first: nothing has chosen a profile, and the roster has more than one row.
  it('@live profile-required: an unbound Run shows the server sentence once', async () => {
    await show('unbound.dynotable.sql', `SELECT * FROM "${LARGE_TABLE}"`);
    await waitForStatus('unbound');
    await run();
    assert.deepEqual(toasts, [{kind: 'error', message: sentence('error-profile-required.json')}]);
  });

  it('@live profile picker: choosing the profile connects with it', async () => {
    quickPicks.answer = undefined;
    quickPicks.shown.length = 0;
    await vscode.commands.executeCommand('dynotable.selectProfile');
    const item = quickPicks.shown[0]?.find(
      (row) => row.label === PROFILE || row.description === PROFILE
    );
    assert.ok(item, 'DYNOTABLE_LIVE_PROFILE names no roster row');
    quickPicks.answer = item.label;
    await vscode.commands.executeCommand('dynotable.selectProfile');
    await waitForStatus('connected');
    assert.deepEqual((await api()).status(), {kind: 'connected', requested: item.label});
  });

  it("@live explorer: lists the profile's tables and indices", async () => {
    const tables = await children(await group('DynamoDB'));
    const names = tables.map((node) => (node.kind === 'table' ? node.name : ''));
    assert.ok(names.includes(LARGE_TABLE), JSON.stringify(names));
    found.table = names.find((name) => name !== '' && name !== LARGE_TABLE) ?? '';
    const [target] = await children(await group('OpenSearch'));
    const [index] = target ? await children(target) : [];
    assert.equal(index?.kind, 'index');
    found.index = index.name;
    assert.notEqual(found.table, '');
  });

  for (const [name, text] of [
    ['run.dynotable.sql', () => `SELECT * FROM "${found.table}"`],
    ['run.partiql', () => `SELECT * FROM "${found.table}"`],
    ['run.opensearch', () => `// dynotable: index=${found.index}\n{"query": {"match_all": {}}}`]
  ] as const) {
    it(`@live run: ${name} shows its rows in the panel`, async () => {
      await show(name, text());
      await run();
      assert.deepEqual(toasts, []);
      const view = (await api()).panel.view();
      assert.equal(view.kind, 'result');
      assert.ok(view.cells.length > 0, 'the run returned no rows');
    });
  }

  it('@live refusal copy: profile-window-required shows the server sentence once', async () => {
    const editor = await show('open.dynotable.sql', `SELECT * FROM "${found.table}"`);
    await vscode.commands.executeCommand('dynotable.openInApp', {
      uri: editor.document.uri.toString()
    });
    assert.deepEqual(toasts, [
      {kind: 'error', message: sentence('error-profile-window-required.json')}
    ]);
  });

  // A run that finishes after the cancel must be refused, never answered with rows.
  for (const name of ['cancel.dynotable.sql', 'cancel.partiql']) {
    it(`@live cancel: a ${name} run cancelled at once is refused and shows no rows`, async () => {
      await show(name, `SELECT * FROM "${LARGE_TABLE}"`);
      const done = run();
      const {panel} = await api();
      await waitFor('the running view', () => panel.view().kind === 'running');
      const view = panel.view();
      assert.equal(view.kind, 'running');
      await panel.receive({type: 'cancel', runId: view.runId});
      await done;
      const outcome = panel.outcome();
      assert.equal(outcome?.kind, 'failed');
      const {code, message, data} = outcome.error as WireError;
      assert.deepEqual(
        {code, message, data},
        {
          code: -32803,
          message: CANCELLED,
          data: {code: 'run-failed'}
        }
      );
      assert.equal(panel.view().kind, 'cancelled');
      assert.deepEqual(toasts, []);
    });
  }

  it("@live quick fix: PartiQL IN ('a') offers Use brackets, which leaves IN ['a']", async () => {
    const editor = await show('fix.partiql', `SELECT * FROM "${ORDERS}" WHERE "status" IN ('a')`);
    const {uri} = editor.document;
    const parens = (await diagnostics(uri)).find(
      (d) => editor.document.getText(d.range) === "('a')"
    );
    assert.ok(parens, 'no diagnostic on the parentheses');
    const actions = await execute<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      uri,
      parens.range
    );
    const fix = actions.find((action) => action.title === 'Use brackets');
    assert.ok(fix?.edit, JSON.stringify(actions.map((action) => action.title)));
    await vscode.workspace.applyEdit(fix.edit);
    assert.equal(editor.document.getText(), `SELECT * FROM "${ORDERS}" WHERE "status" IN ['a']`);
  });

  it('@live completion: invoked after FROM, it lists the seeded tables', async () => {
    const editor = await show('from.dynotable.sql', 'SELECT * FROM ');
    const list = await execute<vscode.CompletionList>(
      'vscode.executeCompletionItemProvider',
      editor.document.uri,
      new vscode.Position(0, 14)
    );
    const labels = list.items.map(({label}) => (typeof label === 'string' ? label : label.label));
    for (const table of [ORDERS, CUSTOMERS]) assert.ok(labels.includes(table), table);
  });

  it('@live run: SQL GROUP BY customerId answers the columns ["customerid", "COUNT(*)"]', async () => {
    await show(
      'group.dynotable.sql',
      `SELECT customerId, COUNT(*) FROM "${ORDERS}" GROUP BY customerId`
    );
    await run();
    assert.deepEqual(toasts, []);
    assert.deepEqual((await result()).columns, ['customerid', 'COUNT(*)']);
  });

  it('@live lens Run: the Run lens of the second statement runs the second statement', async () => {
    const second = `SELECT COUNT(*) FROM "${CUSTOMERS}"`;
    const editor = await show(
      'lens.dynotable.sql',
      `SELECT customerId FROM "${ORDERS}";\n${second};`
    );
    const lenses = await execute<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      editor.document.uri
    );
    const lens = lenses.find(
      (candidate) => candidate.range.start.line === 1 && candidate.command?.title === 'Run'
    )?.command;
    assert.ok(lens?.arguments, JSON.stringify(lenses.map((candidate) => candidate.command)));
    await execute(lens.command, ...lens.arguments);
    assert.deepEqual(toasts, []);
    assert.equal((await result()).executedStatement, second);
  });

  it('@live Pick Index: writes the listed index into the directive', async () => {
    quickPicks.answer = 'OpenSearch';
    await execute('dynotable.newQuery');
    const document = vscode.window.activeTextEditor?.document;
    assert.equal(document?.languageId, 'opensearch');
    quickPicks.answer = found.index;
    await execute('dynotable.pickIndex');
    assert.equal(document.getText(), `// dynotable: index=${found.index}\n`);
    assert.deepEqual(toasts, []);
  });

  it('@live validate: Validate against the index shows one message', async () => {
    const editor = await show(
      'validate.opensearch',
      `// dynotable: index=${found.index}\n{"query": {"match_all": {}}}`
    );
    const actions = await execute<vscode.CodeAction[]>(
      'vscode.executeCodeActionProvider',
      editor.document.uri,
      new vscode.Range(0, 0, 1, 0)
    );
    const validate = actions.find(
      (action) => action.title === 'Validate against the index'
    )?.command;
    assert.ok(validate, JSON.stringify(actions.map((action) => action.title)));
    await execute(validate.command, ...(validate.arguments ?? []));
    await waitFor('the message', () => toasts.length > 0);
    // The server also sends the sentence as window/showMessage; a second toast would come now.
    await sleep(1000);
    assert.equal(toasts.length, 1, JSON.stringify(toasts));
  });

  for (const dialect of Object.keys(SUFFIX)) {
    it(`@live capabilities: every advertised capability answers in a ${dialect} buffer`, async () => {
      const cells = cellsOf(found.index)[dialect] ?? assert.fail(dialect);
      const capabilities = (await api()).client()?.initializeResult?.capabilities;
      assert.ok(capabilities, 'no connected session');
      const advertised = Object.keys(capabilities).filter(
        (key) => key.endsWith('Provider') && key !== 'executeCommandProvider'
      );
      const since = channelText.length;
      const missing: string[] = [];
      let n = 0;
      const open = async ({text}: Cell) =>
        (await show(`cap-${n++}${SUFFIX[dialect]}`, text)).document.uri;
      // Pushed, so not a capability key.
      if ((await diagnostics(await open(cells.diagnostics))).length === 0)
        missing.push('diagnostics');
      for (const key of advertised) {
        const probe = PROBES[key];
        const cell = cells[key];
        if (!probe || cell === undefined) {
          missing.push(`${key}: no probe`);
          continue;
        }
        if (cell === 'none') {
          // The spec gives no answer for this dialect; the server must still not fail.
          await Promise.resolve(
            probe(await open(cells.diagnostics), new vscode.Position(0, 0))
          ).catch(() => {});
          continue;
        }
        const uri = await open(cell);
        if (key === 'codeActionProvider') await diagnostics(uri);
        const [line = 0, character = 0] = cell.at ?? [];
        const answer = await Promise.resolve(
          probe(uri, new vscode.Position(line, character))
        ).catch((error: unknown) => `failed: ${String(error)}`);
        if (!answers(key, answer, cell.text)) missing.push(`${key}: ${JSON.stringify(answer)}`);
      }
      assert.deepEqual([...missing, ...failedRequests(since)], []);
    });
  }

  // A reload stops the extension mid-run without a cancel; the app must end that run.
  it('@live teardown: after the client goes away mid-run, the next run is not refused as busy', async () => {
    await show('dropped.dynotable.sql', `SELECT * FROM "${LARGE_TABLE}"`);
    const done = run();
    const {panel, client} = await api();
    await waitFor('the running view', () => panel.view().kind === 'running');
    // Lets the request reach the app.
    await sleep(200);
    await client()?.dispose();
    await done;
    await execute('dynotable.reconnect');
    await waitForStatus('connected');
    toasts.length = 0;
    await show('after.dynotable.sql', `SELECT * FROM "${LARGE_TABLE}"`);
    await run();
    assert.deepEqual(toasts, []);
    await result();
  });
});

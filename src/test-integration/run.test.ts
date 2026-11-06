import {strict as assert} from 'node:assert';
import {after, before, beforeEach, describe, it} from 'mocha';
import * as vscode from 'vscode';
import {RpcFailure, type Id} from '../../scripts/rpc';
import type {CommandArgs, Range, WireError} from '../protocol';
import {
  api,
  fakeServer,
  show as showFile,
  sleep,
  toastAnswers,
  toasts,
  waitFor,
  waitForStatus
} from './harness';

const fake = fakeServer();
const RUN = 'dynotable.runStatement';
const OPEN = 'dynotable.openInApp';
const TWO_STATEMENTS = 'SELECT * FROM "orders";\nSELECT * FROM "customers";';

const line = (n: number, length: number): Range => ({
  start: {line: n, character: 0},
  end: {line: n, character: length}
});

/** A Run lens per line, as the server sends: an anchor range, the statement in the argument. */
const runLenses = (params: unknown) => {
  const {uri} = (params as {textDocument: {uri: string}}).textDocument;
  return TWO_STATEMENTS.split('\n').map((text, n) => ({
    range: line(n, 0),
    command: {title: 'Run', command: RUN, arguments: [{uri, range: line(n, text.length)}]}
  }));
};
fake.handle('textDocument/codeLens', runLenses);

const commandMessages = (command: string) =>
  fake.received.filter(
    (message) =>
      message.method === 'workspace/executeCommand' &&
      (message.params as {command: string}).command === command
  );
const commandCalls = (command: string) =>
  commandMessages(command).map(
    (message) => (message.params as {arguments: [CommandArgs]}).arguments[0]
  );
const lastRun = () => commandCalls(RUN).at(-1);
/** VS Code also cancels its own requests, such as code lenses, when the editor changes. */
const cancels = () => {
  const runs = new Set(commandMessages(RUN).map((message) => message.id));
  return fake.received.filter(
    (message) =>
      message.method === '$/cancelRequest' && runs.has((message.params as {id: unknown}).id as Id)
  );
};
const panel = async () => (await api()).panel;
const view = async () => (await panel()).view();
const run = () => vscode.commands.executeCommand('dynotable.run');

const show = (name: string, text = TWO_STATEMENTS) => showFile(name, text);

/** Starts a held run and returns its id and its settled command promise. */
async function heldRun(name: string): Promise<{runId: string; done: Thenable<unknown>}> {
  fake.holdRuns = true;
  await show(name);
  const runs = commandCalls(RUN).length;
  const done = run();
  const hook = await panel();
  // The panel shows the running view before the request reaches the server.
  await waitFor('the held run', () => commandCalls(RUN).length > runs);
  await waitFor('the running view', () => hook.view().kind === 'running');
  const current = hook.view();
  assert.equal(current.kind, 'running');
  return {runId: current.runId, done};
}

describe('run', () => {
  before(async () => {
    await fake.start();
    await show('first.dynotable.sql');
    await waitForStatus('connected');
  });
  after(() => fake.stop());
  beforeEach(() => {
    fake.holdRuns = false;
    fake.answerCancelledRuns = false;
    fake.unhandle(`command:${RUN}`);
    fake.unhandle(`command:${OPEN}`);
    toasts.length = 0;
  });

  it('lens Run: reaches the panel with the statement range of its argument', async () => {
    const editor = await show('lens.dynotable.sql');
    const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      'vscode.executeCodeLensProvider',
      editor.document.uri
    );
    const second = lenses.find((lens) => lens.range.start.line === 1)?.command;
    assert.ok(second?.arguments);
    await vscode.commands.executeCommand(second.command, ...second.arguments);
    assert.deepEqual(lastRun()?.range, line(1, 26));
    assert.equal((await view()).kind, 'result');
  });

  it('caret Run: a caret in the second statement runs the second statement', async () => {
    const editor = await show('caret.dynotable.sql');
    editor.selection = new vscode.Selection(1, 5, 1, 5);
    await run();
    assert.deepEqual(lastRun()?.range, line(1, 26));
  });

  // The lens ranges include their end, so a caret right after the `;` runs that statement.
  it('caret Run: a caret at the end of the first statement runs the first statement', async () => {
    const editor = await show('caret-end.dynotable.sql');
    editor.selection = new vscode.Selection(0, 23, 0, 23);
    await run();
    assert.deepEqual(lastRun()?.range, line(0, 23));
  });

  it('caret Run: a caret outside every statement sends no range', async () => {
    const editor = await show('caret-outside.dynotable.sql', `${TWO_STATEMENTS}\n\n`);
    const runs = commandCalls(RUN).length;
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await run();
    assert.equal(commandCalls(RUN).length, runs + 1);
    assert.ok(!('range' in (lastRun() ?? {})), JSON.stringify(lastRun()));
  });

  // Else VS Code shows its own "command failed", or the whole file runs.
  it('caret Run: a refused lens request shows the server sentence and runs nothing', async () => {
    const refusal = fake.fixture('error-signed-out.json') as WireError;
    fake.handle('textDocument/codeLens', () => {
      throw new RpcFailure(refusal);
    });
    const runs = commandCalls(RUN).length;
    try {
      await show('caret-refused.dynotable.sql');
      await run();
    } finally {
      fake.handle('textDocument/codeLens', runLenses);
    }
    assert.deepEqual(toasts, [{kind: 'error', message: refusal.message}]);
    assert.equal(commandCalls(RUN).length, runs);
  });

  // The lens range is for the text before the edit; there it selects the first statement.
  it('caret Run: an edit while the lens request is pending runs nothing', async () => {
    // Else VS Code's own lens requests reach the handler too.
    const lens = vscode.workspace.getConfiguration('editor');
    await lens.update('codeLens', false, vscode.ConfigurationTarget.Global);
    const editor = await show('caret-edited.dynotable.sql');
    editor.selection = new vscode.Selection(1, 5, 1, 5);
    fake.handle('textDocument/codeLens', async (params) => {
      await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'SELECT 1;\n'));
      return runLenses(params);
    });
    const runs = commandCalls(RUN).length;
    try {
      await run();
    } finally {
      fake.handle('textDocument/codeLens', runLenses);
      await lens.update('codeLens', undefined, vscode.ConfigurationTarget.Global);
    }
    assert.equal(commandCalls(RUN).length, runs);
    assert.deepEqual(toasts, [
      {kind: 'information', message: 'The query changed before the run started. Run it again.'}
    ]);
  });

  // Copy is the only route to the CSV formula guard.
  it('copy: Copy CSV and Copy JSON put the rows on the clipboard', async () => {
    await show('copy.dynotable.sql');
    await run();
    const hook = await panel();
    await hook.receive({type: 'copy', format: 'csv'});
    const csv = (await vscode.env.clipboard.readText()).split('\r\n');
    assert.deepEqual(csv.slice(0, 2), [
      'o.orderId,o.status,c.country',
      'ORD2024056001,PENDING,Tajikistan'
    ]);
    await hook.receive({type: 'copy', format: 'json'});
    const json = JSON.parse(await vscode.env.clipboard.readText()) as unknown[];
    assert.deepEqual(json[0], {
      'o.orderId': 'ORD2024056001',
      'o.status': 'PENDING',
      'c.country': 'Tajikistan'
    });
  });

  it('unreadable: an answer that is not a result shows one error and keeps the last view', async () => {
    await show('before.dynotable.sql');
    await run();
    const previous = await view();
    assert.equal(previous.kind, 'result');
    fake.handle(`command:${RUN}`, () => ({}));
    await show('unreadable.dynotable.sql');
    await run();
    assert.deepEqual(toasts, [
      {kind: 'error', message: 'DynoTable answered with a result the extension cannot read.'}
    ]);
    assert.deepEqual(await view(), previous);
  });

  // A `Selection` serializes its anchor and active ends too.
  it('selection Run: an explicit selection reaches the wire as {start, end}', async () => {
    const editor = await show('selection.partiql');
    editor.selection = new vscode.Selection(0, 22, 0, 0);
    await run();
    assert.deepEqual(lastRun()?.range, line(0, 22));
  });

  // The server refuses a blank-text range for opensearch.
  it('opensearch Run: with no selection, sends no range', async () => {
    await show('query.opensearch', '// dynotable: index=orders\n{"query": {"match_all": {}}}');
    await run();
    const args = lastRun();
    assert.ok(args);
    assert.ok(!('range' in args), JSON.stringify(args));
  });

  for (const name of ['cancel.dynotable.sql', 'cancel.partiql']) {
    it(`cancel: a held ${name} run sends $/cancelRequest and shows nothing`, async () => {
      const cancelled = cancels().length;
      const {runId, done} = await heldRun(name);
      await (await panel()).receive({type: 'cancel', runId});
      await done;
      assert.equal(cancels().length, cancelled + 1);
      assert.deepEqual(toasts, []);
      assert.equal((await view()).kind, 'cancelled');
    });
  }

  it('late answer: rows that arrive after Cancel do not replace the cancelled view', async () => {
    fake.answerCancelledRuns = true;
    const {runId, done} = await heldRun('late.partiql');
    await (await panel()).receive({type: 'cancel', runId});
    await done;
    assert.deepEqual(toasts, []);
    assert.equal((await view()).kind, 'cancelled');
  });

  it('stale cancel: a cancel for another run id leaves the current run alone', async () => {
    const cancelled = cancels().length;
    const {runId, done} = await heldRun('stale.partiql');
    await (await panel()).receive({type: 'cancel', runId: 'an-earlier-run'});
    await sleep(500);
    assert.equal(cancels().length, cancelled);
    assert.equal((await view()).kind, 'running');
    await (await panel()).receive({type: 'cancel', runId});
    await done;
  });

  it('one run at a time: a second Run while one runs is refused', async () => {
    const runs = commandCalls(RUN).length;
    const {runId, done} = await heldRun('one.partiql');
    await run();
    assert.equal(commandCalls(RUN).length, runs + 1);
    assert.equal(toasts.length, 1);
    assert.equal(toasts[0]?.kind, 'warning');
    await (await panel()).receive({type: 'cancel', runId});
    await done;
  });

  it('panel close: closing the panel cancels the run', async () => {
    const cancelled = cancels().length;
    const {done} = await heldRun('close.partiql');
    (await panel()).close();
    await done;
    assert.equal(cancels().length, cancelled + 1);
  });

  // The server sends the sentence as window/showMessage too; the client adds nothing.
  it('validateQuery: produces exactly one toast', async () => {
    const editor = await show('validate.opensearch', '// dynotable: index=orders\nstatus:PENDING');
    await vscode.commands.executeCommand('dynotable.validateQuery', {
      uri: editor.document.uri.toString()
    });
    await waitFor('the toast', () => toasts.length > 0);
    await sleep(500);
    assert.equal(toasts.length, 1);
  });

  it('refusal copy: profile-window-required shows the server sentence once', async () => {
    const refusal = fake.fixture('error-profile-window-required.json') as WireError;
    fake.handle(`command:${OPEN}`, () => {
      throw new RpcFailure(refusal);
    });
    const editor = await show('open.dynotable.sql');
    await vscode.commands.executeCommand(OPEN, {uri: editor.document.uri.toString()});
    await sleep(500);
    assert.deepEqual(toasts, [{kind: 'error', message: refusal.message}]);
  });

  it('stage: stage-in-app shows its sentence once and offers Stage, which opens the app', async () => {
    const refusal = fake.fixture('error-stage-in-app.json') as WireError;
    fake.handle(`command:${RUN}`, () => {
      throw new RpcFailure(refusal);
    });
    fake.handle(`command:${OPEN}`, () => null);
    toastAnswers.set(refusal.message, 'Stage in DynoTable');
    const opens = commandCalls(OPEN).length;
    const editor = await show('stage.partiql', "INSERT INTO \"orders\" VALUE {'orderId': 'x'}");
    editor.selection = new vscode.Selection(0, 0, 0, 10);
    try {
      await run();
    } finally {
      toastAnswers.clear();
    }
    assert.deepEqual(commandCalls(OPEN).at(-1), {
      uri: editor.document.uri.toString(),
      range: line(0, 10)
    });
    assert.equal(commandCalls(OPEN).length, opens + 1);
    assert.deepEqual(toasts, [{kind: 'error', message: refusal.message}]);
  });
});

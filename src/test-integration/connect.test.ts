import {strict as assert} from 'node:assert';
import {readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {join} from 'node:path';
import {after, before, describe, it} from 'mocha';
import * as vscode from 'vscode';
import {LanguageClient} from 'vscode-languageclient/node';
import {RpcFailure} from '../../scripts/rpc';
import {REASONS} from '../reasons';
import {
  api,
  channelText,
  fakeServer,
  harnessEnv,
  installFakeApp,
  recordSpawns,
  sleep,
  toastAnswers,
  toasts,
  waitFor,
  waitForStatus,
  workspace
} from './harness';

const fake = fakeServer();
/** Where this launch's settings, state and log files go. */
const written = [join(harnessEnv('DYNOTABLE_HARNESS_DIR'), 'user-data'), workspace];
/** Every token the fake has served, for the leak checks. */
const tokens = new Set<string>();
const LIST_TABLES = 'dynotable/listTables';

/** Where the channels stood after the trace-sink control client, and the tokens it could log. */
let afterControl: {text: number; tokens: Set<string>} | undefined;

const leaked = (texts = channelText) =>
  texts.some((text) => [...tokens].some((token) => text.includes(token)));
/** Every regular file under `dir`. Node 20.9's recursive `readdirSync` walks into sockets. */
const filesUnder = (dir: string): string[] =>
  readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : entry.isFile() ? [path] : [];
  });
const fileLeaked = (secrets: Iterable<string> = tokens) =>
  written.flatMap(filesUnder).some((file) => {
    let bytes: Buffer;
    try {
      bytes = readFileSync(file);
    } catch {
      // Removed since the listing.
      return false;
    }
    return [...secrets].some((token) => bytes.includes(token));
  });
const reconnect = () => vscode.commands.executeCommand('dynotable.reconnect');
const initializeCount = () => fake.initializeParams.length;
const liveSessions = () => [...fake.sessions].filter((session) => session.initialized).length;

async function openFile(name: string, text = 'SELECT * FROM "orders"') {
  writeFileSync(join(workspace, name), text);
  return vscode.workspace.openTextDocument(vscode.Uri.file(join(workspace, name)));
}

/** Restores the fake's defaults and connects anew. */
async function fresh(): Promise<void> {
  fake.version = (
    fake.fixture('initialize.json') as {serverInfo: {version: string}}
  ).serverInfo.version;
  fake.onInitialize = undefined;
  fake.initializeDelayMs = 0;
  fake.handle(LIST_TABLES, () => fake.fixture('list-tables.json'));
  // A test may have left a port file with a wrong token.
  fake.rotateToken();
  await reconnect();
  await waitForStatus('connected');
  tokens.add(fake.token);
}

describe('connect', () => {
  before(() => fake.start());
  // The error paths below use new tokens: none may reach a channel or a file either.
  after(() => {
    assert.ok(afterControl, 'the trace-sink test did not run');
    const later = [...tokens].filter((token) => !afterControl?.tokens.has(token));
    assert.ok(later.length > 0, 'no test used a new token');
    assert.ok(!leaked(channelText.slice(afterControl.text)), 'a channel holds a token');
    assert.ok(!fileLeaked(later), 'a settings, state or log file holds a token');
  });
  after(() => fake.stop());

  // Runs first, before anything has connected.
  it('selectors: only DynoTable-scoped SQL connects and gets didOpen', async () => {
    tokens.add(fake.token);
    const outside = await openFile('plain.sql');
    const plainUntitled = await vscode.workspace.openTextDocument({language: 'sql'});
    await sleep(1000);
    assert.equal(initializeCount(), 0, 'an out-of-scope SQL buffer started a connection');
    const query = await vscode.workspace.openTextDocument(
      vscode.Uri.parse('untitled:Query-1.dynotable.sql')
    );
    assert.equal(query.languageId, 'sql');
    await waitFor('didOpen of the New query buffer', () => fake.opened(query.uri.toString()));
    assert.ok(!fake.opened(outside.uri.toString()));
    assert.ok(!fake.opened(plainUntitled.uri.toString()));
  });

  it('capabilities: initialize carries the three gating capabilities', async () => {
    await fresh();
    const params = (
      fake.initializeParams as Array<{
        capabilities: {
          window?: {showMessage?: unknown; workDoneProgress?: boolean};
          textDocument?: {completion?: {completionItem?: {snippetSupport?: boolean}}};
        };
      }>
    ).at(-1);
    assert.ok(params?.capabilities.window?.showMessage);
    assert.equal(params?.capabilities.window?.workDoneProgress, true);
    assert.equal(
      params?.capabilities.textDocument?.completion?.completionItem?.snippetSupport,
      true
    );
  });

  // The positive control for every "no library toast" assertion: the stubs see the library.
  it('toast stubs count a server showMessage of each type', async () => {
    toasts.length = 0;
    for (const type of [1, 2, 3]) fake.notifyAll('window/showMessage', {type, message: `m${type}`});
    await waitFor('three toasts', () => toasts.length === 3);
    assert.deepEqual(
      toasts.map(({kind, message}) => [kind, message]),
      [
        ['error', 'm1'],
        ['warning', 'm2'],
        ['information', 'm3']
      ]
    );
  });

  it('trace sink: no channel or file holds the token, while a client without it logs it', async () => {
    assert.ok(!leaked(), 'a channel holds the token');
    assert.ok(!fileLeaked(), 'a settings, state or log file holds the token');
    // The control registers the server's commands too, which a live client already holds.
    fake.dropSessions();
    await waitForStatus('disconnected', 'connection-ended');
    // The same settings and log level, with the library's default trace channel.
    const control = new LanguageClient(
      'dynotable',
      'DynoTable control',
      () =>
        new Promise((resolve) => {
          const socket = connect(fake.port, '127.0.0.1', () =>
            resolve({reader: socket, writer: socket})
          );
        }),
      {
        initializationOptions: {token: fake.token},
        outputChannel: vscode.window.createOutputChannel('DynoTable control', {log: true})
      }
    );
    await control.start();
    await control.stop();
    assert.ok(leaked(), 'the positive control logged no token: tracing is not on');
    await waitFor('the control trace in a log file', () => fileLeaked());
    afterControl = {text: channelText.length, tokens: new Set(tokens)};
  });

  it('storage: neither workspaceState nor globalState holds the token', async () => {
    const {context} = await api();
    for (const memento of [context.workspaceState, context.globalState]) {
      const stored = JSON.stringify(memento.keys().map((key) => [key, memento.get(key)]));
      for (const token of tokens) assert.ok(!stored.includes(token));
    }
  });

  it('squatter requests: applyEdit, registerCapability, showDocument and configuration are refused', async () => {
    await fresh();
    const document = await openFile('squat.partiql', 'SELECT 1');
    await waitFor('didOpen', () => fake.opened(document.uri.toString()));
    const range = {start: {line: 0, character: 0}, end: {line: 0, character: 8}};
    const answers = [
      ...(await fake.requestAll('workspace/applyEdit', {
        edit: {changes: {[document.uri.toString()]: [{range, newText: 'DROP'}]}}
      })),
      ...(await fake.requestAll('client/registerCapability', {
        registrations: [{id: 'squat', method: 'workspace/didChangeWatchedFiles'}]
      })),
      ...(await fake.requestAll('window/showDocument', {
        uri: 'https://example.com',
        external: true
      })),
      // The library would answer with the user's settings.
      ...(await fake.requestAll('workspace/configuration', {items: [{}]}))
    ];
    assert.equal(answers.length, 4);
    for (const answer of answers) assert.ok(answer instanceof RpcFailure, JSON.stringify(answer));
    assert.equal(document.getText(), 'SELECT 1');
  });

  it('unbound: profile-required sets unbound; signed-out does not', async () => {
    await fresh();
    fake.handle(LIST_TABLES, () => {
      throw new RpcFailure(fake.fixture('error-profile-required.json') as never);
    });
    await reconnect();
    await waitForStatus('unbound');

    fake.handle(LIST_TABLES, () => {
      throw new RpcFailure(fake.fixture('error-signed-out.json') as never);
    });
    const listed = fake.received.length;
    await reconnect();
    await waitFor('the connect-time listing', () =>
      fake.received.slice(listed).some((message) => message.method === LIST_TABLES)
    );
    await sleep(500);
    assert.equal((await api()).status().kind, 'connected');
  });

  it('-32601 on the connect-time listing latches the missing-request reason', async () => {
    await fresh();
    fake.handle(LIST_TABLES, () => {
      throw new RpcFailure({code: -32601, message: 'Unhandled method'});
    });
    await reconnect();
    await waitForStatus('disconnected', 'missing-request');
    await waitFor('the session to end', () => liveSessions() === 0);
  });

  it('version gate: an old app latches update-app and does not reconnect', async () => {
    await fresh();
    fake.version = '1.0.0';
    await reconnect();
    await waitForStatus('disconnected', 'update-app');
    await waitFor('no client running', () => liveSessions() === 0);
    const initialized = initializeCount();
    await openFile('after-gate.partiql');
    await sleep(1000);
    assert.equal(initializeCount(), initialized);
  });

  it('refused start: only our sentence is shown, no library toast', async () => {
    await fresh();
    writeFileSync(
      (await api()).portFilePath,
      JSON.stringify({port: fake.port, token: 'wrong', pid: process.pid})
    );
    toasts.length = 0;
    await reconnect();
    await waitForStatus('disconnected', 'auth-failed');
    // The server drops each refused socket 250 ms later; a late close must not toast either.
    await sleep(1000);
    assert.deepEqual(toasts, [{kind: 'error', message: REASONS['auth-failed'].sentence}]);
  });

  it('signed-out at initialize latches the signed-out reason', async () => {
    await fresh();
    fake.onInitialize = () => {
      throw new RpcFailure(fake.fixture('error-signed-out.json') as never);
    };
    await reconnect();
    await waitForStatus('disconnected', 'signed-out');
  });

  it('late close: after a -32898 and a rotated token, one client connects', async () => {
    await fresh();
    writeFileSync(
      (await api()).portFilePath,
      JSON.stringify({port: fake.port, token: 'stale', pid: process.pid})
    );
    const initialized = initializeCount();
    fake.onInitialize = () => {
      if (initializeCount() === initialized + 1) fake.rotateToken();
    };
    await reconnect();
    tokens.add(fake.token);
    await waitForStatus('connected');
    assert.equal(initializeCount(), initialized + 2);
    // Past the server's drop of the refused socket, which reaches the refused client late.
    await sleep(1000);
    assert.equal(liveSessions(), 1);
    assert.equal(initializeCount(), initialized + 2);
    assert.equal((await api()).status().kind, 'connected');
  });

  it('Open DynoTable reaches the spawn seam without --headless', async () => {
    await fresh();
    await installFakeApp();
    const spawns = await recordSpawns();
    toastAnswers.set(REASONS['connection-ended'].sentence, 'Open DynoTable');
    fake.dropSessions();
    try {
      await waitFor('a launch', () => spawns.length === 1);
    } finally {
      toastAnswers.clear();
    }
    assert.ok(!spawns[0]?.args.includes('--headless'), JSON.stringify(spawns));
  });

  it('watcher: a new port file reconnects; a deleted one spawns nothing', async () => {
    await fresh();
    const initialized = initializeCount();
    await fake.rebind();
    tokens.add(fake.token);
    await waitFor(
      'a new connection',
      () => initializeCount() > initialized && liveSessions() === 1
    );
    await waitForStatus('connected');

    const spawns = await recordSpawns();
    await fake.stop();
    await waitForStatus('disconnected', 'connection-ended');
    await sleep(3000);
    assert.equal(spawns.length, 0);
    await fake.start();
    tokens.add(fake.token);
    await waitForStatus('connected');
  });

  it('restart storm: two sqlFiles changes during a start leave one working client', async () => {
    await fresh();
    const query = await vscode.workspace.openTextDocument(
      vscode.Uri.parse('untitled:Query-2.dynotable.sql')
    );
    fake.initializeDelayMs = 2000;
    const initialized = initializeCount();
    void reconnect();
    await waitFor('a start in flight', () => initializeCount() > initialized);
    const settings = vscode.workspace.getConfiguration('dynotable');
    await settings.update('sqlFiles', ['**/*.a.sql'], vscode.ConfigurationTarget.Workspace);
    await settings.update('sqlFiles', ['**/*.b.sql'], vscode.ConfigurationTarget.Workspace);
    // The start in flight, then one start for both changes: the second joins the queued restart.
    await waitFor('two starts', () => initializeCount() === initialized + 2);
    await waitForStatus('connected');
    await sleep(500);
    assert.equal(initializeCount(), initialized + 2);
    assert.equal(liveSessions(), 1);
    const answer = await vscode.commands.executeCommand('dynotable.validateQuery', {
      uri: query.uri.toString()
    });
    assert.equal(answer, fake.fixture('validate-query.json'));
    await settings.update('sqlFiles', undefined, vscode.ConfigurationTarget.Workspace);
  });
});

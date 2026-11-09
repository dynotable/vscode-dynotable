import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PassThrough} from 'node:stream';
import {setTimeout as sleep} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {REQUEST_FAILED, type WireError} from '../../../src/protocol';
import {frame, FrameReader, RpcFailure, type Id} from '../../../src/rpc';
import {sink} from '../io';
import {useHarness} from '../test-session';
import {createBridge, type Bridge, type BridgeOptions} from './lsp-bridge';

const h = useHarness();
const bridges: Bridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.stop()));
});

interface Wire {
  jsonrpc: '2.0';
  id?: Id | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: {code: number; message: string; data?: {code?: string}};
}

/** An editor on the bridge's stdio. */
interface Editor {
  stdin: PassThrough;
  /** Every stdout byte, as written. */
  stdout(): Buffer;
  stderr: string;
  codes: number[];
  /** Settles when the bridge has ended. */
  done: Promise<void>;
  send(message: object): void;
  messages(): Wire[];
}

const framed = (body: object) => frame(Buffer.from(JSON.stringify(body), 'utf8'));

function startBridge(options: Partial<BridgeOptions> = {}): Editor {
  const stdin = new PassThrough();
  const chunks: Buffer[] = [];
  const editor: Editor = {
    stdin,
    stdout: () => Buffer.concat(chunks),
    stderr: '',
    codes: [],
    done: Promise.resolve(),
    send: (body) => stdin.write(framed(body)),
    messages: () =>
      new FrameReader()
        .push(editor.stdout())
        .bodies.map((body) => JSON.parse(body.toString('utf8')) as Wire)
  };
  const io = sink({
    stdin,
    stdout: {write: (chunk) => chunks.push(Buffer.from(chunk))},
    stderr: {write: (chunk) => (editor.stderr += String(chunk))},
    setExitCode: (code) => editor.codes.push(code)
  });
  const bridge = createBridge({
    minAppVersion: h.fake.version,
    env: {},
    home: h.home,
    io,
    // A test must never start an installed app.
    launch: false,
    awaitPortFileMs: 0,
    cwd: h.cwd,
    platform: 'linux',
    agent: true,
    ...options
  });
  bridges.push(bridge);
  editor.done = bridge.run();
  return editor;
}

const initialize = (params: object = {}, id: Id = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'initialize',
  params: {
    processId: null,
    rootUri: null,
    capabilities: {},
    initializationOptions: {token: 'editor-token'},
    ...params
  }
});

const answerTo = (editor: Editor, id: Id) =>
  editor.messages().find((m) => m.method === undefined && m.id === id);

/** Starts a bridge, sends `initialize` and waits for its answer. */
async function connect(
  params: object = {},
  options: Partial<BridgeOptions> = {},
  {id = 1 as Id, timeout = 2000} = {}
): Promise<Editor> {
  const editor = startBridge(options);
  editor.send(initialize(params, id));
  await vi.waitFor(() => expect(answerTo(editor, id)).toBeDefined(), {timeout});
  return editor;
}

async function close(editor: Editor): Promise<void> {
  editor.stdin.end();
  await editor.done;
}

const optionsOf = (index: number) =>
  (h.fake.initializeParams[index] as {initializationOptions: Record<string, unknown>})
    .initializationOptions;

const errorCodeOf = (wire: Wire | undefined) => wire?.error?.data?.code;

/** A new folder `name` in a temp dir, holding a `.dynotable.json` that names `profile`. */
function dotfileDir(name: string, profile: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'cli-root-')), name);
  mkdirSync(path);
  writeFileSync(join(path, '.dynotable.json'), JSON.stringify({profile}));
  return path;
}

describe('rewriting the initialize frame', () => {
  it("replaces the editor's token and purpose with the port file's token and agent", async () => {
    await h.fake.start();
    const editor = await connect({
      initializationOptions: {token: 'editor-token', purpose: 'editor', theme: 'dark'}
    });
    await close(editor);
    expect(optionsOf(0)).toEqual({token: h.fake.token, purpose: 'agent', theme: 'dark'});
    expect(editor.codes).toEqual([0]);
  });

  it('dynotable-lsp sends no purpose', async () => {
    await h.fake.start();
    await close(await connect({}, {agent: false}));
    expect(optionsOf(0)).toEqual({token: h.fake.token});
  });

  it('turns null options into an object', async () => {
    await h.fake.start();
    await close(await connect({initializationOptions: null}));
    expect(optionsOf(0)).toEqual({token: h.fake.token, purpose: 'agent'});
  });

  it("takes --profile, then the editor's profile, then .dynotable.json", async () => {
    await h.fake.start();
    writeFileSync(join(h.cwd, '.dynotable.json'), JSON.stringify({profile: 'from-dotfile'}));
    const editorProfile = {initializationOptions: {token: 'x', profile: 'from-editor'}};
    await close(await connect());
    await close(await connect(editorProfile));
    await close(await connect(editorProfile, {profile: 'from-flag'}));
    expect([0, 1, 2].map((i) => optionsOf(i).profile)).toEqual([
      'from-dotfile',
      'from-editor',
      'from-flag'
    ]);
  });

  // A Content-Length counted in characters would cut the frame, and the app would never answer.
  it('counts Content-Length in bytes for a non-ASCII rootUri', async () => {
    await h.fake.start();
    await close(await connect({rootUri: 'file:///tmp/Zoë-données'}));
    expect((h.fake.initializeParams[0] as {rootUri: string}).rootUri).toBe(
      'file:///tmp/Zoë-données'
    );
  });

  it('reads .dynotable.json from rootUri, then the first workspace folder, then cwd', async () => {
    await h.fake.start();
    const root = dotfileDir('my root', 'from-root');
    const folder = dotfileDir('folder', 'from-folder');
    writeFileSync(join(h.cwd, '.dynotable.json'), JSON.stringify({profile: 'from-cwd'}));
    const rootUri = pathToFileURL(root).href;
    expect(rootUri).toContain('my%20root');
    const workspaceFolders = [{uri: pathToFileURL(folder).href, name: 'folder'}];
    try {
      await close(await connect({rootUri, workspaceFolders}));
      await close(await connect({rootUri: null, workspaceFolders}));
      await close(await connect());
    } finally {
      rmSync(join(root, '..'), {recursive: true, force: true});
      rmSync(join(folder, '..'), {recursive: true, force: true});
    }
    expect([0, 1, 2].map((i) => optionsOf(i).profile)).toEqual([
      'from-root',
      'from-folder',
      'from-cwd'
    ]);
  });

  it.each<Id>([0, 'init-1'])('keeps the initialize id %j in the answer', async (id) => {
    await h.fake.start();
    const editor = await connect({}, {}, {id});
    expect(answerTo(editor, id)?.result).toMatchObject({serverInfo: {version: h.fake.version}});
    await close(editor);
  });
});

describe('handshake and retry', () => {
  it('a message the app sends before its answer reaches the editor after the answer', async () => {
    await h.fake.start();
    h.fake.onInitialize = (session) =>
      session.peer.notify('window/logMessage', {type: 3, message: 'early'});
    const editor = await connect();
    await vi.waitFor(() => expect(editor.messages()).toHaveLength(2));
    const [answer, log] = editor.messages();
    expect(answer?.id).toBe(1);
    expect(log).toMatchObject({method: 'window/logMessage', params: {message: 'early'}});
    await close(editor);
  });

  it('retries once after a token rotated at the first initialize, and nothing of the failed socket leaks', async () => {
    await h.fake.start();
    h.fake.onInitialize = (session) => {
      if (h.fake.initializeParams.length > 1) return;
      session.peer.notify('window/logMessage', {type: 1, message: 'failed socket'});
      h.fake.rotateToken();
    };
    const editor = await connect();
    expect(h.fake.initializeParams).toHaveLength(2);
    expect(optionsOf(1).token).toBe(h.fake.token);
    expect(editor.messages().map((m) => m.id)).toEqual([1]);
    expect(answerTo(editor, 1)?.result).toBeDefined();
    await close(editor);
    expect(editor.codes).toEqual([0]);
  });

  it('two auth failures answer the initialize with auth-failed and exit 1', async () => {
    await h.fake.start();
    h.fake.onInitialize = () => h.fake.rotateToken();
    const editor = await connect();
    await editor.done;
    expect(editor.messages()).toHaveLength(1);
    expect(errorCodeOf(answerTo(editor, 1))).toBe('auth-failed');
    expect(editor.codes).toEqual([1]);
    for (const index of [0, 1])
      expect(editor.stdout().toString()).not.toContain(optionsOf(index).token);
  });

  // An app below the floor ignores `purpose`; its answer must not reach the editor.
  it('an app below the floor: only the update-app error reaches the editor', async () => {
    await h.fake.start();
    h.fake.onInitialize = (session) =>
      session.peer.notify('window/logMessage', {type: 3, message: 'old app'});
    const editor = await connect({}, {minAppVersion: '99.0.0'});
    await editor.done;
    expect(editor.messages()).toEqual([
      expect.objectContaining({id: 1, error: expect.objectContaining({data: {code: 'update-app'}})})
    ]);
    expect(editor.codes).toEqual([1]);
  });

  // The app's sentence says why; the CLI's generic start-failed text cannot.
  it("an app refusal of the editor's initialize reaches the editor as the app sent it", async () => {
    await h.fake.start();
    const refusal: WireError = {
      code: REQUEST_FAILED,
      message: 'This connection is already initialized.',
      data: {code: 'run-failed'}
    };
    h.fake.onInitialize = () => {
      throw new RpcFailure(refusal);
    };
    const editor = await connect();
    await editor.done;
    expect(answerTo(editor, 1)?.error).toEqual(refusal);
    expect(JSON.parse(editor.stderr)).toMatchObject({code: 'run-failed', detail: refusal.message});
    expect(editor.codes).toEqual([1]);
  });

  it('a malformed .dynotable.json answers the initialize with an error and never connects', async () => {
    await h.fake.start();
    writeFileSync(join(h.cwd, '.dynotable.json'), '{not json');
    const editor = await connect();
    await editor.done;
    expect(errorCodeOf(answerTo(editor, 1))).toBe('usage');
    expect(answerTo(editor, 1)?.error?.message).toContain('.dynotable.json');
    expect(h.fake.initializeParams).toEqual([]);
    expect(editor.codes).toEqual([1]);
  });
});

describe('the first frame', () => {
  it.each([
    ['is not an initialize request', framed({jsonrpc: '2.0', method: 'initialized', params: {}})],
    ['has a bad header', Buffer.from('Content-Length: x\r\n\r\n{}', 'utf8')]
  ])('that %s prints a usage line, answers nothing and exits 1', async (_, bytes) => {
    await h.fake.start();
    const editor = startBridge();
    editor.stdin.write(bytes);
    await editor.done;
    expect(JSON.parse(editor.stderr)).toMatchObject({code: 'usage'});
    expect(editor.stdout().length).toBe(0);
    expect(editor.codes).toEqual([1]);
    expect(h.fake.initializeParams).toEqual([]);
  });
});

describe('after the handshake', () => {
  it('passes a server frame through byte for byte', async () => {
    await h.fake.start();
    const editor = await connect();
    const before = editor.stdout().length;
    // A JSON round trip would turn the literal into 12345678901234567000.
    const literal = frame(
      Buffer.from('{"jsonrpc":"2.0","method":"x/big","params":{"n":12345678901234567890}}', 'utf8')
    );
    h.fake.writeRaw(literal);
    await vi.waitFor(() => expect(editor.stdout().length).toBe(before + literal.length));
    expect(editor.stdout().subarray(before)).toEqual(literal);
    await close(editor);
  });

  it('passes window/workDoneProgress/create and its answer through', async () => {
    await h.fake.start();
    const editor = await connect();
    const answers = h.fake.requestAll('window/workDoneProgress/create', {token: 'p-1'});
    await vi.waitFor(() =>
      expect(editor.messages().some((m) => m.method === 'window/workDoneProgress/create')).toBe(
        true
      )
    );
    const request = editor.messages().find((m) => m.method === 'window/workDoneProgress/create');
    expect(request?.params).toEqual({token: 'p-1'});
    editor.send({jsonrpc: '2.0', id: request?.id, result: null});
    expect(await answers).toEqual([null]);
    await close(editor);
  });
});

describe('stdin and launch', () => {
  it('stdin EOF while the app delays its answer exits 0 and leaves no session', async () => {
    await h.fake.start();
    h.fake.initializeDelayMs = 2000;
    const editor = startBridge();
    editor.send(initialize());
    await vi.waitFor(() => expect(h.fake.initializeParams).toHaveLength(1));
    await close(editor);
    expect(editor.codes).toEqual([0]);
    expect(editor.stdout().length).toBe(0);
    await vi.waitFor(() => expect(h.fake.sessions.size).toBe(0));
  });

  // A bridge that ignored --no-launch would start the stub, which exits 3: integration-off.
  it('--no-launch with no port file answers launcher-off after the wait, and starts nothing', async () => {
    const stub = join(h.cwd, 'dynotable');
    writeFileSync(stub, '#!/bin/sh\nexit 3\n');
    chmodSync(stub, 0o755);
    const editor = await connect(
      {},
      {env: {DYNOTABLE_APP_PATH: stub}, launch: false, awaitPortFileMs: 300}
    );
    await editor.done;
    expect(errorCodeOf(answerTo(editor, 1))).toBe('launcher-off');
    expect(editor.codes).toEqual([1]);
  });

  it('--no-launch connects to an app that starts serving inside the wait', async () => {
    const editor = startBridge({launch: false, awaitPortFileMs: 5000});
    // What the editor sends after initialize waits for the connection.
    editor.stdin.write(
      Buffer.concat([
        framed(initialize()),
        framed({jsonrpc: '2.0', method: 'initialized', params: {}})
      ])
    );
    await sleep(300);
    expect(editor.stdout().length).toBe(0);
    await h.fake.start();
    await vi.waitFor(() => expect(answerTo(editor, 1)?.result).toBeDefined(), {timeout: 3000});
    await vi.waitFor(() => expect(h.fake.received.map((m) => m.method)).toEqual(['initialized']));
    await close(editor);
    expect(editor.codes).toEqual([0]);
  });
});

describe('close and exit', () => {
  // ConnectCore would reconnect to the new token; the editor's session cannot move.
  it('an app-side close exits 1 and never reconnects', async () => {
    await h.fake.start();
    const editor = await connect();
    h.fake.rotateToken();
    h.fake.dropSessions();
    await editor.done;
    expect(editor.codes).toEqual([1]);
    // Two port-file polls.
    await sleep(600);
    expect(h.fake.initializeParams).toHaveLength(1);
  });

  it('a close after the editor sent shutdown exits 0', async () => {
    await h.fake.start();
    const editor = await connect();
    editor.send({jsonrpc: '2.0', method: 'initialized', params: {}});
    editor.send({jsonrpc: '2.0', id: 2, method: 'shutdown'});
    await vi.waitFor(() => expect(answerTo(editor, 2)).toBeDefined());
    // The app closes the socket on exit.
    editor.send({jsonrpc: '2.0', method: 'exit'});
    await editor.done;
    expect(editor.codes).toEqual([0]);
    expect(h.fake.received.map((m) => m.method)).toEqual(['initialized', 'shutdown', 'exit']);
  });

  it('stdin close after connect closes the socket and exits 0', async () => {
    await h.fake.start();
    const editor = await connect();
    expect(h.fake.sessions.size).toBe(1);
    await close(editor);
    expect(editor.codes).toEqual([0]);
    await vi.waitFor(() => expect(h.fake.sessions.size).toBe(0));
  });

  it('a reset right after accept answers the initialize with an error and exits 1', async () => {
    await h.fake.start();
    h.fake.resetOnAccept = true;
    const editor = await connect();
    await editor.done;
    expect(errorCodeOf(answerTo(editor, 1))).toBe('connection-ended');
    expect(editor.codes).toEqual([1]);
  });
});

import type {Socket} from 'node:net';
import {fileURLToPath} from 'node:url';
import type {StartHandle, StartOutcome, StartParams} from '../../../src/connect-core';
import {REQUEST_FAILED, type WireError} from '../../../src/protocol';
import {frame, FrameReader, parseMessage, type Id, type Message} from '../../../src/rpc';
import {readDotfile} from '../dotfile';
import {EXIT, type Sink} from '../io';
import {codeOfError, messageOf, type ErrorCode} from '../messages';
import {failureLine} from '../output';
import {createCore, okOutcome, refusedOutcome, type CoreOptions} from '../session';

/** How long `--no-launch` waits for the app to serve before it gives up. */
export const AWAIT_PORT_FILE_MS = 20_000;

export interface BridgeOptions extends CoreOptions {
  io: Sink;
  /** False for `dynotable-lsp`: the session is an editor session and gets no `purpose`. */
  agent: boolean;
  /** The `.dynotable.json` root when the editor names no folder. */
  cwd: string;
  /** `--profile`. */
  profile?: string;
}

export interface Bridge {
  /** Bridges stdin and stdout to the app. Settles when the bridge has ended. */
  run(): Promise<void>;
  stop(): Promise<void>;
}

/** One attempt's socket until the app answers the editor's `initialize`. */
interface Handshake {
  socket: Socket;
  /** The answer, what the app sent before it, then the bytes after it. */
  toEditor: Buffer[];
  closed: boolean;
  /** Set once the bridge pipes this socket. */
  onClose?: () => void;
}

type Initialize = Message & {id: Id};

const EMPTY = Buffer.alloc(0);

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** The folder of `.dynotable.json`: the editor's root, else its first workspace folder, else `cwd`. */
function rootOf(params: Record<string, unknown>, cwd: string): string {
  const folders = params.workspaceFolders;
  const first = Array.isArray(folders) ? record(folders[0]).uri : undefined;
  for (const uri of [params.rootUri, first]) {
    if (typeof uri !== 'string') continue;
    try {
      return fileURLToPath(uri);
    } catch {
      // Not a file URI.
    }
  }
  return cwd;
}

/**
 * The stdio bridge. It holds the editor's `initialize` until `ConnectCore` has a session, sends
 * it with the port file's token on each attempt, and then pipes bytes both ways.
 */
export function createBridge(options: BridgeOptions): Bridge {
  const {io} = options;
  const stdin = new FrameReader();
  const handshakes = new Map<number, Handshake>();
  let initialize: Initialize | undefined;
  /** Set before `ConnectCore` starts its first attempt. */
  let initializeFrame: (token: string) => Buffer;
  /** The editor's bytes after `initialize`, until a session is connected. */
  let held: Buffer[] = [];
  let live: Socket | undefined;
  /** The app's error answer to the latest attempt's `initialize`, as it sent it. */
  let refusal: {answer: Buffer; error: WireError} | undefined;
  let shutdown = false;
  let ended = false;
  let settle!: () => void;
  const done = new Promise<void>((resolve) => (settle = resolve));

  const start = (params: StartParams): StartHandle => {
    const socket = params.socket as Socket;
    const reader = new FrameReader();
    const handshake: Handshake = {socket, toEditor: [], closed: false};
    handshakes.set(params.attempt, handshake);
    refusal = undefined;
    // ConnectCore is not told of a close: the bridge ends instead of reconnecting, because the
    // editor's session cannot move to a new connection.
    const outcome = new Promise<StartOutcome>((resolve) => {
      socket.once('close', () => {
        handshake.closed = true;
        resolve({kind: 'closed'});
        handshake.onClose?.();
      });
      const read = (chunk: Buffer) => {
        for (let next = chunk; ; next = EMPTY) {
          const {
            bodies: [body],
            error
          } = reader.push(next, 1);
          if (!body) {
            if (error) socket.destroy();
            return;
          }
          const message = parseMessage(body);
          if (!message || message.method !== undefined || message.id !== initialize?.id) {
            handshake.toEditor.push(frame(body));
            continue;
          }
          socket.off('data', read);
          socket.pause();
          handshake.toEditor.unshift(frame(body));
          handshake.toEditor.push(reader.remainder);
          if (message.error) refusal = {answer: frame(body), error: message.error};
          resolve(message.error ? refusedOutcome(message.error) : okOutcome(message.result));
          return;
        }
      };
      socket.on('data', read);
    });
    socket.write(initializeFrame(params.token));
    return {
      outcome,
      dispose: async () => {
        handshakes.delete(params.attempt);
        socket.destroy();
      }
    };
  };

  // Only `--no-launch` waits: a launching bridge has started the app itself.
  const core = createCore(
    {
      ...options,
      awaitPortFileMs: options.launch ? undefined : (options.awaitPortFileMs ?? AWAIT_PORT_FILE_MS)
    },
    start
  );

  async function end(code: number): Promise<void> {
    if (ended) return;
    ended = true;
    io.exit(code);
    io.stdin.destroy();
    // Destroys the live socket too.
    await core.stop();
    settle();
  }

  /** Answers the editor's `initialize` with the CLI's text, then ends. */
  function refuse(code: ErrorCode, detail?: string): void {
    const error = {code: REQUEST_FAILED, message: detail ?? messageOf(code), data: {code}};
    const answer = {jsonrpc: '2.0', id: initialize?.id ?? null, error};
    io.out(frame(Buffer.from(JSON.stringify(answer), 'utf8')));
    io.err(failureLine({code, ...(detail ? {detail} : {})}));
    void end(EXIT.failure);
  }

  /** Passes the app's refusal of `initialize` to the editor, then ends. */
  function forward({answer, error}: {answer: Buffer; error: WireError}): void {
    io.out(answer);
    io.err(failureLine({code: codeOfError(error), detail: error.message}));
    void end(EXIT.failure);
  }

  /** Notes the editor's `shutdown`: a close after it is a clean end. */
  function watch(chunk: Buffer): void {
    for (const body of stdin.push(chunk).bodies) {
      if (parseMessage(body)?.method === 'shutdown') shutdown = true;
    }
  }

  function onStdin(data: Buffer | string): void {
    const chunk = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    if (live) live.write(chunk);
    else if (initialize) held.push(chunk);
    else {
      readInitialize(chunk);
      return;
    }
    watch(chunk);
  }

  function readInitialize(chunk: Buffer): void {
    const {bodies, error} = stdin.push(chunk, 1);
    const [body] = bodies;
    if (!body) {
      if (error) notInitialize();
      return;
    }
    const message = parseMessage(body);
    if (message?.method !== 'initialize' || message.id === undefined) {
      notInitialize();
      return;
    }
    initialize = message as Initialize;
    held.push(stdin.remainder);
    watch(EMPTY);
    void connect(initialize);
  }

  function notInitialize(): void {
    const detail = 'The first message from the editor must be an initialize request.';
    io.err(failureLine({code: 'usage', detail}));
    void end(EXIT.failure);
  }

  async function connect(init: Initialize): Promise<void> {
    const params = record(init.params);
    const editorOptions = record(params.initializationOptions);
    let profile = options.profile;
    if (profile === undefined && editorOptions.profile === undefined) {
      const dotfile = readDotfile(rootOf(params, options.cwd));
      if (dotfile.kind === 'error') {
        refuse('usage', dotfile.message);
        return;
      }
      if (dotfile.kind === 'profile') profile = dotfile.profile;
    }
    initializeFrame = (token) => {
      const initializationOptions = {
        ...editorOptions,
        token,
        ...(profile === undefined ? {} : {profile}),
        ...(options.agent ? {purpose: 'agent'} : {})
      };
      const message = {...init, params: {...params, initializationOptions}};
      return frame(Buffer.from(JSON.stringify(message), 'utf8'));
    };
    await core.ensureConnected();
    if (ended) return;
    const state = core.current;
    if (state.kind === 'latched') {
      // The app refused the editor's own `initialize`: its answer says why, the CLI's text cannot.
      if (state.reason === 'start-failed' && refusal) forward(refusal);
      else refuse(state.reason);
      return;
    }
    const handshake = state.kind === 'connected' ? handshakes.get(state.attempt) : undefined;
    if (!handshake) {
      refuse('connection-ended');
      return;
    }
    pipe(handshake);
  }

  function pipe(handshake: Handshake): void {
    const {socket} = handshake;
    live = socket;
    io.out(Buffer.concat(handshake.toEditor));
    socket.write(Buffer.concat(held));
    held = [];
    socket.on('data', (chunk: Buffer) => io.out(chunk));
    handshake.onClose = () => void end(shutdown ? EXIT.ok : EXIT.failure);
    if (handshake.closed) handshake.onClose();
    else socket.resume();
  }

  return {
    run() {
      io.stdin.on('data', onStdin);
      // A paused stdin would not report its end, so it is read from the start.
      io.stdin.once('end', () => void end(EXIT.ok));
      io.stdin.once('close', () => void end(EXIT.ok));
      return done;
    },
    stop: () => end(EXIT.interrupted)
  };
}

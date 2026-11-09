import {spawn} from 'node:child_process';
import type {Socket} from 'node:net';
import {
  ConnectCore,
  type StartHandle,
  type StartOutcome,
  type StartParams
} from '../../src/connect-core';
import {
  currentPlatform,
  locateApp,
  portFilePath,
  readPortFile,
  userDataDir,
  type Env,
  type Platform
} from '../../src/discovery';
import {connectTcp, fs} from '../../src/node-seams';
import {
  AUTH_FAILED,
  failureCodeOf,
  initializeResultSchema,
  is,
  type Schema,
  type WireError
} from '../../src/protocol';
import {Peer, RpcFailure} from '../../src/rpc';
import {readDotfile} from './dotfile';
import type {Sink} from './io';
import {codeOfError} from './messages';
import {emit, type Failure, type Result} from './output';
import {CLI_VERSION} from './version';

/** What every command's `ConnectCore` is built from. */
export interface CoreOptions {
  minAppVersion: string;
  env: Env;
  /** Feeds the default user data directory. */
  home: string;
  /** False under `--no-launch`. */
  launch: boolean;
  platform?: Platform;
  /** See `CoreSeams.awaitPortFileMs`. */
  awaitPortFileMs?: number;
}

export interface SessionOptions extends CoreOptions {
  io: Sink;
  /** Where `.dynotable.json` is read when no `profile` is given. */
  cwd: string;
  /** `--profile`. */
  profile?: string;
}

export type Answer<T> = {ok: true; value: T} | {ok: false; failure: Failure};

/** A connected session's requests. */
export interface Connection {
  request<T>(method: string, params: unknown, guard: Schema<T>): Promise<Answer<T>>;
  notify(method: string, params: unknown): void;
}

export interface CliSession {
  /**
   * Connects, runs `work`, prints its result and closes. A failure to connect is printed in its
   * place.
   */
  run(work: (connection: Connection) => Promise<Result>): Promise<void>;
  /** Ends every wait and the connection. Nothing is printed. */
  stop(): Promise<void>;
}

const connection = (peer: Peer): Connection => ({
  async request(method, params, guard) {
    let value: unknown;
    try {
      value = await peer.request(method, params).response;
    } catch (error) {
      if (!(error instanceof RpcFailure)) return {ok: false, failure: {code: 'connection-ended'}};
      return {ok: false, failure: {code: codeOfError(error.error), detail: error.error.message}};
    }
    return is(guard, value) ? {ok: true, value} : {ok: false, failure: {code: 'bad-answer'}};
  },
  notify: (method, params) => peer.notify(method, params)
});

/**
 * A `ConnectCore` on the real process. It reads `DYNOTABLE_APP_PATH` and `DYNOTABLE_USER_DATA_DIR`;
 * the second one turns launching off.
 */
export function createCore(
  options: CoreOptions,
  startSession: (params: StartParams) => StartHandle
): ConnectCore {
  const {env, home} = options;
  const platform = options.platform ?? currentPlatform();
  const customUserData = env.DYNOTABLE_USER_DATA_DIR || undefined;
  const portFile = portFilePath(platform, customUserData ?? userDataDir(platform, env, home));
  return new ConnectCore({
    platform,
    home,
    env,
    minAppVersion: options.minAppVersion,
    launcherOff: () => customUserData !== undefined || !options.launch,
    ...(options.awaitPortFileMs === undefined ? {} : {awaitPortFileMs: options.awaitPortFileMs}),
    readPortFile: () => readPortFile(fs, portFile),
    kill: (pid, signal) => process.kill(pid, signal),
    connect: connectTcp,
    locateApp: () => locateApp(fs, {platform, env, home, appPath: env.DYNOTABLE_APP_PATH ?? ''}),
    spawn: (command, args, spawnOptions) => spawn(command, args, spawnOptions),
    startSession,
    onState: () => {}
  });
}

/** The outcome of an `initialize` answered with a result. */
export const okOutcome = (result: unknown): StartOutcome => ({
  kind: 'ok',
  version: is(initializeResultSchema, result) ? result.serverInfo.version : undefined
});

/** The outcome of an `initialize` answered with an error. */
export function refusedOutcome(error: WireError): StartOutcome {
  if (error.code === AUTH_FAILED) return {kind: 'auth-failed'};
  if (failureCodeOf(error) === 'signed-out') return {kind: 'signed-out'};
  return {kind: 'refused'};
}

/** An agent session over `ConnectCore`. `ConnectCore` owns the retry, the launch and the floor. */
export function createSession(options: SessionOptions): CliSession {
  const {io} = options;
  const peers = new Map<number, Peer>();
  let profile = options.profile;

  const start = (params: StartParams): StartHandle => {
    const peer = new Peer(params.socket as Socket);
    peers.set(params.attempt, peer);
    void peer.closed.then(() => params.onClosed());
    const outcome = peer
      .request('initialize', {
        processId: process.pid,
        rootUri: null,
        clientInfo: {name: 'dynotable-cli', version: CLI_VERSION},
        capabilities: {},
        initializationOptions: {
          token: params.token,
          ...(profile === undefined ? {} : {profile}),
          purpose: 'agent'
        }
      })
      .response.then(
        (result): StartOutcome => {
          peer.notify('initialized', {});
          return okOutcome(result);
        },
        (error: unknown): StartOutcome =>
          error instanceof RpcFailure ? refusedOutcome(error.error) : {kind: 'closed'}
      );
    return {
      outcome,
      dispose: async () => {
        peers.delete(params.attempt);
        params.socket.destroy();
      }
    };
  };

  const core = createCore(options, start);

  async function close(peer: Peer): Promise<void> {
    // A closed peer rejects at once.
    await peer.request('shutdown').response.catch(() => {});
    peer.notify('exit');
    await core.stop();
  }

  return {
    async run(work) {
      if (profile === undefined) {
        const dotfile = readDotfile(options.cwd);
        if (dotfile.kind === 'error') {
          emit(io, {failure: {code: 'usage', detail: dotfile.message}});
          return;
        }
        if (dotfile.kind === 'profile') profile = dotfile.profile;
      }
      await core.ensureConnected();
      const state = core.current;
      const peer = state.kind === 'connected' ? peers.get(state.attempt) : undefined;
      if (!peer) {
        await core.stop();
        // After `stop()` the state is whatever it was; the interrupt has printed already.
        if (state.kind === 'latched') emit(io, {failure: {code: state.reason}});
        return;
      }
      const result = await work(connection(peer));
      emit(io, result);
      await close(peer);
    },
    stop: () => core.stop()
  };
}

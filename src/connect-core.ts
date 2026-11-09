import {meetsMinimum, type AppLocation, type Env, type Platform} from './discovery';
import type {PortFile} from './protocol';
import type {LatchedReason} from './reasons';

/** Longer than the server's own 30 s handshake deadline, so the server's answer arrives first. */
export const INIT_TIMEOUT_MS = 40_000;
/** How long a cold `--headless` start may run with no port file. */
const COLD_START_MS = 30_000;
/** How long to wait for the port file after a running app was nudged (exit 0). */
const NUDGE_WAIT_MS = 20_000;
const POLL_MS = 250;

/** What a `--headless` child's exit code means. Any other code, or a signal, is a crash. */
const EXIT_RESULTS: Record<number, LatchedReason | 'nudged'> = {
  0: 'nudged',
  1: 'start-failed',
  3: 'integration-off'
};

export interface Socket {
  destroy(): void;
}

type ExitListener = (code: number | null, signal: string | null) => void;
type ErrorListener = (error: Error) => void;

export interface Child {
  once(event: 'spawn', listener: () => void): unknown;
  once(event: 'exit', listener: ExitListener): unknown;
  once(event: 'error', listener: ErrorListener): unknown;
  off(event: 'exit', listener: ExitListener): unknown;
  off(event: 'error', listener: ErrorListener): unknown;
  unref(): void;
}

export interface SpawnOptions {
  detached: true;
  stdio: 'ignore';
  cwd: string;
  env: Env;
}

export type StartOutcome =
  | {kind: 'ok'; version: string | undefined}
  | {kind: 'auth-failed'}
  | {kind: 'signed-out'}
  | {kind: 'refused'}
  | {kind: 'closed'};

/** One attempt's client. It is the session once its outcome is `ok`. */
export interface StartHandle {
  /** Never rejects. */
  outcome: Promise<StartOutcome>;
  dispose(): Promise<void>;
}

export interface StartParams {
  attempt: number;
  socket: Socket;
  token: string;
  /** Called when the connection closes. Fenced here by attempt id. */
  onClosed(): void;
}

export interface CoreSeams {
  platform: Platform;
  home: string;
  env: Env;
  minAppVersion: string;
  /** True while `dynotable.userDataDir` is set: the user starts the app. */
  launcherOff(): boolean;
  /**
   * While the launcher is off and no usable port file exists, wait this long for one before
   * latching `launcher-off`. Unset: latch at once.
   */
  awaitPortFileMs?: number;
  readPortFile(): PortFile | undefined;
  /** `process.kill`: signal 0 throws when the pid is dead or owned by another user. */
  kill(pid: number, signal: 0): void;
  /** Rejects with a Node error whose `code` is, for example, `ECONNREFUSED`. */
  connect(port: number): Promise<Socket>;
  locateApp(): AppLocation | undefined;
  spawn(command: string, args: string[], options: SpawnOptions): Child;
  startSession(params: StartParams): StartHandle;
  onState(state: State): void;
}

export type State =
  | {kind: 'idle'}
  | {kind: 'starting'}
  | {kind: 'waiting-for-run'}
  | {kind: 'connected'; version: string; attempt: number}
  | {kind: 'latched'; reason: LatchedReason};

const ALLOWED = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'TMPDIR',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'DESKTOP_SESSION',
  'XMODIFIERS'
]);
// The desktop-session prefixes choose Chromium's secret-store backend and the input method.
const ALLOWED_PREFIXES = ['LC_', 'XDG_', 'KDE_', 'GNOME_', 'GTK_', 'QT_', 'GDK_'];
// `AWS_ENDPOINT_URL*` would send every profile's calls to a local emulator for the app's lifetime.
const DENIED_PREFIXES = ['ELECTRON_', 'NODE_', 'NPM_', 'VSCODE_', 'AWS_'];
const SNAP_SUFFIX = '_VSCODE_SNAP_ORIG';

/**
 * Approximates a desktop launch. The long-lived app must not inherit a terminal's AWS credentials,
 * Node or Electron switches, or development variables.
 */
export function launchEnv(platform: Platform, inherited: Env): Env {
  if (platform === 'win32') {
    // Windows names are case-insensitive: `Path` is PATH, `electron_run_as_node` is denied too.
    return Object.fromEntries(
      Object.entries(inherited).filter(
        ([name]) => !DENIED_PREFIXES.some((prefix) => name.toUpperCase().startsWith(prefix))
      )
    );
  }
  const env = {...inherited};
  if (platform === 'linux') {
    // A snap VS Code points GTK_*, GDK_* and XDG_* into its own runtime and keeps the host values.
    for (const [name, value] of Object.entries(inherited)) {
      if (!name.endsWith(SNAP_SUFFIX)) continue;
      const original = name.slice(0, -SNAP_SUFFIX.length);
      delete env[name];
      if (value) env[original] = value;
      else delete env[original];
    }
  }
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => ALLOWED.has(name) || ALLOWED_PREFIXES.some((prefix) => name.startsWith(prefix))
    )
  );
}

function spawnOptions(home: string, env: Env): SpawnOptions {
  return {
    // The app outlives VS Code; the caller also calls `unref` so VS Code can exit without it.
    detached: true,
    // Piped stdio fails with EPIPE in the app once VS Code exits.
    stdio: 'ignore',
    // An inherited cwd is VS Code's folder, which Windows then locks against update or delete.
    cwd: home,
    env
  };
}

const keyOf = (file: PortFile) => `${file.port}\n${file.token}`;

/** How a wait settles after `stop()`. It is not a reason: nothing latches. */
type Stopped = 'stopped';

type LaunchResult = PortFile | LatchedReason | Stopped;

interface Live {
  id: number;
  handle: StartHandle;
  socket: Socket;
}

/**
 * The connection lifecycle: one attempt at a time, the launcher, the latch and the restart queue.
 * Every failure latches. Only a new `(port, token)` in the port file or a restart clears a latch.
 */
export class ConnectCore {
  private state: State = {kind: 'idle'};
  private attempts = 0;
  private inFlight: Promise<void> | undefined;
  private restarting = false;
  private recheck = false;
  /** The `(port, token)` the latest attempt used. The watcher ignores it. */
  private lastKey: string | undefined;
  private live: Live | undefined;
  private queue: Promise<void> = Promise.resolve();
  /** A restart that waits in the queue. Later requests join it. */
  private queued: Promise<void> | undefined;
  private runs = 0;
  private runWaiters: Array<() => void> = [];
  /** Aborted by `stop()`. Every wait settles on it. */
  private readonly stopping = new AbortController();

  constructor(private readonly seams: CoreSeams) {}

  private get stopped(): boolean {
    return this.stopping.signal.aborted;
  }

  get current(): State {
    return this.state;
  }

  /** A lazy-connect trigger. It never clears a latch. */
  ensureConnected(): Promise<void> {
    if (this.state.kind === 'idle' && !this.inFlight) {
      this.inFlight = this.attempt().finally(() => {
        this.inFlight = undefined;
        if (this.recheck) {
          this.recheck = false;
          this.check();
        }
      });
    }
    return this.inFlight ?? Promise.resolve();
  }

  /**
   * Serialized. Waits for a start in flight and for runs, then connects anew. Clears a latch.
   * Requests that arrive while a restart waits in the queue share it.
   */
  restart(): Promise<void> {
    if (this.queued) return this.queued;
    const next = this.queue.then(async () => {
      this.queued = undefined;
      this.restarting = true;
      try {
        await this.inFlight;
        if (this.stopped) return;
        if (this.runs > 0) {
          this.setState({kind: 'waiting-for-run'});
          await new Promise<void>((resolve) => this.runWaiters.push(resolve));
        }
        // A request on the stopping client fails; the status must say why.
        this.setState({kind: 'starting'});
        await this.dispose();
        if (this.stopped) return;
        this.state = {kind: 'idle'};
        await this.ensureConnected();
      } finally {
        this.restarting = false;
      }
    });
    this.queued = next;
    // A failed restart must not block every later one.
    this.queue = next.catch(() => {});
    return next;
  }

  async trackRun<T>(run: () => Promise<T>): Promise<T> {
    this.runs++;
    try {
      return await run();
    } finally {
      if (--this.runs === 0) for (const resolve of this.runWaiters.splice(0)) resolve();
    }
  }

  /** The port-file watcher's event. A delete never launches anything. */
  portFileChanged(): void {
    if (this.inFlight || this.restarting) {
      this.recheck = true;
      return;
    }
    this.check();
  }

  /** Launches the app with a window, the route back to the GUI. */
  async openApp(): Promise<LatchedReason | undefined> {
    // A plain launch uses the default user data, not the folder the user pointed the extension at.
    if (this.seams.launcherOff()) return 'launcher-off';
    const app = this.seams.locateApp();
    if (!app) return 'not-installed';
    const [command, args] =
      this.seams.platform === 'darwin' && app.bundle
        ? ['open', ['-a', app.bundle]]
        : [app.binary, []];
    try {
      const child = this.seams.spawn(command, args, this.options());
      child.unref();
      return await new Promise((resolve) => {
        child.once('spawn', () => resolve(undefined));
        child.once('error', () => resolve('spawn-failed'));
      });
    } catch {
      return 'spawn-failed';
    }
  }

  /** Ends `attempt`'s session and latches `reason`. A late call from an older attempt is ignored. */
  async latch(attempt: number, reason: LatchedReason): Promise<void> {
    if (this.live?.id !== attempt) return;
    const live = this.live;
    this.live = undefined;
    this.setState({kind: 'latched', reason});
    await close(live.handle, live.socket);
  }

  async dispose(): Promise<void> {
    const live = this.live;
    this.live = undefined;
    if (live) await close(live.handle, live.socket);
  }

  /**
   * Ends the core for good: every wait settles, an attempt in flight disposes its handle and
   * destroys its socket, and the live session closes. After it, nothing spawns, starts a session or
   * reports a state.
   */
  async stop(): Promise<void> {
    this.stopping.abort();
    for (const resolve of this.runWaiters.splice(0)) resolve();
    await this.dispose();
  }

  private check(): void {
    if (this.state.kind === 'idle') return;
    const file = this.seams.readPortFile();
    if (!file || keyOf(file) === this.lastKey) return;
    void this.restart();
  }

  private setState(state: State): void {
    if (this.stopped) return;
    this.state = state;
    this.seams.onState(state);
  }

  private async attempt(): Promise<void> {
    const id = ++this.attempts;
    this.setState({kind: 'starting'});
    // A seam that throws must still latch, or the state stays `starting` with nothing running.
    const result = await this.connect(id).catch((): LatchedReason => 'start-failed');
    if (result === 'stopped') return;
    if (typeof result === 'string') this.setState({kind: 'latched', reason: result});
    else this.setState({kind: 'connected', version: result.version, attempt: id});
  }

  private async connect(id: number): Promise<LatchedReason | Stopped | {version: string}> {
    let file = this.seams.readPortFile();
    let launched = false;
    let authRetried = false;
    for (;;) {
      if (this.stopped) return 'stopped';
      const socket = file && this.isLive(file) ? await this.open(file) : 'stale';
      if (socket === 'failed') return 'start-failed';
      if (socket === 'stopped') return socket;
      if (!file || socket === 'stale') {
        // A dead pid's file never reaches `open()`; its key still must not relaunch on a watcher echo.
        if (file) this.lastKey = keyOf(file);
        if (launched) return 'start-failed';
        launched = true;
        const result = await this.launch(file);
        if (typeof result === 'string') return result;
        file = result;
        continue;
      }
      const handle = this.seams.startSession({
        attempt: id,
        socket,
        token: file.token,
        onClosed: () => this.closed(id)
      });
      const outcome = await this.withTimeout(handle.outcome);
      if (outcome.kind === 'stopped' || this.stopped) {
        await close(handle, socket);
        return 'stopped';
      }
      if (outcome.kind === 'ok') {
        if (
          outcome.version === undefined ||
          !meetsMinimum(outcome.version, this.seams.minAppVersion)
        ) {
          await close(handle, socket);
          return 'update-app';
        }
        this.live = {id, handle, socket};
        return {version: outcome.version};
      }
      await close(handle, socket);
      switch (outcome.kind) {
        case 'auth-failed':
          // The app may have restarted and minted a new token.
          if (authRetried) return 'auth-failed';
          authRetried = true;
          file = this.seams.readPortFile();
          continue;
        case 'signed-out':
          return 'signed-out';
        case 'refused':
          return 'start-failed';
        case 'closed':
          return 'connection-ended';
        case 'timeout':
          return 'timed-out';
      }
    }
  }

  private async withTimeout(outcome: Promise<StartOutcome>) {
    const {signal} = this.stopping;
    let timer: NodeJS.Timeout | undefined;
    let onStop: (() => void) | undefined;
    const timeout = new Promise<{kind: 'timeout'} | {kind: Stopped}>((resolve) => {
      timer = setTimeout(() => resolve({kind: 'timeout'}), INIT_TIMEOUT_MS);
      onStop = () => resolve({kind: 'stopped'});
      signal.addEventListener('abort', onStop, {once: true});
    });
    try {
      return await Promise.race([outcome, timeout]);
    } finally {
      clearTimeout(timer);
      if (onStop) signal.removeEventListener('abort', onStop);
    }
  }

  /** `stale` when the port is closed: a killed app leaves its file behind. */
  private async open(file: PortFile): Promise<Socket | 'stale' | 'failed' | Stopped> {
    this.lastKey = keyOf(file);
    let socket: Socket;
    try {
      socket = await this.seams.connect(file.port);
    } catch (error) {
      if (this.stopped) return 'stopped';
      return (error as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'stale' : 'failed';
    }
    // A connect cannot be cancelled, so a socket that arrives after `stop()` is dropped here.
    if (!this.stopped) return socket;
    socket.destroy();
    return 'stopped';
  }

  /**
   * The app writes its pid. A dead one, or another user's, means a crash left the file. A live pid
   * does not prove that the process holds the port: see PROTOCOL.md, "A stale file".
   */
  private isLive(file: PortFile): boolean {
    if (file.pid === undefined) return true;
    try {
      this.seams.kill(file.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private closed(id: number): void {
    if (this.live?.id !== id) return;
    const dropped = this.live;
    this.live = undefined;
    void close(dropped.handle, dropped.socket);
    this.setState({kind: 'latched', reason: 'connection-ended'});
    this.check();
  }

  private options(): SpawnOptions {
    return spawnOptions(this.seams.home, launchEnv(this.seams.platform, this.seams.env));
  }

  private async launch(stale: PortFile | undefined): Promise<LaunchResult> {
    if (this.seams.launcherOff()) {
      const ms = this.seams.awaitPortFileMs;
      if (ms === undefined) return 'launcher-off';
      return (await this.waitForFile(stale, ms)) ?? 'launcher-off';
    }
    const app = this.seams.locateApp();
    if (!app) return 'not-installed';
    // An old app would open its full window, so it is never spawned.
    if (app.version !== undefined && !meetsMinimum(app.version, this.seams.minAppVersion)) {
      return 'update-app';
    }
    for (let spawns = 1; ; spawns++) {
      const result = await this.spawnHeadless(app.binary, stale);
      if (result !== 'nudged') return result;
      const file = await this.waitForFile(stale, NUDGE_WAIT_MS);
      // A `stopped` wait is truthy and ends the loop too.
      if (file) return file;
      // The holder may have been quitting, so one more spawn can become the primary.
      if (spawns === 2) return 'not-serving';
    }
  }

  /** A serving primary never exits. Its readiness is a new `(port, token)` in the port file. */
  private spawnHeadless(binary: string, stale: PortFile | undefined) {
    return new Promise<LaunchResult | 'nudged'>((resolve) => {
      let child: Child;
      try {
        child = this.seams.spawn(binary, ['--headless'], this.options());
      } catch {
        resolve('spawn-failed');
        return;
      }
      child.unref();
      const file = this.waitForFile(stale, COLD_START_MS);
      let settled = false;
      const settle = (result: LaunchResult | 'nudged') => {
        if (settled) return;
        settled = true;
        file.cancel();
        child.off('error', onError);
        child.off('exit', onExit);
        resolve(result);
      };
      const onError = () => settle('spawn-failed');
      const onExit: ExitListener = (code) => settle(EXIT_RESULTS[code ?? -1] ?? 'crashed');
      child.once('error', onError);
      child.once('exit', onExit);
      // `waitForFile` settles `stopped` on `stop()` as well.
      void file.then((found) => settle(found ?? 'timed-out'));
    });
  }

  /**
   * Polls for a port file whose `(port, token)` differs from `stale`. Settles `undefined` at the
   * end of `ms` or on `cancel()`, and `stopped` on `stop()`.
   */
  private waitForFile(stale: PortFile | undefined, ms: number) {
    const handle = {cancel: () => {}};
    const {signal} = this.stopping;
    const promise = new Promise<PortFile | Stopped | undefined>((resolve) => {
      if (signal.aborted) {
        resolve('stopped');
        return;
      }
      const finish = (file: PortFile | Stopped | undefined) => {
        clearInterval(poll);
        clearTimeout(timer);
        signal.removeEventListener('abort', onStop);
        resolve(file);
      };
      const onStop = () => finish('stopped');
      const poll = setInterval(() => {
        const file = this.seams.readPortFile();
        if (file && (!stale || keyOf(file) !== keyOf(stale))) finish(file);
      }, POLL_MS);
      const timer = setTimeout(() => finish(undefined), ms);
      signal.addEventListener('abort', onStop, {once: true});
      handle.cancel = () => finish(undefined);
    });
    return Object.assign(promise, handle);
  }
}

/** A rejected dispose counts as finished. The socket is destroyed either way. */
async function close(handle: StartHandle, socket: Socket): Promise<void> {
  try {
    await handle.dispose();
  } catch {
    // The library rejects a stop on a client that never ran, or one that lost its shutdown race.
  } finally {
    socket.destroy();
  }
}

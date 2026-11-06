import {EventEmitter} from 'node:events';
import {afterEach, beforeEach, describe, expect, it, vi, type Mock} from 'vitest';
import {
  ConnectCore,
  launchEnv,
  type CoreSeams,
  type SpawnOptions,
  type StartOutcome,
  type StartParams,
  type State
} from './connect-core';
import type {AppLocation, Platform} from './discovery';
import type {PortFile} from './protocol';

class FakeChild extends EventEmitter {
  unref = vi.fn<() => void>();
}

interface Spawned {
  command: string;
  args: string[];
  options: SpawnOptions;
  child: FakeChild;
}

interface Started {
  params: StartParams;
  answer(outcome: StartOutcome): void;
  dispose: Mock<() => Promise<void>>;
}

const OK: StartOutcome = {kind: 'ok', version: '1.19.0'};
const STALE: PortFile = {port: 41120, token: 'old', pid: 111};
const FRESH: PortFile = {port: 41121, token: 'new', pid: 222};

interface Options {
  platform?: Platform;
  file?: PortFile;
  app?: AppLocation | null;
  launcherOff?: boolean;
  /** Answers each start; `undefined` leaves it pending for the test to answer. */
  answer?: (attempt: number) => StartOutcome | undefined;
  kill?: (pid: number) => void;
  connect?: (port: number) => Promise<void>;
  /** Replaces whole seams. */
  seams?: Partial<CoreSeams>;
}

function harness(options: Options = {}) {
  let file = options.file;
  const spawns: Spawned[] = [];
  const starts: Started[] = [];
  const connects: number[] = [];
  const events: string[] = [];
  const seams: CoreSeams = {
    platform: options.platform ?? 'linux',
    home: '/home/u',
    env: {HOME: '/home/u', PATH: '/usr/bin', AWS_PROFILE: 'prod'},
    minAppVersion: '1.19.0-0',
    launcherOff: () => options.launcherOff ?? false,
    readPortFile: () => file,
    kill: (pid) => options.kill?.(pid),
    connect: async (port) => {
      connects.push(port);
      await options.connect?.(port);
      return {destroy: () => {}};
    },
    locateApp: () =>
      options.app === null ? undefined : (options.app ?? {binary: '/usr/bin/dynotable'}),
    spawn: (command, args, spawnOptions) => {
      const child = new FakeChild();
      spawns.push({command, args, options: spawnOptions, child});
      return child;
    },
    startSession: (params) => {
      let answer!: (outcome: StartOutcome) => void;
      const outcome = new Promise<StartOutcome>((resolve) => (answer = resolve));
      const n = starts.length + 1;
      events.push(`start${n}`);
      const dispose = vi.fn<() => Promise<void>>(async () => void events.push(`dispose${n}`));
      starts.push({params, answer, dispose});
      const auto = (options.answer ?? (() => OK))(n);
      if (auto) answer(auto);
      return {outcome, dispose};
    },
    onState: () => {},
    ...options.seams
  };
  const core = new ConnectCore(seams);
  const state = (): State => core.current;
  return {
    core,
    spawns,
    starts,
    connects,
    events,
    state,
    setFile: (next: PortFile | undefined) => (file = next)
  };
}

const latched = (reason: string) => ({kind: 'latched', reason});
const refused = () => Object.assign(new Error('refused'), {code: 'ECONNREFUSED'});
const throws = (code: string) => () => {
  throw Object.assign(new Error(code), {code});
};
const connected = {kind: 'connected', version: '1.19.0', attempt: expect.any(Number)};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('launchEnv', () => {
  it('macOS/Linux keep the desktop allow-list only', () => {
    const env = launchEnv('darwin', {
      ELECTRON_RUN_AS_NODE: '1',
      AWS_PROFILE: 'prod',
      NODE_OPTIONS: '--inspect',
      NODE_ENV: 'development',
      HOME: '/Users/u',
      PATH: '/usr/bin',
      XAUTHORITY: '/x'
    });
    expect(env).toEqual({HOME: '/Users/u', PATH: '/usr/bin', XAUTHORITY: '/x'});
  });

  it('Windows drops the deny-list case-insensitively', () => {
    const env = launchEnv('win32', {
      Path: 'C:\\Windows',
      electron_run_as_node: '1',
      Node_Options: '--inspect',
      AWS_ENDPOINT_URL: 'http://localhost:8000'
    });
    expect(env).toEqual({Path: 'C:\\Windows'});
  });

  // A snap VS Code points GTK at its own runtime; the app would then load the wrong libraries.
  it('Linux restores snap originals and deletes a variable whose original is empty', () => {
    const env = launchEnv('linux', {
      GTK_PATH: '/snap/code/gtk',
      GTK_PATH_VSCODE_SNAP_ORIG: '/usr/lib/gtk',
      GDK_PIXBUF_MODULE_FILE: '/snap/code/gdk',
      GDK_PIXBUF_MODULE_FILE_VSCODE_SNAP_ORIG: ''
    });
    expect(env).toEqual({GTK_PATH: '/usr/lib/gtk'});
  });
});

describe('launcher', () => {
  it('cold start: a child with no exit whose port file appears connects', async () => {
    const h = harness();
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(1000);
    h.setFile(FRESH);
    await vi.advanceTimersByTimeAsync(250);
    await done;
    expect(h.spawns.map((s) => [s.command, s.args])).toEqual([
      ['/usr/bin/dynotable', ['--headless']]
    ]);
    expect(h.connects).toEqual([FRESH.port]);
    expect(h.state()).toEqual(connected);
  });

  it('pins the spawn options', async () => {
    const h = harness();
    void h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    const [spawned] = h.spawns;
    expect(spawned?.options).toEqual({
      // Without it the app dies with VS Code, and `unref` (below) lets VS Code exit first.
      detached: true,
      // Piped stdio kills the long-lived app with EPIPE once VS Code exits.
      stdio: 'ignore',
      // An inherited cwd locks VS Code's own folder on Windows for the app's lifetime.
      cwd: '/home/u',
      // The filtered environment: no AWS_PROFILE from the terminal VS Code started in.
      env: {HOME: '/home/u', PATH: '/usr/bin'}
    });
    expect(spawned?.child.unref).toHaveBeenCalled();
  });

  it('stale file: ECONNREFUSED runs the launcher', async () => {
    const h = harness({
      file: {port: STALE.port, token: STALE.token},
      connect: async (port) => {
        if (port === STALE.port) throw refused();
      }
    });
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    h.setFile(FRESH);
    await vi.advanceTimersByTimeAsync(250);
    await done;
    expect(h.spawns).toHaveLength(1);
    expect(h.connects).toEqual([STALE.port, FRESH.port]);
    expect(h.state()).toEqual(connected);
  });

  // The stale port may now belong to another local user's listener, which would receive the token.
  it.each(['ESRCH', 'EPERM'])(
    'dead pid (%s): runs the launcher and never connects to it',
    async (code) => {
      const h = harness({
        file: STALE,
        kill: (pid) => {
          if (pid === STALE.pid) throw Object.assign(new Error(code), {code});
        }
      });
      const done = h.core.ensureConnected();
      await vi.advanceTimersByTimeAsync(0);
      h.setFile(FRESH);
      await vi.advanceTimersByTimeAsync(250);
      await done;
      expect(h.spawns).toHaveLength(1);
      expect(h.connects).toEqual([FRESH.port]);
    }
  );

  it('a file with no pid connects without the launcher', async () => {
    const h = harness({
      file: {port: STALE.port, token: STALE.token},
      kill: () => {
        throw new Error('kill must not run');
      }
    });
    await h.core.ensureConnected();
    expect(h.spawns).toHaveLength(0);
    expect(h.state()).toEqual(connected);
  });

  it.each([
    [3, null, 'integration-off'],
    [1, null, 'start-failed'],
    [null, 'SIGSEGV', 'crashed']
  ] as const)('exit %s / %s latches %s', async (code, signal, reason) => {
    const h = harness();
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    h.spawns[0]?.child.emit('exit', code, signal);
    await done;
    expect(h.state()).toEqual(latched(reason));
  });

  it('exit 0: polls from a stale file to a new (port, token)', async () => {
    const h = harness({
      file: STALE,
      kill: () => {
        throw Object.assign(new Error('ESRCH'), {code: 'ESRCH'});
      }
    });
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    h.spawns[0]?.child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.connects).toEqual([]);
    h.setFile({...FRESH, pid: undefined});
    await vi.advanceTimersByTimeAsync(250);
    await done;
    expect(h.spawns).toHaveLength(1);
    expect(h.connects).toEqual([FRESH.port]);
  });

  it('exit 0 twice with no port file: spawns once more, then latches not-serving', async () => {
    const h = harness();
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    h.spawns[0]?.child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.spawns).toHaveLength(2);
    h.spawns[1]?.child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(20_000);
    await done;
    expect(h.state()).toEqual(latched('not-serving'));
    expect(h.spawns).toHaveLength(2);
  });

  it('plain timeout: a live child that writes nothing times out', async () => {
    const h = harness();
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.state()).toEqual({kind: 'starting'});
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.state()).toEqual(latched('timed-out'));
  });

  it('spawn error maps to its reason', async () => {
    const h = harness();
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    h.spawns[0]?.child.emit('error', Object.assign(new Error('EACCES'), {code: 'EACCES'}));
    await done;
    expect(h.state()).toEqual(latched('spawn-failed'));
  });

  it.each([
    ['no binary', {app: null}, 'not-installed'],
    // An old app handles --headless as a plain launch and opens its full window.
    ['an old app', {app: {binary: '/a', version: '1.18.2'}}, 'update-app'],
    ['userDataDir set', {launcherOff: true}, 'launcher-off']
  ] as const)('%s: latches with no spawn', async (_name, options, reason) => {
    const h = harness(options);
    await h.core.ensureConnected();
    expect(h.spawns).toHaveLength(0);
    expect(h.state()).toEqual(latched(reason));
  });

  // The server's handshake deadline is 30 s; ours must not fire first and hide its answer.
  it('initialize that never answers times out at 40 s and disposes the attempt', async () => {
    const h = harness({file: FRESH, answer: () => undefined});
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(39_999);
    expect(h.state()).toEqual({kind: 'starting'});
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(h.state()).toEqual(latched('timed-out'));
    expect(h.starts[0]?.dispose).toHaveBeenCalled();
  });

  it('-32898 twice: re-reads the port file once, then gives up', async () => {
    const h = harness({file: FRESH, answer: () => ({kind: 'auth-failed'})});
    await h.core.ensureConnected();
    expect(h.starts).toHaveLength(2);
    expect(h.state()).toEqual(latched('auth-failed'));
  });

  it('signed-out at initialize latches', async () => {
    const h = harness({file: FRESH, answer: () => ({kind: 'signed-out'})});
    await h.core.ensureConnected();
    expect(h.state()).toEqual(latched('signed-out'));
  });

  it.each([
    [
      'initialize closed',
      'connection-ended',
      {file: FRESH, answer: () => ({kind: 'closed'}) as const}
    ],
    [
      'initialize refused',
      'start-failed',
      {file: FRESH, answer: () => ({kind: 'refused'}) as const}
    ],
    [
      'a connect error other than ECONNREFUSED',
      'start-failed',
      {file: FRESH, connect: async () => throws('EACCES')()}
    ],
    // Else the state stays `starting` with nothing running.
    ['a seam that throws', 'start-failed', {seams: {locateApp: throws('EIO')}}],
    ['a spawn that throws', 'spawn-failed', {seams: {spawn: throws('EACCES')}}]
  ] as const)('%s latches %s', async (_name, reason, options) => {
    const h = harness(options);
    await h.core.ensureConnected();
    expect(h.state()).toEqual(latched(reason));
  });

  // A second refusal means the launched app does not serve that port either.
  it('ECONNREFUSED after the launch latches start-failed', async () => {
    const h = harness({
      file: {port: STALE.port, token: STALE.token},
      connect: async () => {
        throw refused();
      }
    });
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    h.setFile(FRESH);
    await vi.advanceTimersByTimeAsync(250);
    await done;
    expect(h.spawns).toHaveLength(1);
    expect(h.connects).toEqual([STALE.port, FRESH.port]);
    expect(h.state()).toEqual(latched('start-failed'));
  });

  // An app the user just quit, or that was killed, must never come back invisibly.
  it('connection ended: a dropped session latches, and the next trigger spawns nothing', async () => {
    const h = harness({file: FRESH});
    await h.core.ensureConnected();
    h.starts[0]?.params.onClosed();
    expect(h.state()).toEqual(latched('connection-ended'));
    await h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.spawns).toHaveLength(0);
    expect(h.starts).toHaveLength(1);
  });

  it('Reconnect clears a latch and connects', async () => {
    const h = harness();
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    h.spawns[0]?.child.emit('exit', 3, null);
    await done;
    h.setFile(FRESH);
    await h.core.restart();
    expect(h.state()).toEqual(connected);
  });

  it.each([
    [
      'darwin',
      {binary: '/A/DynoTable.app/Contents/MacOS/DynoTable', bundle: '/A/DynoTable.app'},
      'open',
      ['-a', '/A/DynoTable.app']
    ],
    ['linux', {binary: '/usr/bin/dynotable'}, '/usr/bin/dynotable', []]
  ] as const)(
    'Open DynoTable on %s launches without --headless',
    async (platform, app, command, args) => {
      const h = harness({platform, app});
      const opened = h.core.openApp();
      h.spawns[0]?.child.emit('spawn');
      expect(await opened).toBeUndefined();
      expect(h.spawns.map((s) => [s.command, s.args, s.options.env])).toEqual([
        [command, args, {HOME: '/home/u', PATH: '/usr/bin'}]
      ]);
    }
  );

  it.each([
    ['no app', 'not-installed', {app: null}],
    ['a spawn that throws', 'spawn-failed', {seams: {spawn: throws('EACCES')}}],
    // A spawn here would start a second app on the default user data.
    ['userDataDir set', 'launcher-off', {launcherOff: true}]
  ] as const)('Open DynoTable with %s answers %s', async (_name, reason, options) => {
    expect(await harness(options).core.openApp()).toBe(reason);
  });
});

describe('concurrency', () => {
  it('concurrent triggers produce one spawn', async () => {
    const h = harness();
    void h.core.ensureConnected();
    void h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawns).toHaveLength(1);
  });

  it('a restart during a start waits for it and disposes it before the next start', async () => {
    const h = harness({file: FRESH, answer: (n) => (n === 1 ? undefined : OK)});
    void h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    const restarted = h.core.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.events).toEqual(['start1']);
    h.starts[0]?.answer(OK);
    await restarted;
    expect(h.events).toEqual(['start1', 'dispose1', 'start2']);
  });

  // A request on the stopping client would fail with a status that still says connected.
  it('a restart shows starting while it ends the old session', async () => {
    const h = harness({file: FRESH});
    await h.core.ensureConnected();
    let finish!: () => void;
    h.starts[0]?.dispose.mockImplementation(
      () => new Promise<void>((resolve) => (finish = resolve))
    );
    const restarted = h.core.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toEqual({kind: 'starting'});
    finish();
    await restarted;
    expect(h.state()).toEqual(connected);
  });

  // Repeated Reconnect clicks, or a settings change during a start, would each toast and each
  // replace the session the one before made.
  it('restart requests that arrive while one waits share it', async () => {
    const h = harness({file: FRESH, answer: (n) => (n === 1 ? undefined : OK)});
    void h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    const first = h.core.restart();
    // The first waits for the start in flight; the next two wait in the queue.
    await vi.advanceTimersByTimeAsync(0);
    const second = h.core.restart();
    const third = h.core.restart();
    expect(third).toBe(second);
    h.starts[0]?.answer(OK);
    await Promise.all([first, second]);
    expect(h.events).toEqual(['start1', 'dispose1', 'start2', 'dispose2', 'start3']);
  });

  it('a failed restart does not block the next one', async () => {
    let fail = true;
    const h = harness({
      file: FRESH,
      seams: {
        onState: () => {
          if (!fail) return;
          fail = false;
          throw new Error('paint failed');
        }
      }
    });
    await expect(h.core.restart()).rejects.toThrow('paint failed');
    await h.core.restart();
    expect(h.state()).toEqual(connected);
  });

  it('a restart during a run waits for the run', async () => {
    const h = harness({file: FRESH});
    await h.core.ensureConnected();
    let finish!: () => void;
    const run = h.core.trackRun(() => new Promise<void>((resolve) => (finish = resolve)));
    const restarted = h.core.restart();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state()).toEqual({kind: 'waiting-for-run'});
    expect(h.events).toEqual(['start1']);
    finish();
    await run;
    await restarted;
    expect(h.events).toEqual(['start1', 'dispose1', 'start2']);
  });

  it('a latched reason does not respawn on the next trigger', async () => {
    const h = harness();
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    h.spawns[0]?.child.emit('exit', 3, null);
    await done;
    await h.core.ensureConnected();
    expect(h.spawns).toHaveLength(1);
  });

  it('a watcher event for the in-flight attempt’s (port, token) is ignored', async () => {
    const h = harness({file: FRESH, answer: () => undefined});
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    h.core.portFileChanged();
    h.starts[0]?.answer(OK);
    await done;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.starts).toHaveLength(1);
  });

  // The app restarted during the attempt: its new port file must not wait for a Reconnect.
  it('a new (port, token) written during an attempt reconnects once the attempt latches', async () => {
    const h = harness({
      file: STALE,
      kill: () => {},
      answer: (n) => (n === 1 ? undefined : OK)
    });
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    h.setFile(FRESH);
    h.core.portFileChanged();
    h.starts[0]?.answer({kind: 'signed-out'});
    await done;
    await vi.advanceTimersByTimeAsync(0);
    expect(h.connects).toEqual([STALE.port, FRESH.port]);
    expect(h.state()).toEqual(connected);
  });

  // A failed launch latches; an event for the same dead-pid file must not launch again.
  it('a watcher event for an unchanged dead-pid file after a failed launch does not relaunch', async () => {
    const h = harness({file: STALE, kill: throws('ESRCH')});
    const done = h.core.ensureConnected();
    await vi.advanceTimersByTimeAsync(0);
    h.spawns[0]?.child.emit('exit', 1, null);
    await done;
    expect(h.state()).toEqual(latched('start-failed'));
    h.core.portFileChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.spawns).toHaveLength(1);
  });

  it('a watcher delete does nothing', async () => {
    const h = harness({file: FRESH});
    await h.core.ensureConnected();
    h.starts[0]?.params.onClosed();
    h.setFile(undefined);
    h.core.portFileChanged();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.spawns).toHaveLength(0);
    expect(h.starts).toHaveLength(1);
  });

  // The positive control for the two above: without it, a watcher that never acts passes them.
  it('a watcher event with a new (port, token) clears a latch and connects', async () => {
    const h = harness({file: STALE, kill: () => {}});
    await h.core.ensureConnected();
    h.starts[0]?.params.onClosed();
    h.setFile(FRESH);
    h.core.portFileChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.connects).toEqual([STALE.port, FRESH.port]);
    expect(h.state()).toEqual(connected);
  });

  // The connect-time listing of a replaced session answers late; it must not end the new one.
  it('a latch from an older attempt is ignored; the live attempt’s latch disposes it', async () => {
    const h = harness({file: FRESH});
    await h.core.ensureConnected();
    await h.core.restart();
    await h.core.latch(1, 'missing-request');
    expect(h.state()).toEqual(connected);
    await h.core.latch(2, 'missing-request');
    expect(h.state()).toEqual(latched('missing-request'));
    expect(h.starts[1]?.dispose).toHaveBeenCalled();
  });
});

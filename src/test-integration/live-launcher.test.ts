import {strict as assert} from 'node:assert';
import {homedir} from 'node:os';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {beforeEach, describe, it} from 'mocha';
import * as vscode from 'vscode';
import {launchEnv} from '../connect-core';
import type {PortFile} from '../protocol';
import {REASONS, type LatchedReason} from '../reasons';
import {
  api,
  bindLiveProfile,
  harnessEnv,
  launcherSpawns,
  livePortFile,
  runOrders,
  session,
  sleep,
  toasts,
  waitFor,
  waitForStatus,
  type Spawned
} from './harness';
import {
  alive,
  appProcesses,
  appWindows,
  guardedSpawn,
  liveAppPath,
  ownedBy,
  signalApp,
  stopApps
} from './live-app';

/**
 * The extension starts the app itself, through the wrapper (docs/manual-e2e.md, Launcher runs).
 * Each test makes its own start state, except the cold spawn: it must run first in its VS Code
 * launch, while the extension has done nothing.
 */
const DIR = harnessEnv('DYNOTABLE_LIVE_USER_DATA_DIR');
/** Longer than the extension's own cold-start wait. */
const START_MS = 45_000;

const status = async () => (await api()).status();
const reconnect = () => vscode.commands.executeCommand('dynotable.reconnect');
const toast = (latched: LatchedReason) => ({kind: 'error', message: REASONS[latched].sentence});
/** Compared, never printed: it holds the token. */
const keyOf = (file: PortFile | undefined) => file && `${file.port}\n${file.token}`;

/** The one app on DIR, named by the port file. */
async function servingPid(): Promise<number> {
  const pid = (await livePortFile())?.pid ?? assert.fail('no port file, or one with no pid');
  assert.ok(ownedBy(pid, DIR), `the port file's pid ${pid} is not an app on ${DIR}`);
  const mains = appProcesses(DIR).filter(({main}) => main);
  assert.deepEqual(
    mains.map((process) => process.pid),
    [pid]
  );
  return pid;
}

/** A serving app with a bound session on it. */
async function connectedApp(): Promise<number> {
  if ((await status()).kind !== 'connected') {
    await launcherSpawns();
    await reconnect();
    await waitFor('a session', async () => (await status()).kind !== 'starting', START_MS);
    if ((await status()).kind === 'unbound') await bindLiveProfile();
    assert.equal((await status()).kind, 'connected', JSON.stringify(await status()));
  }
  return servingPid();
}

const noWindow = () => assert.deepEqual(appWindows(DIR), [], 'an app window is on screen');

const onlyHeadless = (spawns: Spawned[]) =>
  assert.deepEqual(
    spawns.map(({command, args}) => ({command, args})),
    [{command: liveAppPath(), args: ['--headless']}]
  );

async function exitOf(spawned: Pick<Spawned, 'exit'>, ms: number) {
  return Promise.race([
    spawned.exit,
    sleep(ms).then(() => assert.fail(`the spawned app did not exit in ${ms} ms`))
  ]);
}

describe('live launcher', function () {
  this.timeout(4 * 60_000);

  beforeEach(() => {
    toasts.length = 0;
  });

  it('@live-launcher cold spawn: with no app, a lazy connect starts it headless and a run returns rows', async () => {
    assert.equal((await status()).kind, 'hidden', 'this test must run first in its launch');
    await stopApps(DIR);
    const before = keyOf(await livePortFile());
    const spawns = await launcherSpawns();
    await session(START_MS);
    onlyHeadless(spawns);
    assert.ok(keyOf(await livePortFile()) !== before, 'the port file has no new (port, token)');
    const pid = await servingPid();
    // The wrapper execs the app, so the spawned pid serves.
    assert.equal(spawns[0]?.pid, pid);
    await bindLiveProfile();
    await runOrders();
    assert.equal(spawns.length, 1);
    noWindow();
    console.log(
      `cold spawn: ${spawns.length} spawn, args ${JSON.stringify(spawns[0]?.args)}, pid ${pid}`
    );
  });

  // No extension path launches while an app serves, so the test starts the second instance.
  it('@live-launcher nudge: a second headless launch exits 0 and the first app keeps serving', async () => {
    const pid = await connectedApp();
    const {client} = await api();
    const first = client();
    const key = keyOf(await livePortFile());
    const child = guardedSpawn(liveAppPath())(liveAppPath(), ['--headless'], {
      detached: true,
      stdio: 'ignore',
      cwd: homedir(),
      env: launchEnv('darwin', process.env)
    });
    const exit = new Promise<{code: number | null; signal: string | null}>((resolve) =>
      child.once('exit', (code, signal) => resolve({code, signal}))
    );
    const code = await exitOf({exit}, 30_000);
    assert.deepEqual(code, {code: 0, signal: null});
    assert.equal(child.pid !== undefined && alive(child.pid), false);
    // A nudge to a serving app changes nothing.
    await sleep(2000);
    assert.ok(keyOf(await livePortFile()) === key, 'the port file changed after the nudge');
    assert.equal(await servingPid(), pid);
    assert.ok(client() === first, 'the session was replaced');
    await runOrders();
    noWindow();
    console.log(`nudge: pid ${child.pid} exited ${code.code}; pid ${pid} still serves`);
  });

  it('@live-launcher killed: after a SIGKILL, Reconnect starts a new app and a run works', async () => {
    const killed = await connectedApp();
    toasts.length = 0;
    signalApp(killed, DIR, 'SIGKILL');
    await waitForStatus('disconnected', 'connection-ended');
    assert.deepEqual(toasts, [toast('connection-ended')]);
    await waitFor('the killed app to go', () => !alive(killed));
    assert.equal((await livePortFile())?.pid, killed, 'the stale port file is gone or changed');
    const spawns = await launcherSpawns();
    await reconnect();
    await waitForStatus('connected', undefined, START_MS);
    onlyHeadless(spawns);
    const pid = await servingPid();
    assert.notEqual(pid, killed);
    assert.equal(spawns[0]?.pid, pid);
    await runOrders();
    noWindow();
    console.log(`killed: pid ${killed}; Reconnect spawned ${spawns.length}, new pid ${pid}`);
  });

  it('@live-launcher integration-off: the launched app exits 3; the Settings sentence shows once', async () => {
    const pid = await connectedApp();
    signalApp(pid, DIR, 'SIGTERM');
    await waitFor('the port file to go', async () => (await livePortFile()) === undefined);
    await waitFor('every app process to go', () => appProcesses(DIR).length === 0);
    const config = join(DIR, 'lsp-config.json');
    const setEnabled = (enabled: boolean) =>
      writeFileSync(config, JSON.stringify({...JSON.parse(readFileSync(config, 'utf8')), enabled}));
    assert.deepEqual(appProcesses(DIR), [], 'an app runs: the config must not change now');
    setEnabled(false);
    try {
      const spawns = await launcherSpawns();
      toasts.length = 0;
      await reconnect();
      await waitForStatus('disconnected', 'integration-off', START_MS);
      onlyHeadless(spawns);
      const exit = await exitOf(spawns[0] ?? assert.fail('no spawn'), 5000);
      assert.deepEqual(exit, {code: 3, signal: null});
      // A second toast of the sentence would come now.
      await sleep(1000);
      assert.deepEqual(toasts, [toast('integration-off')]);
      assert.match(REASONS['integration-off'].sentence, /Settings → Editor integration/);
      assert.deepEqual(appProcesses(DIR), []);
      console.log(
        `integration-off: quit pid ${pid}; spawned pid ${spawns[0]?.pid} exited ${exit.code}`
      );
    } finally {
      setEnabled(true);
    }
  });
});

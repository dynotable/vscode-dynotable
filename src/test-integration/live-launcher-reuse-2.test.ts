import {strict as assert} from 'node:assert';
import {existsSync, readFileSync, rmSync} from 'node:fs';
import {describe, it} from 'mocha';
import {
  bindLiveProfile,
  harnessEnv,
  launcherSpawns,
  livePortFile,
  runOrders,
  session
} from './harness';
import {alive, appProcesses, appWindows, ownedBy} from './live-app';

/**
 * The second half of the case that live-launcher-reuse-1 starts. The VS Code launch that started the
 * app has ended, so the app must still run, and this launch must use it.
 */
const DIR = harnessEnv('DYNOTABLE_LIVE_USER_DATA_DIR');

describe('live launcher reuse, next launch', function () {
  this.timeout(2 * 60_000);

  it('@live-launcher reuse 2: the next VS Code uses the app the last one started, with no spawn', async () => {
    const handoff = harnessEnv('DYNOTABLE_LAUNCHER_HANDOFF');
    assert.ok(
      existsSync(handoff),
      'no hand-off: live-launcher-reuse-1 must pass first, in this run'
    );
    const started = JSON.parse(readFileSync(handoff, 'utf8')) as {pid: number; port: number};
    rmSync(handoff);
    assert.ok(alive(started.pid), `the app ${started.pid} did not outlive the last VS Code`);
    assert.ok(ownedBy(started.pid, DIR), `pid ${started.pid} is not on ${DIR}`);
    const file = await livePortFile();
    assert.deepEqual({pid: file?.pid, port: file?.port}, started);
    const spawns = await launcherSpawns();
    await session();
    await bindLiveProfile();
    await runOrders();
    assert.deepEqual(spawns, []);
    assert.equal((await livePortFile())?.pid, started.pid);
    assert.deepEqual(
      appProcesses(DIR)
        .filter(({main}) => main)
        .map(({pid}) => pid),
      [started.pid]
    );
    assert.deepEqual(appWindows(DIR), [], 'an app window is on screen');
    console.log(`reuse 2: pid ${started.pid} outlived the last VS Code; ${spawns.length} spawns`);
  });
});

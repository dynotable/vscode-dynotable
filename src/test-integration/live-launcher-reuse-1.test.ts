import {strict as assert} from 'node:assert';
import {writeFileSync} from 'node:fs';
import {describe, it} from 'mocha';
import {harnessEnv, launcherSpawns, livePortFile, session} from './harness';
import {appProcesses, appWindows, liveAppPath, ownedBy, stopApps} from './live-app';

/**
 * The first half of one case over two VS Code launches: this launch starts the app, then ends. The
 * second half (live-launcher-reuse-2) runs next and finds the same app.
 */
const DIR = harnessEnv('DYNOTABLE_LIVE_USER_DATA_DIR');

describe('live launcher reuse, first launch', function () {
  this.timeout(2 * 60_000);

  it('@live-launcher reuse 1: the extension starts the app, which outlives this VS Code', async () => {
    await stopApps(DIR);
    const spawns = await launcherSpawns();
    await session(45_000);
    assert.deepEqual(
      spawns.map(({command, args}) => ({command, args})),
      [{command: liveAppPath(), args: ['--headless']}]
    );
    const file = (await livePortFile()) ?? assert.fail('no port file');
    assert.equal(file.pid, spawns[0]?.pid);
    assert.ok(file.pid !== undefined && ownedBy(file.pid, DIR), `pid ${file.pid} is not on ${DIR}`);
    assert.equal(appProcesses(DIR).filter(({main}) => main).length, 1);
    assert.deepEqual(appWindows(DIR), [], 'an app window is on screen');
    console.log(`reuse 1: ${spawns.length} spawn, pid ${file.pid}`);
    writeFileSync(
      harnessEnv('DYNOTABLE_LAUNCHER_HANDOFF'),
      JSON.stringify({pid: file.pid, port: file.port})
    );
  });
});

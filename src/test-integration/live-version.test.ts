import {strict as assert} from 'node:assert';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, it} from 'mocha';
import * as vscode from 'vscode';
import {REASONS} from '../reasons';
import {api, harnessEnv, recordSpawns, sleep, toasts, waitForStatus} from './harness';

// The launcher sets DYNOTABLE_MIN_APP_VERSION above the running app's version for this file.
describe('live version gate', () => {
  it('@live version gate: an app older than the minimum shows update DynoTable and opens nothing', async () => {
    const spawns = await recordSpawns();
    const path = join(harnessEnv('DYNOTABLE_HARNESS_DIR'), 'workspace', 'old.partiql');
    writeFileSync(path, 'SELECT 1');
    await vscode.workspace.openTextDocument(path);
    await waitForStatus('disconnected', 'update-app');
    // A reconnect or an Open DynoTable would come now.
    await sleep(1000);
    assert.deepEqual(toasts, [{kind: 'error', message: REASONS['update-app'].sentence}]);
    assert.deepEqual(spawns, []);
    assert.equal((await api()).client(), undefined);
  });
});

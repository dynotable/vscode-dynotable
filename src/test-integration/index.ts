import {strict as assert} from 'node:assert';
import {join, sep} from 'node:path';
import Mocha from 'mocha';
import * as vscode from 'vscode';
import {api, harnessEnv, stubWindow} from './harness';
import {liveAppPath} from './live-app';

/**
 * Nothing a test does may touch the real app, its port file, a process launch or a browser. A live
 * run reads the port file of the live userData directory, and nothing else. A launcher run may
 * start the wrapper DYNOTABLE_LIVE_APP_PATH, through the seam a test puts in.
 */
async function guardRails(): Promise<void> {
  const root = harnessEnv('DYNOTABLE_HARNESS_DIR') + sep;
  assert.notEqual(root, sep, 'the launcher sets DYNOTABLE_HARNESS_DIR');
  const live = harnessEnv('DYNOTABLE_LIVE_USER_DATA_DIR');
  const {portFilePath, appRoot, seams} = await api();
  if (live) assert.equal(portFilePath, join(live, 'lsp-port.json'));
  else assert.ok(portFilePath.startsWith(root), `port file ${portFilePath} is outside ${root}`);
  // A launcher run starts the app through the wrapper only, and the launcher must be on.
  if (process.env.DYNOTABLE_LIVE_APP_PATH) {
    assert.equal(appRoot, liveAppPath());
    assert.equal(vscode.workspace.getConfiguration('dynotable').get('userDataDir'), '');
  } else {
    assert.ok(appRoot?.startsWith(root), `app root ${appRoot} is outside ${root}`);
  }
  assert.throws(() => seams.spawn('true'), /disabled in tests/);
  assert.throws(
    () => seams.openExternal(vscode.Uri.parse('https://dynotable.com')),
    /disabled in tests/
  );
}

/** The extension host's entry point. The launcher runs one test file per VS Code launch. */
export async function run(): Promise<void> {
  stubWindow();
  const mocha = new Mocha({ui: 'bdd', timeout: 60_000, color: true});
  if (process.env.DYNOTABLE_TEST_GREP) mocha.grep(process.env.DYNOTABLE_TEST_GREP);
  mocha.suite.beforeAll('guard rails', guardRails);
  // A test that replaces a seam must not weaken the guard rails for the tests after it.
  const {seams} = await api();
  const refusing = {...seams};
  mocha.suite.afterEach('restore seams', () => void Object.assign(seams, refusing));
  mocha.addFile(join(__dirname, process.env.DYNOTABLE_TEST_FILE ?? ''));
  let ran = 0;
  const failures = await new Promise<number>((resolve) =>
    mocha.run(resolve).on('test end', () => ran++)
  );
  if (failures > 0) throw new Error(`${failures} integration test(s) failed`);
  // A grep with a typo, or a file with no test for this mode, must not pass.
  if (ran === 0) throw new Error('No integration test ran.');
}

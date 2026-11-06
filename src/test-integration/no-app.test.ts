import {strict as assert} from 'node:assert';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {beforeEach, describe, it} from 'mocha';
import * as vscode from 'vscode';
import {REASONS} from '../reasons';
import {api, harnessEnv, quickPicks, recordSpawns, toasts, waitFor, waitForStatus} from './harness';

const settings = () => vscode.workspace.getConfiguration('dynotable');

const notInstalled = {kind: 'error', message: REASONS['not-installed'].sentence};

// No app is installed and no port file exists, so every attempt latches not-installed.
describe('no app', () => {
  beforeEach(() => {
    toasts.length = 0;
  });

  // The latch shows its reason once. A command that meets an older latch shows it again, once.
  it('a command shows the reason once, from idle and when already latched', async () => {
    assert.equal((await api()).status().kind, 'hidden');
    await vscode.commands.executeCommand('dynotable.selectProfile');
    assert.deepEqual(toasts, [notInstalled]);
    await vscode.commands.executeCommand('dynotable.selectProfile');
    assert.deepEqual(toasts, [notInstalled, notInstalled]);
  });

  it('Download from the status bar menu and Open Documentation open their pages', async () => {
    const opened: string[] = [];
    (await api()).seams.openExternal = async (target) => {
      opened.push(target.toString());
      return true;
    };
    quickPicks.answer = 'Download DynoTable';
    await vscode.commands.executeCommand('dynotable.statusActions');
    await vscode.commands.executeCommand('dynotable.openDocs');
    assert.deepEqual(opened, [
      'https://dynotable.com/download',
      'https://dynotable.com/docs/editors'
    ]);
  });

  // Setting the user data directory turns the launcher off at once, with no window reload.
  it('a changed userDataDir applies at once', async () => {
    const dir = join(harnessEnv('DYNOTABLE_HARNESS_DIR'), 'custom-user-data');
    await settings().update('userDataDir', dir, vscode.ConfigurationTarget.Global);
    await waitForStatus('disconnected', 'launcher-off');
    await settings().update('userDataDir', undefined, vscode.ConfigurationTarget.Global);
    await waitForStatus('disconnected', 'not-installed');
  });

  // The not-installed fix is Set App Path, then Reconnect.
  it('a changed appPath applies at Reconnect', async () => {
    const app = join(harnessEnv('DYNOTABLE_HARNESS_DIR'), 'app', 'custom', 'dynotable');
    mkdirSync(join(app, '..'), {recursive: true});
    writeFileSync(app, '');
    const spawns = await recordSpawns();
    await settings().update('appPath', app, vscode.ConfigurationTarget.Global);
    void vscode.commands.executeCommand('dynotable.reconnect');
    await waitFor('a launch', () => spawns.length === 1);
    assert.deepEqual(spawns[0], {command: app, args: ['--headless']});
  });
});

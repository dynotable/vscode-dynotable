import {strict as assert} from 'node:assert';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, it} from 'mocha';
import * as vscode from 'vscode';
import {RpcFailure} from '../../scripts/rpc';
import type {WireError} from '../protocol';
import {REASONS} from '../reasons';
import {
  api,
  fakeServer,
  quickPicks,
  sleep,
  toastAnswers,
  toasts,
  waitFor,
  waitForStatus,
  workspace
} from './harness';

const fake = fakeServer();
const STORED = {id: 'profile-1-id', name: 'profile-1-name'};
const CHOSEN = {id: 'profile-2-id', name: 'profile-2-name'};

const requestedProfile = (n: number) =>
  (fake.initializeParams[n] as {initializationOptions: {profile?: string}}).initializationOptions
    .profile;

async function open(name: string): Promise<vscode.TextDocument> {
  writeFileSync(join(workspace, name), 'SELECT * FROM "orders"');
  return vscode.workspace.openTextDocument(vscode.Uri.file(join(workspace, name)));
}

describe('profiles', () => {
  before(() => fake.start());
  after(() => fake.stop());

  // Runs first, before anything has connected. VS Code keeps storage in memory under extension
  // tests, so a relaunch loses it: the test writes what an earlier extension host left instead.
  it('after a restart, the first connection sends the stored id', async () => {
    await (await api()).context.workspaceState.update('dynotable.profile', STORED);
    await open('first.dynotable.sql');
    await waitForStatus('connected');
    assert.equal(requestedProfile(0), STORED.id);
  });

  // The server does not confirm the binding, so the status bar must not claim one.
  it('choosing a profile connects anew with its id, and the status bar shows it as requested', async () => {
    const count = fake.initializeParams.length;
    quickPicks.answer = CHOSEN.name;
    await vscode.commands.executeCommand('dynotable.selectProfile');
    await waitForStatus('connected');
    assert.equal(fake.initializeParams.length, count + 1);
    assert.equal(requestedProfile(count), CHOSEN.id);
    const {statusBar} = await api();
    assert.equal(statusBar.text, `$(database) DynoTable: ${CHOSEN.name}`);
    assert.equal(statusBar.tooltip, `Connected to DynoTable. Requested profile: ${CHOSEN.name}.`);
  });

  // The server would refuse the profile at initialize; the session must not end for that.
  it('an incomplete profile is not chosen: a warning, and no new connection', async () => {
    fake.handle('dynotable/listProfiles', () => fake.fixture('list-profiles-incomplete.json'));
    const count = fake.initializeParams.length;
    toasts.length = 0;
    quickPicks.answer = 'profile-3-name';
    try {
      await vscode.commands.executeCommand('dynotable.selectProfile');
    } finally {
      fake.unhandle('dynotable/listProfiles');
    }
    await sleep(500);
    assert.deepEqual(toasts, [
      {kind: 'warning', message: 'This profile is incomplete. Finish setting it up in DynoTable.'}
    ]);
    assert.equal(fake.initializeParams.length, count);
  });

  // The roster came from the replaced session, maybe from another app.
  it('a choice made while the session changes is not stored and starts no connection', async () => {
    const {context} = await api();
    const stored = context.workspaceState.get('dynotable.profile');
    quickPicks.answer = STORED.name;
    quickPicks.during = () => vscode.commands.executeCommand('dynotable.reconnect');
    const count = fake.initializeParams.length;
    try {
      await vscode.commands.executeCommand('dynotable.selectProfile');
    } finally {
      quickPicks.during = undefined;
    }
    // One for the reconnect only.
    assert.equal(fake.initializeParams.length, count + 1);
    assert.deepEqual(context.workspaceState.get('dynotable.profile'), stored);
  });

  it('an empty roster offers Open DynoTable', async () => {
    const sentence = 'DynoTable has no profiles. Create a profile in DynoTable.';
    fake.handle('dynotable/listProfiles', () => []);
    toastAnswers.set(sentence, 'Open DynoTable');
    toasts.length = 0;
    try {
      await vscode.commands.executeCommand('dynotable.selectProfile');
    } finally {
      fake.unhandle('dynotable/listProfiles');
      toastAnswers.clear();
    }
    // No app is installed in the harness, so Open DynoTable answers with that reason.
    assert.deepEqual(toasts, [
      {kind: 'information', message: sentence},
      {kind: 'error', message: REASONS['not-installed'].sentence}
    ]);
  });

  it('an unbound Run lens click opens the picker', async () => {
    const refusal = fake.fixture('error-profile-required.json') as WireError;
    const refuse = () => {
      throw new RpcFailure(refusal);
    };
    fake.handle('dynotable/listTables', refuse);
    fake.handle('command:dynotable.runStatement', refuse);
    await vscode.commands.executeCommand('dynotable.reconnect');
    await waitForStatus('unbound');
    toastAnswers.set(refusal.message, 'Select Profile');
    quickPicks.answer = undefined;
    quickPicks.shown.length = 0;
    const document = await open('lens.dynotable.sql');
    // What a click on the server's Run lens executes.
    await vscode.commands.executeCommand('dynotable.runStatement', {
      uri: document.uri.toString(),
      range: {start: {line: 0, character: 0}, end: {line: 0, character: 22}}
    });
    await waitFor('the profile picker', () => quickPicks.shown.length === 1);
    assert.deepEqual(
      quickPicks.shown[0]?.map((item) => item.label),
      ['profile-1-name', 'profile-2-name']
    );
  });
});

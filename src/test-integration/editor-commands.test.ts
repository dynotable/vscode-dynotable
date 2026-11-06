import {strict as assert} from 'node:assert';
import {readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, it} from 'mocha';
import * as vscode from 'vscode';
import type {IndexRow} from '../protocol';
import {fakeServer, quickPicks, toasts, waitFor, waitForStatus, workspace} from './harness';

const fake = fakeServer();

let indices: IndexRow[] = [{name: 'products', target: 'search-1'}];
fake.handle('dynotable/listIndices', () => ({indices, unreachable: []}));

const active = () => vscode.window.activeTextEditor?.document ?? assert.fail('no active editor');

describe('editor commands', () => {
  before(() => fake.start());
  after(() => fake.stop());

  // A SQL buffer outside the selector would get no completion, lens or Run.
  it('New query in SQL opens a buffer the server receives', async () => {
    quickPicks.answer = 'SQL';
    await vscode.commands.executeCommand('dynotable.newQuery');
    const document = active();
    assert.equal(document.languageId, 'sql');
    await waitFor('didOpen of the New query buffer', () => fake.opened(document.uri.toString()));
  });

  it('attaching a file writes its folder sqlFiles, and the restarted client opens it', async () => {
    await waitForStatus('connected');
    const path = join(workspace, 'report.sql');
    writeFileSync(path, 'SELECT * FROM "orders"');
    const uri = vscode.Uri.file(path);
    await vscode.window.showTextDocument(uri);
    await vscode.commands.executeCommand('dynotable.attachSqlFile');
    const settings = JSON.parse(readFileSync(join(workspace, '.vscode', 'settings.json'), 'utf8'));
    assert.deepEqual(settings['dynotable.sqlFiles'], ['**/*.dynotable.sql', 'report.sql']);
    await waitFor('didOpen of the attached file', () => fake.opened(uri.toString()));
  });

  it('Pick index writes line 0 of a New query OpenSearch buffer', async () => {
    quickPicks.answer = 'OpenSearch';
    await vscode.commands.executeCommand('dynotable.newQuery');
    const document = active();
    assert.equal(document.languageId, 'opensearch');
    assert.equal(document.getText(), '// dynotable: index=\n');

    quickPicks.answer = 'products';
    await vscode.commands.executeCommand('dynotable.pickIndex');
    assert.equal(document.getText(), '// dynotable: index=products\n');
  });

  // The listing came from the replaced session, maybe for another profile.
  it('Pick index writes nothing when the session changes while the picker is open', async () => {
    quickPicks.answer = 'OpenSearch';
    await vscode.commands.executeCommand('dynotable.newQuery');
    const document = active();
    quickPicks.answer = 'products';
    quickPicks.during = () => vscode.commands.executeCommand('dynotable.reconnect');
    try {
      await vscode.commands.executeCommand('dynotable.pickIndex');
    } finally {
      quickPicks.during = undefined;
    }
    assert.equal(document.getText(), '// dynotable: index=\n');
  });

  it('Pick index warns and writes nothing when no index is listed or the pick cannot be pinned', async () => {
    quickPicks.answer = 'OpenSearch';
    await vscode.commands.executeCommand('dynotable.newQuery');
    const document = active();
    toasts.length = 0;
    try {
      indices = [];
      await vscode.commands.executeCommand('dynotable.pickIndex');
      indices = [
        {name: 'logs', target: 'search 1'},
        {name: 'logs', target: 'search-2'}
      ];
      quickPicks.answer = 'logs';
      await vscode.commands.executeCommand('dynotable.pickIndex');
    } finally {
      indices = [{name: 'products', target: 'search-1'}];
    }
    assert.deepEqual(toasts, [
      {kind: 'warning', message: 'DynoTable lists no OpenSearch index.'},
      {
        kind: 'warning',
        message:
          '"logs" is on more than one OpenSearch target, and the target name "search 1" contains a space, so it cannot be pinned.'
      }
    ]);
    assert.equal(document.getText(), '// dynotable: index=\n');
  });
});

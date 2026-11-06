import {strict as assert} from 'node:assert';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, it} from 'mocha';
import * as vscode from 'vscode';
import {fakeServer, harnessEnv, toasts, waitFor, waitForStatus} from './harness';

async function write(path: string, text: string): Promise<vscode.Uri> {
  mkdirSync(join(path, '..'), {recursive: true});
  writeFileSync(path, text);
  return vscode.Uri.file(path);
}

// The launcher opens this file's window on a workspace file with one folder.
describe('workspace folders', () => {
  const fake = fakeServer();
  before(() => fake.start());
  after(() => fake.stop());

  it('an added folder attaches by its own sqlFiles value, and only inside itself', async () => {
    const dir = harnessEnv('DYNOTABLE_HARNESS_DIR');
    const first = await write(join(dir, 'workspace', 'first.partiql'), 'SELECT 1');
    await vscode.workspace.openTextDocument(first);
    await waitForStatus('connected');

    const second = join(dir, 'second');
    await write(
      join(second, '.vscode', 'settings.json'),
      JSON.stringify({'dynotable.sqlFiles': ['**/attached.sql']})
    );
    // The folder's own value replaces the default, and its patterns do not reach the first folder.
    const replaced = await write(join(second, 'query.dynotable.sql'), 'SELECT 1');
    const elsewhere = await write(join(dir, 'workspace', 'attached.sql'), 'SELECT 1');
    const attached = await write(join(second, 'attached.sql'), 'SELECT 1');
    const changed = new Promise((resolve) => vscode.workspace.onDidChangeWorkspaceFolders(resolve));
    assert.ok(vscode.workspace.updateWorkspaceFolders(1, 0, {uri: vscode.Uri.file(second)}));
    await changed;
    await vscode.workspace.openTextDocument(replaced);
    await vscode.workspace.openTextDocument(elsewhere);
    await vscode.workspace.openTextDocument(attached);
    await waitFor('didOpen of the attached file', () => fake.opened(attached.toString()));
    // didOpen goes out in open order, so a match for either file would have arrived first.
    assert.ok(!fake.opened(replaced.toString()), 'the default pattern attached a file');
    assert.ok(!fake.opened(elsewhere.toString()), "the second folder's pattern left the folder");
  });

  it('Attach SQL File on a file outside every folder does not suggest the *.dynotable.sql name', async () => {
    const outside = await write(
      join(harnessEnv('DYNOTABLE_HARNESS_DIR'), 'outside.sql'),
      'SELECT 1'
    );
    await vscode.window.showTextDocument(outside);
    toasts.length = 0;
    await vscode.commands.executeCommand('dynotable.attachSqlFile');
    assert.deepEqual(toasts, [
      {kind: 'information', message: 'Only a file in an open workspace folder can be attached.'}
    ]);
  });
});

import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {after, before, describe, it} from 'mocha';
import * as vscode from 'vscode';
import {fakeServer, harnessEnv, waitFor} from './harness';

// The launcher opens this file's window with no folder.
describe('no folder', () => {
  const fake = fakeServer();
  before(() => fake.start());
  after(() => fake.stop());

  it('a *.dynotable.sql file gets didOpen', async () => {
    const path = join(harnessEnv('DYNOTABLE_HARNESS_DIR'), 'query.dynotable.sql');
    writeFileSync(path, 'SELECT * FROM "orders"');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
    await waitFor('didOpen', () => fake.opened(document.uri.toString()));
  });
});

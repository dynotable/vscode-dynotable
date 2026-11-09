import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import type {WireError} from '../../../src/protocol';
import {RpcFailure} from '../../../src/rpc';
import {useHarness} from '../test-session';
import {readDocument, run, type RunInput} from './run';

const h = useHarness();

const STATEMENT = 'SELECT * FROM "orders"\nWHERE "id" = \'1\'\n';

const message = (method: string) => h.fake.received.find((m) => m.method === method);

async function runOf(
  input: RunInput,
  {stdin = '', rowCap}: {stdin?: string; rowCap?: number} = {}
) {
  const read = await readDocument(input, {cwd: h.cwd, path}, Readable.from([stdin]));
  if (!('document' in read)) throw new Error(`no document: ${JSON.stringify(read)}`);
  await h.run(run(read.document, rowCap));
}

describe('run', () => {
  it('opens a file under its file URI with the file content', async () => {
    await h.fake.start();
    writeFileSync(path.join(h.cwd, 'q.dtsql'), STATEMENT);
    await runOf({input: {kind: 'file', path: 'q.dtsql'}});
    expect(message('textDocument/didOpen')?.params).toEqual({
      textDocument: {
        uri: pathToFileURL(path.join(h.cwd, 'q.dtsql')).href,
        languageId: 'sql',
        version: 1,
        text: STATEMENT
      }
    });
  });

  const untitled: Array<[string, RunInput, string]> = [
    ['stdin', {input: {kind: 'stdin'}, lang: 'partiql'}, 'untitled:dynotable-cli/1.partiql'],
    [
      '-e',
      {input: {kind: 'text', text: STATEMENT}, lang: 'opensearch'},
      'untitled:dynotable-cli/1.opensearch'
    ]
  ];
  it.each(untitled)('opens %s as an untitled document of the --lang id', async (_, input, uri) => {
    await h.fake.start();
    // -e must not read stdin.
    await runOf(input, {stdin: input.input.kind === 'stdin' ? STATEMENT : 'not this'});
    expect(message('textDocument/didOpen')?.params).toEqual({
      textDocument: {uri, languageId: input.lang, version: 1, text: STATEMENT}
    });
  });

  it('runs the whole document with the row cap and prints one result document', async () => {
    await h.fake.start();
    await runOf({input: {kind: 'text', text: STATEMENT}, lang: 'sql'}, {rowCap: 25});
    // No range: the app runs the whole document.
    expect(message('workspace/executeCommand')?.params).toEqual({
      command: 'dynotable.runStatement',
      arguments: [{uri: 'untitled:dynotable-cli/1.dtsql', rowCap: 25}]
    });
    expect(JSON.parse(h.stdout)).toEqual(h.fake.fixture('run-sql.json'));
    expect(h.stdout.trimEnd().split('\n')).toHaveLength(1);
    expect(h.stderr).toBe('');
    expect(h.codes).toEqual([0]);
  });

  it('a write fails with stage-in-app', async () => {
    await h.fake.start();
    h.fake.handle('command:dynotable.runStatement', () => {
      throw new RpcFailure(h.fake.fixture('error-stage-in-app.json') as WireError);
    });
    await runOf({input: {kind: 'text', text: 'DELETE FROM "orders"'}, lang: 'partiql'});
    expect(h.stdout).toBe('');
    expect(h.failure().code).toBe('stage-in-app');
    expect(h.codes).toEqual([1]);
  });

  // main.ts reads the input before it connects, so a bad input never starts the app.
  it('a missing file is a usage error', async () => {
    const read = await readDocument(
      {input: {kind: 'file', path: 'missing.dtsql'}},
      {cwd: h.cwd, path},
      Readable.from([])
    );
    expect(read).toEqual({failure: {code: 'usage', detail: expect.stringContaining('ENOENT')}});
  });
});

import {symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import {useHarness} from '../test-session';
import type {Input} from '../args';
import {readDocument, run} from './run';

const h = useHarness();

const STATEMENT = 'SELECT * FROM "orders"\nWHERE "id" = \'1\'\n';

const message = (method: string) => h.fake.received.find((m) => m.method === method);

async function runOf(input: Input, {stdin = '', rowCap}: {stdin?: string; rowCap?: number} = {}) {
  const read = await readDocument(input, {cwd: h.cwd, path}, Readable.from([stdin]));
  if (!('document' in read)) throw new Error(`no document: ${JSON.stringify(read)}`);
  await h.run(run(read.document, rowCap));
}

describe('run', () => {
  it('opens a file under its file URI with the file content', async () => {
    await h.fake.start();
    writeFileSync(path.join(h.cwd, 'q.dtsql'), STATEMENT);
    await runOf({kind: 'file', path: 'q.dtsql'});
    expect(message('textDocument/didOpen')?.params).toEqual({
      textDocument: {
        uri: pathToFileURL(path.join(h.cwd, 'q.dtsql')).href,
        languageId: 'sql',
        version: 1,
        text: STATEMENT
      }
    });
  });

  const untitled: Array<[string, Exclude<Input, {kind: 'file'}>, string]> = [
    ['stdin', {kind: 'stdin', lang: 'partiql'}, 'untitled:dynotable-cli/1.partiql'],
    [
      '-e',
      {kind: 'text', text: STATEMENT, lang: 'opensearch'},
      'untitled:dynotable-cli/1.opensearch'
    ]
  ];
  it.each(untitled)('opens %s as an untitled document of the --lang id', async (_, input, uri) => {
    await h.fake.start();
    // -e must not read stdin.
    await runOf(input, {stdin: input.kind === 'stdin' ? STATEMENT : 'not this'});
    expect(message('textDocument/didOpen')?.params).toEqual({
      textDocument: {uri, languageId: input.lang, version: 1, text: STATEMENT}
    });
  });

  it('runs the whole document with the row cap and prints one result document', async () => {
    await h.fake.start();
    await runOf({kind: 'text', text: STATEMENT, lang: 'sql'}, {rowCap: 25});
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

  // main.ts reads the input before it connects, so a bad input never starts the app.
  it('a missing file is a usage error', async () => {
    const read = await readDocument(
      {kind: 'file', path: 'missing.dtsql'},
      {cwd: h.cwd, path},
      Readable.from([])
    );
    expect(read).toEqual({failure: {code: 'usage', detail: expect.stringContaining('ENOENT')}});
  });

  // The name is checked before any read, so a missing file says nothing about the file system.
  it('a name that is not dedicated is refused before the file is read', async () => {
    const read = await readDocument(
      {kind: 'file', path: 'missing.sql'},
      {cwd: h.cwd, path},
      Readable.from([])
    );
    expect(read).toEqual({
      failure: {code: 'usage', detail: expect.stringContaining('the name must end in')}
    });
  });

  // Else a link would send a secret file to the app, and its tokens into a parser error.
  it('refuses a dedicated name that links to a file without one', async () => {
    writeFileSync(path.join(h.cwd, 'credentials'), 'aws_secret_access_key = x');
    symlinkSync(path.join(h.cwd, 'credentials'), path.join(h.cwd, 'q.partiql'));
    const read = await readDocument(
      {kind: 'file', path: 'q.partiql'},
      {cwd: h.cwd, path},
      Readable.from([])
    );
    expect(read).toEqual({
      failure: {code: 'usage', detail: expect.stringContaining('links to another file')}
    });
  });
});

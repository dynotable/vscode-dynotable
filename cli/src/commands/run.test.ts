import {symlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pathToFileURL} from 'node:url';
import {describe, expect, it} from 'vitest';
import {REQUEST_FAILED, type Range} from '../../../src/protocol';
import {RpcFailure} from '../../../src/rpc';
import type {Input} from '../args';
import {tablePrinter} from '../table';
import {useHarness} from '../test-session';
import {readDocument, run, runAtRow} from './run';

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

const span = (startLine: number, endLine: number, endCharacter: number): Range => ({
  start: {line: startLine, character: 0},
  end: {line: endLine, character: endCharacter}
});
const NO_STATEMENT = (line: number) =>
  `No statement on line ${line}. A file with a syntax error has no runnable statements.\n`;

describe('runAtRow', () => {
  const FILE = 'q.dtsql';
  const uri = () => pathToFileURL(path.join(h.cwd, FILE)).href;
  /** A lens in the `contract/code-lens.json` shape: a zero-width anchor, the statement in the argument. */
  const lens = (statement: Range, command = 'dynotable.runStatement') => ({
    range: {start: statement.start, end: statement.start},
    command: {
      title: command === 'dynotable.runStatement' ? 'Run' : 'Open in DynoTable',
      command,
      arguments: [{uri: uri(), range: statement}]
    }
  });

  async function runAt(row: number, lenses: unknown) {
    await runWith(row, () => lenses);
  }

  async function runWith(row: number, answer: () => unknown) {
    await h.fake.start();
    writeFileSync(path.join(h.cwd, FILE), STATEMENT);
    h.fake.handle('textDocument/codeLens', answer);
    const read = await readDocument(
      {kind: 'file', path: FILE},
      {cwd: h.cwd, path},
      Readable.from([])
    );
    if (!('document' in read)) throw new Error(`no document: ${JSON.stringify(read)}`);
    await h.run(runAtRow(read.document, row), {
      agent: false,
      print: tablePrinter({width: 120, color: false})
    });
  }

  it('runs the statement whose second line holds the row, with its argument unchanged', async () => {
    await runAt(2, [lens(span(0, 0, 10)), lens(span(1, 2, 7))]);
    expect(message('textDocument/codeLens')?.params).toEqual({
      textDocument: {uri: uri()}
    });
    expect(message('workspace/executeCommand')?.params).toEqual({
      command: 'dynotable.runStatement',
      arguments: [
        {uri: uri(), range: {start: {line: 1, character: 0}, end: {line: 2, character: 7}}}
      ]
    });
    expect(h.codes).toEqual([0]);
  });

  it('picks the first of two statements on one row', async () => {
    await runAt(0, [lens(span(0, 0, 10)), lens(span(0, 0, 25))]);
    expect(message('workspace/executeCommand')?.params).toEqual({
      command: 'dynotable.runStatement',
      arguments: [
        {uri: uri(), range: {start: {line: 0, character: 0}, end: {line: 0, character: 10}}}
      ]
    });
  });

  // A failed codeLens is that failure, never "no statement", and nothing runs.
  it('prints the detail of a codeLens error and runs nothing', async () => {
    await runWith(0, () => {
      throw new RpcFailure({
        code: REQUEST_FAILED,
        message: 'The parser stopped.',
        data: {code: 'run-failed'}
      });
    });
    expect(h.stderr).toBe('The parser stopped.\n');
    expect(h.codes).toEqual([1]);
    expect(message('workspace/executeCommand')).toBeUndefined();
  });

  // The selection-style end at character 0 of the next line does not cover that line.
  it('a row on the end line at character 0 is not in the statement', async () => {
    await runAt(1, [lens(span(0, 1, 0))]);
    expect(h.stderr).toBe(NO_STATEMENT(2));
    expect(message('workspace/executeCommand')).toBeUndefined();
  });

  it('a row between statements fails with the line sentence', async () => {
    await runAt(1, [lens(span(0, 0, 10)), lens(span(2, 2, 10))]);
    expect(h.stderr).toBe(NO_STATEMENT(2));
    expect(h.codes).toEqual([1]);
    expect(message('workspace/executeCommand')).toBeUndefined();
  });

  it('a null codeLens answer fails with the line sentence', async () => {
    await runAt(0, null);
    expect(h.stderr).toBe(NO_STATEMENT(1));
    expect(h.codes).toEqual([1]);
  });

  // With no range, the app runs the whole document: run --zed must never do that.
  it('a Run lens whose argument has no range is not run', async () => {
    const whole = lens(span(0, 0, 10));
    await runAt(0, [{...whole, command: {...whole.command, arguments: [{uri: uri()}]}}]);
    expect(h.stderr).toBe(NO_STATEMENT(1));
    expect(message('workspace/executeCommand')).toBeUndefined();
  });

  it('an Open in DynoTable lens is not run', async () => {
    await runAt(0, [lens(span(0, 0, 10), 'dynotable.openInApp')]);
    expect(h.stderr).toBe(NO_STATEMENT(1));
    expect(message('workspace/executeCommand')).toBeUndefined();
  });
});

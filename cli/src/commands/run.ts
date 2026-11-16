import {readFile, realpath} from 'node:fs/promises';
import type {Readable} from 'node:stream';
import {text} from 'node:stream/consumers';
import {codeLensListSchema, nullable, runResultSchema, type CodeLens} from '../../../src/protocol';
import type {Input} from '../args';
import {locate, type Place, type TextDocument} from '../document';
import type {Failure, Result} from '../output';
import type {Connection} from '../session';

/**
 * A file's text, read only when the file it resolves to has a dedicated name too: a link such as
 * `q.partiql -> ~/.aws/credentials` must not pass the name check.
 */
async function fileText(file: string, place: Place): Promise<string> {
  const target = await realpath(place.path.resolve(place.cwd, file));
  const located = locate({kind: 'file', path: target}, place);
  if ('message' in located) throw new Error(`${file} links to another file. ${located.message}`);
  return readFile(target, 'utf8');
}

async function textOf(input: Input, place: Place, stdin: Readable): Promise<string> {
  switch (input.kind) {
    case 'file':
      return fileText(input.path, place);
    case 'stdin':
      return text(stdin);
    case 'text':
      return input.text;
  }
}

/** Reads `run`'s input before any connection, so a bad input never starts the app. */
export async function readDocument(
  input: Input,
  place: Place,
  stdin: Readable
): Promise<{document: TextDocument} | {failure: Failure}> {
  const located = locate(input, place);
  if ('message' in located) return {failure: {code: 'usage', detail: located.message}};
  try {
    return {document: {...located, text: await textOf(input, place, stdin)}};
  } catch (error) {
    return {failure: {code: 'usage', detail: (error as Error).message}};
  }
}

/** Opens the document and runs all of it as one statement. */
export function run(
  document: TextDocument,
  rowCap: number | undefined
): (connection: Connection) => Promise<Result> {
  return async (connection) => {
    connection.notify('textDocument/didOpen', {textDocument: {...document, version: 1}});
    return connection.request(
      'workspace/executeCommand',
      {
        command: 'dynotable.runStatement',
        arguments: [{uri: document.uri, ...(rowCap === undefined ? {} : {rowCap})}]
      },
      runResultSchema
    );
  };
}

const RUN = 'dynotable.runStatement';

/**
 * The first Run lens whose statement holds `row` (0-based). The statement range is in the lens's
 * argument; the lens's own range is only an anchor. An end at character 0 of a later line does not
 * hold that line.
 */
function runLensAt(lenses: CodeLens[], row: number): CodeLens | undefined {
  return lenses.find((lens) => {
    const statement = lens.command.arguments[0].range;
    if (lens.command.command !== RUN || !statement) return false;
    const {start, end} = statement;
    const last = end.character === 0 && end.line > start.line ? end.line - 1 : end.line;
    return start.line <= row && row <= last;
  });
}

/** Opens the document and runs the one statement at `row` (0-based), never the whole document. */
export function runAtRow(
  document: TextDocument,
  row: number
): (connection: Connection) => Promise<Result> {
  return async (connection) => {
    connection.notify('textDocument/didOpen', {textDocument: {...document, version: 1}});
    const lenses = await connection.request(
      'textDocument/codeLens',
      {textDocument: {uri: document.uri}},
      nullable(codeLensListSchema)
    );
    if ('failure' in lenses) return lenses;
    const lens = runLensAt(lenses.value ?? [], row);
    if (!lens) {
      return {
        failure: {
          code: 'run-failed',
          detail: `No statement on line ${row + 1}. A file with a syntax error has no runnable statements.`
        }
      };
    }
    return connection.request(
      'workspace/executeCommand',
      {command: RUN, arguments: lens.command.arguments},
      runResultSchema
    );
  };
}

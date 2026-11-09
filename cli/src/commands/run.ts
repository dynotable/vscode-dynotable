import {readFile} from 'node:fs/promises';
import type {Readable} from 'node:stream';
import {text} from 'node:stream/consumers';
import {runResultSchema} from '../../../src/protocol';
import type {Input, Lang} from '../args';
import {locate, type Place, type TextDocument} from '../document';
import type {Failure, Result} from '../output';
import type {Connection} from '../session';

export interface RunInput {
  input: Input;
  lang?: Lang;
}

async function textOf(input: Input, place: Place, stdin: Readable): Promise<string> {
  switch (input.kind) {
    case 'file':
      return readFile(place.path.resolve(place.cwd, input.path), 'utf8');
    case 'stdin':
      return text(stdin);
    case 'text':
      return input.text;
  }
}

/** Reads `run`'s input before any connection, so a bad input never starts the app. */
export async function readDocument(
  {input, lang}: RunInput,
  place: Place,
  stdin: Readable
): Promise<{document: TextDocument} | {failure: Failure}> {
  const located = locate(input, lang, place);
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
    const answer = await connection.request(
      'workspace/executeCommand',
      {
        command: 'dynotable.runStatement',
        arguments: [{uri: document.uri, ...(rowCap === undefined ? {} : {rowCap})}]
      },
      runResultSchema
    );
    return answer.ok ? {value: answer.value} : {failure: answer.failure};
  };
}

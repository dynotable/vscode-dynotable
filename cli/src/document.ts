import type nodePath from 'node:path';
import {pathToFileURL} from 'node:url';
import type {Input, Lang} from './args';

/** The document `run` opens. */
export interface TextDocument {
  uri: string;
  languageId: Lang;
  text: string;
}

/** `node:path`, or its `posix` or `win32` flavour. */
export type PathFlavour = typeof nodePath.posix;

/** Where a relative file path resolves. */
export interface Place {
  cwd: string;
  path: PathFlavour;
}

/** A plain `.sql` file is not DynoTable's, so it has no entry. */
const SUFFIXES: ReadonlyArray<readonly [string, Lang]> = [
  ['.dtsql', 'sql'],
  ['.dynotable.sql', 'sql'],
  ['.partiql', 'partiql'],
  ['.opensearch', 'opensearch']
];

const UNTITLED_EXTENSIONS: Record<Lang, string> = {
  sql: 'dtsql',
  partiql: 'partiql',
  opensearch: 'opensearch'
};

function languageOfFile(file: string, path: PathFlavour): Lang | undefined {
  const name = path.basename(file).toLowerCase();
  return SUFFIXES.find(([suffix]) => name.endsWith(suffix))?.[1];
}

function fileUri(file: string, {cwd, path}: Place): string {
  return pathToFileURL(path.resolve(cwd, file), {windows: path.sep === '\\'}).href;
}

/** The URI and language of an input, or why it has none. */
export function locate(
  input: Input,
  lang: Lang | undefined,
  place: Place
): {uri: string; languageId: Lang} | {message: string} {
  if (input.kind === 'file') {
    const languageId = languageOfFile(input.path, place.path);
    if (!languageId) {
      return {
        message: `${input.path}: the name must end in ${SUFFIXES.map(([suffix]) => suffix).join(', ')}.`
      };
    }
    return {uri: fileUri(input.path, place), languageId};
  }
  if (!lang) return {message: '--lang is required with stdin and -e.'};
  // One document per process, so one name is enough.
  return {uri: `untitled:dynotable-cli/1.${UNTITLED_EXTENSIONS[lang]}`, languageId: lang};
}

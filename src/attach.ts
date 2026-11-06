import {posix, win32} from 'node:path';
import type {Platform} from './discovery';

export interface AttachInput {
  platform: Platform;
  /** The workspace folder that holds the file; `undefined` when none does. */
  folder: string | undefined;
  file: string;
  /** The folder's current `dynotable.sqlFiles`. */
  sqlFiles: string[];
}

/** `undefined` when no workspace folder holds the file. */
export type AttachResult = {sqlFiles: string[]} | undefined;

/**
 * VS Code's glob has no backslash escape. A one-character class matches the character literally;
 * a `]` is literal only as the first character of a class. VS Code trims a pattern, so leading and
 * trailing whitespace goes into classes too.
 */
const escapeGlob = (path: string) =>
  path
    .replace(/[[\]{}*?]/g, (char) => `[${char}]`)
    .replace(/^\s+|\s+$/g, (space) => [...space].map((char) => `[${char}]`).join(''));

/** Appends the file's folder-relative path, as a literal glob, to the folder's `sqlFiles`. */
export function attach(input: AttachInput): AttachResult {
  if (input.folder === undefined) return undefined;
  const path = input.platform === 'win32' ? win32 : posix;
  const relative = path.relative(input.folder, input.file).split(path.sep).join('/');
  return {sqlFiles: [...input.sqlFiles, escapeGlob(relative)]};
}

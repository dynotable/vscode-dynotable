import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isObject} from '../../src/protocol';

const DOTFILE = '.dynotable.json';

export type Dotfile =
  | {kind: 'none'}
  | {kind: 'profile'; profile: string}
  | {kind: 'error'; message: string};

/** Reads the `profile` key of `<dir>/.dynotable.json`. Other keys are ignored. */
export function readDotfile(dir: string): Dotfile {
  const path = join(dir, DOTFILE);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {kind: 'none'};
    return {kind: 'error', message: `${path} cannot be read.`};
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {kind: 'error', message: `${path} is not valid JSON.`};
  }
  if (!isObject(value)) return {kind: 'error', message: `${path} must hold a JSON object.`};
  const {profile} = value;
  if (profile === undefined) return {kind: 'none'};
  if (typeof profile !== 'string') {
    return {kind: 'error', message: `"profile" in ${path} must be a string.`};
  }
  return {kind: 'profile', profile};
}

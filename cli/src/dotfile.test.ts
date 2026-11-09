import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, expect, it} from 'vitest';
import {readDotfile} from './dotfile';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cli-dotfile-'));
});
afterEach(() => rmSync(dir, {recursive: true, force: true}));

const write = (text: string) => writeFileSync(join(dir, '.dynotable.json'), text);

it('a missing file gives no profile', () => {
  expect(readDotfile(dir)).toEqual({kind: 'none'});
});

// A broken file must not fall back to the default profile without a word.
it('a malformed file is an error', () => {
  write('{"profile": ');
  expect(readDotfile(dir).kind).toBe('error');
});

it('a profile that is not a string is an error', () => {
  write('{"profile": 3}');
  expect(readDotfile(dir).kind).toBe('error');
});

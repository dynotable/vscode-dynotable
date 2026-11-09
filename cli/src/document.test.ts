import path from 'node:path';
import {describe, expect, it} from 'vitest';
import type {Lang} from './args';
import {locate} from './document';

const posix = {cwd: '/work', path: path.posix};

describe('locate', () => {
  const files: Array<[string, Lang]> = [
    ['q.dtsql', 'sql'],
    ['q.dynotable.sql', 'sql'],
    ['q.partiql', 'partiql'],
    ['q.opensearch', 'opensearch']
  ];
  it.each(files)('%s is %s', (file, languageId) => {
    expect(locate({kind: 'file', path: file}, undefined, posix)).toEqual({
      uri: `file:///work/${file}`,
      languageId
    });
  });

  it('matches the name without regard to case', () => {
    expect(locate({kind: 'file', path: 'Q.DTSQL'}, undefined, posix)).toMatchObject({
      languageId: 'sql'
    });
  });

  // A plain .sql file belongs to other SQL tools.
  it('refuses a plain .sql file', () => {
    expect(locate({kind: 'file', path: 'q.sql'}, undefined, posix)).toHaveProperty('message');
  });

  it('gives a Windows drive path a file:///C:/ URI', () => {
    const place = {cwd: 'C:\\work', path: path.win32};
    expect(locate({kind: 'file', path: 'sub dir\\q.dtsql'}, undefined, place)).toEqual({
      uri: 'file:///C:/work/sub%20dir/q.dtsql',
      languageId: 'sql'
    });
  });
});

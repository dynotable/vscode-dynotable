import {describe, expect, it} from 'vitest';
import {attach, type AttachInput} from './attach';

const base: AttachInput = {
  platform: 'linux',
  folder: '/w',
  file: '/w/q.sql',
  sqlFiles: ['**/*.dynotable.sql']
};

describe('attach', () => {
  // A backslash in a VS Code glob is not a separator, so the pattern would never match.
  it('turns Windows backslashes into /', () => {
    const result = attach({...base, platform: 'win32', folder: 'C:\\w', file: 'C:\\w\\db\\q.sql'});
    expect(result).toEqual({sqlFiles: ['**/*.dynotable.sql', 'db/q.sql']});
  });

  // Unescaped, `[prod]` is a character class and `{a}` a brace group: neither matches the file.
  it.each([
    ['[prod].sql', '[[]prod[]].sql'],
    ['{a}.sql', '[{]a[}].sql'],
    ['a*?.sql', 'a[*][?].sql'],
    // Trimmed, ` report.sql ` would attach `report.sql` instead.
    [' report.sql ', '[ ]report.sql[ ]']
  ])('escapes %s', (name, pattern) => {
    expect(attach({...base, file: `/w/${name}`})).toEqual({
      sqlFiles: ['**/*.dynotable.sql', pattern]
    });
  });

  it('refuses with no folder open', () => {
    expect(attach({...base, folder: undefined})).toBeUndefined();
  });
});

import {describe, expect, it} from 'vitest';
import {parse} from './args';

const cli = (...args: string[]) => parse('dynotable-cli', args);

describe('subcommands', () => {
  it.each([
    [
      ['lsp', '--profile', 'dev', '--no-launch'],
      {command: 'lsp', agent: true, launch: false, profile: 'dev'}
    ],
    [['profiles', '--no-launch'], {command: 'profiles', agent: true, launch: false}],
    [['tables', '--profile=dev'], {command: 'tables', agent: true, launch: true, profile: 'dev'}],
    [
      ['indices', '--profile', 'dev'],
      {command: 'indices', agent: true, launch: true, profile: 'dev'}
    ],
    [
      ['run', 'q.dtsql', '--row-cap', '50', '--profile', 'dev'],
      {
        command: 'run',
        agent: true,
        launch: true,
        profile: 'dev',
        rowCap: 50,
        input: {kind: 'file', path: 'q.dtsql'}
      }
    ],
    [
      ['run', '-e', 'SELECT * FROM orders', '--lang', 'sql'],
      {
        command: 'run',
        agent: true,
        launch: true,
        input: {kind: 'text', text: 'SELECT * FROM orders', lang: 'sql'}
      }
    ],
    [
      ['run', '-', '--lang', 'partiql'],
      {command: 'run', agent: true, launch: true, input: {kind: 'stdin', lang: 'partiql'}}
    ]
  ])('%j', (args, expected) => {
    expect(cli(...args)).toEqual({kind: 'command', ...expected});
  });

  it.each([['--help'], ['run', '--help']])('%j shows the help', (...args) => {
    expect(cli(...args)).toEqual({kind: 'help'});
  });

  it('--version shows the version', () => {
    expect(cli('--version')).toEqual({kind: 'version'});
  });
});

describe('usage errors', () => {
  it.each([
    ['no subcommand', []],
    ['an unknown subcommand', ['query']],
    ['an unknown flag', ['tables', '--region', 'eu-west-1']],
    ['a flag the subcommand does not take', ['profiles', '--profile', 'dev']],
    ['an argument to a listing', ['tables', 'orders']],
    ['--lang outside the three ids', ['run', '-', '--lang', 'mysql']],
    ['stdin without --lang', ['run', '-']],
    ['-e without --lang', ['run', '-e', 'SELECT 1']],
    // A file's extension names its language, so --lang there is a mistake.
    ['--lang with a file', ['run', 'q.dtsql', '--lang', 'sql']],
    ['-e with a file', ['run', 'q.dtsql', '-e', 'SELECT 1', '--lang', 'sql']],
    ['two inputs', ['run', 'a.dtsql', 'b.dtsql']],
    ['a row cap that is not a positive integer', ['run', 'q.dtsql', '--row-cap', '0']]
  ])('%s', (_name, args) => {
    expect(cli(...args)).toMatchObject({kind: 'usage', message: expect.any(String)});
  });
});

describe('argv0', () => {
  it.each(['/usr/local/bin/dynotable-lsp', 'C:\\Tools\\DynoTable-LSP.exe'])(
    '%s is the editor bridge: no purpose',
    (argv0) => {
      expect(parse(argv0, ['--profile', 'dev'])).toEqual({
        kind: 'command',
        command: 'lsp',
        agent: false,
        launch: true,
        profile: 'dev'
      });
    }
  );

  // Else an agent allowed only `dynotable-lsp` could reach the one-shot commands, or the reverse.
  it.each([['lsp'], ['run', '-e', 'SELECT 1', '--lang', 'sql'], ['profiles']])(
    'dynotable-lsp refuses the subcommand %s',
    (...args) => {
      expect(parse('dynotable-lsp', args)).toMatchObject({kind: 'usage'});
    }
  );

  it('dynotable-lsp refuses a one-shot flag', () => {
    expect(parse('dynotable-lsp', ['--row-cap', '5'])).toMatchObject({kind: 'usage'});
  });
});

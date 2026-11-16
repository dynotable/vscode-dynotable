import {describe, expect, it} from 'vitest';
import {parse} from './args';

const cli = (...args: string[]) => parse('dynotable-cli', args, {});
const zedEnv = {ZED_FILE: "/w/it's a file.dtsql", ZED_ROW: '3'};

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
      expect(parse(argv0, ['--profile', 'dev'], {})).toEqual({
        kind: 'command',
        command: 'lsp',
        agent: false,
        launch: true,
        profile: 'dev'
      });
    }
  );

  // `dynotable-lsp` gives only editor sessions: the bridge and the Zed task's `run --zed`. Else
  // an agent allowed only `dynotable-lsp` could reach the agent commands, or the reverse.
  it.each([['lsp'], ['run', '-e', 'SELECT 1', '--lang', 'sql'], ['profiles']])(
    'dynotable-lsp refuses the subcommand %s',
    (...args) => {
      expect(parse('dynotable-lsp', args, zedEnv)).toMatchObject({kind: 'usage'});
    }
  );

  it('dynotable-lsp refuses a one-shot flag', () => {
    expect(parse('dynotable-lsp', ['--row-cap', '5'], {})).toMatchObject({kind: 'usage'});
  });
});

describe('dynotable-lsp run --zed', () => {
  // Zed does not escape the file name in a task command, so it comes only from the environment.
  it('reads the file and the 1-based ZED_ROW from the environment', () => {
    expect(parse('dynotable-lsp', ['run', '--zed'], zedEnv)).toEqual({
      kind: 'command',
      command: 'zed-run',
      agent: false,
      launch: true,
      file: "/w/it's a file.dtsql",
      row: 2,
      line: 3
    });
  });

  it.each([
    ['ZED_FILE empty', {...zedEnv, ZED_FILE: ''}],
    ['ZED_ROW unset', {ZED_FILE: zedEnv.ZED_FILE}],
    ['ZED_ROW 0', {...zedEnv, ZED_ROW: '0'}],
    ['ZED_ROW not a whole number', {...zedEnv, ZED_ROW: '3abc'}]
  ])('%s is a usage error', (_name, env) => {
    expect(parse('dynotable-lsp', ['run', '--zed'], env)).toMatchObject({kind: 'usage'});
  });

  // It never runs a file given on the command line or another profile than the project's.
  it.each([
    ['a file', ['run', '--zed', 'q.dtsql']],
    ['a flag', ['run', '--zed', '--profile', 'x']],
    ['--zed without run', ['--zed']],
    ['run without --zed', ['run', 'q.dtsql']]
  ])('dynotable-lsp refuses %s', (_name, args) => {
    expect(parse('dynotable-lsp', args, zedEnv)).toMatchObject({kind: 'usage'});
  });

  it('dynotable-cli refuses run --zed', () => {
    expect(parse('dynotable-cli', ['run', '--zed'], zedEnv)).toMatchObject({kind: 'usage'});
  });
});

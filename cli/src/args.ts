import {parseArgs} from 'node:util';

export const SUBCOMMANDS = ['lsp', 'profiles', 'tables', 'indices', 'run'] as const;
export type Subcommand = (typeof SUBCOMMANDS)[number];

export const LANGS = ['sql', 'partiql', 'opensearch'] as const;
export type Lang = (typeof LANGS)[number];

/** The name under which the binary is the editor bridge. Under any other name it is agent-only. */
export const EDITOR_BRIDGE_NAME = 'dynotable-lsp';

/** Where `run` reads its statement. */
export type Input = {kind: 'file'; path: string} | {kind: 'stdin'} | {kind: 'text'; text: string};

export interface Command {
  kind: 'command';
  command: Subcommand;
  /** False only for the editor bridge: the session sends no `purpose`. */
  agent: boolean;
  /** False under `--no-launch`. */
  launch: boolean;
  profile?: string;
  rowCap?: number;
  lang?: Lang;
  /** `run` only. */
  input?: Input;
}

export type Invocation =
  | Command
  | {kind: 'help'}
  | {kind: 'version'}
  | {kind: 'usage'; message: string};

const OPTIONS = {
  profile: {type: 'string'},
  'row-cap': {type: 'string'},
  lang: {type: 'string'},
  expression: {type: 'string', short: 'e'},
  'no-launch': {type: 'boolean'},
  help: {type: 'boolean'},
  version: {type: 'boolean'}
} as const;

type Option = keyof typeof OPTIONS;

const ALLOWED: Record<Subcommand, readonly Option[]> = {
  lsp: ['profile', 'no-launch'],
  profiles: ['no-launch'],
  tables: ['profile', 'no-launch'],
  indices: ['profile', 'no-launch'],
  run: ['profile', 'row-cap', 'lang', 'expression', 'no-launch']
};

const FLAG_NAMES: Record<Option, string> = {
  profile: '--profile',
  'row-cap': '--row-cap',
  lang: '--lang',
  expression: '-e',
  'no-launch': '--no-launch',
  help: '--help',
  version: '--version'
};

const usage = (message: string): Invocation => ({kind: 'usage', message});

/** The program name without its directory and a Windows `.exe`. */
function programName(argv0: string): string {
  const base = argv0.split(/[\\/]/).pop() ?? '';
  return base.replace(/\.exe$/i, '').toLowerCase();
}

/**
 * Parses the command line. `argv0` is the name the binary was started under; `args` are the
 * arguments after it.
 */
export function parse(argv0: string, args: readonly string[]): Invocation {
  let parsed;
  try {
    parsed = parseArgs({args: [...args], options: OPTIONS, allowPositionals: true, strict: true});
  } catch (error) {
    return usage((error as Error).message);
  }
  const {values, positionals} = parsed;
  if (values.help) return {kind: 'help'};
  if (values.version) return {kind: 'version'};
  const given = (Object.keys(values) as Option[]).filter((name) => values[name] !== undefined);

  if (programName(argv0) === EDITOR_BRIDGE_NAME) {
    if (positionals.length > 0) {
      return usage(`${EDITOR_BRIDGE_NAME} takes no subcommand; it only bridges an editor.`);
    }
    const refused = given.find((name) => !ALLOWED.lsp.includes(name));
    if (refused) return usage(`${EDITOR_BRIDGE_NAME} does not take ${FLAG_NAMES[refused]}.`);
    return {kind: 'command', command: 'lsp', agent: false, ...common(values)};
  }

  const [command, ...rest] = positionals;
  if (command === undefined) return usage('Give a subcommand: ' + SUBCOMMANDS.join(', ') + '.');
  if (!(SUBCOMMANDS as readonly string[]).includes(command)) {
    return usage(`Unknown subcommand "${command}".`);
  }
  const subcommand = command as Subcommand;
  const refused = given.find((name) => !ALLOWED[subcommand].includes(name));
  if (refused) return usage(`${subcommand} does not take ${FLAG_NAMES[refused]}.`);
  const result: Command = {kind: 'command', command: subcommand, agent: true, ...common(values)};
  if (subcommand !== 'run') {
    return rest.length > 0 ? usage(`${subcommand} takes no arguments.`) : result;
  }

  if (values['row-cap'] !== undefined) {
    if (!/^[1-9]\d*$/.test(values['row-cap']))
      return usage('--row-cap must be a positive integer.');
    result.rowCap = Number(values['row-cap']);
  }
  if (values.lang !== undefined) {
    if (!(LANGS as readonly string[]).includes(values.lang)) {
      return usage(`--lang must be one of ${LANGS.join(', ')}.`);
    }
    result.lang = values.lang as Lang;
  }
  if (values.expression !== undefined) {
    if (rest.length > 0) return usage('Give -e or an input, not both.');
    result.input = {kind: 'text', text: values.expression};
  } else if (rest.length !== 1) {
    return usage('run takes one input: a file, - for stdin, or -e <statement>.');
  } else {
    result.input = rest[0] === '-' ? {kind: 'stdin'} : {kind: 'file', path: rest[0] as string};
  }
  // A file's extension names its language. Stdin and -e have none.
  if (result.input.kind === 'file' && result.lang) {
    return usage('--lang applies only to stdin and -e. A file takes its language from its name.');
  }
  if (result.input.kind !== 'file' && !result.lang) {
    return usage(`--lang is required with stdin and -e: ${LANGS.join(', ')}.`);
  }
  return result;
}

function common(values: {profile?: string; 'no-launch'?: boolean}) {
  return {
    launch: !values['no-launch'],
    ...(values.profile === undefined ? {} : {profile: values.profile})
  };
}

export const HELP = `Usage: dynotable-cli <subcommand> [options]

Reads DynamoDB and OpenSearch through the DynoTable app. Output is JSON.

Subcommands:
  profiles                     List the profiles available to agents.
  tables                       List the tables of the profile.
  indices                      List the OpenSearch indices of the profile.
  run <file> | - | -e <text>   Run one statement. A file must end in .dtsql, .dynotable.sql,
                               .partiql or .opensearch. Stdin (-) and -e need --lang.
  lsp                          Bridge an editor's Language Server stdio to the app.

Options:
  --profile <id or slug>       The profile. Else .dynotable.json in the current directory.
  --row-cap <n>                run: the most rows to return.
  --lang <sql|partiql|opensearch>
                               run: the language of stdin or -e.
  --no-launch                  Do not start DynoTable when it is not running.
  --help                       Show this text.
  --version                    Show the version.
`;

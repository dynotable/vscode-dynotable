import {visible} from './display';
import {EXIT, type Sink} from './io';
import {messageOf, type ErrorCode} from './messages';

export interface Failure {
  code: ErrorCode;
  /** The app's or the parser's own text, when there is one. */
  detail?: string;
}

/** What a command ends with: a document for stdout, a failure for stderr, or both. */
export interface Result {
  value?: unknown;
  failure?: Failure;
}

const exitOf = (code: ErrorCode) =>
  code === 'usage' ? EXIT.usage : code === 'interrupted' ? EXIT.interrupted : EXIT.failure;

/** The stderr line of a failure. */
export function failureLine({code, detail}: Failure): string {
  return `${JSON.stringify({code, message: messageOf(code), ...(detail ? {detail} : {})})}\n`;
}

/** How a command's result reaches stdout and stderr. Writes, then sets the exit code. */
export type Printer = (io: Sink, result: Result) => void;

/** Writes, then sets the exit code. */
export function emit(io: Sink, {value, failure}: Result): void {
  if (value !== undefined) io.out(`${JSON.stringify(value)}\n`);
  if (!failure) {
    io.exit(EXIT.ok);
    return;
  }
  io.err(failureLine(failure));
  io.exit(exitOf(failure.code));
}

/**
 * `run --zed`'s own sentences. They win over the app's `detail`, whose advice names settings and
 * flags that this command does not have.
 */
const REPLACED: Partial<Record<ErrorCode, string>> = {
  'profile-required':
    'No profile is chosen. Name one profile in .dynotable.json in the project folder.',
  'launcher-off': 'DynoTable is not running. Start DynoTable.'
};

const textOf = ({code, detail}: Failure): string => REPLACED[code] ?? detail ?? messageOf(code);

/** A failure of `dynotable-lsp` in plain text: a person reads it in a terminal, not a program. */
export function printText(io: Sink, failure: Failure): void {
  io.err(`${visible(textOf(failure))}\n`);
  io.exit(exitOf(failure.code));
}

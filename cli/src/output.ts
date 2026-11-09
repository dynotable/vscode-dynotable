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

/** Writes, then sets the exit code. */
export function emit(io: Sink, {value, failure}: Result): void {
  if (value !== undefined) io.out(`${JSON.stringify(value)}\n`);
  if (!failure) {
    io.exit(EXIT.ok);
    return;
  }
  const {code, detail} = failure;
  io.err(`${JSON.stringify({code, message: messageOf(code), ...(detail ? {detail} : {})})}\n`);
  io.exit(exitOf(code));
}

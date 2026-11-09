import type {Readable} from 'node:stream';

/** What `main.ts` binds to the real process. Commands never touch `process`. */
export interface Streams {
  stdin: Readable;
  stdout: {write(chunk: string | Uint8Array): unknown};
  stderr: {write(chunk: string | Uint8Array): unknown};
  setExitCode(code: number): void;
}

export const EXIT = {ok: 0, failure: 1, usage: 2, interrupted: 130} as const;

/**
 * A command's only way out. The first exit code wins: after it, writes and later exit codes are
 * dropped, so a SIGINT stops the output of a command that finishes after it. Write, then exit.
 */
export interface Sink {
  readonly stdin: Readable;
  out(chunk: string | Uint8Array): void;
  err(chunk: string): void;
  exit(code: number): void;
  readonly finished: boolean;
}

export function sink(streams: Streams): Sink {
  let finished = false;
  return {
    stdin: streams.stdin,
    out: (chunk) => {
      if (!finished) streams.stdout.write(chunk);
    },
    err: (chunk) => {
      if (!finished) streams.stderr.write(chunk);
    },
    exit: (code) => {
      if (finished) return;
      finished = true;
      streams.setExitCode(code);
    },
    get finished() {
      return finished;
    }
  };
}

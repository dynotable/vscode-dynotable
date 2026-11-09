import {PassThrough} from 'node:stream';
import {expect, it} from 'vitest';
import {EXIT, sink} from './io';

// A command that answers after Ctrl-C must not print its result or replace the 130.
it('after interrupted, later exit codes and writes are dropped', () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const codes: number[] = [];
  const io = sink({
    stdin: new PassThrough(),
    stdout: {write: (chunk) => stdout.push(String(chunk))},
    stderr: {write: (chunk) => stderr.push(String(chunk))},
    setExitCode: (code) => codes.push(code)
  });
  io.out('partial ');
  io.exit(EXIT.interrupted);
  io.out('{"rows":[]}');
  io.err('late');
  io.exit(EXIT.ok);
  expect(stdout).toEqual(['partial ']);
  expect(stderr).toEqual([]);
  expect(codes).toEqual([130]);
});

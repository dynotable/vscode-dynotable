import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {constants} from 'node:os';
import {resolveBinary} from './resolve-platform.mjs';

/** @type {readonly NodeJS.Signals[]} */
const FORWARDED = ['SIGINT', 'SIGTERM'];

/**
 * Runs `binary` under the name `argv0`, with this process's stdio. This process ends as the child
 * ends: with its exit code, or by its signal.
 *
 * @param {string} binary
 * @param {string} argv0
 * @param {readonly string[]} args
 */
export function launch(binary, argv0, args) {
  const child = spawn(binary, args, {stdio: 'inherit', argv0});
  /** @param {NodeJS.Signals} signal */
  const forward = (signal) => {
    child.kill(signal);
  };
  const release = () => {
    for (const signal of FORWARDED) process.off(signal, forward);
  };
  for (const signal of FORWARDED) process.on(signal, forward);
  child.on('error', (error) => {
    release();
    process.stderr.write(`dynotable-cli: cannot start ${binary}: ${error.message}\n`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    release();
    if (signal === null) {
      process.exitCode = code ?? 1;
      return;
    }
    // The shell convention, for a signal that does not end this process.
    process.exitCode = 128 + (constants.signals[signal] ?? 0);
    process.kill(process.pid, signal);
  });
}

/**
 * A bin's body: the binary of this platform under the name `argv0`.
 *
 * @param {string} argv0
 */
export function main(argv0) {
  let binary;
  try {
    binary = resolveBinary(process.platform, process.arch, createRequire(import.meta.url).resolve);
  } catch (error) {
    process.stderr.write(`${/** @type {Error} */ (error).message}\n`);
    process.exitCode = 1;
    return;
  }
  launch(binary, argv0, process.argv.slice(2));
}

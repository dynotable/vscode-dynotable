import {HELP, parse} from './args';
import {EXIT, sink} from './io';

/** Stamped by the build. */
declare const DYNOTABLE_CLI_VERSION: string | undefined;
const VERSION = typeof DYNOTABLE_CLI_VERSION === 'string' ? DYNOTABLE_CLI_VERSION : '0.0.0-dev';

const io = sink({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  setExitCode: (code) => {
    process.exitCode = code;
  }
});

const invocation = parse(process.argv0, process.argv.slice(2));
switch (invocation.kind) {
  case 'help':
    io.out(HELP);
    io.exit(EXIT.ok);
    break;
  case 'version':
    io.out(`${VERSION}\n`);
    io.exit(EXIT.ok);
    break;
  case 'usage':
    io.err(`${JSON.stringify({code: 'usage', message: invocation.message})}\n`);
    io.exit(EXIT.usage);
    break;
  case 'command':
    io.err(
      `${JSON.stringify({code: 'usage', message: `${invocation.command} is not in this build.`})}\n`
    );
    io.exit(EXIT.usage);
    break;
}

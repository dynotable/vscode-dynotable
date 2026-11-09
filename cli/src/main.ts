import {HELP, parse} from './args';
import {EXIT, sink} from './io';
import {emit} from './output';
import {CLI_VERSION} from './version';

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
    io.out(`${CLI_VERSION}\n`);
    io.exit(EXIT.ok);
    break;
  case 'usage':
    emit(io, {failure: {code: 'usage', detail: invocation.message}});
    break;
  case 'command':
    emit(io, {failure: {code: 'usage', detail: `${invocation.command} is not in this build.`}});
    break;
}

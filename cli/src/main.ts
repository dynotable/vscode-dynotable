import {homedir} from 'node:os';
import {HELP, parse} from './args';
import {list} from './commands/listing';
import {EXIT, sink} from './io';
import {emit} from './output';
import {createSession} from './session';
import {CLI_VERSION, minAppVersion} from './version';

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
  case 'command': {
    const {command} = invocation;
    if (command === 'profiles' || command === 'tables' || command === 'indices') {
      const session = createSession({
        minAppVersion,
        env: process.env,
        home: homedir(),
        io,
        launch: invocation.launch,
        cwd: process.cwd(),
        ...(invocation.profile === undefined ? {} : {profile: invocation.profile})
      });
      void session.run(list(command));
    } else {
      emit(io, {
        failure: {code: 'usage', detail: `${command} is not in this build.`}
      });
    }
    break;
  }
}

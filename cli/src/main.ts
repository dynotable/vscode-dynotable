import {homedir} from 'node:os';
import path from 'node:path';
import {HELP, parse, type Command} from './args';
import {list} from './commands/listing';
import {readDocument, run, type RunInput} from './commands/run';
import {EXIT, sink} from './io';
import {emit} from './output';
import {createSession, type CliSession} from './session';
import {CLI_VERSION, minAppVersion} from './version';

const io = sink({
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
  setExitCode: (code) => {
    process.exitCode = code;
  }
});

let session: CliSession | undefined;
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) return;
  interrupted = true;
  emit(io, {failure: {code: 'interrupted'}});
  // A stdin read in progress must not hold the process open.
  io.stdin.destroy();
  void session?.stop();
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
    void start(invocation);
    break;
}

async function start(given: Command): Promise<void> {
  const work = await workOf(given);
  // A bad input, or a SIGINT during the stdin read, ended the command.
  if (!work || io.finished) return;
  session = createSession({
    minAppVersion,
    env: process.env,
    home: homedir(),
    io,
    launch: given.launch,
    cwd: process.cwd(),
    ...(given.profile === undefined ? {} : {profile: given.profile})
  });
  await session.run(work);
}

async function workOf(given: Command) {
  switch (given.command) {
    case 'profiles':
    case 'tables':
    case 'indices':
      return list(given.command);
    case 'run': {
      // parse() gives every run an input.
      const read = await readDocument(given as RunInput, {cwd: process.cwd(), path}, io.stdin);
      if ('document' in read) return run(read.document, given.rowCap);
      emit(io, read);
      return undefined;
    }
    case 'lsp':
      emit(io, {failure: {code: 'usage', detail: `${given.command} is not in this build.`}});
      return undefined;
  }
}

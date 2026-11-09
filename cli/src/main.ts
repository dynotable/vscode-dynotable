import {homedir} from 'node:os';
import path from 'node:path';
import {HELP, parse, type Command} from './args';
import {createBridge} from './commands/lsp-bridge';
import {list} from './commands/listing';
import {readDocument, run} from './commands/run';
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

let session: Pick<CliSession, 'stop'> | undefined;
let interrupted = false;
process.on('SIGINT', () => {
  if (interrupted) return;
  interrupted = true;
  emit(io, {failure: {code: 'interrupted'}});
  // A stdin read in progress must not hold the process open.
  io.stdin.destroy();
  void session?.stop();
});
// The editor or the reader of the output is gone: end as when stdin closes.
process.stdout.on('error', () => io.stdin.destroy());

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
    // A bug must still end in the stderr contract, not in a stack trace.
    start(invocation).catch((error: unknown) =>
      emit(io, {failure: {code: 'run-failed', detail: (error as Error).message}})
    );
    break;
}

async function start(given: Command): Promise<void> {
  const common = {
    minAppVersion,
    env: process.env,
    home: homedir(),
    io,
    launch: given.launch,
    cwd: process.cwd(),
    ...(given.profile === undefined ? {} : {profile: given.profile})
  };
  if (given.command === 'lsp') {
    const bridge = createBridge({...common, agent: given.agent});
    session = bridge;
    await bridge.run();
    return;
  }
  const work = await workOf(given);
  // A bad input, or a SIGINT during the stdin read, ended the command.
  if (!work || io.finished) return;
  // A listing of profiles needs no profile, so a broken .dynotable.json must not stop it.
  const {cwd, ...rest} = common;
  const oneShot = createSession(given.command === 'profiles' ? rest : {...rest, cwd});
  session = oneShot;
  await oneShot.run(work);
}

async function workOf(given: Exclude<Command, {command: 'lsp'}>) {
  switch (given.command) {
    case 'profiles':
    case 'tables':
    case 'indices':
      return list(given.command);
    case 'run': {
      const read = await readDocument(given, {cwd: process.cwd(), path}, io.stdin);
      if ('document' in read) return run(read.document, given.rowCap);
      emit(io, read);
      return undefined;
    }
  }
}

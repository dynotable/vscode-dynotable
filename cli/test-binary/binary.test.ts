// The compiled binary against the fake app. `pnpm cli:build` builds it first. Each case covers what
// only the real process shows: its exit, its signals and the name it was started under.
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {afterEach, beforeAll, beforeEach, expect, it} from 'vitest';
import {FakeServer} from '../../src/test-integration/fake-server';
import {frame, FrameReader} from '../../src/rpc';
import {binaryName, targetOf} from '../npm/dynotable-cli/lib/resolve-platform.mjs';
import {CLI_MIN_APP_VERSION} from '../src/version';

const CONTRACT = join(__dirname, '..', '..', 'contract');
const WRAPPER_VERSION = (
  JSON.parse(
    readFileSync(join(__dirname, '..', 'npm', 'dynotable-cli', 'package.json'), 'utf8')
  ) as {version: string}
).version;
const host = targetOf(process.platform, process.arch);
const BINARY = join(
  __dirname,
  '..',
  'dist',
  host?.name ?? 'unsupported',
  'bin',
  binaryName(process.platform)
);

/** How long a process may take to end once nothing holds it. */
const END_MS = 5000;

let fake: FakeServer;
let home: string;
let userData: string;

beforeAll(() => {
  if (!existsSync(BINARY)) throw new Error(`${BINARY} is missing. Run pnpm cli:build first.`);
  // The first start of a new binary can take seconds on macOS. The limits below are for warm ones.
  const warm = spawnSync(BINARY, ['--version'], {encoding: 'utf8'});
  if (warm.status !== 0) throw new Error(`${BINARY} --version failed: ${warm.stderr}`);
}, 60_000);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'cli-bin-home-'));
  userData = mkdtempSync(join(tmpdir(), 'cli-bin-data-'));
  fake = new FakeServer(join(userData, 'lsp-port.json'), CONTRACT);
  // The compiled floor, so the binary accepts the fake.
  fake.version = CLI_MIN_APP_VERSION;
  await fake.start();
});

afterEach(async () => {
  await fake.stop();
  rmSync(home, {recursive: true, force: true});
  rmSync(userData, {recursive: true, force: true});
});

interface Run {
  stdin: NodeJS.WritableStream & {end(): void};
  stdout(): Buffer;
  stderr(): string;
  /** Settles with the exit code, or the signal that ended the process. */
  ended: Promise<{code: number | null; signal: NodeJS.Signals | null}>;
  kill(signal: NodeJS.Signals): void;
}

/**
 * Starts the binary. It reads the port file under a temp user data directory, which also turns
 * launching off, so it never reaches an installed app.
 */
function start(args: string[], options: {argv0?: string; binary?: string} = {}): Run {
  const child = spawn(options.binary ?? BINARY, args, {
    cwd: home,
    env: {PATH: process.env.PATH, HOME: home, DYNOTABLE_USER_DATA_DIR: userData},
    ...(options.argv0 === undefined ? {} : {argv0: options.argv0})
  });
  const out: Buffer[] = [];
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString('utf8')));
  return {
    stdin: child.stdin,
    stdout: () => Buffer.concat(out),
    stderr: () => err,
    ended: new Promise((resolve) => child.on('exit', (code, signal) => resolve({code, signal}))),
    kill: (signal) => child.kill(signal)
  };
}

const framed = (body: object) => frame(Buffer.from(JSON.stringify(body), 'utf8'));

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {processId: null, rootUri: null, capabilities: {}, initializationOptions: {}}
};

/** Settles `ended`, or fails when it takes longer than `ms`. */
async function within<T>(ended: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`still running after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([ended, late]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; !condition(); waited += 20) {
    if (waited > 10_000) throw new Error(`timed out waiting for ${what}`);
    await sleep(20);
  }
}

const purposeOf = (params: unknown) =>
  (params as {initializationOptions: {purpose?: unknown}}).initializationOptions.purpose;

it('profiles prints the rows and the process ends', async () => {
  const run = start(['profiles']);
  expect(await within(run.ended, END_MS)).toEqual({code: 0, signal: null});
  expect(Array.isArray(JSON.parse(run.stdout().toString('utf8')))).toBe(true);
  expect(run.stderr()).toBe('');
  expect(purposeOf(fake.initializeParams[0])).toBe('agent');
  // The build stamps the wrapper's version; an unstamped binary says 0.0.0-dev.
  expect(fake.initializeParams[0]).toMatchObject({
    clientInfo: {name: 'dynotable-cli', version: WRAPPER_VERSION}
  });
});

// The floor is compiled in: an app that ignores `purpose` must never get an agent's requests.
it('an app below the compiled floor ends with update-app and is sent no request', async () => {
  fake.version = '1.0.0';
  const run = start(['tables']);
  expect(await within(run.ended, END_MS)).toEqual({code: 1, signal: null});
  expect(JSON.parse(run.stderr())).toMatchObject({code: 'update-app'});
  expect(fake.received.map((message) => message.method)).not.toContain('dynotable/listTables');
});

it('profiles ignores a broken .dynotable.json, which other commands refuse', async () => {
  writeFileSync(join(home, '.dynotable.json'), '{not json');
  const profiles = start(['profiles']);
  expect(await within(profiles.ended, END_MS)).toEqual({code: 0, signal: null});
  const tables = start(['tables']);
  expect(await within(tables.ended, END_MS)).toEqual({code: 2, signal: null});
  expect(JSON.parse(tables.stderr())).toMatchObject({code: 'usage'});
});

it('lsp answers the editor initialize over stdio and ends at stdin EOF', async () => {
  const run = start(['lsp', '--no-launch']);
  run.stdin.write(framed(INITIALIZE));
  await until(() => new FrameReader().push(run.stdout()).bodies.length === 1, 'the answer');
  const [answer] = new FrameReader().push(run.stdout()).bodies;
  expect(JSON.parse(String(answer))).toMatchObject({id: 1, result: {serverInfo: {}}});
  run.stdin.end();
  expect(await within(run.ended, END_MS)).toEqual({code: 0, signal: null});
});

it('SIGINT during a run exits 130 with no stdout and leaves no session', async () => {
  fake.holdRuns = true;
  const statement = join(home, 'q.dtsql');
  writeFileSync(statement, 'SELECT * FROM "orders"');
  const run = start(['run', statement]);
  await until(
    () => fake.received.some((message) => message.method === 'workspace/executeCommand'),
    'the run'
  );
  run.kill('SIGINT');
  expect(await within(run.ended, END_MS)).toEqual({code: 130, signal: null});
  expect(run.stdout().length).toBe(0);
  expect(JSON.parse(run.stderr())).toMatchObject({code: 'interrupted'});
  await until(() => fake.sessions.size === 0, 'the session to close');
});

it('the bridge ends when the app drops the session, while stdin stays open', async () => {
  const run = start(['lsp', '--no-launch']);
  run.stdin.write(framed(INITIALIZE));
  await until(() => new FrameReader().push(run.stdout()).bodies.length === 1, 'the answer');
  fake.dropSessions();
  expect(await within(run.ended, END_MS)).toEqual({code: 1, signal: null});
});

it('stdin closed while initialize is in flight ends the bridge', async () => {
  fake.initializeDelayMs = 30_000;
  const run = start(['lsp', '--no-launch']);
  run.stdin.write(framed(INITIALIZE));
  await until(() => fake.initializeParams.length === 1, 'the initialize');
  run.stdin.end();
  expect(await within(run.ended, END_MS)).toEqual({code: 0, signal: null});
});

// The npm wrapper starts the binary with argv0 `dynotable-lsp`; the release archive holds a hard
// link of that name. Both must give the editor bridge, which sends no `purpose`.
it.each([
  {how: 'argv0', name: 'dynotable-lsp', purpose: undefined},
  {how: 'argv0', name: 'dynotable-cli', purpose: 'agent'},
  {how: 'hard link', name: 'dynotable-lsp', purpose: undefined}
])('started as $name ($how) → purpose $purpose', async ({how, name, purpose}) => {
  let binary: string | undefined;
  if (how === 'hard link') {
    binary = join(home, name + (process.platform === 'win32' ? '.exe' : ''));
    linkSync(BINARY, binary);
  }
  const args = name === 'dynotable-lsp' ? [] : ['lsp', '--no-launch'];
  const run = start(args, how === 'argv0' ? {argv0: name} : {binary});
  run.stdin.write(framed(INITIALIZE));
  await until(() => fake.initializeParams.length === 1, 'the initialize');
  expect(purposeOf(fake.initializeParams[0])).toBe(purpose);
  run.stdin.end();
  expect(await within(run.ended, END_MS)).toEqual({code: 0, signal: null});
});

import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, type Server} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {listTablesSchema, type WireError} from '../../src/protocol';
import {RpcFailure} from '../../src/rpc';
import {FakeServer} from '../../src/test-integration/fake-server';
import {sink} from './io';
import {createSession, type SessionOptions} from './session';

const CONTRACT = join(__dirname, '..', '..', 'contract');

let home: string;
let cwd: string;
let fake: FakeServer;
let stdout: string;
let stderr: string;
let codes: number[];
let servers: Server[];

/** Where the app writes its port file on Linux under `home`. */
const portFile = () => join(home, '.config', 'DynoTable', 'lsp-port.json');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cli-home-'));
  cwd = mkdtempSync(join(tmpdir(), 'cli-cwd-'));
  fake = new FakeServer(portFile(), CONTRACT);
  stdout = '';
  stderr = '';
  codes = [];
  servers = [];
});

afterEach(async () => {
  await fake.stop();
  for (const server of servers) server.close();
  rmSync(home, {recursive: true, force: true});
  rmSync(cwd, {recursive: true, force: true});
});

/** One `listTables` through a session, as a one-shot command does it. */
async function listTables(options: Partial<SessionOptions> = {}): Promise<void> {
  const io = sink({
    stdin: process.stdin,
    stdout: {write: (chunk) => (stdout += String(chunk))},
    stderr: {write: (chunk) => (stderr += String(chunk))},
    setExitCode: (code) => codes.push(code)
  });
  const session = createSession({
    minAppVersion: fake.version,
    env: {},
    home,
    io,
    // A test must never start an installed app.
    launch: false,
    cwd,
    platform: 'linux',
    ...options
  });
  await session.run(async (connection) => {
    const answer = await connection.request('dynotable/listTables', {}, listTablesSchema);
    return answer.ok ? {value: answer.value} : {failure: answer.failure};
  });
}

const failure = () => JSON.parse(stderr) as {code: string; message: string};

const optionsOf = (index: number) =>
  (fake.initializeParams[index] as {initializationOptions: Record<string, unknown>})
    .initializationOptions;

describe('session', () => {
  it('sends an agent initialize with the CLI clientInfo and no optional capabilities', async () => {
    await fake.start();
    await listTables({profile: 'profile-1-slug'});
    expect(codes).toEqual([0]);
    expect(stderr).toBe('');
    expect(JSON.parse(stdout)).toEqual(fake.fixture('list-tables.json'));
    const params = fake.initializeParams[0] as Record<string, unknown>;
    expect(params.initializationOptions).toEqual({
      token: fake.token,
      profile: 'profile-1-slug',
      purpose: 'agent'
    });
    expect(params.clientInfo).toEqual({name: 'dynotable-cli', version: '0.0.0-dev'});
    expect(params.capabilities).toEqual({});
    // A session ends with shutdown, then exit; the app keeps serving.
    await vi.waitFor(() =>
      expect(fake.received.map((m) => m.method)).toEqual([
        'initialized',
        'dynotable/listTables',
        'shutdown',
        'exit'
      ])
    );
  });

  it('reconnects once after a token rotated at the first initialize', async () => {
    await fake.start();
    fake.onInitialize = () => {
      if (fake.initializeParams.length === 1) fake.rotateToken();
    };
    await listTables();
    expect(codes).toEqual([0]);
    expect(fake.initializeParams).toHaveLength(2);
  });

  it('two auth failures end with auth-failed', async () => {
    await fake.start();
    fake.onInitialize = () => fake.rotateToken();
    await listTables();
    expect(codes).toEqual([1]);
    expect(failure().code).toBe('auth-failed');
    expect(fake.initializeParams).toHaveLength(2);
  });

  it('signed-out at initialize exits 1 with signed-out', async () => {
    await fake.start();
    fake.onInitialize = () => {
      throw new RpcFailure(fake.fixture('error-signed-out.json') as WireError);
    };
    await listTables();
    expect(codes).toEqual([1]);
    expect(failure().code).toBe('signed-out');
  });

  // An app below the floor ignores `purpose` and would grant an editor session.
  it('an app below the floor is refused with update-app and nothing is requested', async () => {
    await fake.start();
    fake.version = '1.0.0';
    await listTables({minAppVersion: '1.20.0'});
    expect(codes).toEqual([1]);
    expect(failure().code).toBe('update-app');
    expect(fake.received.map((m) => m.method)).not.toContain('dynotable/listTables');
  });

  it('with launching off and no port file, ends with launcher-off', async () => {
    await listTables();
    expect(codes).toEqual([1]);
    expect(failure().code).toBe('launcher-off');
  });

  it('a listener that is not a language server exits 1 with one JSON line and no stack', async () => {
    const server = createServer((socket) =>
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address() as {port: number};
    mkdirSync(join(home, '.config', 'DynoTable'), {recursive: true});
    writeFileSync(portFile(), JSON.stringify({port, token: 'secret-token', pid: process.pid}));
    await listTables();
    expect(codes).toEqual([1]);
    expect(stderr.trim().split('\n')).toHaveLength(1);
    expect(failure().code).toBe('connection-ended');
    expect(stdout).toBe('');
  });

  describe('the token never reaches stdout or stderr', () => {
    const setups: Array<[string, () => void]> = [
      ['bad-answer', () => fake.handle('dynotable/listTables', () => ({tables: 'not a list'}))],
      ['auth-failed', () => (fake.onInitialize = () => fake.rotateToken())],
      [
        'connection-ended',
        () =>
          fake.handle('dynotable/listTables', (_params, session) => {
            session.peer.socket.destroy();
            return new Promise(() => {});
          })
      ]
    ];
    it.each(setups)('%s', async (code, setup) => {
      await fake.start();
      setup();
      await listTables();
      expect(failure().code).toBe(code);
      const tokens = [fake.token, ...fake.initializeParams.map((_, i) => optionsOf(i).token)];
      for (const token of tokens) {
        expect(stdout).not.toContain(token);
        expect(stderr).not.toContain(token);
      }
    });
  });

  it('uses the profile in .dynotable.json, and --profile overrides it', async () => {
    await fake.start();
    writeFileSync(join(cwd, '.dynotable.json'), JSON.stringify({profile: 'profile-2-slug'}));
    await listTables();
    await listTables({profile: 'profile-1-slug'});
    expect(optionsOf(0).profile).toBe('profile-2-slug');
    expect(optionsOf(1).profile).toBe('profile-1-slug');
  });

  it('a profile that is not available to agents ends with profile-not-exposed', async () => {
    await fake.start();
    fake.agentProfiles = ['profile-1-id'];
    await listTables({profile: 'profile-2-slug'});
    expect(codes).toEqual([1]);
    expect(failure().code).toBe('profile-not-exposed');
  });
});

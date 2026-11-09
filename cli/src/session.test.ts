import {mkdirSync, writeFileSync} from 'node:fs';
import {createServer, type Server} from 'node:net';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {listTablesSchema, type WireError} from '../../src/protocol';
import {RpcFailure} from '../../src/rpc';
import type {SessionOptions} from './session';
import {useHarness} from './test-session';

const h = useHarness();
let servers: Server[];

beforeEach(() => {
  servers = [];
});

afterEach(() => {
  for (const server of servers) server.close();
});

/** One `listTables` through a session, as a one-shot command does it. */
const listTables = (options: Partial<SessionOptions> = {}) =>
  h.run(async (connection) => {
    const answer = await connection.request('dynotable/listTables', {}, listTablesSchema);
    return answer.ok ? {value: answer.value} : {failure: answer.failure};
  }, options);

const optionsOf = (index: number) =>
  (
    h.fake.initializeParams[index] as {
      initializationOptions: Record<string, unknown>;
    }
  ).initializationOptions;

describe('session', () => {
  it('sends an agent initialize with the CLI clientInfo and no optional capabilities', async () => {
    await h.fake.start();
    await listTables({profile: 'profile-1-slug'});
    expect(h.codes).toEqual([0]);
    expect(h.stderr).toBe('');
    expect(JSON.parse(h.stdout)).toEqual(h.fake.fixture('list-tables.json'));
    const params = h.fake.initializeParams[0] as Record<string, unknown>;
    expect(params.initializationOptions).toEqual({
      token: h.fake.token,
      profile: 'profile-1-slug',
      purpose: 'agent'
    });
    expect(params.clientInfo).toEqual({
      name: 'dynotable-cli',
      version: '0.0.0-dev'
    });
    expect(params.capabilities).toEqual({});
    // A session ends with shutdown, then exit; the app keeps serving.
    await vi.waitFor(() =>
      expect(h.fake.received.map((m) => m.method)).toEqual([
        'initialized',
        'dynotable/listTables',
        'shutdown',
        'exit'
      ])
    );
  });

  it('reconnects once after a token rotated at the first initialize', async () => {
    await h.fake.start();
    h.fake.onInitialize = () => {
      if (h.fake.initializeParams.length === 1) h.fake.rotateToken();
    };
    await listTables();
    expect(h.codes).toEqual([0]);
    expect(h.fake.initializeParams).toHaveLength(2);
  });

  it('two auth failures end with auth-failed', async () => {
    await h.fake.start();
    h.fake.onInitialize = () => h.fake.rotateToken();
    await listTables();
    expect(h.codes).toEqual([1]);
    expect(h.failure().code).toBe('auth-failed');
    expect(h.fake.initializeParams).toHaveLength(2);
  });

  it('signed-out at initialize exits 1 with signed-out', async () => {
    await h.fake.start();
    h.fake.onInitialize = () => {
      throw new RpcFailure(h.fake.fixture('error-signed-out.json') as WireError);
    };
    await listTables();
    expect(h.codes).toEqual([1]);
    expect(h.failure().code).toBe('signed-out');
  });

  // An app below the floor ignores `purpose` and would grant an editor session.
  it('an app below the floor is refused with update-app and nothing is requested', async () => {
    await h.fake.start();
    h.fake.version = '1.0.0';
    await listTables({minAppVersion: '1.20.0'});
    expect(h.codes).toEqual([1]);
    expect(h.failure().code).toBe('update-app');
    expect(h.fake.received.map((m) => m.method)).not.toContain('dynotable/listTables');
  });

  it('with launching off and no port file, ends with launcher-off', async () => {
    await listTables();
    expect(h.codes).toEqual([1]);
    expect(h.failure().code).toBe('launcher-off');
  });

  it('a listener that is not a language server exits 1 with one JSON line and no stack', async () => {
    const server = createServer((socket) =>
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    );
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address() as {port: number};
    mkdirSync(join(h.home, '.config', 'DynoTable'), {recursive: true});
    writeFileSync(h.portFile(), JSON.stringify({port, token: 'secret-token', pid: process.pid}));
    await listTables();
    expect(h.codes).toEqual([1]);
    expect(h.stderr.trim().split('\n')).toHaveLength(1);
    expect(h.failure().code).toBe('connection-ended');
    expect(h.stdout).toBe('');
  });

  describe('the token never reaches stdout or stderr', () => {
    const setups: Array<[string, () => void]> = [
      [
        'bad-answer',
        () =>
          h.fake.handle('dynotable/listTables', () => ({
            tables: 'not a list'
          }))
      ],
      ['auth-failed', () => (h.fake.onInitialize = () => h.fake.rotateToken())],
      [
        'connection-ended',
        () =>
          h.fake.handle('dynotable/listTables', (_params, session) => {
            session.peer.socket.destroy();
            return new Promise(() => {});
          })
      ]
    ];
    it.each(setups)('%s', async (code, setup) => {
      await h.fake.start();
      setup();
      await listTables();
      expect(h.failure().code).toBe(code);
      const tokens = [h.fake.token, ...h.fake.initializeParams.map((_, i) => optionsOf(i).token)];
      for (const token of tokens) {
        expect(h.stdout).not.toContain(token);
        expect(h.stderr).not.toContain(token);
      }
    });
  });

  it('uses the profile in .dynotable.json, and --profile overrides it', async () => {
    await h.fake.start();
    writeFileSync(join(h.cwd, '.dynotable.json'), JSON.stringify({profile: 'profile-2-slug'}));
    await listTables();
    await listTables({profile: 'profile-1-slug'});
    expect(optionsOf(0).profile).toBe('profile-2-slug');
    expect(optionsOf(1).profile).toBe('profile-1-slug');
  });

  it('a profile that is not available to agents ends with profile-not-exposed', async () => {
    await h.fake.start();
    h.fake.agentProfiles = ['profile-1-id'];
    await listTables({profile: 'profile-2-slug'});
    expect(h.codes).toEqual([1]);
    expect(h.failure().code).toBe('profile-not-exposed');
  });
});

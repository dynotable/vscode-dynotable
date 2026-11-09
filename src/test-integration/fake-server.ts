import {randomBytes} from 'node:crypto';
import {mkdirSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, type Server, type Socket} from 'node:net';
import {dirname} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {readFixture} from '../../scripts/contract';
import {Peer, RpcFailure, type Id} from '../rpc';
import {
  AUTH_FAILED,
  METHOD_NOT_FOUND,
  REQUEST_FAILED,
  type CommandArgs,
  type InitializeResult,
  type ProfileRow,
  type WireError
} from '../protocol';

export interface Session {
  peer: Peer;
  initialized: boolean;
  /** Held runs by request id, released by `$/cancelRequest`. */
  held: Map<Id, () => void>;
  /** Set on an agent session that is bound to no profile available to agents. */
  refusal?: WireError;
  /** True on an agent session while `agentProfiles` is set. */
  agent?: boolean;
}

/** Answers a request, or throws `RpcFailure`. */
export type Handler = (params: unknown, session: Session) => unknown;

export interface Message {
  method: string;
  params: unknown;
  /** A request's id. */
  id?: Id;
}

/** The server drops a refused socket this long after the refusal. */
const AUTH_DROP_MS = 250;

/** The requests an unbound session refuses. */
const NEEDS_PROFILE = new Set([
  'dynotable/listTables',
  'dynotable/listIndices',
  'workspace/executeCommand'
]);

/**
 * A DynoTable Language Server on loopback, answering from `contract/` fixtures. Every fixture
 * passes its strict guard on load. Tests override a method with `handle`.
 */
export class FakeServer {
  token = randomBytes(32).toString('base64url');
  port = 0;
  version: string;
  /** Holds every run open until the client cancels it. */
  holdRuns = false;
  /** A held run answers with rows after its cancel, as a reply already in flight does. */
  answerCancelledRuns = false;
  /** Keeps a start in flight this long before `initialize` is answered. */
  initializeDelayMs = 0;
  /**
   * Runs before each `initialize` is checked; a test can rotate the token here, or send the
   * session a message that then arrives before the answer. It can throw an `RpcFailure` to refuse:
   * with `-32898`, the socket drops as after a wrong token.
   */
  onInitialize: ((session: Session) => void) | undefined;
  /** Resets each connection as soon as it is accepted. */
  resetOnAccept = false;
  /**
   * The ids and slugs of the profiles available to agents. While it is set, an agent session
   * lists only those rows and binds only one of them.
   */
  agentProfiles: string[] | undefined;
  readonly initializeParams: unknown[] = [];
  /** Every message after `initialize`, in arrival order. */
  readonly received: Message[] = [];
  readonly sessions = new Set<Session>();

  private server: Server | undefined;
  private readonly handlers = new Map<string, Handler>();
  private readonly languages = new Map<string, string>();

  constructor(
    private readonly portFile: string,
    private readonly contractDir: string
  ) {
    this.version = (this.fixture('initialize.json') as InitializeResult).serverInfo.version;
  }

  fixture(file: string): unknown {
    return readFixture(this.contractDir, file);
  }

  /** Answers `method` (or `command:<id>` for `workspace/executeCommand`) with `handler`. */
  handle(method: string, handler: Handler): void {
    this.handlers.set(method, handler);
  }

  /** True once a `textDocument/didOpen` for `uri` arrived. */
  opened(uri: string): boolean {
    return this.languages.has(uri);
  }

  /** Restores the fixture answer of `method`. */
  unhandle(method: string): void {
    this.handlers.delete(method);
  }

  async start(port = 0): Promise<void> {
    const server = createServer((socket) => this.accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    this.server = server;
    this.port = (server.address() as {port: number}).port;
    this.writePortFile();
  }

  /** A new token in the port file. Live sessions keep running. */
  rotateToken(): void {
    this.token = randomBytes(32).toString('base64url');
    this.writePortFile();
  }

  /** An app restart: every session drops, and the server serves a new port and token. */
  async rebind(): Promise<void> {
    await this.close();
    this.token = randomBytes(32).toString('base64url');
    await this.start();
  }

  /** Drops every session, as an app that quit or crashed does. */
  dropSessions(): void {
    for (const session of this.sessions) session.peer.socket.destroy();
  }

  /** Writes `bytes` as they are to every initialized session, past the framing of `Peer`. */
  writeRaw(bytes: Buffer): void {
    for (const session of this.initializedSessions()) session.peer.socket.write(bytes);
  }

  notifyAll(method: string, params: unknown): void {
    for (const session of this.initializedSessions()) session.peer.notify(method, params);
  }

  /** Sends a server-to-client request to every session and collects each answer or error. */
  requestAll(method: string, params: unknown): Promise<unknown[]> {
    return Promise.all(
      this.initializedSessions().map((session) =>
        session.peer.request(method, params).response.catch((error: unknown) => error)
      )
    );
  }

  /** Stops serving and deletes the port file, as a clean stop does. */
  async stop(): Promise<void> {
    rmSync(this.portFile, {force: true});
    await this.close();
  }

  private initializedSessions(): Session[] {
    return [...this.sessions].filter((session) => session.initialized);
  }

  private async close(): Promise<void> {
    this.dropSessions();
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise((resolve) => server.close(resolve));
  }

  private writePortFile(): void {
    mkdirSync(dirname(this.portFile), {recursive: true});
    const temp = `${this.portFile}.tmp`;
    const file = {port: this.port, token: this.token, pid: process.pid};
    writeFileSync(temp, JSON.stringify(file), {mode: 0o600});
    renameSync(temp, this.portFile);
  }

  private accept(socket: Socket): void {
    if (this.resetOnAccept) {
      socket.resetAndDestroy();
      return;
    }
    const session: Session = {peer: new Peer(socket), initialized: false, held: new Map()};
    this.sessions.add(session);
    socket.on('close', () => this.sessions.delete(session));
    session.peer.onRequest = (method, params, id) => this.request(session, method, params, id);
    session.peer.onNotification = (method, params) => this.notification(session, method, params);
  }

  private refuse(session: Session): never {
    setTimeout(() => session.peer.socket.destroy(), AUTH_DROP_MS);
    throw new RpcFailure(this.fixture('error-auth.json') as WireError);
  }

  private async request(session: Session, method: string, params: unknown, id: Id) {
    if (method === 'initialize') {
      this.initializeParams.push(params);
      try {
        this.onInitialize?.(session);
      } catch (error) {
        if (error instanceof RpcFailure && error.error.code === AUTH_FAILED) {
          setTimeout(() => session.peer.socket.destroy(), AUTH_DROP_MS);
        }
        throw error;
      }
      if (this.initializeDelayMs > 0) await sleep(this.initializeDelayMs);
      const options = (
        params as {initializationOptions?: {token?: unknown; profile?: unknown; purpose?: unknown}}
      ).initializationOptions;
      if (session.initialized) {
        throw new RpcFailure({
          code: REQUEST_FAILED,
          message: 'This connection is already initialized.',
          data: {code: 'run-failed'}
        });
      }
      if (options?.token !== this.token) this.refuse(session);
      session.initialized = true;
      if (this.agentProfiles && options?.purpose === 'agent') {
        session.agent = true;
        session.refusal = this.agentRefusal(options.profile);
      }
      const result = this.fixture('initialize.json') as InitializeResult;
      return {...result, serverInfo: {...result.serverInfo, version: this.version}};
    }
    if (!session.initialized) this.refuse(session);
    this.received.push({method, params, id});
    if (session.refusal && NEEDS_PROFILE.has(method)) throw new RpcFailure(session.refusal);
    const args =
      method === 'workspace/executeCommand'
        ? (params as {command: string; arguments?: unknown[]})
        : undefined;
    const handler = this.handlers.get(args ? `command:${args.command}` : method);
    if (handler) return handler(params, session);
    switch (method) {
      case 'shutdown':
        return null;
      case 'dynotable/listProfiles':
        return session.agent ? this.agentRows() : this.fixture('list-profiles.json');
      case 'dynotable/listTables':
        return this.fixture('list-tables.json');
      case 'dynotable/listIndices':
        return this.fixture('list-indices.json');
      case 'workspace/executeCommand':
        return this.command(session, args?.command, args?.arguments?.[0] as CommandArgs, id);
    }
    // A capability the fake does not model answers empty rather than failing the client.
    if (method.startsWith('textDocument/')) return null;
    throw new RpcFailure({code: METHOD_NOT_FOUND, message: `Unhandled method ${method}`});
  }

  private agentRows(): ProfileRow[] {
    const exposed = new Set(this.agentProfiles);
    return (this.fixture('list-profiles.json') as ProfileRow[]).filter(
      (row) => exposed.has(row.id) || exposed.has(row.slug)
    );
  }

  /** Unknown and not available give one answer, as PROTOCOL.md § Profiles says. */
  private agentRefusal(profile: unknown): WireError | undefined {
    const rows = this.agentRows();
    const bound =
      typeof profile === 'string'
        ? rows.some((row) => row.id === profile || row.slug === profile)
        : rows.length === 1;
    if (bound) return undefined;
    if (profile === undefined && rows.length > 1) {
      return this.fixture('error-profile-required.json') as WireError;
    }
    return this.fixture('error-profile-not-exposed.json') as WireError;
  }

  private async command(session: Session, command: unknown, args: CommandArgs, id: Id) {
    const language = this.languages.get(args?.uri) ?? '';
    const dialect = ['partiql', 'opensearch'].includes(language) ? language : 'sql';
    switch (command) {
      case 'dynotable.runStatement':
        if (this.holdRuns) {
          await new Promise<void>((resolve) => session.held.set(id, resolve));
          if (this.answerCancelledRuns) return this.fixture(`run-${dialect}.json`);
          const cancel = dialect === 'sql' ? 'error-cancel-sql.json' : 'error-cancel-partiql.json';
          throw new RpcFailure(this.fixture(cancel) as WireError);
        }
        return this.fixture(`run-${dialect}.json`);
      case 'dynotable.openInApp':
        return null;
      case 'dynotable.validateQuery':
        session.peer.notify('window/showMessage', this.fixture('validate-query-message.json'));
        return this.fixture('validate-query.json');
    }
    throw new RpcFailure({code: METHOD_NOT_FOUND, message: `Unknown command ${String(command)}`});
  }

  private notification(session: Session, method: string, params: unknown): void {
    // The server drops a notification that arrives before `initialize`.
    if (!session.initialized) return;
    this.received.push({method, params});
    if (method === 'exit') session.peer.socket.destroy();
    if (method === 'textDocument/didOpen') {
      const {uri, languageId} = (params as {textDocument: {uri: string; languageId: string}})
        .textDocument;
      this.languages.set(uri, languageId);
    }
    if (method === '$/cancelRequest') {
      const id = (params as {id: Id}).id;
      session.held.get(id)?.();
      session.held.delete(id);
    }
  }
}

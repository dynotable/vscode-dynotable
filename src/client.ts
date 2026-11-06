import type {Socket} from 'node:net';
import * as vscode from 'vscode';
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  LSPErrorCodes,
  ResponseError
} from 'vscode-languageclient/node';
import type {StartHandle, StartOutcome, StartParams} from './connect-core';
import type {Listing} from './explorer-model';
import {AUTH_FAILED, failureCodeOf, is, METHOD_NOT_FOUND, type Schema} from './protocol';

/** Also the settings prefix the library reads `trace.server` from. */
const CLIENT_ID = 'dynotable';

/** New query names its untitled SQL buffers so; other untitled SQL is not DynoTable's. */
const UNTITLED_SQL = '**/*.dynotable.sql';

/** A protocol document filter. A relative pattern's `baseUri` is a string: see `toVscode`. */
export interface Filter {
  language: string;
  scheme: string;
  pattern?: string | {baseUri: string; pattern: string};
}

const sqlFiles = (folder?: vscode.WorkspaceFolder) =>
  vscode.workspace.getConfiguration('dynotable', folder).get<string[]>('sqlFiles') ?? [];

/**
 * `sql` attaches only through `dynotable.sqlFiles` and New query's untitled buffers. Each folder's
 * own value decides what attaches in that folder, as patterns relative to it. With no folder open,
 * the entries that begin with `**\/` match the absolute path. In a window with folders, a `sql` file
 * outside every folder does not attach: a string pattern would also match inside the folders.
 */
export function documentSelector(): Filter[] {
  const selector: Filter[] = [];
  for (const language of ['partiql', 'opensearch']) {
    for (const scheme of ['file', 'untitled']) selector.push({language, scheme});
  }
  selector.push({language: 'sql', scheme: 'untitled', pattern: UNTITLED_SQL});
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const folder of folders) {
    for (const pattern of sqlFiles(folder)) {
      selector.push({
        language: 'sql',
        scheme: 'file',
        pattern: {baseUri: folder.uri.toString(), pattern}
      });
    }
  }
  if (folders.length === 0) {
    for (const pattern of sqlFiles()) {
      if (pattern.startsWith('**/')) selector.push({language: 'sql', scheme: 'file', pattern});
    }
  }
  return selector;
}

/** For `languages.match`, which takes a `RelativePattern` object where the protocol takes a string. */
export function toVscode(selector: Filter[]): vscode.DocumentFilter[] {
  return selector.map(({language, scheme, pattern}) => ({
    language,
    scheme,
    pattern:
      typeof pattern === 'object'
        ? new vscode.RelativePattern(vscode.Uri.parse(pattern.baseUri), pattern.pattern)
        : pattern
  }));
}

const noop = () => {};

/**
 * The library traces only when its trace channel's level is Trace, and a verbose trace logs the
 * `initialize` params, token included. This channel's level is Off and never changes.
 */
const TRACE_SINK: vscode.LogOutputChannel = {
  name: 'DynoTable Trace',
  logLevel: vscode.LogLevel.Off,
  onDidChangeLogLevel: () => ({dispose: noop}),
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  append: noop,
  appendLine: noop,
  replace: noop,
  clear: noop,
  show: noop,
  hide: noop,
  dispose: noop
};

/** The server sends none of these. A listener on a stale port could, so the client refuses them. */
const refusal = () =>
  new ResponseError(LSPErrorCodes.RequestFailed, 'The DynoTable client refuses this request.');

class DynoTableClient extends LanguageClient {
  /**
   * The library forces a toast for a failed start or a closed connection; the status bar and our
   * own notification carry those, so the library only logs.
   */
  override error(message: string, data?: unknown): void {
    super.error(message, data, false);
  }
}

export interface Session extends StartHandle {
  client: LanguageClient;
}

/** Sends a server command for `client`. It replaces the library's own send. */
export type CommandHandler = (
  client: LanguageClient,
  command: string,
  args: unknown[]
) => Promise<unknown>;

/** One attempt's client. Each attempt builds a new one: a client whose start failed never restarts. */
export function startSession(
  output: vscode.LogOutputChannel,
  selector: Filter[],
  onCommand: CommandHandler,
  {socket, token, onClosed}: StartParams,
  /** The requested profile's id. With none, the server binds a single-row roster only. */
  profile: string | undefined
): Session {
  let closed = false;
  const end = () => {
    closed = true;
    onClosed();
  };
  const client = new DynoTableClient(
    CLIENT_ID,
    'DynoTable',
    // connect-core's connect seam returns a `net.Socket`.
    () => Promise.resolve({reader: socket as Socket, writer: socket as Socket}),
    {
      documentSelector: selector,
      initializationOptions: {token, profile},
      outputChannel: output,
      traceOutputChannel: TRACE_SINK,
      initializationFailedHandler: () => false,
      // A write error can come first and stop the client, and a stopping client never reports
      // the close that follows: so an error also ends the session.
      errorHandler: {
        error: () => {
          end();
          return {action: ErrorAction.Shutdown, handled: true};
        },
        closed: () => {
          end();
          return {action: CloseAction.DoNotRestart, handled: true};
        }
      },
      middleware: {
        executeCommand: (command, args) => onCommand(client, command, args),
        handleRegisterCapability: () => Promise.reject(refusal()),
        workspace: {
          handleApplyEdit: () => refusal(),
          // The library would answer with the user's settings, those of other extensions included.
          configuration: () => refusal()
        },
        window: {showDocument: () => Promise.reject(refusal())}
      }
    }
  );
  const outcome = client.start().then(
    (): StartOutcome => ({kind: 'ok', version: client.initializeResult?.serverInfo?.version}),
    (error: unknown): StartOutcome => {
      if (error instanceof ResponseError) {
        if (error.code === AUTH_FAILED) return {kind: 'auth-failed'};
        if (failureCodeOf(error) === 'signed-out') return {kind: 'signed-out'};
      }
      return {kind: closed ? 'closed' : 'refused'};
    }
  );
  return {client, outcome, dispose: () => client.dispose()};
}

export const unreadable = (what: string) =>
  `DynoTable answered with ${what} the extension cannot read.`;

export const LIST_TABLES = 'dynotable/listTables';
export const LIST_INDICES = 'dynotable/listIndices';

/** `fresh` makes the server refresh the listing first, even inside a failure cooldown. */
export async function requestListing<T>(
  client: LanguageClient,
  method: string,
  guard: Schema<T>,
  fresh: boolean
): Promise<Listing<T>> {
  try {
    const value: unknown = await client.sendRequest(method, fresh ? {fresh} : {});
    return is(guard, value)
      ? {kind: 'ok', value}
      : {kind: 'failed', message: unreadable('a listing')};
  } catch (error) {
    if (!(error instanceof ResponseError)) {
      return {kind: 'failed', message: error instanceof Error ? error.message : String(error)};
    }
    return {
      kind: 'failed',
      message: error.message,
      code: error.code,
      failure: failureCodeOf(error)
    };
  }
}

/**
 * What the connect-time `dynotable/listTables` says about the session. An unbound session answers
 * `profile-required` at once; a bound one answers only after a full table listing.
 */
export function bindingOf(listing: Listing<unknown>): 'unbound' | 'missing-request' | undefined {
  if (listing.kind === 'ok') return undefined;
  if (listing.code === METHOD_NOT_FOUND) return 'missing-request';
  return listing.failure === 'profile-required' ? 'unbound' : undefined;
}

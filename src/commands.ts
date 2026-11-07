import * as vscode from 'vscode';
import {
  CodeLensRequest,
  ExecuteCommandRequest,
  ResponseError,
  type LanguageClient
} from 'vscode-languageclient/node';
import {attach} from './attach';
import {LIST_INDICES, unreadable} from './client';
import type {ConnectCore} from './connect-core';
import {applyPin, directiveLine, pinFor} from './directive';
import type {Platform} from './discovery';
import {indexFailures, queryOf, type Node, type Query} from './explorer-model';
import {contains} from './plan-lens';
import {pickerOf, type RequestedProfile} from './profiles';
import {
  commandArgsSchema,
  is,
  listIndicesSchema,
  profileListSchema,
  type CommandArgs,
  type Position,
  type Range
} from './protocol';
import {ACTION_LABELS, type Action} from './reasons';
import {
  OPEN_IN_APP,
  REFUSAL_LABELS,
  refusalOf,
  RUN_STATEMENT,
  type RefusalAction
} from './refusals';
import type {ResultsPanel} from './results';
import {notify, type StatusModel} from './status';

export interface CommandDeps {
  connection: ConnectCore;
  panel: ResultsPanel;
  platform: Platform;
  /** The connected session's client, after a lazy connect. `undefined` once the user was told why. */
  client(): Promise<LanguageClient | undefined>;
  status(): StatusModel;
  act(action: Action | undefined): Promise<void>;
  inScope(document: vscode.TextDocument): boolean;
  /** Persists the choice and reconnects: a session binds its profile at `initialize` only. */
  requestProfile(profile: RequestedProfile): Promise<void>;
}

const LIST_PROFILES = 'dynotable/listProfiles';

/**
 * The `executeCommand` middleware. It sends every server command itself and never calls the
 * library's `next`, so a refusal reaches the user once, in the server's own sentence.
 */
export async function serverCommand(
  deps: CommandDeps,
  client: LanguageClient,
  command: string,
  args: unknown[]
): Promise<unknown> {
  if (command === RUN_STATEMENT && is(commandArgsSchema, args[0])) {
    await runStatement(deps, client, args[0]);
    return undefined;
  }
  try {
    return await client.sendRequest(ExecuteCommandRequest.type, {command, arguments: args});
  } catch (error) {
    await report(deps, client, error, command, args[0]);
    return undefined;
  }
}

/** `dynotable.run`: the selection, else the statement under the caret, else the whole buffer. */
export async function runActiveEditor(deps: CommandDeps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !deps.inScope(editor.document)) {
    void vscode.window.showInformationMessage('Open a DynoTable query to run it.');
    return;
  }
  const client = await deps.client();
  if (!client) return;
  const {document, selection} = editor;
  const args: CommandArgs = {uri: document.uri.toString()};
  if (!selection.isEmpty) {
    args.range = client.code2ProtocolConverter.asRange(selection);
  } else if (document.languageId !== 'opensearch') {
    // Without a range the server runs the whole document; for opensearch that is the only form.
    let range: Range | undefined;
    const {version} = document;
    try {
      const caret = client.code2ProtocolConverter.asPosition(selection.active);
      range = (await lensArgsAt(client, args.uri, caret, RUN_STATEMENT))?.range;
    } catch (error) {
      // Running the whole document instead could run statements the user did not mean to run.
      await report(deps, client, error, CodeLensRequest.method);
      return;
    }
    // The lens range is for the text the request saw; on edited text it can select another statement.
    if (document.version !== version) {
      void vscode.window.showInformationMessage(
        'The query changed before the run started. Run it again.'
      );
      return;
    }
    if (range) args.range = range;
  }
  await runStatement(deps, client, args);
}

/**
 * `dynotable.open`: the Open in DynoTable lens of the statement under the caret, with the arguments
 * the server gave it. The server decides which statements get one.
 */
export async function openActiveEditor(deps: CommandDeps): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || !deps.inScope(editor.document) || editor.document.languageId === 'opensearch') {
    void vscode.window.showInformationMessage(
      'Open a DynoTable SQL or PartiQL query to open it in DynoTable.'
    );
    return;
  }
  const client = await deps.client();
  if (!client) return;
  const {document, selection} = editor;
  const {version} = document;
  let args: CommandArgs | undefined;
  try {
    const caret = client.code2ProtocolConverter.asPosition(selection.active);
    args = await lensArgsAt(client, document.uri.toString(), caret, OPEN_IN_APP);
  } catch (error) {
    await report(deps, client, error, CodeLensRequest.method);
    return;
  }
  if (document.version !== version) {
    void vscode.window.showInformationMessage(
      'The query changed before DynoTable opened it. Try again.'
    );
    return;
  }
  if (!args) {
    void vscode.window.showInformationMessage(
      'DynoTable cannot open this statement. Put the cursor in a statement that shows Open in DynoTable.'
    );
    return;
  }
  await serverCommand(deps, client, OPEN_IN_APP, [args]);
}

/**
 * `dynotable.selectProfile`. Only a connected session can list the roster; from a disconnected
 * state, `client()` shows the reason instead.
 */
export async function selectProfile(deps: CommandDeps): Promise<void> {
  const client = await deps.client();
  if (!client) return;
  const session = deps.connection.current;
  let rows: unknown;
  try {
    rows = await client.sendRequest(LIST_PROFILES);
  } catch (error) {
    await report(deps, client, error, LIST_PROFILES);
    return;
  }
  if (!is(profileListSchema, rows)) {
    void vscode.window.showErrorMessage(unreadable('a profile list'));
    return;
  }
  const picker = pickerOf(rows);
  if (picker.kind === 'empty') {
    const open = ACTION_LABELS['open-app'];
    if ((await vscode.window.showInformationMessage(picker.sentence, open)) === open) {
      await deps.act('open-app');
    }
    return;
  }
  const item = await vscode.window.showQuickPick(picker.items, {
    placeHolder: 'Select a DynoTable profile'
  });
  // A choice from a replaced session's roster can name a profile of another app.
  if (!item || deps.connection.current !== session) return;
  if (item.refusal) {
    void vscode.window.showWarningMessage(item.refusal);
    return;
  }
  await deps.requestProfile({id: item.profile.id, name: item.profile.name});
}

/** Untitled `sql` attaches only under a `.dynotable.sql` path. */
const SUFFIXES: Record<Query['language'], string> = {
  sql: '.dynotable.sql',
  partiql: '.partiql',
  opensearch: '.opensearch'
};

/** An `opensearch` buffer names its index on line 0; Pick index fills it in. */
const DIALECTS: Array<vscode.QuickPickItem & Query> = [
  {label: 'SQL', language: 'sql', text: ''},
  {label: 'PartiQL', language: 'partiql', text: ''},
  {label: 'OpenSearch', language: 'opensearch', text: `${directiveLine({index: ''})}\n`}
];

/** `dynotable.newQuery`: on an explorer table or index, else in the dialect the user chooses. */
export async function newQuery(node: Node | undefined): Promise<void> {
  const query = node
    ? queryOf(node)
    : await vscode.window.showQuickPick(DIALECTS, {placeHolder: 'Select the query language'});
  if (!query) return;
  if ('error' in query) {
    void vscode.window.showWarningMessage(query.error);
  } else {
    await openQuery(query);
  }
}

/** `dynotable.attachSqlFile`: adds the active SQL file to its folder's `dynotable.sqlFiles`. */
export async function attachSqlFile(deps: CommandDeps): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  if (document?.uri.scheme !== 'file' || document.languageId !== 'sql') {
    void vscode.window.showInformationMessage('Open a SQL file to attach it to DynoTable.');
    return;
  }
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const settings = vscode.workspace.getConfiguration('dynotable', folder?.uri);
  const result = attach({
    platform: deps.platform,
    folder: folder?.uri.fsPath,
    file: document.uri.fsPath,
    sqlFiles: settings.get<string[]>('sqlFiles') ?? []
  });
  if (!result) {
    // In a window with folders, a `*.dynotable.sql` file outside them does not attach either.
    void vscode.window.showInformationMessage(
      vscode.workspace.workspaceFolders
        ? 'Only a file in an open workspace folder can be attached.'
        : 'Only a file in an open workspace folder can be attached. Outside a folder, name the file *.dynotable.sql.'
    );
    return;
  }
  if (deps.inScope(document)) {
    void vscode.window.showInformationMessage('DynoTable already attaches this file.');
    return;
  }
  // The change event restarts a live session with the new selector.
  await settings.update('sqlFiles', result.sqlFiles, vscode.ConfigurationTarget.WorkspaceFolder);
  void deps.connection.ensureConnected();
}

/** `dynotable.pickIndex`: writes the chosen index into line 0 of the active `opensearch` buffer. */
export async function pickIndex(deps: CommandDeps): Promise<void> {
  const document = vscode.window.activeTextEditor?.document;
  if (document?.languageId !== 'opensearch') {
    void vscode.window.showInformationMessage('Open an OpenSearch query to pick its index.');
    return;
  }
  const client = await deps.client();
  if (!client) return;
  const session = deps.connection.current;
  let listing: unknown;
  try {
    listing = await client.sendRequest(LIST_INDICES, {});
  } catch (error) {
    await report(deps, client, error, LIST_INDICES);
    return;
  }
  if (!is(listIndicesSchema, listing)) {
    void vscode.window.showErrorMessage(unreadable('an index list'));
    return;
  }
  const {indices} = listing;
  if (indices.length === 0) {
    const failures = indexFailures(listing);
    void vscode.window.showWarningMessage(
      failures.length > 0 ? failures.join(' ') : 'DynoTable lists no OpenSearch index.'
    );
    return;
  }
  const item = await vscode.window.showQuickPick(
    indices.map((row) => ({label: row.name, detail: row.target, row})),
    {placeHolder: 'Select an OpenSearch index'}
  );
  // A replaced session can list the indices of another profile.
  if (!item || deps.connection.current !== session) return;
  const pin = pinFor(item.row, listing);
  if ('error' in pin) {
    void vscode.window.showWarningMessage(pin.error);
    return;
  }
  const line0 = document.lineAt(0);
  const edit = new vscode.WorkspaceEdit();
  edit.replace(document.uri, line0.range, applyPin(line0.text, pin));
  await vscode.workspace.applyEdit(edit);
}

/** Opens `Query-<n>` with the first `n` no open document uses. */
async function openQuery({language, text}: Query): Promise<void> {
  const open = new Set(vscode.workspace.textDocuments.map((document) => document.uri.toString()));
  const uriOf = (n: number) => vscode.Uri.parse(`untitled:Query-${n}${SUFFIXES[language]}`);
  let n = 1;
  while (open.has(uriOf(n).toString())) n++;
  const document = await vscode.workspace.openTextDocument(uriOf(n));
  const edit = new vscode.WorkspaceEdit();
  edit.insert(document.uri, new vscode.Position(0, 0), text);
  await vscode.workspace.applyEdit(edit);
  await vscode.window.showTextDocument(document);
}

/** The argument of the server's `command` lens around `caret`. Lens ranges are anchors only. */
async function lensArgsAt(
  client: LanguageClient,
  uri: string,
  caret: Position,
  command: string
): Promise<CommandArgs | undefined> {
  const lenses = await client.sendRequest(CodeLensRequest.type, {textDocument: {uri}});
  for (const lens of lenses ?? []) {
    const arg: unknown = lens.command?.arguments?.[0];
    if (lens.command?.command !== command || !is(commandArgsSchema, arg)) continue;
    if (arg.range && contains(arg.range, caret)) return arg;
  }
  return undefined;
}

async function runStatement(
  deps: CommandDeps,
  client: LanguageClient,
  args: CommandArgs
): Promise<void> {
  const outcome = await deps.connection.trackRun(() =>
    deps.panel.execute((token) =>
      client.sendRequest(
        ExecuteCommandRequest.type,
        {command: RUN_STATEMENT, arguments: [args]},
        token
      )
    )
  );
  if (!outcome) {
    void vscode.window.showWarningMessage(
      'A DynoTable run is in progress. Cancel it in the results panel, or wait for it to end.'
    );
  } else if (outcome.kind === 'unreadable') {
    void vscode.window.showErrorMessage(unreadable('a result'));
  } else if (outcome.kind === 'failed') {
    await report(deps, client, outcome.error, RUN_STATEMENT, args, outcome.cancelled);
  }
}

async function report(
  deps: CommandDeps,
  client: LanguageClient,
  error: unknown,
  command: string,
  args?: unknown,
  cancelled = false
): Promise<void> {
  const failure =
    error instanceof ResponseError
      ? {code: error.code, message: error.message, data: error.data as unknown}
      : {code: 0, message: error instanceof Error ? error.message : String(error)};
  const refusal = refusalOf(failure, cancelled, command);
  if (refusal.kind === 'silent') return;
  if (refusal.kind === 'status') {
    const model = deps.status();
    if (model.kind === 'disconnected') await deps.act(await notify(model.reason));
    return;
  }
  const picked = await vscode.window.showErrorMessage(
    refusal.message,
    ...refusal.actions.map((action) => REFUSAL_LABELS[action])
  );
  const action = refusal.actions.find((candidate) => REFUSAL_LABELS[candidate] === picked);
  await perform(deps, client, action, args);
}

async function perform(
  deps: CommandDeps,
  client: LanguageClient,
  action: RefusalAction | undefined,
  args: unknown
): Promise<void> {
  if (action === 'stage') {
    const {uri, range} = args as CommandArgs;
    await serverCommand(deps, client, OPEN_IN_APP, [range ? {uri, range} : {uri}]);
  } else {
    await deps.act(action);
  }
}

import {spawn} from 'node:child_process';
import {readdirSync, readFileSync, statSync, watch, type FSWatcher} from 'node:fs';
import {connect, type Socket} from 'node:net';
import {homedir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import * as vscode from 'vscode';
import type {LanguageClient} from 'vscode-languageclient/node';
import {
  bindingOf,
  documentSelector,
  LIST_TABLES,
  requestListing,
  startSession,
  toVscode,
  type Filter
} from './client';
import {
  attachSqlFile,
  newQuery,
  pickIndex,
  runActiveEditor,
  selectProfile,
  serverCommand,
  type CommandDeps
} from './commands';
import {ConnectCore, type State} from './connect-core';
import {
  currentPlatform,
  locateApp,
  overrides,
  portFilePath,
  readPortFile,
  userDataDir,
  type ExtensionMode,
  type Fs
} from './discovery';
import {Explorer} from './explorer';
import type {Node} from './explorer-model';
import type {RequestedProfile} from './profiles';
import {listTablesSchema} from './protocol';
import {REASONS, type Action} from './reasons';
import {ResultsPanel, type RunOutcome} from './results';
import type {View} from './results-model';
import {notify, paint, pickAction, STATUS_COMMAND, statusOf, type StatusModel} from './status';

export interface Seams {
  spawn: typeof spawn;
  openExternal(target: vscode.Uri): Thenable<boolean>;
}

/** Returned by `activate` in Test mode only. Tests replace `seams` to observe them. */
export interface TestApi {
  portFilePath: string;
  /** Where the app locator looks first. */
  appRoot: string | undefined;
  seams: Seams;
  status(): StatusModel;
  statusBar: vscode.StatusBarItem;
  context: vscode.ExtensionContext;
  /** Feeds the results panel's own receive path, as the webview does. */
  panel: {
    receive(message: unknown): Promise<void>;
    view(): View;
    outcome(): RunOutcome | undefined;
    close(): void;
  };
  explorer: {
    children(node?: Node): Promise<Node[]>;
    item(node: Node): vscode.TreeItem;
    message(): string | undefined;
  };
  /** The connected session's client. */
  client(): LanguageClient | undefined;
}

const MODES: Record<vscode.ExtensionMode, ExtensionMode> = {
  [vscode.ExtensionMode.Production]: 'production',
  [vscode.ExtensionMode.Development]: 'development',
  [vscode.ExtensionMode.Test]: 'test'
};

/** Workspace state key of the requested profile. */
const PROFILE_KEY = 'dynotable.profile';
const DOWNLOAD_URL = 'https://dynotable.com/download';
const DOCS_URL = 'https://dynotable.com/docs/editors';
/** How often to look for the userData directory while it does not exist. */
const DIRECTORY_POLL_MS = 2000;

/** A test that reaches a real process launch or browser open fails here instead. */
const refuse = (name: string) => () => {
  throw new Error(`${name} is disabled in tests; replace the seam`);
};

const fs: Fs = {
  readFile: (path) => readFileSync(path, 'utf8'),
  readdir: (path) => readdirSync(path),
  isFile: (path) => statSync(path, {throwIfNoEntry: false})?.isFile() ?? false
};

const connectTcp = (port: number) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
  });

/**
 * Watches the port file's directory, because an atomic rename replaces the file's inode. While the
 * directory does not exist, it polls for it.
 */
function watchPortFile(path: string, changed: () => void): vscode.Disposable {
  let watcher: FSWatcher | undefined;
  const arm = () => {
    try {
      watcher = watch(dirname(path), (_event, file) => {
        if (!file || file === basename(path)) changed();
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
      return true;
    } catch {
      return false;
    }
  };
  arm();
  const poll = setInterval(() => {
    if (!watcher && arm()) changed();
  }, DIRECTORY_POLL_MS);
  return {
    dispose: () => {
      clearInterval(poll);
      watcher?.close();
    }
  };
}

/** Read at each use, so a changed setting applies without a window reload. */
const setting = (name: 'userDataDir' | 'appPath') =>
  vscode.workspace.getConfiguration('dynotable').get<string>(name) || undefined;

let core: ConnectCore | undefined;
let results: ResultsPanel | undefined;

export function activate(context: vscode.ExtensionContext): TestApi | undefined {
  const mode = MODES[context.extensionMode];
  const test = mode === 'test';
  const platform = currentPlatform();
  const {testUserDataDir, testAppRoot, minAppVersion} = overrides(mode, process.env);
  const home = homedir();
  const portFile = () =>
    portFilePath(
      platform,
      testUserDataDir || setting('userDataDir') || userDataDir(platform, process.env, home)
    );
  const seams: Seams = {
    spawn: test ? (refuse('spawn') as typeof spawn) : spawn,
    openExternal: test ? refuse('openExternal') : vscode.env.openExternal
  };

  const output = vscode.window.createOutputChannel('DynoTable', {log: true});
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  const panel = new ResultsPanel(() =>
    readFileSync(join(context.extensionPath, 'dist', 'results.js'), 'utf8')
  );
  results = panel;
  context.subscriptions.push(output, item, panel);

  let selector: Filter[] = documentSelector();
  let matcher = toVscode(selector);
  const clients = new Map<number, LanguageClient>();
  let unbound = false;
  const requested = () => context.workspaceState.get<RequestedProfile>(PROFILE_KEY);
  const status = () => statusOf(connection.current, unbound, requested()?.name);
  const repaint = () => {
    paint(item, status());
    explorer.render();
  };

  const connection = new ConnectCore({
    platform,
    home,
    env: process.env,
    minAppVersion,
    launcherOff: () => setting('userDataDir') !== undefined,
    readPortFile: () => readPortFile(fs, portFile()),
    kill: (pid, signal) => process.kill(pid, signal),
    connect: connectTcp,
    locateApp: () =>
      locateApp(fs, {
        platform,
        env: process.env,
        home,
        appPath: setting('appPath') ?? '',
        testAppRoot
      }),
    // Read at call time, so a test that replaces the seam sees the call.
    spawn: (command, args, options) => seams.spawn(command, args, options),
    startSession: (params) => {
      const session = startSession(
        output,
        selector,
        (client, command, args) => serverCommand(deps, client, command, args),
        params,
        requested()?.id
      );
      clients.set(params.attempt, session.client);
      return {
        outcome: session.outcome,
        dispose: () => session.dispose().finally(() => clients.delete(params.attempt))
      };
    },
    onState: (state) => {
      unbound = false;
      repaint();
      if (state.kind === 'latched') void notify(state.reason).then(run);
      if (state.kind === 'connected') void listing(state);
    }
  });
  core = connection;

  // Showing the view is a lazy-connect trigger.
  const explorer = new Explorer(status, () => void connection.ensureConnected());
  context.subscriptions.push(explorer);

  /**
   * One `dynotable/listTables` decides unbound and fills the explorer. The bound state shows until
   * the answer arrives: a bound answer can take seconds.
   */
  async function listing(state: Extract<State, {kind: 'connected'}>): Promise<void> {
    const client = clients.get(state.attempt);
    if (!client) return;
    const tables = requestListing(client, LIST_TABLES, listTablesSchema, false);
    explorer.connected(client, tables);
    const binding = bindingOf(await tables);
    if (binding === 'missing-request') await connection.latch(state.attempt, 'missing-request');
    if (binding === 'unbound' && connection.current === state) {
      unbound = true;
      repaint();
    }
  }

  async function run(action: Action | undefined): Promise<void> {
    switch (action) {
      case 'reconnect':
        return connection.restart();
      case 'open-app': {
        const failed = await connection.openApp();
        if (failed) void vscode.window.showErrorMessage(REASONS[failed].sentence);
        return;
      }
      case 'download':
        await seams.openExternal(vscode.Uri.parse(DOWNLOAD_URL));
        return;
      case 'open-docs':
        await seams.openExternal(vscode.Uri.parse(DOCS_URL));
        return;
      case 'set-app-path':
        await vscode.commands.executeCommand('workbench.action.openSettings', 'dynotable.appPath');
        return;
      case 'select-profile':
        await vscode.commands.executeCommand('dynotable.selectProfile');
        return;
    }
  }

  const currentClient = () => {
    const state = connection.current;
    return state.kind === 'connected' ? clients.get(state.attempt) : undefined;
  };
  const inScope = (document: vscode.TextDocument) => vscode.languages.match(matcher, document) > 0;
  const deps: CommandDeps = {
    connection,
    panel,
    platform,
    status,
    act: run,
    inScope,
    requestProfile: async (profile) => {
      await context.workspaceState.update(PROFILE_KEY, profile);
      await connection.restart();
    },
    client: async () => {
      // A reason latched by this call was already shown, by `onState`.
      const latchedBefore = connection.current.kind === 'latched';
      await connection.ensureConnected();
      const state = connection.current;
      if (state.kind === 'connected') return currentClient();
      if (state.kind !== 'latched') {
        void vscode.window.showInformationMessage('DynoTable is reconnecting. Try again shortly.');
      } else if (latchedBefore) {
        await run(await notify(state.reason));
      }
      return undefined;
    }
  };
  const connectFor = (document: vscode.TextDocument) => {
    if (inScope(document)) void connection.ensureConnected();
  };
  /** A selector change needs a new client. A latch holds until Reconnect or a new port file. */
  const reselect = () => {
    selector = documentSelector();
    matcher = toVscode(selector);
    const {kind} = connection.current;
    if (kind !== 'idle' && kind !== 'latched') void connection.restart();
  };

  const armWatcher = () => watchPortFile(portFile(), () => connection.portFileChanged());
  let watcher = armWatcher();

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(connectFor),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('dynotable.sqlFiles')) reselect();
      // Another user data directory is another app: its port file decides, as after a restart.
      if (event.affectsConfiguration('dynotable.userDataDir')) {
        watcher.dispose();
        watcher = armWatcher();
        if (connection.current.kind !== 'idle') void connection.restart();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(reselect),
    vscode.commands.registerCommand(STATUS_COMMAND, async () => run(await pickAction(status()))),
    vscode.commands.registerCommand('dynotable.reconnect', () => connection.restart()),
    vscode.commands.registerCommand('dynotable.run', () => runActiveEditor(deps)),
    vscode.commands.registerCommand('dynotable.openDocs', () => run('open-docs')),
    vscode.commands.registerCommand('dynotable.selectProfile', () => selectProfile(deps)),
    vscode.commands.registerCommand('dynotable.newQuery', (node?: Node) => newQuery(node)),
    vscode.commands.registerCommand('dynotable.attachSqlFile', () => attachSqlFile(deps)),
    vscode.commands.registerCommand('dynotable.pickIndex', () => pickIndex(deps)),
    vscode.commands.registerCommand('dynotable.refreshExplorer', async () => {
      if (await deps.client()) explorer.refresh();
    }),
    {dispose: () => watcher.dispose()}
  );
  // Editors restored at startup opened before activation.
  for (const document of vscode.workspace.textDocuments) connectFor(document);
  if (explorer.view.visible) void connection.ensureConnected();

  if (!test) return undefined;
  return {
    get portFilePath() {
      return portFile();
    },
    get appRoot() {
      return setting('appPath') || testAppRoot;
    },
    seams,
    status,
    statusBar: item,
    context,
    panel: {
      receive: (message) => panel.receive(message),
      view: () => panel.current,
      outcome: () => panel.last,
      close: () => panel.close()
    },
    explorer: {
      children: (node) => explorer.getChildren(node),
      item: (node) => explorer.getTreeItem(node),
      message: () => explorer.view.message
    },
    client: currentClient
  };
}

export function deactivate(): Promise<void> | undefined {
  // Cancels a run before the session stops.
  results?.dispose();
  return core?.dispose();
}

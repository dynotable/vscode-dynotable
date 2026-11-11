import {strict as assert} from 'node:assert';
import {EventEmitter} from 'node:events';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import * as vscode from 'vscode';
import type {SpawnOptions} from '../connect-core';
import type {TestApi} from '../extension';
import {readPortFile} from '../discovery';
import type {Node} from '../explorer-model';
import type {PortFile} from '../protocol';
import {FakeServer} from './fake-server';
import {guardedSpawn, liveAppPath} from './live-app';

export const EXTENSION_ID = 'dynotable.vscode-dynotable';

/** Set by the launcher for every harness run. */
export function harnessEnv(
  name:
    | 'DYNOTABLE_HARNESS_DIR'
    | 'DYNOTABLE_TEST_USER_DATA_DIR'
    | 'DYNOTABLE_LIVE_USER_DATA_DIR'
    | 'DYNOTABLE_LAUNCHER_HANDOFF'
): string {
  return process.env[name] ?? '';
}

export type ToastKind = 'error' | 'warning' | 'information';

/** Every `window.show*Message` call made while the stubs are in place. */
export const toasts: Array<{kind: ToastKind; message: string}> = [];

/** Message → the action label the stub picks for it. Any other toast is dismissed. */
export const toastAnswers = new Map<string, string>();

/**
 * Every `window.showQuickPick` call's items. The stub picks the item labelled `answer`, after
 * `during` ends: what happens while the picker is open.
 */
export const quickPicks: {
  shown: vscode.QuickPickItem[][];
  answer: string | undefined;
  during?: () => Thenable<unknown>;
} = {
  shown: [],
  answer: undefined
};

/** The `window.showSaveDialog` stub returns `answer` and keeps the last call's `defaultUri`. */
export const saveDialogs: {answer: vscode.Uri | undefined; defaultUri: vscode.Uri | undefined} = {
  answer: undefined,
  defaultUri: undefined
};

/** Every `window.setStatusBarMessage` text, in call order. */
export const statusMessages: string[] = [];

/** Every string written to an output channel created while the stub is in place. */
export const channelText: string[] = [];

/**
 * Test files load from the extension's own folder, so they share its `vscode` API object: these
 * stubs count the library's toasts and channels as well as ours, and no toast waits for a click.
 */
export function stubWindow(): void {
  const window = vscode.window as unknown as Record<string, unknown>;
  for (const kind of ['error', 'warning', 'information'] as const) {
    window[`show${kind[0]?.toUpperCase()}${kind.slice(1)}Message`] = (message: string) => {
      toasts.push({kind, message});
      return Promise.resolve(toastAnswers.get(message));
    };
  }
  window.showQuickPick = async (items: Thenable<vscode.QuickPickItem[]>) => {
    const resolved = await items;
    quickPicks.shown.push(resolved);
    await quickPicks.during?.();
    return resolved.find((item) => item.label === quickPicks.answer);
  };
  window.showSaveDialog = (options?: vscode.SaveDialogOptions) => {
    saveDialogs.defaultUri = options?.defaultUri;
    return Promise.resolve(saveDialogs.answer);
  };
  window.setStatusBarMessage = (text: string) => {
    statusMessages.push(text);
    return new vscode.Disposable(() => {});
  };
  const create = vscode.window.createOutputChannel.bind(vscode.window) as (
    ...args: unknown[]
  ) => object;
  window.createOutputChannel = (...args: unknown[]) =>
    new Proxy(create(...args), {
      get(target, key) {
        const value: unknown = Reflect.get(target, key);
        if (typeof value !== 'function') return value;
        return (...callArgs: unknown[]) => {
          for (const arg of callArgs) if (typeof arg === 'string') channelText.push(arg);
          return value.apply(target, callArgs);
        };
      }
    });
}

export function extension(): vscode.Extension<TestApi | undefined> {
  return (
    vscode.extensions.getExtension<TestApi | undefined>(EXTENSION_ID) ??
    assert.fail(`${EXTENSION_ID} is not loaded`)
  );
}

export async function api(): Promise<TestApi> {
  return (await extension().activate()) ?? assert.fail('activate returned no test API');
}

/** A fake that writes its port file where the harness put the test userData directory. */
export function fakeServer(): FakeServer {
  // In a live run, that directory is the real app's: the fake would overwrite its port file.
  if (harnessEnv('DYNOTABLE_LIVE_USER_DATA_DIR')) throw new Error('No fake server in a live run');
  return new FakeServer(
    join(harnessEnv('DYNOTABLE_TEST_USER_DATA_DIR'), 'lsp-port.json'),
    join(extension().extensionPath, 'contract')
  );
}

export {sleep};

export const workspace = join(harnessEnv('DYNOTABLE_HARNESS_DIR'), 'workspace');

export async function show(name: string, text: string): Promise<vscode.TextEditor> {
  writeFileSync(join(workspace, name), text);
  const document = await vscode.workspace.openTextDocument(join(workspace, name));
  return vscode.window.showTextDocument(document, vscode.ViewColumn.One);
}

export async function waitFor(
  what: string,
  condition: () => boolean | Promise<boolean>,
  ms = 15_000
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

export async function waitForStatus(kind: string, reason?: string, ms?: number): Promise<void> {
  const {status} = await api();
  await waitFor(
    `status ${kind} ${reason ?? ''}`,
    () => {
      const model = status();
      return (
        model.kind === kind &&
        (reason === undefined || ('reason' in model && model.reason === reason))
      );
    },
    ms
  );
}

/** Opens an in-scope buffer, a lazy-connect trigger, and waits for a live session, bound or not. */
export async function session(ms?: number): Promise<void> {
  const path = join(workspace, 'session.partiql');
  writeFileSync(path, 'SELECT 1');
  await vscode.workspace.openTextDocument(path);
  const {status} = await api();
  await waitFor('a session', () => ['connected', 'unbound'].includes(status().kind), ms);
}

/** The explorer's root group `label`. A group shows once its own listing arrives. */
export async function explorerGroup(label: string): Promise<Node> {
  let found: Node | undefined;
  await waitFor(`the ${label} group`, async () => {
    found = (await (await api()).explorer.children()).find(
      (node) => node.kind === 'group' && node.label === label
    );
    return found !== undefined;
  });
  return found ?? assert.fail(`no ${label} group`);
}

/** An installed app in the harness app root, for the current platform's locator. */
export async function installFakeApp(): Promise<void> {
  const root = (await api()).appRoot ?? assert.fail('no app root');
  const files: Record<string, string> =
    process.platform === 'darwin'
      ? {
          'DynoTable.app/Contents/MacOS/DynoTable': '',
          'DynoTable.app/Contents/Info.plist':
            '<key>CFBundleShortVersionString</key><string>1.19.0</string>'
        }
      : process.platform === 'win32'
        ? {'app-1.19.0/dynotable.exe': ''}
        : {dynotable: ''};
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), {recursive: true});
    writeFileSync(join(root, file), text);
  }
}

/** Replaces the spawn seam with one that records each launch and reports a started child. */
export async function recordSpawns(): Promise<Array<{command: string; args: string[]}>> {
  const spawns: Array<{command: string; args: string[]}> = [];
  (await api()).seams.spawn = ((command: string, args: string[]) => {
    spawns.push({command, args});
    const child = Object.assign(new EventEmitter(), {unref: () => {}});
    setImmediate(() => child.emit('spawn'));
    return child;
  }) as unknown as TestApi['seams']['spawn'];
  return spawns;
}

export interface Spawned {
  command: string;
  args: string[];
  pid: number | undefined;
  exit: Promise<{code: number | null; signal: string | null}>;
}

/**
 * Launcher runs: replaces the spawn seam with a real spawn of the wrapper with `--headless`, and
 * records each launch. A refused one is recorded too, so the test sees it.
 */
export async function launcherSpawns(): Promise<Spawned[]> {
  const spawn = guardedSpawn(liveAppPath());
  const spawns: Spawned[] = [];
  (await api()).seams.spawn = ((command: string, args: string[], options: SpawnOptions) => {
    const record: Spawned = {command, args: [...args], pid: undefined, exit: new Promise(() => {})};
    spawns.push(record);
    const child = spawn(command, args, options);
    record.pid = child.pid;
    record.exit = new Promise((resolve) =>
      child.once('exit', (code, signal) => resolve({code, signal}))
    );
    return child;
  }) as unknown as TestApi['seams']['spawn'];
  return spawns;
}

/** The live port file, parsed. Never print its token. */
export async function livePortFile(): Promise<PortFile | undefined> {
  return readPortFile({readFile: (path) => readFileSync(path, 'utf8')}, (await api()).portFilePath);
}

/** Selects the roster row DYNOTABLE_LIVE_PROFILE names and waits for the bound session. */
export async function bindLiveProfile(): Promise<void> {
  const profile = process.env.DYNOTABLE_LIVE_PROFILE ?? '';
  quickPicks.answer = undefined;
  quickPicks.shown.length = 0;
  await vscode.commands.executeCommand('dynotable.selectProfile');
  const item = quickPicks.shown[0]?.find(
    (row) => row.label === profile || row.description === profile
  );
  assert.ok(item, 'DYNOTABLE_LIVE_PROFILE names no roster row');
  quickPicks.answer = item.label;
  await vscode.commands.executeCommand('dynotable.selectProfile');
  await waitForStatus('connected');
}

/** Runs a PartiQL SELECT on the seeded `orders` table; it must show rows and no toast. */
export async function runOrders(): Promise<void> {
  toasts.length = 0;
  await show('orders.partiql', 'SELECT * FROM "orders"');
  await vscode.commands.executeCommand('dynotable.run');
  assert.deepEqual(toasts, []);
  const view = (await api()).panel.view();
  assert.equal(view.kind, 'result');
  assert.ok(view.cells.length > 0, 'the run returned no rows');
}

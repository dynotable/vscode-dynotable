/**
 * Launches VS Code once per integration test file, at the `engines` floor and on stable, each time
 * with fresh temp directories, so no state leaks between files.
 *
 *   pnpm test:integration [file-name-filter …]
 *   pnpm test:live [file-name-filter …]
 *   pnpm test:live:coordinated <test-name>
 *   pnpm test:live:launcher [file-name-filter …]
 *
 * `--live` runs only the tests tagged `@live`, against the real app whose userData directory is
 * DYNOTABLE_LIVE_USER_DATA_DIR. A file that holds `@live` tests holds no fake-backed test: a fake
 * would overwrite the real app's port file.
 *
 * `--coordinated` runs the one `@live-coordinated` test whose name holds `<test-name>`. Each one
 * waits for a person to change the app's state, so it runs on one VS Code version (stable unless
 * DYNOTABLE_VSCODE_VERSIONS is set), with the launcher off as for an app on a custom userData
 * directory.
 *
 * `--launcher` runs the `@live-launcher` tests (macOS), with the launcher on: the extension starts
 * the app itself, through DYNOTABLE_LIVE_APP_PATH, a wrapper that starts the app on
 * DYNOTABLE_LIVE_USER_DATA_DIR. The spawn seam is real for that path with `--headless` only. The
 * `live-launcher-reuse-*` files are one case over two VS Code launches, so they run in order. At
 * the end, every app process on that directory is stopped.
 *
 * DYNOTABLE_TEST_DISPLAY (macOS) names the display that VS Code's windows open on.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {runTests} from '@vscode/test-electron';
import {currentPlatform, userDataDir} from '../discovery';
import {onDisplay} from './display';
import {liveAppPath, stopApps} from './live-app';

const root = resolve(__dirname, '../../..');

/** Written to the fixture workspace before launch, or to user settings when no folder opens. */
const SETTINGS = {'dynotable.trace.server': 'verbose'};

/** The live userData directory. Never the real app's own one: the live suite must not touch it. */
function liveUserData(required: string[]): string {
  const dir = process.env.DYNOTABLE_LIVE_USER_DATA_DIR;
  if (!dir) throw new Error('test:live needs DYNOTABLE_LIVE_USER_DATA_DIR.');
  for (const name of required) if (!process.env[name]) throw new Error(`test:live needs ${name}.`);
  const platform = currentPlatform();
  const canonical = (path: string) => {
    let full = resolve(path);
    try {
      full = realpathSync(full);
    } catch {}
    return platform === 'linux' ? full : full.toLowerCase();
  };
  if (canonical(dir) === canonical(userDataDir(platform, process.env, homedir()))) {
    throw new Error('DYNOTABLE_LIVE_USER_DATA_DIR is the real DynoTable userData directory.');
  }
  // Another app's directory, for example the one a development build of the app runs on.
  const deny = process.env.DYNOTABLE_LIVE_DENY_USER_DATA_DIR;
  if (deny && canonical(dir) === canonical(deny)) {
    throw new Error('DYNOTABLE_LIVE_USER_DATA_DIR is DYNOTABLE_LIVE_DENY_USER_DATA_DIR.');
  }
  return resolve(dir);
}

/** Launches that differ from the default fixture folder or environment. */
const LAYOUTS: Record<
  string,
  {folder?: false; open?: string; workspaceFile?: true; env?: Record<string, string>}
> = {
  'no-folder.test.js': {folder: false},
  // A single-folder window that gains a folder enters a workspace, which restarts the extensions.
  'workspace-folders.test.js': {workspaceFile: true},
  // An in-scope editor that is already open when the extension activates.
  'restored.test.js': {open: 'restored.partiql'},
  // Above any app version, so the running app is too old.
  'live-version.test.js': {env: {DYNOTABLE_MIN_APP_VERSION: '99.0.0'}}
};

type Mode = 'fake' | 'live' | 'coordinated' | 'launcher';

/** By test titles only: a comment or another string that names a tag does not move a file. */
const modeOf = (text: string): Mode =>
  /["'`]@live-coordinated /.test(text)
    ? 'coordinated'
    : /["'`]@live-launcher /.test(text)
      ? 'launcher'
      : /["'`]@live /.test(text)
        ? 'live'
        : 'fake';

async function main(): Promise<void> {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const floor = (manifest.engines.vscode as string).replace(/^\^/, '');
  const mode: Mode = process.argv.includes('--coordinated')
    ? 'coordinated'
    : process.argv.includes('--launcher')
      ? 'launcher'
      : process.argv.includes('--live')
        ? 'live'
        : 'fake';
  if (mode === 'launcher' && process.platform !== 'darwin') {
    throw new Error('test:live:launcher needs macOS.');
  }
  const live = mode !== 'fake';
  const versions =
    process.env.DYNOTABLE_VSCODE_VERSIONS?.split(',') ??
    (mode === 'coordinated' ? ['stable'] : [floor, 'stable']);
  const liveDir = live
    ? liveUserData(
        mode === 'launcher'
          ? ['DYNOTABLE_LIVE_PROFILE']
          : ['DYNOTABLE_LIVE_PROFILE', 'DYNOTABLE_LIVE_LARGE_TABLE']
      )
    : '';
  const app = mode === 'launcher' ? liveAppPath() : '';
  // A machine-scope setting: VS Code reads it from user settings only.
  const userSettings = {
    fake: undefined,
    live: undefined,
    coordinated: {'dynotable.userDataDir': liveDir},
    launcher: {'dynotable.appPath': app}
  }[mode];
  const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  // Coordinated: the argument names the test, not the file.
  if (mode === 'coordinated' && args.length !== 1) {
    throw new Error('test:live:coordinated needs one test name.');
  }
  const filters = mode === 'coordinated' ? [] : args;
  const grep = {
    fake: '',
    live: '@live ',
    coordinated: `@live-coordinated ${args[0]}`,
    launcher: '@live-launcher '
  }[mode];
  const files = readdirSync(__dirname)
    .filter((file) => file.endsWith('.test.js'))
    .filter((file) => modeOf(readFileSync(join(__dirname, file), 'utf8')) === mode)
    .filter((file) => filters.length === 0 || filters.some((filter) => file.includes(filter)))
    .toSorted();
  if (files.length === 0) throw new Error('No integration test file matched.');
  // The fake serves the recorded app's version, which can predate MIN_APP_VERSION.
  const recorded = JSON.parse(readFileSync(join(root, 'contract', 'initialize.json'), 'utf8'));
  // Outlives each launch: the first reuse file hands the app's pid to the second.
  const handoff = mkdtempSync(join(tmpdir(), 'dynotable-handoff-'));
  try {
    for (const version of versions) {
      for (const file of files) {
        const dir = mkdtempSync(join(tmpdir(), 'dynotable-it-'));
        const workspace = join(dir, 'workspace');
        const layout = LAYOUTS[file] ?? {};
        const settingsDir =
          layout.folder === false ? join(dir, 'user-data', 'User') : join(workspace, '.vscode');
        mkdirSync(settingsDir, {recursive: true});
        writeFileSync(join(settingsDir, 'settings.json'), JSON.stringify(SETTINGS));
        if (userSettings) {
          mkdirSync(join(dir, 'user-data', 'User'), {recursive: true});
          writeFileSync(
            join(dir, 'user-data', 'User', 'settings.json'),
            JSON.stringify(userSettings)
          );
        }
        const opened = layout.open ? [join(workspace, layout.open)] : [];
        const target = layout.workspaceFile ? join(dir, 'fixture.code-workspace') : workspace;
        if (layout.workspaceFile) {
          writeFileSync(target, JSON.stringify({folders: [{path: 'workspace'}]}));
        }
        for (const path of opened) writeFileSync(path, 'SELECT * FROM "orders"');
        console.log(`\n▶ ${file} on VS Code ${version}`);
        const launch = () =>
          runTests({
            version,
            extensionDevelopmentPath: root,
            extensionTestsPath: join(__dirname, 'index.js'),
            launchArgs: [
              ...(layout.folder === false ? [] : [target]),
              ...opened,
              '--user-data-dir',
              join(dir, 'user-data'),
              '--extensions-dir',
              join(dir, 'extensions'),
              '--disable-extensions',
              // The manifest refuses untrusted workspaces, so an untrusted fixture folder would
              // leave the extension disabled.
              '--disable-workspace-trust',
              // Every log channel of the extension at Trace: the trace-sink test needs it.
              '--log',
              'dynotable.vscode-dynotable:trace'
            ],
            extensionTestsEnv: {
              DYNOTABLE_TEST_FILE: file,
              DYNOTABLE_HARNESS_DIR: dir,
              DYNOTABLE_TEST_USER_DATA_DIR: live ? liveDir : join(dir, 'dynotable'),
              DYNOTABLE_TEST_APP_ROOT: join(dir, 'app'),
              DYNOTABLE_LIVE_USER_DATA_DIR: liveDir,
              DYNOTABLE_LIVE_APP_PATH: app,
              DYNOTABLE_LAUNCHER_HANDOFF: join(handoff, 'app.json'),
              DYNOTABLE_TEST_GREP: grep,
              // Live: the shell's value, set when the app build is unreleased.
              ...(live ? {} : {DYNOTABLE_MIN_APP_VERSION: recorded.serverInfo.version}),
              ...layout.env
            }
          });
        const display = process.env.DYNOTABLE_TEST_DISPLAY;
        try {
          await (display ? onDisplay(display, dir, launch) : launch());
        } finally {
          rmSync(dir, {recursive: true, force: true});
        }
      }
    }
  } finally {
    rmSync(handoff, {recursive: true, force: true});
    if (mode === 'launcher') await stopApps(liveDir);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

import {posix, win32} from 'node:path';
import {gte, rcompare, valid} from 'semver';
import {is, portFileSchema, type PortFile} from './protocol';

export type Platform = 'darwin' | 'win32' | 'linux';

export const currentPlatform = (): Platform =>
  process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux';
export type Env = Record<string, string | undefined>;

/** Mirrors `vscode.ExtensionMode`, which a pure module cannot import. */
export type ExtensionMode = 'production' | 'development' | 'test';

/** The first app release that serves everything this extension needs. Its pre-releases do not pass. */
export const MIN_APP_VERSION = '1.19.0';

/** Synchronous file reads; each one throws when the path is missing. */
export interface Fs {
  readFile(path: string): string;
  readdir(path: string): string[];
  isFile(path: string): boolean;
}

export interface Overrides {
  testUserDataDir?: string;
  testAppRoot?: string;
  minAppVersion: string;
}

/** Test seams apply only in Test mode. The minimum-version override never applies in Production. */
export function overrides(mode: ExtensionMode, env: Env): Overrides {
  const test = mode === 'test';
  return {
    testUserDataDir: test ? env.DYNOTABLE_TEST_USER_DATA_DIR || undefined : undefined,
    testAppRoot: test ? env.DYNOTABLE_TEST_APP_ROOT || undefined : undefined,
    minAppVersion: (mode !== 'production' && env.DYNOTABLE_MIN_APP_VERSION) || MIN_APP_VERSION
  };
}

const pathFor = (platform: Platform) => (platform === 'win32' ? win32 : posix);

export function userDataDir(platform: Platform, env: Env, home: string): string {
  const path = pathFor(platform);
  switch (platform) {
    case 'darwin':
      return path.join(home, 'Library', 'Application Support', 'DynoTable');
    case 'win32':
      return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'DynoTable');
    case 'linux':
      return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'DynoTable');
  }
}

export const portFilePath = (platform: Platform, userData: string) =>
  pathFor(platform).join(userData, 'lsp-port.json');

/** `undefined` when the file is missing or does not parse as a port file. */
export function readPortFile(fs: Pick<Fs, 'readFile'>, path: string): PortFile | undefined {
  try {
    const value: unknown = JSON.parse(fs.readFile(path));
    return is(portFileSchema, value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function meetsMinimum(version: string | undefined, minimum: string): boolean {
  return version !== undefined && valid(version) !== null && gte(version, minimum);
}

export interface AppLocation {
  /** The executable to spawn. */
  binary: string;
  /** The `.app` bundle on macOS, for `open -a`. */
  bundle?: string;
  /** `undefined` where it cannot be read before launch (Linux). */
  version?: string;
}

/** NuGet strips the dots inside a pre-release part: `app-1.19.0-beta1` is `1.19.0-beta.1`. */
function versionFromAppFolder(folder: string): string | undefined {
  const match = /^app-(\d+\.\d+\.\d+)(?:-(.+))?$/.exec(folder);
  if (!match) return undefined;
  const pre = match[2]?.replace(/(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])/g, '.');
  return valid(pre ? `${match[1]}-${pre}` : match[1]) ?? undefined;
}

function macBundle(fs: Fs, bundle: string): AppLocation | undefined {
  const binary = posix.join(bundle, 'Contents', 'MacOS', 'DynoTable');
  if (!fs.isFile(binary)) return undefined;
  let version: string | undefined;
  try {
    const plist = fs.readFile(posix.join(bundle, 'Contents', 'Info.plist'));
    version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
  } catch {
    // An unreadable Info.plist leaves the version unknown.
  }
  return {binary, bundle, version};
}

/** The stub `dynotable.exe` does not forward its child's exit code, so the newest `app-*` runs. */
function squirrelRoot(fs: Fs, root: string): AppLocation | undefined {
  let folders: string[];
  try {
    folders = fs.readdir(root);
  } catch {
    return undefined;
  }
  return folders
    .map((folder) => ({
      version: versionFromAppFolder(folder),
      binary: win32.join(root, folder, 'dynotable.exe')
    }))
    .filter((app): app is AppLocation & {version: string} => app.version !== undefined)
    .filter((app) => fs.isFile(app.binary))
    .toSorted((a, b) => rcompare(a.version, b.version))[0];
}

function fromAppPath(fs: Fs, platform: Platform, appPath: string): AppLocation | undefined {
  // A path to the executable inside a bundle or an `app-*` folder keeps that version, so an old app
  // is still refused before it can open its window.
  if (platform === 'darwin') {
    const bundle = /^(.+\.app)(?:\/Contents\/MacOS\/[^/]+)?$/.exec(appPath)?.[1];
    if (bundle) return macBundle(fs, bundle);
  }
  if (platform === 'win32') {
    const app = squirrelRoot(fs, win32.dirname(appPath));
    if (app) return app;
    const version = versionFromAppFolder(win32.basename(win32.dirname(appPath)));
    if (version && fs.isFile(appPath)) return {binary: appPath, version};
  }
  return fs.isFile(appPath) ? {binary: appPath} : undefined;
}

export interface LocateInput {
  platform: Platform;
  env: Env;
  home: string;
  /** The `dynotable.appPath` setting, empty when unset. */
  appPath: string;
  /** Test mode only: replaces every standard install location. */
  testAppRoot?: string;
}

export function locateApp(fs: Fs, input: LocateInput): AppLocation | undefined {
  const {platform, env, home, appPath, testAppRoot} = input;
  if (appPath) return fromAppPath(fs, platform, appPath);
  switch (platform) {
    case 'darwin': {
      const bundles = testAppRoot
        ? [posix.join(testAppRoot, 'DynoTable.app')]
        : ['/Applications/DynoTable.app', posix.join(home, 'Applications', 'DynoTable.app')];
      for (const bundle of bundles) {
        const app = macBundle(fs, bundle);
        if (app) return app;
      }
      return undefined;
    }
    case 'win32': {
      const local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
      return squirrelRoot(fs, testAppRoot ?? win32.join(local, 'dynotable'));
    }
    case 'linux': {
      const binary = testAppRoot ? posix.join(testAppRoot, 'dynotable') : '/usr/bin/dynotable';
      return fs.isFile(binary) ? {binary} : undefined;
    }
  }
}

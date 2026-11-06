import {describe, expect, it} from 'vitest';
import {
  locateApp,
  meetsMinimum,
  MIN_APP_VERSION,
  overrides,
  readPortFile,
  userDataDir,
  type Fs,
  type LocateInput
} from './discovery';

/** Files by absolute path. A directory exists when some file sits below it. */
function fakeFs(files: Record<string, string>, sep = '/'): Fs {
  return {
    readFile(path) {
      if (!(path in files)) throw Object.assign(new Error(path), {code: 'ENOENT'});
      return files[path] as string;
    },
    readdir(path) {
      const prefix = path + sep;
      const names = Object.keys(files)
        .filter((file) => file.startsWith(prefix))
        .map((file) => file.slice(prefix.length).split(sep)[0] as string);
      if (names.length === 0) throw Object.assign(new Error(path), {code: 'ENOENT'});
      return [...new Set(names)];
    },
    isFile: (path) => path in files
  };
}

describe('userDataDir', () => {
  it.each([
    ['darwin', {}, '/Users/u/Library/Application Support/DynoTable'],
    ['win32', {APPDATA: 'D:\\Roaming'}, 'D:\\Roaming\\DynoTable'],
    ['linux', {XDG_CONFIG_HOME: '/cfg'}, '/cfg/DynoTable'],
    ['linux', {}, '/Users/u/.config/DynoTable']
  ] as const)('%s with %o', (platform, env, expected) => {
    expect(userDataDir(platform, env, '/Users/u')).toBe(expected);
  });
});

describe('overrides', () => {
  const env = {
    DYNOTABLE_TEST_USER_DATA_DIR: '/tmp/ud',
    DYNOTABLE_TEST_APP_ROOT: '/tmp/apps',
    DYNOTABLE_MIN_APP_VERSION: '0.0.1'
  };

  // An inherited environment must not redirect a shipped extension to another app or port file.
  it('Production ignores the Test seams and the minimum-version override', () => {
    expect(overrides('production', env)).toEqual({minAppVersion: MIN_APP_VERSION});
  });

  it('Development ignores the Test seams and applies the override', () => {
    expect(overrides('development', env)).toEqual({minAppVersion: '0.0.1'});
  });

  it('Test applies the seams', () => {
    expect(overrides('test', env)).toEqual({
      testUserDataDir: '/tmp/ud',
      testAppRoot: '/tmp/apps',
      minAppVersion: '0.0.1'
    });
  });
});

const read = (text: string) => readPortFile(fakeFs({'/p': text}), '/p');

describe('readPortFile', () => {
  // An older app writes no pid; refusing it would block the version gate from saying "update".
  it('reads a file with no pid', () => {
    expect(read('{"port":41120,"token":"t"}')).toEqual({port: 41120, token: 't'});
  });

  it.each([
    ['truncated JSON', '{"port":41120,"tok'],
    ['port as a string', '{"port":"41120","token":"t"}']
  ])('treats %s as no file', (_name, text) => {
    expect(read(text)).toBeUndefined();
  });
});

describe('meetsMinimum', () => {
  it.each([
    ['the minimum’s pre-release', '1.19.0-beta.1', true],
    ['a later version’s pre-release', '1.20.0-beta.1', true],
    ['a version below the minimum', '1.18.2', false],
    ['no version (an old app)', undefined, false],
    // `semver.gte` throws on it, which would leave the attempt with no reason.
    ['a version that is not semver', '1.19', false]
  ])('%s', (_name, version, expected) => {
    expect(meetsMinimum(version, '1.19.0-0')).toBe(expected);
  });
});

const squirrel = (folders: string[], extra: Record<string, string> = {}) =>
  fakeFs(
    {
      'C:\\L\\dynotable\\dynotable.exe': '',
      ...Object.fromEntries(folders.map((f) => [`C:\\L\\dynotable\\${f}\\dynotable.exe`, ''])),
      ...extra
    },
    '\\'
  );

describe('locateApp', () => {
  const base: LocateInput = {
    platform: 'win32',
    env: {LOCALAPPDATA: 'C:\\L'},
    home: 'C:\\U',
    appPath: ''
  };

  // A string sort would pick 1.9.0 and launch an old app.
  it('picks app-1.10.0 over app-1.9.0', () => {
    expect(locateApp(squirrel(['app-1.9.0', 'app-1.10.0']), base)).toEqual({
      binary: 'C:\\L\\dynotable\\app-1.10.0\\dynotable.exe',
      version: '1.10.0'
    });
  });

  it('maps app-1.19.0-beta1 back to 1.19.0-beta.1', () => {
    expect(locateApp(squirrel(['app-1.19.0-beta1']), base)?.version).toBe('1.19.0-beta.1');
  });

  // Squirrel leaves a half-installed or cleaned-up folder behind during an update.
  it('skips a folder without an executable', () => {
    const fs = squirrel(['app-1.19.0'], {'C:\\L\\dynotable\\app-1.20.0\\Update.log': ''});
    expect(locateApp(fs, base)?.version).toBe('1.19.0');
  });

  // The stub does not forward its child's exit code, so the launcher would never see exit 3.
  it('resolves a Windows stub app path to its newest app-*', () => {
    const fs = squirrel(['app-1.19.0', 'app-1.20.0']);
    expect(locateApp(fs, {...base, appPath: 'C:\\L\\dynotable\\dynotable.exe'})?.binary).toBe(
      'C:\\L\\dynotable\\app-1.20.0\\dynotable.exe'
    );
  });

  // A path to the bundle's executable must not lose the version, or an old app opens its window.
  it.each(['/Apps/DynoTable.app', '/Apps/DynoTable.app/Contents/MacOS/DynoTable'])(
    'resolves app path %s to the bundle binary and plist version',
    (appPath) => {
      const fs = fakeFs({
        '/Apps/DynoTable.app/Contents/MacOS/DynoTable': '',
        '/Apps/DynoTable.app/Contents/Info.plist':
          '<dict><key>CFBundleShortVersionString</key>\n\t<string>1.19.0</string></dict>'
      });
      expect(locateApp(fs, {platform: 'darwin', env: {}, home: '/U', appPath})).toEqual({
        binary: '/Apps/DynoTable.app/Contents/MacOS/DynoTable',
        bundle: '/Apps/DynoTable.app',
        version: '1.19.0'
      });
    }
  );

  it('keeps the app-* folder version of a Windows app path to its dynotable.exe', () => {
    const fs = squirrel(['app-1.18.0']);
    const appPath = 'C:\\L\\dynotable\\app-1.18.0\\dynotable.exe';
    expect(locateApp(fs, {...base, appPath})).toEqual({binary: appPath, version: '1.18.0'});
  });
});

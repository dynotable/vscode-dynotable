import {join} from 'node:path';
import {expect, it} from 'vitest';
import {RELEASES_URL, resolveBinary} from './resolve-platform.mjs';

/** A `require.resolve` that knows the installed packages. */
const installed =
  (...names: string[]) =>
  (request: string) => {
    const name = request.replace(/\/package\.json$/, '');
    if (!names.includes(name)) throw new Error(`Cannot find module '${request}'`);
    return join('/nm', name, 'package.json');
  };

it('darwin-arm64 resolves to its package binary', () => {
  expect(resolveBinary('darwin', 'arm64', installed('@dynotable/cli-darwin-arm64'))).toBe(
    join('/nm', '@dynotable/cli-darwin-arm64', 'bin', 'dynotable-cli')
  );
});

it('win32 resolves to the win package and the .exe', () => {
  expect(resolveBinary('win32', 'x64', installed('@dynotable/cli-win-x64'))).toBe(
    join('/nm', '@dynotable/cli-win-x64', 'bin', 'dynotable-cli.exe')
  );
});

it('an unsupported platform names it and the Releases URL', () => {
  expect(() => resolveBinary('darwin', 'x64', installed())).toThrow(
    `dynotable-cli has no binary for darwin-x64. See ${RELEASES_URL}`
  );
});

it('a missing platform package names the platform and the Releases URL', () => {
  const error = (() => {
    try {
      resolveBinary('linux', 'x64', installed('@dynotable/cli-darwin-arm64'));
    } catch (thrown) {
      return (thrown as Error).message;
    }
    return '';
  })();
  expect(error).toContain('@dynotable/cli-linux-x64 for linux-x64 is not installed');
  expect(error).toContain(RELEASES_URL);
});

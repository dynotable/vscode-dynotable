import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {expect, it} from 'vitest';
import {CLI_MIN_APP_VERSION, releaseFloor} from './version';

// A lower floor in a release would let the CLI open editor sessions on an app that ignores
// `purpose`.
it('a release build refuses a floor below CLI_MIN_APP_VERSION', () => {
  expect(() => releaseFloor('1.19.9')).toThrow(CLI_MIN_APP_VERSION);
  expect(() => releaseFloor('not-a-version')).toThrow('invalid');
  expect(releaseFloor(undefined)).toBe('1.20.0');
  expect(releaseFloor('1.21.0')).toBe('1.21.0');
});

// The check runs before Bun is looked for, so this compiles nothing.
it('the --all build refuses a lowered floor before it compiles', () => {
  const build = join(__dirname, '..', 'scripts', 'build.mjs');
  const result = spawnSync(process.execPath, [build, '--all', '--min-app-version', '1.0.0'], {
    encoding: 'utf8'
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`below ${CLI_MIN_APP_VERSION}`);
});

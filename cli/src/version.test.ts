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

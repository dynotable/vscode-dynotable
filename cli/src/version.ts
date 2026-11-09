import {lt, valid} from 'semver';

/** Stamped by the build. */
declare const DYNOTABLE_CLI_VERSION: string | undefined;
export const CLI_VERSION =
  typeof DYNOTABLE_CLI_VERSION === 'string' ? DYNOTABLE_CLI_VERSION : '0.0.0-dev';

/**
 * The first app release whose agent sessions are enforced. An older app ignores `purpose` and
 * opens an editor session, so the CLI refuses it. This is not the extension's floor.
 */
export const CLI_MIN_APP_VERSION = '1.20.0';

/** Set by the build for the dev live lane only. */
declare const DYNOTABLE_CLI_MIN_APP_VERSION: string | undefined;

/** The floor compiled into this binary. There is no runtime or environment override. */
export const minAppVersion =
  typeof DYNOTABLE_CLI_MIN_APP_VERSION === 'string'
    ? DYNOTABLE_CLI_MIN_APP_VERSION
    : CLI_MIN_APP_VERSION;

/**
 * For the release build: refuses a floor override that is not a version, or that is lower than
 * `CLI_MIN_APP_VERSION`. A lower floor would let the CLI open editor sessions on an older app.
 */
export function releaseFloor(override: string | undefined): string {
  if (override === undefined) return CLI_MIN_APP_VERSION;
  if (valid(override) === null) throw new Error(`The app version floor "${override}" is invalid.`);
  if (lt(override, CLI_MIN_APP_VERSION)) {
    throw new Error(
      `A release build cannot lower the app version floor below ${CLI_MIN_APP_VERSION}.`
    );
  }
  return override;
}

import {
  AUTH_FAILED,
  FAILURE_CODES,
  failureCodeOf,
  METHOD_NOT_FOUND,
  type FailureCode,
  type WireError
} from '../../src/protocol';
import type {LatchedReason} from '../../src/reasons';

export const CLI_CODES = ['usage', 'bad-answer', 'listing-failed', 'interrupted'] as const;
export type CliCode = (typeof CLI_CODES)[number];

/** The `code` the CLI prints on stderr. */
export type ErrorCode = LatchedReason | FailureCode | CliCode;

/** The CLI's own text for each code. It names environment variables and flags, not settings. */
export function messageOf(code: ErrorCode): string {
  switch (code) {
    case 'integration-off':
      return 'The Editor integration is off in DynoTable. Turn it on in DynoTable under Settings → Editor integration.';
    case 'start-failed':
      return 'DynoTable could not start the Editor integration.';
    case 'crashed':
      return 'DynoTable stopped before the Editor integration was ready.';
    case 'spawn-failed':
      return 'dynotable-cli could not start DynoTable. Make sure DYNOTABLE_APP_PATH points to the app, or unset it.';
    case 'timed-out':
      return 'DynoTable did not start the Editor integration in time.';
    case 'not-serving':
      return 'DynoTable is running, but the Editor integration is not serving. Open DynoTable and look at Settings → Editor integration.';
    case 'auth-failed':
      return 'DynoTable refused the connection. Restart DynoTable, then try again.';
    case 'signed-out':
      return 'DynoTable is signed out. Sign in to DynoTable, then try again.';
    case 'update-app':
      return 'This version of DynoTable is too old for dynotable-cli. Update DynoTable.';
    case 'not-installed':
      return 'DynoTable is not installed. Install it, or set DYNOTABLE_APP_PATH to the app.';
    case 'launcher-off':
      return 'DynoTable is not running, or launching is disabled (--no-launch or DYNOTABLE_USER_DATA_DIR). Start DynoTable.';
    case 'missing-request':
      return 'This DynoTable build does not support a request that dynotable-cli needs. Update DynoTable.';
    case 'connection-ended':
      return 'The connection to DynoTable ended. DynoTable quit or stopped, the Editor integration was turned off, or DynoTable signed out.';
    case 'profile-required':
      return 'Choose a profile: list them with dynotable-cli profiles, then give one with --profile <id or slug>.';
    case 'profile-window-required':
      return 'This needs a DynoTable window on the profile. Open one in DynoTable.';
    case 'reauth-required':
      return 'The AWS sign-in of the profile expired. Open DynoTable and sign in.';
    case 'premium-required':
      return 'This needs an active DynoTable licence.';
    case 'stage-in-app':
      return 'dynotable-cli only reads. Writes are staged in DynoTable.';
    case 'busy':
      return 'DynoTable is running another query. Try again later.';
    case 'planner-refused':
      return 'The query is too large for this device.';
    case 'profile-not-exposed':
      return 'The profile is not found, or it is not available to agents. Make the profile available to agents in DynoTable.';
    case 'agent-refused':
      return 'This request is not available to agents. Do it in DynoTable.';
    case 'run-failed':
      return 'The request failed.';
    case 'usage':
      return 'The command line is not valid. See dynotable-cli --help.';
    case 'bad-answer':
      return 'DynoTable sent an answer that dynotable-cli cannot read. Update dynotable-cli and DynoTable.';
    case 'listing-failed':
      return 'The listing is incomplete. The rows that DynoTable could read are on stdout.';
    case 'interrupted':
      return 'Interrupted.';
    default:
      return unreachable(code);
  }
}

function unreachable(code: never): never {
  throw new Error(`No message for ${String(code)}`);
}

const KNOWN = new Set<string>(FAILURE_CODES);

/** The code of an error answer. A `data.code` this build does not know is `run-failed`. */
export function codeOfError(error: WireError): ErrorCode {
  if (error.code === AUTH_FAILED) return 'auth-failed';
  if (error.code === METHOD_NOT_FOUND) return 'missing-request';
  const code = failureCodeOf(error);
  return code !== undefined && KNOWN.has(code) ? code : 'run-failed';
}

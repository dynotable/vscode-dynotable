import {failureCodeOf, type FailureCode} from './protocol';
import {ACTION_LABELS, type Action} from './reasons';

/** The library's own codes for a request on a client that is not running, or that stopped. */
export const CONNECTION_INACTIVE = -32096;
export const PENDING_RESPONSE_REJECTED = -32097;

export const RUN_STATEMENT = 'dynotable.runStatement';
export const OPEN_IN_APP = 'dynotable.openInApp';

export type RefusalAction = Action | 'stage';

export const REFUSAL_LABELS: Record<RefusalAction, string> = {
  ...ACTION_LABELS,
  stage: 'Stage in DynoTable'
};

export interface Failure {
  code: number;
  message: string;
  data?: unknown;
}

export type Refusal =
  | {kind: 'silent'}
  /** Show the connection's current reason instead of the library's message. */
  | {kind: 'status'}
  | {kind: 'message'; message: string; actions: RefusalAction[]};

/** Open DynoTable is offered for these, never implied as the fix. */
const ACTIONS: Partial<Record<FailureCode, RefusalAction[]>> = {
  'profile-required': ['select-profile'],
  'signed-out': ['open-app'],
  'profile-window-required': ['open-app'],
  'reauth-required': ['open-app']
};

/** The server's sentence is kept. A run this client cancelled is silent, whatever the dialect. */
export function refusalOf(failure: Failure, cancelled: boolean, command: string): Refusal {
  if (cancelled) return {kind: 'silent'};
  if (failure.code === CONNECTION_INACTIVE) return {kind: 'status'};
  // The session's end is announced once, by its latched reason.
  if (failure.code === PENDING_RESPONSE_REJECTED) return {kind: 'silent'};
  const code = failureCodeOf(failure);
  let actions: RefusalAction[] = [];
  if (code === 'stage-in-app') actions = command === RUN_STATEMENT ? ['stage'] : [];
  // The lenient guard passes any code string, so `constructor` must not reach Object.prototype.
  else if (code && Object.hasOwn(ACTIONS, code)) actions = ACTIONS[code] ?? [];
  return {kind: 'message', message: failure.message, actions};
}

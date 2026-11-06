/** Reasons that hold until the port file changes or the user runs Reconnect. */
export const LATCHED_REASONS = [
  'integration-off',
  'start-failed',
  'crashed',
  'spawn-failed',
  'timed-out',
  'not-serving',
  'auth-failed',
  'signed-out',
  'update-app',
  'not-installed',
  'launcher-off',
  'missing-request',
  'connection-ended'
] as const;
export type LatchedReason = (typeof LATCHED_REASONS)[number];

/** `unbound` is a state of a live session, so it is not latched. */
export type Reason = LatchedReason | 'unbound';

export type Action =
  | 'open-app'
  | 'download'
  | 'set-app-path'
  | 'open-docs'
  | 'select-profile'
  | 'reconnect';

export interface ReasonCopy {
  sentence: string;
  /** The first action is the likely fix. The second is always Reconnect. */
  actions: [Action, 'reconnect', ...Action[]];
}

export const REASONS: Record<Reason, ReasonCopy> = {
  'integration-off': {
    sentence:
      'The Editor integration is off in DynoTable. Turn it on in DynoTable under Settings → Editor integration.',
    actions: ['open-app', 'reconnect']
  },
  'start-failed': {
    sentence: 'DynoTable could not start the Editor integration.',
    actions: ['open-app', 'reconnect']
  },
  crashed: {
    sentence: 'DynoTable stopped before the Editor integration was ready.',
    actions: ['open-app', 'reconnect']
  },
  'spawn-failed': {
    sentence: 'The extension could not start DynoTable. Make sure the app path points to the app.',
    actions: ['set-app-path', 'reconnect']
  },
  'timed-out': {
    sentence: 'DynoTable did not start the Editor integration in time.',
    actions: ['open-app', 'reconnect']
  },
  'not-serving': {
    sentence:
      'DynoTable is running, but the Editor integration is not serving. Open DynoTable and check Settings → Editor integration.',
    actions: ['open-app', 'reconnect']
  },
  'auth-failed': {
    sentence: 'DynoTable refused the connection. Restart DynoTable, then reconnect.',
    actions: ['open-app', 'reconnect']
  },
  'signed-out': {
    sentence: 'DynoTable is signed out. Sign in to DynoTable, then reconnect.',
    actions: ['open-app', 'reconnect']
  },
  'update-app': {
    sentence: 'This version of DynoTable is too old for the extension. Update DynoTable.',
    actions: ['download', 'reconnect']
  },
  'not-installed': {
    sentence: 'DynoTable is not installed. Install it, or set the path of the app.',
    actions: ['download', 'reconnect', 'set-app-path']
  },
  'launcher-off': {
    sentence:
      'A custom DynoTable user data directory is set, so the extension does not start DynoTable. Start DynoTable with that directory.',
    actions: ['open-docs', 'reconnect']
  },
  'missing-request': {
    sentence:
      'This DynoTable build does not support a request the extension needs. Update DynoTable.',
    actions: ['download', 'reconnect']
  },
  'connection-ended': {
    sentence:
      'The connection to DynoTable ended. DynoTable quit or stopped, the Editor integration was turned off, or DynoTable signed out.',
    actions: ['open-app', 'reconnect']
  },
  unbound: {
    sentence: 'Select a DynoTable profile to run queries and list tables.',
    actions: ['select-profile', 'reconnect']
  }
};

export const ACTION_LABELS: Record<Action, string> = {
  'open-app': 'Open DynoTable',
  download: 'Download DynoTable',
  'set-app-path': 'Set App Path',
  'open-docs': 'Open Documentation',
  'select-profile': 'Select Profile',
  reconnect: 'Reconnect'
};

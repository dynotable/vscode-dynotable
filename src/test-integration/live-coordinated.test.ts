import {strict as assert} from 'node:assert';
import {existsSync} from 'node:fs';
import {beforeEach, describe, it} from 'mocha';
import * as vscode from 'vscode';
import {REASONS, type LatchedReason} from '../reasons';
import {api, recordSpawns, session, sleep, toasts, waitFor, waitForStatus} from './harness';

/**
 * Each test waits for a person to change the app's state (docs/manual-e2e.md, Coordinated runs).
 * The launcher runs them one at a time, with the launcher off: the app runs on a custom userData
 * directory, so the extension never starts it.
 */
const ACTOR_MS = 10 * 60_000;

async function actor(step: string, done: () => boolean): Promise<void> {
  console.log(`waiting for: ${step}`);
  await waitFor(step, done, ACTOR_MS);
}

const reason = async (): Promise<LatchedReason | undefined> => {
  const model = (await api()).status();
  return model.kind === 'disconnected' ? model.reason : undefined;
};

const ended = async () => {
  const {status} = await api();
  return () => {
    const model = status();
    return model.kind === 'disconnected' && model.reason === 'connection-ended';
  };
};

const reconnect = () => vscode.commands.executeCommand('dynotable.reconnect');
const toast = (latched: LatchedReason) => ({kind: 'error', message: REASONS[latched].sentence});

describe('live coordinated', function () {
  this.timeout(ACTOR_MS + 2 * 60_000);

  beforeEach(() => {
    toasts.length = 0;
  });

  // Phase B (the launcher on) shows the Settings → Editor integration sentence from the exit code.
  it('@live-coordinated integration-off: turning the Editor integration off ends the connection', async () => {
    await session();
    await actor('turn the Editor integration off in DynoTable', await ended());
    assert.deepEqual(toasts, [toast('connection-ended')]);
    await reconnect();
    await waitForStatus('disconnected', 'launcher-off');
  });

  it('@live-coordinated quit: the app quit ends the connection; nothing starts it until Reconnect', async () => {
    await session();
    const spawns = await recordSpawns();
    const {portFilePath} = await api();
    await actor('quit DynoTable', await ended());
    assert.deepEqual(toasts, [toast('connection-ended')]);
    // A clean stop removes the port file.
    await waitFor('the port file to go', () => !existsSync(portFilePath));
    await sleep(5000);
    assert.equal(await reason(), 'connection-ended');
    await reconnect();
    await waitForStatus('disconnected', 'launcher-off');
    assert.deepEqual(spawns, []);
  });

  // Phase B (the launcher on) starts the app again after Reconnect.
  it('@live-coordinated killed: a killed app ends the connection and leaves a stale port file', async () => {
    await session();
    const {portFilePath} = await api();
    await actor('kill the DynoTable process (SIGKILL)', await ended());
    assert.deepEqual(toasts, [toast('connection-ended')]);
    assert.ok(existsSync(portFilePath), 'the port file is gone: the app did not stop abruptly');
    await reconnect();
    await waitForStatus('disconnected', 'launcher-off');
  });

  it('@live-coordinated restarted: after an app restart, the extension connects again by itself', async () => {
    await session();
    const {client, status} = await api();
    const before = client();
    await actor(
      'quit DynoTable and start it again',
      () => client() !== undefined && client() !== before && status().kind !== 'starting'
    );
    assert.ok(['connected', 'unbound'].includes(status().kind), JSON.stringify(status()));
  });

  it('@live-coordinated signed-out: signing out ends the connection; Reconnect shows the signed-out sentence', async () => {
    await session();
    await actor('sign out of DynoTable', await ended());
    await reconnect();
    await waitForStatus('disconnected', 'signed-out');
    assert.deepEqual(toasts.at(-1), toast('signed-out'));
  });
});

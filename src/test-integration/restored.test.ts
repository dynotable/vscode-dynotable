import {after, describe, it} from 'mocha';
import {fakeServer, waitFor, waitForStatus} from './harness';

// The launcher opens `restored.partiql` with the window, so it is open before activation.
describe('restored editors', () => {
  const fake = fakeServer();
  after(() => fake.stop());

  it('an in-scope editor open at activation connects', async () => {
    // No app is installed and no fake serves yet, so activation's own attempt latches.
    await waitForStatus('disconnected', 'not-installed');
    // A latch clears only on a new port file, and the watcher acts only after an attempt.
    await fake.start();
    await waitForStatus('connected');
    await waitFor('didOpen of the restored editor', () =>
      fake.received.some(
        (message) =>
          message.method === 'textDocument/didOpen' &&
          (message.params as {textDocument: {uri: string}}).textDocument.uri.endsWith(
            'restored.partiql'
          )
      )
    );
  });
});

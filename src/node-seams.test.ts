import {createServer} from 'node:net';
import {expect, it} from 'vitest';
import {connectTcp} from './node-seams';

// An error with no listener throws out of the event loop and ends the CLI process.
it('connectTcp: an error after the connect does not throw', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const socket = await connectTcp((server.address() as {port: number}).port);
  try {
    expect(() => socket.emit('error', new Error('reset'))).not.toThrow();
  } finally {
    socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

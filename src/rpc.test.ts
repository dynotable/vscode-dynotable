import {createServer, connect, type Server, type Socket} from 'node:net';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {frame, FrameReader, Peer} from './rpc';

const bytes = (text: string) => Buffer.from(text, 'utf8');
const texts = (bodies: Buffer[]) => bodies.map((body) => body.toString('utf8'));

describe('FrameReader', () => {
  it('joins a frame split in its header and in its body', () => {
    const whole = frame(bytes('{"a":1}'));
    const reader = new FrameReader();
    expect(reader.push(whole.subarray(0, 5))).toEqual({bodies: []});
    expect(reader.push(whole.subarray(5, 22))).toEqual({bodies: []});
    expect(texts(reader.push(whole.subarray(22)).bodies)).toEqual(['{"a":1}']);
  });

  it('reads two frames in one chunk and keeps the remainder', () => {
    const third = frame(bytes('{"c":3}'));
    const reader = new FrameReader();
    const {bodies} = reader.push(
      Buffer.concat([frame(bytes('{"a":1}')), frame(bytes('{"b":2}')), third.subarray(0, 4)])
    );
    expect(texts(bodies)).toEqual(['{"a":1}', '{"b":2}']);
    expect(reader.remainder.toString('ascii')).toBe('Cont');
  });

  // A length counted in characters would cut the body short, and the next frame would not parse.
  it('counts Content-Length in bytes, across a split inside a multi-byte character', () => {
    const body = '{"name":"Zoë €😀"}';
    const whole = frame(bytes(body));
    expect(whole.toString('ascii').startsWith('Content-Length: 23\r\n')).toBe(true);
    const split = whole.indexOf(Buffer.from('😀')) + 2;
    const reader = new FrameReader();
    expect(reader.push(whole.subarray(0, split)).bodies).toEqual([]);
    expect(texts(reader.push(whole.subarray(split)).bodies)).toEqual([body]);
  });

  it('reads a lower-case Content-Length next to a Content-Type header', () => {
    const reader = new FrameReader();
    const {bodies} = reader.push(
      bytes(
        'Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: 2\r\n\r\n{}'
      )
    );
    expect(texts(bodies)).toEqual(['{}']);
  });

  it('answers an error, and does not throw, for a header with no Content-Length', () => {
    const reader = new FrameReader();
    const result = reader.push(bytes('Content-Type: text/plain\r\n\r\n{}'));
    expect(result.bodies).toEqual([]);
    expect(result.error).toMatch(/Content-Length/);
  });
});

describe('Peer', () => {
  const servers: Server[] = [];
  const sockets: Socket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.destroy();
    for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
  });

  /** A peer on one end of a loopback connection, and the raw socket of the other end. */
  async function pair(): Promise<{peer: Peer; remote: Socket}> {
    let accept!: (socket: Socket) => void;
    const accepted = new Promise<Socket>((resolve) => (accept = resolve));
    const server = createServer(accept);
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as {port: number}).port;
    const local = await new Promise<Socket>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => resolve(socket));
    });
    const remote = await accepted;
    sockets.push(local, remote);
    return {peer: new Peer(local), remote};
  }

  it('closes with an error on a body that is not JSON', async () => {
    const {peer, remote} = await pair();
    remote.write(frame(bytes('not json')));
    expect(await peer.closed).toBeInstanceOf(Error);
    expect(peer.socket.destroyed).toBe(true);
  });

  it('closes with an error on a framed JSON null, with no unhandled rejection', async () => {
    const unhandled = vi.fn<(reason: unknown) => void>();
    process.on('unhandledRejection', unhandled);
    try {
      const {peer, remote} = await pair();
      remote.write(frame(bytes('null')));
      expect(await peer.closed).toBeInstanceOf(Error);
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  // A request on a closed peer that never settles hangs its caller forever.
  it('rejects a request made after the connection closed', async () => {
    const {peer, remote} = await pair();
    remote.destroy();
    await peer.closed;
    await expect(peer.request('dynotable/listProfiles').response).rejects.toThrow(/closed/);
  });
});

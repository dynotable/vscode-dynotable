import type {Socket} from 'node:net';
import {INTERNAL_ERROR, METHOD_NOT_FOUND, type WireError} from '../src/protocol';

export type Id = number | string;

/** Thrown by a request handler to answer with an error; rejects a request that was answered so. */
export class RpcFailure extends Error {
  constructor(readonly error: WireError) {
    super(error.message);
  }
}

export interface Pending {
  id: Id;
  response: Promise<unknown>;
}

type RequestHandler = (method: string, params: unknown, id: Id) => unknown;
type NotificationHandler = (method: string, params: unknown) => void;

const HEADER_END = '\r\n\r\n';

/**
 * A raw JSON-RPC 2.0 peer over the LSP base protocol (`Content-Length` framing). Both sides of a
 * connection use it: the recorder as a client, the fake server as a server.
 */
export class Peer {
  onRequest: RequestHandler = () => {
    throw new RpcFailure({code: METHOD_NOT_FOUND, message: 'Method not found'});
  };
  onNotification: NotificationHandler = () => {};

  private nextId = 1;
  private readonly pending = new Map<Id, {resolve(v: unknown): void; reject(e: Error): void}>();
  private buffer = Buffer.alloc(0);

  constructor(readonly socket: Socket) {
    socket.on('data', (chunk: Buffer) => this.read(chunk));
    socket.on('close', () => {
      for (const {reject} of this.pending.values()) reject(new Error('connection closed'));
      this.pending.clear();
    });
  }

  request(method: string, params?: unknown): Pending {
    const id = this.nextId++;
    const response = new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
    this.send({jsonrpc: '2.0', id, method, params});
    return {id, response};
  }

  notify(method: string, params?: unknown): void {
    this.send({jsonrpc: '2.0', method, params});
  }

  private send(message: object): void {
    if (this.socket.destroyed) return;
    const body = Buffer.from(JSON.stringify(message), 'utf8');
    this.socket.write(`Content-Length: ${body.length}${HEADER_END}`);
    this.socket.write(body);
  }

  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf(HEADER_END);
      if (end < 0) return;
      const length = /Content-Length: *(\d+)/i.exec(this.buffer.subarray(0, end).toString('ascii'));
      if (!length) throw new Error('frame without Content-Length');
      const start = end + HEADER_END.length;
      const stop = start + Number(length[1]);
      if (this.buffer.length < stop) return;
      const message = JSON.parse(this.buffer.subarray(start, stop).toString('utf8'));
      this.buffer = this.buffer.subarray(stop);
      void this.dispatch(message);
    }
  }

  private async dispatch(message: {
    id?: Id;
    method?: string;
    params?: unknown;
    result?: unknown;
    error?: WireError;
  }): Promise<void> {
    if (message.method === undefined) {
      const waiter = this.pending.get(message.id as Id);
      this.pending.delete(message.id as Id);
      if (message.error) waiter?.reject(new RpcFailure(message.error));
      else waiter?.resolve(message.result);
      return;
    }
    if (message.id === undefined) {
      this.onNotification(message.method, message.params);
      return;
    }
    try {
      const result = await this.onRequest(message.method, message.params, message.id);
      this.send({jsonrpc: '2.0', id: message.id, result: result ?? null});
    } catch (error) {
      const failure =
        error instanceof RpcFailure ? error.error : {code: INTERNAL_ERROR, message: String(error)};
      this.send({jsonrpc: '2.0', id: message.id, error: failure});
    }
  }
}

import type {Socket} from 'node:net';
import {
  INTERNAL_ERROR,
  is,
  METHOD_NOT_FOUND,
  responseErrorSchema,
  type WireError
} from './protocol';

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

const HEADER_END = Buffer.from('\r\n\r\n');

/** `body` in one LSP base-protocol frame. `Content-Length` counts bytes. */
export function frame(body: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

export interface Frames {
  bodies: Buffer[];
  /** Set when a header is malformed. The stream cannot be read past it. */
  error?: string;
}

/**
 * Splits a byte stream into the bodies of LSP base-protocol frames. Header names are
 * case-insensitive, and headers other than `Content-Length` are ignored.
 */
export class FrameReader {
  private buffer = Buffer.alloc(0);
  private error: string | undefined;

  /** Reads at most `limit` frames; the rest stays in `remainder`, byte for byte. */
  push(chunk: Buffer, limit = Infinity): Frames {
    if (this.error) return {bodies: [], error: this.error};
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const bodies: Buffer[] = [];
    while (bodies.length < limit) {
      const end = this.buffer.indexOf(HEADER_END);
      if (end < 0) return {bodies};
      const length = contentLength(this.buffer.subarray(0, end).toString('ascii'));
      if (length === undefined) {
        this.error = 'A frame header has no valid Content-Length.';
        return {bodies, error: this.error};
      }
      const start = end + HEADER_END.length;
      if (this.buffer.length < start + length) return {bodies};
      bodies.push(this.buffer.subarray(start, start + length));
      this.buffer = this.buffer.subarray(start + length);
    }
    return {bodies};
  }

  /** The bytes after the last frame read. */
  get remainder(): Buffer {
    return this.buffer;
  }
}

function contentLength(header: string): number | undefined {
  for (const line of header.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    if (line.slice(0, colon).trim().toLowerCase() !== 'content-length') continue;
    const value = line.slice(colon + 1).trim();
    return /^\d+$/.test(value) ? Number(value) : undefined;
  }
  return undefined;
}

export interface Message {
  id?: Id;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: WireError;
}

const isId = (value: unknown): value is Id =>
  typeof value === 'number' || typeof value === 'string';

/** A request, a notification or a response; `undefined` for anything else. */
export function parseMessage(body: Buffer): Message | undefined {
  let value: unknown;
  try {
    value = JSON.parse(body.toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const message = value as Record<string, unknown>;
  if (typeof message.method === 'string') {
    return message.id === undefined || isId(message.id) ? message : undefined;
  }
  if (!isId(message.id)) return undefined;
  if (Object.hasOwn(message, 'error')) {
    return is(responseErrorSchema, message.error) ? message : undefined;
  }
  return Object.hasOwn(message, 'result') ? message : undefined;
}

/**
 * A raw JSON-RPC 2.0 peer over the LSP base protocol (`Content-Length` framing). Both sides of a
 * connection use it. A frame that is not a JSON-RPC message closes the connection.
 */
export class Peer {
  onRequest: RequestHandler = () => {
    throw new RpcFailure({code: METHOD_NOT_FOUND, message: 'Method not found'});
  };
  onNotification: NotificationHandler = () => {};
  /** Settles when the connection closes, with the error that closed it, if any. */
  readonly closed: Promise<Error | undefined>;

  private nextId = 1;
  private readonly pending = new Map<Id, {resolve(v: unknown): void; reject(e: Error): void}>();
  private readonly reader = new FrameReader();
  private fault: Error | undefined;

  constructor(readonly socket: Socket) {
    this.closed = new Promise((resolve) => {
      socket.once('close', () => {
        for (const {reject} of this.pending.values()) reject(new Error('connection closed'));
        this.pending.clear();
        resolve(this.fault);
      });
    });
    socket.on('data', (chunk: Buffer) => this.read(chunk));
    socket.on('error', (error) => (this.fault ??= error));
  }

  request(method: string, params?: unknown): Pending {
    const id = this.nextId++;
    if (this.socket.destroyed) {
      return {id, response: Promise.reject(new Error('connection closed'))};
    }
    const response = new Promise((resolve, reject) => this.pending.set(id, {resolve, reject}));
    this.send({jsonrpc: '2.0', id, method, params});
    return {id, response};
  }

  notify(method: string, params?: unknown): void {
    this.send({jsonrpc: '2.0', method, params});
  }

  private send(message: object): void {
    if (this.socket.destroyed) return;
    this.socket.write(frame(Buffer.from(JSON.stringify(message), 'utf8')));
  }

  private fail(error: Error): void {
    this.fault ??= error;
    this.socket.destroy();
  }

  private read(chunk: Buffer): void {
    const {bodies, error} = this.reader.push(chunk);
    for (const body of bodies) {
      const message = parseMessage(body);
      if (!message) {
        this.fail(new Error('A frame is not a JSON-RPC message.'));
        return;
      }
      void this.dispatch(message);
    }
    if (error) this.fail(new Error(error));
  }

  private async dispatch(message: Message): Promise<void> {
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

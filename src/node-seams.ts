import {readdirSync, readFileSync, statSync, watch, type FSWatcher} from 'node:fs';
import {connect, type Socket} from 'node:net';
import {basename, dirname} from 'node:path';
import type {Fs} from './discovery';

/** How often to look for the userData directory while it does not exist. */
const DIRECTORY_POLL_MS = 2000;

export const fs: Fs = {
  readFile: (path) => readFileSync(path, 'utf8'),
  readdir: (path) => readdirSync(path),
  isFile: (path) => statSync(path, {throwIfNoEntry: false})?.isFile() ?? false
};

export const connectTcp = (port: number) =>
  new Promise<Socket>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      // An error is followed by 'close', which the session handles. With no listener, an error
      // before the session attaches its own would throw out of the event loop.
      socket.on('error', () => {});
      resolve(socket);
    });
  });

/**
 * Watches the port file's directory, because an atomic rename replaces the file's inode. While the
 * directory does not exist, it polls for it.
 */
export function watchPortFile(path: string, changed: () => void): {dispose(): void} {
  let watcher: FSWatcher | undefined;
  const arm = () => {
    try {
      watcher = watch(dirname(path), (_event, file) => {
        if (!file || file === basename(path)) changed();
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
      return true;
    } catch {
      return false;
    }
  };
  arm();
  const poll = setInterval(() => {
    if (!watcher && arm()) changed();
  }, DIRECTORY_POLL_MS);
  return {
    dispose: () => {
      clearInterval(poll);
      watcher?.close();
    }
  };
}

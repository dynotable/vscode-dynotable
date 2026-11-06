import {execFileSync, spawn, type ChildProcess} from 'node:child_process';
import {realpathSync, statSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import type {SpawnOptions} from '../connect-core';
import {windowsOfPids} from './display';

/**
 * The executable a launcher run may start: a wrapper that pins the app's userData directory. Never
 * an app bundle, a binary inside one, or anything under /Applications.
 */
export function liveAppPath(env: Record<string, string | undefined> = process.env): string {
  const path = env.DYNOTABLE_LIVE_APP_PATH;
  if (!path) throw new Error('test:live:launcher needs DYNOTABLE_LIVE_APP_PATH.');
  if (!isAbsolute(path)) throw new Error('DYNOTABLE_LIVE_APP_PATH must be absolute.');
  if (!statSync(path, {throwIfNoEntry: false})?.isFile()) {
    throw new Error('DYNOTABLE_LIVE_APP_PATH is not a file.');
  }
  for (const candidate of [path, realpathSync(path)]) {
    const lower = candidate.toLowerCase();
    if (/\.app(\/|$)/.test(lower) || lower.startsWith('/applications/')) {
      throw new Error(
        'DYNOTABLE_LIVE_APP_PATH must be a wrapper outside app bundles and /Applications.'
      );
    }
  }
  return path;
}

/** A real spawn for `app --headless` only. Anything else, an Open DynoTable included, throws. */
export function guardedSpawn(app: string) {
  return (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    if (command !== app || args.length !== 1 || args[0] !== '--headless') {
      throw new Error(`spawn ${command} ${args.join(' ')} is disabled in tests`);
    }
    return spawn(command, args, options);
  };
}

/** The whole argument, so a directory that is a prefix of another one does not match it. */
const owns = (command: string, dir: string) => ` ${command} `.includes(` --user-data-dir=${dir} `);

/** Every process on the app's userData directory `dir`, helpers included. */
export function appProcesses(dir: string): Array<{pid: number; main: boolean}> {
  return execFileSync('ps', ['-axo', 'pid=,command='], {encoding: 'utf8'})
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((match) => match !== null && owns(match[2] ?? '', dir))
    .map((match) => ({pid: Number(match?.[1]), main: !match?.[2]?.includes(' --type=')}));
}

export function ownedBy(pid: number, dir: string): boolean {
  try {
    return owns(
      execFileSync('ps', ['-p', String(pid), '-o', 'command='], {encoding: 'utf8'}).trim(),
      dir
    );
  } catch {
    return false;
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signals `pid` only when its command line names `dir`. */
export function signalApp(pid: number, dir: string, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (!ownedBy(pid, dir)) throw new Error(`pid ${pid} is not an app on ${dir}; not signalled`);
  process.kill(pid, signal);
}

async function gone(dir: string, ms: number): Promise<boolean> {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await sleep(100)) {
    if (appProcesses(dir).length === 0) return true;
  }
  return appProcesses(dir).length === 0;
}

/** Quits every app on `dir` (SIGTERM), then kills what is left. Throws when a process stays. */
export async function stopApps(dir: string): Promise<void> {
  for (const {pid} of appProcesses(dir).filter(({main}) => main)) signalApp(pid, dir, 'SIGTERM');
  if (await gone(dir, 15_000)) return;
  for (const {pid} of appProcesses(dir)) signalApp(pid, dir, 'SIGKILL');
  if (!(await gone(dir, 5000))) {
    throw new Error(`processes on ${dir} stay after SIGKILL: ${JSON.stringify(appProcesses(dir))}`);
  }
}

/** The on-screen windows of the apps on `dir`. A headless app has none. */
export const appWindows = (dir: string) => windowsOfPids(appProcesses(dir).map(({pid}) => pid));

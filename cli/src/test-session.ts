import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach} from 'vitest';
import {FakeServer} from '../../src/test-integration/fake-server';
import {sink} from './io';
import type {Result} from './output';
import {createSession, type Connection, type SessionOptions} from './session';

const CONTRACT = join(__dirname, '..', '..', 'contract');

/** One command's view of a session test: a fake app, a temp home and the captured output. */
export interface Harness {
  fake: FakeServer;
  home: string;
  cwd: string;
  stdout: string;
  stderr: string;
  codes: number[];
  /** Where the app writes its port file on Linux under `home`. */
  portFile(): string;
  /** Runs `work` through a session on the fake, as a one-shot command does. */
  run(
    work: (connection: Connection) => Promise<Result>,
    options?: Partial<SessionOptions>
  ): Promise<void>;
  /** The parsed stderr line. */
  failure(): {code: string; message: string; detail?: string};
}

/** Registers the per-test setup and teardown. */
export function useHarness(): Harness {
  const harness = {
    portFile: () => join(harness.home, '.config', 'DynoTable', 'lsp-port.json'),
    async run(work, options = {}) {
      const io = sink({
        stdin: process.stdin,
        stdout: {write: (chunk) => (harness.stdout += String(chunk))},
        stderr: {write: (chunk) => (harness.stderr += String(chunk))},
        setExitCode: (code) => harness.codes.push(code)
      });
      const session = createSession({
        minAppVersion: harness.fake.version,
        env: {},
        home: harness.home,
        io,
        // A test must never start an installed app.
        launch: false,
        cwd: harness.cwd,
        platform: 'linux',
        ...options
      });
      await session.run(work);
    },
    failure: () => JSON.parse(harness.stderr)
  } as Harness;

  beforeEach(() => {
    harness.home = mkdtempSync(join(tmpdir(), 'cli-home-'));
    harness.cwd = mkdtempSync(join(tmpdir(), 'cli-cwd-'));
    harness.fake = new FakeServer(harness.portFile(), CONTRACT);
    harness.stdout = '';
    harness.stderr = '';
    harness.codes = [];
  });

  afterEach(async () => {
    await harness.fake.stop();
    rmSync(harness.home, {recursive: true, force: true});
    rmSync(harness.cwd, {recursive: true, force: true});
  });

  return harness;
}

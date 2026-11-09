// The published bins, copied with a stub platform package into a temp install. POSIX only: the
// cases send signals.
import {spawn} from 'node:child_process';
import {cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {binaryName, packageOf, targetOf} from '../lib/resolve-platform.mjs';

const wrapper = join(__dirname, '..');
const host = targetOf(process.platform, process.arch);

/**
 * The stub child's script. Modes: `exit <n>`; `kill-self`; `argv0`; `wait`: print `ready`, then
 * print the first signal and exit 7.
 */
const STUB = `const [mode, arg] = process.argv.slice(2);
if (mode === 'exit') process.exit(Number(arg));
if (mode === 'kill-self') process.kill(process.pid, 'SIGTERM');
if (mode === 'argv0') console.log(process.argv0);
if (mode === 'wait') {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      console.log(signal);
      process.exit(7);
    });
  }
  setInterval(() => {}, 1000);
  console.log('ready');
}
`;

let install: string;
let stub: string;

beforeAll(() => {
  install = mkdtempSync(join(tmpdir(), 'cli-wrapper-'));
  const copy = join(install, 'dynotable-cli');
  for (const part of ['bin', 'lib', 'package.json'])
    cpSync(join(wrapper, part), join(copy, part), {recursive: true});
  if (!host) return;
  const platform = join(copy, 'node_modules', packageOf(host));
  mkdirSync(join(platform, 'bin'), {recursive: true});
  writeFileSync(join(platform, 'package.json'), JSON.stringify({name: packageOf(host)}));
  // The platform binary is Node itself, so the stub sees the argv0 it was started under.
  symlinkSync(process.execPath, join(platform, 'bin', binaryName(process.platform)));
  stub = join(install, 'stub.cjs');
  writeFileSync(stub, STUB);
});

afterAll(() => rmSync(install, {recursive: true, force: true}));

function start(bin: string, args: string[]) {
  const wrapperBin = join(install, 'dynotable-cli', 'bin', bin);
  const child = spawn(process.execPath, [wrapperBin, stub, ...args], {
    stdio: 'pipe'
  });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
  return {
    child,
    stdout: () => stdout,
    ended: new Promise<{code: number | null; signal: NodeJS.Signals | null}>((resolve) =>
      child.on('exit', (code, signal) => resolve({code, signal}))
    )
  };
}

async function ready(run: ReturnType<typeof start>): Promise<void> {
  while (!run.stdout().includes('ready')) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe.skipIf(process.platform === 'win32' || !host)('the npm wrapper', () => {
  it('exits with the child exit code', async () => {
    expect(await start('dynotable-cli.mjs', ['exit', '3']).ended).toEqual({code: 3, signal: null});
  });

  it('dies by the signal that killed the child', async () => {
    expect(await start('dynotable-cli.mjs', ['kill-self']).ended).toEqual({
      code: null,
      signal: 'SIGTERM'
    });
  });

  it.each(['SIGTERM', 'SIGINT'] as const)(
    'forwards %s sent to the wrapper alone',
    async (signal) => {
      const run = start('dynotable-cli.mjs', ['wait']);
      await ready(run);
      // Only the wrapper gets it: with piped stdio there is no terminal to signal the group.
      run.child.kill(signal);
      expect(await run.ended).toEqual({code: 7, signal: null});
      expect(run.stdout()).toBe(`ready\n${signal}\n`);
    }
  );

  it('the dynotable-lsp bin starts the binary under that name', async () => {
    const run = start('dynotable-lsp.mjs', ['argv0']);
    expect(await run.ended).toEqual({code: 0, signal: null});
    expect(run.stdout()).toBe('dynotable-lsp\n');
  });
});

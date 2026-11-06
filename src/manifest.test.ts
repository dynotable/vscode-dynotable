import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {describe, expect, it} from 'vitest';

const root = resolve(import.meta.dirname, '..');
const readJson = (path: string) => JSON.parse(readFileSync(resolve(root, path), 'utf8'));
const manifest = readJson('package.json');

describe('manifest', () => {
  // A wider range than the library's lets VS Code install the extension where the library breaks.
  it('engines.vscode equals the pinned library floor', () => {
    const library = readJson('node_modules/vscode-languageclient/package.json');
    expect(manifest.engines.vscode).toBe(library.engines.vscode);
  });

  // The library registers the server's commands only while connected. A contributed id would sit
  // in the palette and fail with "command not found" whenever no client runs.
  it('contributes no server command id', () => {
    const ids = manifest.contributes.commands.map((c: {command: string}) => c.command);
    for (const id of ['dynotable.runStatement', 'dynotable.openInApp', 'dynotable.validateQuery']) {
      expect(ids).not.toContain(id);
    }
  });

  it('each grammar path resolves to a file', () => {
    const paths: string[] = manifest.contributes.grammars.map((g: {path: string}) => g.path);
    expect(paths.filter((path) => !existsSync(resolve(root, path)))).toEqual([]);
  });

  // A workspace must not point the extension at another app binary or another port file.
  it('both path settings are machine-scoped', () => {
    const properties = manifest.contributes.configuration.properties;
    expect(properties['dynotable.userDataDir'].scope).toBe('machine');
    expect(properties['dynotable.appPath'].scope).toBe('machine');
  });

  // An untrusted folder must not start or reach the app.
  it('does not run in untrusted workspaces', () => {
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe(false);
  });
});

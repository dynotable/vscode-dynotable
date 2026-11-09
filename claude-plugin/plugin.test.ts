import {readFileSync} from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {EDITOR_BRIDGE_NAME, parse} from '../cli/src/args';
import {locate} from '../cli/src/document';

interface LspServer {
  command: string;
  args: string[];
  extensionToLanguage: Record<string, string>;
}

const readJson = (file: string): unknown =>
  JSON.parse(readFileSync(path.join(import.meta.dirname, file), 'utf8'));

const servers = Object.entries(readJson('.lsp.json') as Record<string, LspServer>);
const wrapper = readJson('../cli/npm/dynotable-cli/package.json') as {bin: Record<string, string>};

describe('the Claude Code plugin', () => {
  it('has one language server', () => {
    expect(servers).toHaveLength(1);
  });

  describe.each(servers)('server %s', (_name, server) => {
    // The editor bridge name opens editor sessions, which an agent must never get.
    it('starts the agent-only command that npm installs', () => {
      expect(Object.keys(wrapper.bin)).toContain(server.command);
      expect(server.command).not.toBe(EDITOR_BRIDGE_NAME);
    });

    // A launching bridge that Claude Code restarts would revive an app the user quit.
    it('runs the agent bridge without launching the app', () => {
      expect(parse(server.command, server.args)).toMatchObject({
        kind: 'command',
        command: 'lsp',
        agent: true,
        launch: false
      });
    });

    // Claude Code keys on the last extension, so a `.sql` key would hand every SQL file in a
    // project to DynoTable. Only the dedicated extensions are mapped.
    it('maps the dedicated extensions, each to the language the CLI gives it', () => {
      expect(Object.keys(server.extensionToLanguage).sort()).toEqual([
        '.dtsql',
        '.opensearch',
        '.partiql'
      ]);
      const place = {cwd: '/work', path: path.posix};
      for (const [extension, language] of Object.entries(server.extensionToLanguage)) {
        expect(locate({kind: 'file', path: `q${extension}`}, undefined, place)).toMatchObject({
          languageId: language
        });
      }
    });
  });
});

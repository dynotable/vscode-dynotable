import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {
  codeLensListSchema,
  initializeResultSchema,
  listIndicesSchema,
  listTablesSchema,
  problem,
  profileListSchema,
  progressListSchema,
  responseErrorSchema,
  runResultSchema,
  showMessageSchema,
  str,
  type Schema
} from '../src/protocol';

const guards = {
  initializeResult: initializeResultSchema,
  runResult: runResultSchema,
  profileList: profileListSchema,
  listTables: listTablesSchema,
  listIndices: listIndicesSchema,
  codeLensList: codeLensListSchema,
  progressList: progressListSchema,
  responseError: responseErrorSchema,
  string: str,
  showMessage: showMessageSchema
} satisfies Record<string, Schema<unknown>>;

export type GuardName = keyof typeof guards;

export const GUARDS: Record<GuardName, Schema<unknown>> = guards;

export interface ManifestEntry {
  guard: GuardName;
  /** `authored` is a reading of PROTOCOL.md; `recorded` came from a real server. */
  provenance: 'authored' | 'recorded';
}

/** Fixture file name → entry. */
export type Manifest = Record<string, ManifestEntry>;

export const readManifest = (dir: string): Manifest =>
  JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));

/** A fixture that fails its strict guard throws: drift must surface in this repo first. */
export function readFixture(dir: string, file: string): unknown {
  const entry = readManifest(dir)[file];
  if (!entry) throw new Error(`${file} is not listed in contract/manifest.json`);
  const value: unknown = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const found = problem(GUARDS[entry.guard], value, 'strict');
  if (found) throw new Error(`${file}: ${found}`);
  return value;
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === 'string') return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [map(key), mapStrings(item, map)])
    );
  }
  return value;
}

/** Every key and string of `value`, deeply. */
export function strings(value: unknown): string[] {
  const texts: string[] = [];
  mapStrings(value, (text) => {
    texts.push(text);
    return text;
  });
  return texts;
}

/**
 * Replaces each secret where it stands as a whole token, in keys and values, in one pass: longest
 * secret first, and a placeholder is never scanned again. A secret inside a longer word (a slug
 * `local` in `localhost`) stays, so `leaks` finds it and the recorder refuses to write.
 */
export function scrub(value: unknown, placeholders: Map<string, string>): unknown {
  const secrets = [...placeholders.keys()]
    .filter((secret) => secret !== '')
    .toSorted((a, b) => b.length - a.length);
  if (secrets.length === 0) return value;
  const escaped = secrets.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`));
  const pattern = new RegExp(String.raw`(?<![\w-])(?:${escaped.join('|')})(?![\w-])`, 'g');
  return mapStrings(value, (text) =>
    text.replace(pattern, (secret) => placeholders.get(secret) ?? '')
  );
}

/** The secrets that still appear in any key or string of `value`, in any letter case. */
export function leaks(value: unknown, secrets: Iterable<string>): string[] {
  const texts = strings(value).map((text) => text.toLowerCase());
  return [...secrets].filter(
    (secret) => secret !== '' && texts.some((text) => text.includes(secret.toLowerCase()))
  );
}

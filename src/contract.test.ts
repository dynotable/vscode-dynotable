import {readdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';
import {GUARDS, leaks, readManifest, scrub} from '../scripts/contract';
import {problem} from './protocol';

const DIR = join(__dirname, '..', 'contract');
const manifest = readManifest(DIR);
const fixtures = Object.keys(manifest);

describe('contract fixtures', () => {
  // An unlisted fixture has no provenance, so nobody can tell a reading of the spec from evidence.
  it('lists every fixture file in the manifest', () => {
    const files = readdirSync(DIR).filter((file) => file !== 'manifest.json');
    expect(files.toSorted()).toEqual(fixtures.toSorted());
  });

  // The client guard must accept what the server sends, or the extension rejects a real answer.
  // The strict guard must too, or the fixtures and the fake have drifted from `protocol.ts`.
  it.each(Object.entries(manifest))('%s passes its lenient and strict guards', (file, entry) => {
    const value: unknown = JSON.parse(readFileSync(join(DIR, file), 'utf8'));
    const guard = GUARDS[entry.guard];
    expect(problem(guard, value, 'lenient')).toBeUndefined();
    expect(problem(guard, value, 'strict')).toBeUndefined();
  });
});

describe('leaks', () => {
  // The recorder refuses to write when this finds anything, so a miss would commit a roster name
  // or an endpoint host to a public repo.
  it('finds a listed name in a value and a listed host in a key', () => {
    const recorded = {
      message: 'Open a window on Prod EU first.',
      rows: [{'search-prod.eu-west-1.es.amazonaws.com': 1}]
    };
    expect(
      leaks(recorded, ['Prod EU', 'search-prod.eu-west-1.es.amazonaws.com', 'absent'])
    ).toEqual(['Prod EU', 'search-prod.eu-west-1.es.amazonaws.com']);
  });

  // A server message can change the case of a name it quotes.
  it('finds a listed name in another letter case', () => {
    expect(leaks({message: 'PROD EU is signed out.'}, ['Prod EU'])).toEqual(['Prod EU']);
  });
});

describe('scrub', () => {
  // A short slug must not rewrite unrelated words; the leak check then refuses the recording.
  it('replaces a whole token and leaves a longer word that holds it', () => {
    const placeholders = new Map([['local', 'profile-1-slug']]);
    expect(scrub({message: 'local runs on localhost'}, placeholders)).toEqual({
      message: 'profile-1-slug runs on localhost'
    });
  });
});

import {describe, expect, it} from 'vitest';
import {problem, profileListSchema, runResultSchema} from './protocol';

const runResult = {
  columns: ['id'],
  rows: [{id: 1}],
  returnedRows: 1,
  totalRows: null,
  truncated: false,
  approximateBytes: 12,
  elapsedMs: 3,
  executedStatement: 'SELECT * FROM "t"',
  effectiveRowCap: 500
};

const profile = {
  id: 'p1',
  name: 'Local',
  slug: 'local',
  kind: 'offline',
  bindable: true,
  engines: {dynamodb: true, opensearch: false}
};

const withoutKey = (key: string) => {
  const {[key]: _dropped, ...rest} = runResult as Record<string, unknown>;
  return rest;
};

describe('protocol guards', () => {
  it('accept a valid value in both modes', () => {
    expect(problem(runResultSchema, runResult, 'strict')).toBeUndefined();
    expect(problem(profileListSchema, [profile], 'strict')).toBeUndefined();
  });

  // The server's surface is additive: a lenient guard that refuses a new field or enum value would
  // break every installed extension on the next app release. The strict guard must see it first.
  it('lenient accepts an extra key and an unknown enum value; strict refuses both', () => {
    const extra = {...runResult, cursor: 'x'};
    const newKind = [{...profile, kind: 'serverless'}];
    expect(problem(runResultSchema, extra, 'lenient')).toBeUndefined();
    expect(problem(profileListSchema, newKind, 'lenient')).toBeUndefined();
    expect(problem(runResultSchema, extra, 'strict')).toBe('$.cursor: unexpected key');
    // An Object.prototype name is still an extra key.
    expect(problem(runResultSchema, {...runResult, constructor: 'x'}, 'strict')).toBe(
      '$.constructor: unexpected key'
    );
    expect(problem(profileListSchema, newKind, 'strict')).toBe(
      '$[0].kind: unknown value "serverless"'
    );
  });

  // Both modes guard the client against a shape it would misrender: a missing total would read as
  // "unknown" only by accident, and a string count would print as a total.
  it.each(['lenient', 'strict'] as const)(
    '%s refuses a missing required key and a wrong type',
    (mode) => {
      expect(problem(runResultSchema, withoutKey('totalRows'), mode)).toBe('$.totalRows: missing');
      expect(problem(runResultSchema, {...runResult, returnedRows: '1'}, mode)).toBe(
        '$.returnedRows: expected number'
      );
    }
  );
});

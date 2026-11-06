import {describe, expect, it} from 'vitest';
import {applyPin, pinFor} from './directive';

describe('applyPin', () => {
  it('inserts a directive when line 0 is not one', () => {
    expect(applyPin('{"match_all": {}}', {index: 'orders'})).toBe(
      '// dynotable: index=orders\n{"match_all": {}}'
    );
  });

  it('replaces index=', () => {
    expect(applyPin('// dynotable: index=old\nstatus:shipped', {index: 'orders'})).toBe(
      '// dynotable: index=orders\nstatus:shipped'
    );
  });

  // The server refuses a key set twice to different values, so a kept duplicate blocks every run.
  it('collapses a duplicated key', () => {
    expect(applyPin('// dynotable: index=a index=b', {index: 'orders'})).toBe(
      '// dynotable: index=orders'
    );
  });

  it('keeps unknown tokens and leading whitespace', () => {
    // `constructor` is an Object.prototype key, not a pin key.
    expect(applyPin('  //dynotable: mode=x constructor=y index=a', {index: 'orders'})).toBe(
      '  //dynotable: mode=x constructor=y index=orders'
    );
  });

  // A `\r`-only file read as one line would get its query swallowed into the directive.
  it.each([
    ['CRLF', '\r\n'],
    ['CR', '\r']
  ])('handles %s line endings', (_name, eol) => {
    expect(applyPin(`// dynotable: index=a${eol}q`, {index: 'b'})).toBe(
      `// dynotable: index=b${eol}q`
    );
    expect(applyPin(`q${eol}r`, {index: 'b'})).toBe(`// dynotable: index=b${eol}q${eol}r`);
  });

  // A pin left from an earlier pick would send a run to a target that does not host the new index.
  it('drops a target= pin the new pick does not need', () => {
    expect(applyPin('// dynotable: index=a target=x', {index: 'b'})).toBe('// dynotable: index=b');
  });
});

describe('pinFor', () => {
  const complete = {
    indices: [
      {name: 'shared', target: 'prod-search'},
      {name: 'shared', target: 'analytics node'},
      {name: 'solo', target: 'prod-search'}
    ],
    unreachable: []
  };

  // An unpinned name on two targets is refused as ambiguous.
  it('adds target= for a name on two targets, and not for a unique one', () => {
    expect(pinFor({name: 'shared', target: 'prod-search'}, complete)).toEqual({
      index: 'shared',
      target: 'prod-search'
    });
    expect(pinFor({name: 'solo', target: 'prod-search'}, complete)).toEqual({index: 'solo'});
  });

  // A target that did not list its indices can host the name too, so the server refuses an
  // unpinned query on it although the picked target is healthy.
  it.each([
    {unreachable: [{target: 'east', message: 'No answer.'}]},
    {partial: {message: 'Discovery failed.'}},
    {indexListingFailed: {message: 'Indices failed.'}}
  ])('adds target= for a unique name when the listing is incomplete: %o', (failure) => {
    expect(pinFor({name: 'solo', target: 'prod-search'}, {...complete, ...failure})).toEqual({
      index: 'solo',
      target: 'prod-search'
    });
  });

  // Tokens are whitespace-delimited: `target=analytics node` would pin "analytics" and add junk.
  it('refuses a display name with a space', () => {
    expect(pinFor({name: 'shared', target: 'analytics node'}, complete)).toEqual({
      error: expect.stringContaining('is on more than one OpenSearch target')
    });
    const incomplete = {
      indices: [{name: 'solo', target: 'search 1'}],
      unreachable: [{target: 'east', message: 'No answer.'}]
    };
    expect(pinFor({name: 'solo', target: 'search 1'}, incomplete)).toEqual({
      error: expect.stringContaining('did not list its indices')
    });
  });
});

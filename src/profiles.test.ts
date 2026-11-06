import {describe, expect, it} from 'vitest';
import {pickerOf} from './profiles';
import type {ProfileRow} from './protocol';

const row = (fields: Partial<ProfileRow>): ProfileRow => ({
  id: 'id-1',
  name: 'Production',
  slug: 'production',
  kind: 'online',
  bindable: true,
  engines: {dynamodb: true, opensearch: false},
  ...fields
});

describe('pickerOf', () => {
  it('shows a bindable row by name, slug and engines, with nothing refused', () => {
    expect(pickerOf([row({engines: {dynamodb: true, opensearch: true}})])).toEqual({
      kind: 'pick',
      items: [
        {
          label: 'Production',
          description: 'production',
          detail: 'DynamoDB, OpenSearch',
          profile: expect.anything(),
          refusal: undefined
        }
      ]
    });
  });

  // `incomplete` is a code; the user needs a sentence, and must not bind an unbindable row.
  it('gives an incomplete row our sentence', () => {
    const picker = pickerOf([row({bindable: false, reason: 'incomplete'})]);
    expect(picker.kind === 'pick' && picker.items[0]).toMatchObject({
      detail: 'DynamoDB — This profile is incomplete. Finish setting it up in DynoTable.',
      refusal: 'This profile is incomplete. Finish setting it up in DynoTable.'
    });
  });

  // The lenient guard passes a newer server's reason; it must not read as `incomplete`.
  it('refuses a non-bindable row with no known reason in general words', () => {
    const picker = pickerOf([row({bindable: false})]);
    expect(picker.kind === 'pick' && picker.items[0]).toMatchObject({
      refusal: 'DynoTable cannot use this profile. Check it in DynoTable.'
    });
  });

  // An empty quick pick tells the user nothing.
  it('tells an empty roster to create a profile in DynoTable', () => {
    expect(pickerOf([])).toEqual({
      kind: 'empty',
      sentence: 'DynoTable has no profiles. Create a profile in DynoTable.'
    });
  });
});

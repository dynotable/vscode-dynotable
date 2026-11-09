import {describe, expect, it} from 'vitest';
import {METHOD_NOT_FOUND} from '../../../src/protocol';
import {RpcFailure} from '../../../src/rpc';
import {useHarness} from '../test-session';
import {list, type ListingCommand} from './listing';

const h = useHarness();

const request = (method: string) => h.fake.received.find((message) => message.method === method);

describe('listing commands', () => {
  const methods: Array<[ListingCommand, string, string]> = [
    ['profiles', 'dynotable/listProfiles', 'list-profiles.json'],
    ['tables', 'dynotable/listTables', 'list-tables.json'],
    ['indices', 'dynotable/listIndices', 'list-indices.json']
  ];
  it.each(methods)('%s sends %s and prints the answer whole', async (command, method, file) => {
    await h.fake.start();
    await h.run(list(command));
    expect(h.fake.received.map((message) => message.method)).toContain(method);
    expect(JSON.parse(h.stdout)).toEqual(h.fake.fixture(file));
    expect(h.stderr).toBe('');
    expect(h.codes).toEqual([0]);
  });

  // A cached listing can hide a table created since the session opened.
  it('tables asks for a fresh listing', async () => {
    await h.fake.start();
    await h.run(list('tables'));
    expect(request('dynotable/listTables')?.params).toEqual({fresh: true});
  });

  describe('an incomplete listing prints its rows and fails with listing-failed', () => {
    const answers: Array<[string, ListingCommand, string, () => unknown]> = [
      [
        'tableListingFailed',
        'tables',
        'dynotable/listTables',
        () => ({
          tables: ['orders'],
          tableListingFailed: {message: 'AccessDenied'}
        })
      ],
      [
        'indexListingFailed',
        'indices',
        'dynotable/listIndices',
        () => h.fake.fixture('list-indices-refused.json')
      ],
      [
        'only unreachable',
        'indices',
        'dynotable/listIndices',
        () => ({
          indices: [{name: 'orders', target: 'target-1'}],
          unreachable: [{target: 'target-2', message: 'timed out'}]
        })
      ],
      [
        'partial',
        'indices',
        'dynotable/listIndices',
        () => h.fake.fixture('list-indices-partial.json')
      ]
    ];
    it.each(answers)('%s', async (_name, command, method, answer) => {
      await h.fake.start();
      const value = answer();
      h.fake.handle(method, () => value);
      await h.run(list(command));
      expect(JSON.parse(h.stdout)).toEqual(value);
      expect(h.failure().code).toBe('listing-failed');
      expect(h.codes).toEqual([1]);
    });
  });

  it('an unbound session tells how to choose a profile', async () => {
    await h.fake.start();
    h.fake.agentProfiles = ['profile-1-id', 'profile-2-id'];
    await h.run(list('tables'));
    expect(h.failure().code).toBe('profile-required');
    expect(h.failure().message).toContain('dynotable-cli profiles');
    expect(h.failure().message).toContain('--profile');
    expect(h.stdout).toBe('');
    expect(h.codes).toEqual([1]);
  });

  // PROTOCOL.md lets an answer grow; a newer app must not break an older CLI.
  it('an answer with an extra field succeeds', async () => {
    await h.fake.start();
    h.fake.handle('dynotable/listTables', () => ({
      tables: ['orders'],
      region: 'eu-west-1'
    }));
    await h.run(list('tables'));
    expect(h.codes).toEqual([0]);
    expect(h.stderr).toBe('');
  });

  it('a malformed answer fails with bad-answer and prints nothing', async () => {
    await h.fake.start();
    h.fake.handle('dynotable/listIndices', () => ({indices: 'none'}));
    await h.run(list('indices'));
    expect(h.failure().code).toBe('bad-answer');
    expect(h.stdout).toBe('');
    expect(h.codes).toEqual([1]);
  });

  it('an app without the request fails with missing-request', async () => {
    await h.fake.start();
    h.fake.handle('dynotable/listIndices', () => {
      throw new RpcFailure({
        code: METHOD_NOT_FOUND,
        message: 'Unhandled method'
      });
    });
    await h.run(list('indices'));
    expect(h.failure().code).toBe('missing-request');
    expect(h.codes).toEqual([1]);
  });
});

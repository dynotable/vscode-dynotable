import {describe, expect, it} from 'vitest';
import {queryOf, treeOf, type Listing} from './explorer-model';
import type {ListIndicesResult, ListTablesResult} from './protocol';

const tables = (value: ListTablesResult): Listing<ListTablesResult> => ({kind: 'ok', value});
const indices = (value: Partial<ListIndicesResult>): Listing<ListIndicesResult> => ({
  kind: 'ok',
  value: {indices: [], unreachable: [], ...value}
});
const noTables = tables({tables: []});

describe('treeOf', () => {
  // Without a `target=` pin, the server cannot tell which of the two indices a query means.
  it('gives a name on two targets one node per target, each pinned to its target', () => {
    const rows = [
      {name: 'shared', target: 'east'},
      {name: 'shared', target: 'west'}
    ];
    expect(treeOf(noTables, indices({indices: rows}))).toEqual([
      {
        kind: 'group',
        label: 'OpenSearch',
        children: [
          {
            kind: 'target',
            label: 'east',
            children: [{kind: 'index', name: 'shared', pin: {index: 'shared', target: 'east'}}]
          },
          {
            kind: 'target',
            label: 'west',
            children: [{kind: 'index', name: 'shared', pin: {index: 'shared', target: 'west'}}]
          }
        ]
      }
    ]);
  });

  // A listing that failed in part must not look complete.
  it('shows each failure field as a message node', () => {
    const tree = treeOf(
      tables({tables: ['orders'], tableListingFailed: {message: 'Tables failed.'}}),
      indices({
        indexListingFailed: {message: 'Indices failed.'},
        partial: {message: 'Discovery failed.'},
        unreachable: [{target: 'east', message: 'No answer.'}]
      })
    );
    expect(tree).toEqual([
      {
        kind: 'group',
        label: 'DynamoDB',
        children: [
          {kind: 'message', text: 'Tables failed.'},
          {kind: 'table', name: 'orders'}
        ]
      },
      {
        kind: 'group',
        label: 'OpenSearch',
        children: [
          {kind: 'message', text: 'Indices failed.'},
          {kind: 'message', text: 'Discovery failed.'},
          {kind: 'message', text: 'east: No answer.'}
        ]
      }
    ]);
  });

  // A refused request still tells the user why the engine shows nothing.
  it('shows a refused request as a message node in its group', () => {
    const refused: Listing<ListTablesResult> = {kind: 'failed', message: 'Sign in again.'};
    expect(treeOf(refused, indices({}))).toEqual([
      {kind: 'group', label: 'DynamoDB', children: [{kind: 'message', text: 'Sign in again.'}]}
    ]);
  });

  // A profile with no OpenSearch engine answers an empty list; an empty group is noise.
  it('shows no group for an engine with an empty list and no failure', () => {
    expect(treeOf(noTables, indices({}))).toEqual([]);
  });
});

describe('queryOf', () => {
  // An unescaped quote ends the identifier early and the statement breaks.
  it('doubles a quote in a table name', () => {
    expect(queryOf({kind: 'table', name: 'say "hi"'})).toEqual({
      language: 'sql',
      text: 'SELECT * FROM "say ""hi"""'
    });
  });
});

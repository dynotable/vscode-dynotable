import {strict as assert} from 'node:assert';
import {after, before, describe, it} from 'mocha';
import * as vscode from 'vscode';
import {RpcFailure} from '../../scripts/rpc';
import type {Node} from '../explorer-model';
import type {WireError} from '../protocol';
import {
  api,
  explorerGroup as group,
  fakeServer,
  quickPicks,
  toasts,
  waitFor,
  waitForStatus
} from './harness';

const fake = fakeServer();
const LIST_TABLES = 'dynotable/listTables';
const LIST_INDICES = 'dynotable/listIndices';

let tables = ['orders', 'customers'];
const INDICES = {indices: [{name: 'products', target: 'search-1'}], unreachable: []};
fake.handle(LIST_TABLES, () => ({tables}));
fake.handle(LIST_INDICES, () => INDICES);

const children = async (node?: Node) => (await api()).explorer.children(node);
const labels = (nodes: Node[]) =>
  nodes.map((node) =>
    node.kind === 'group' || node.kind === 'target'
      ? node.label
      : node.kind === 'message'
        ? node.text
        : node.name
  );
const sent = (method: string) =>
  fake.received.filter((message) => message.method === method).map((message) => message.params);

describe('explorer', () => {
  before(() => fake.start());
  after(() => fake.stop());

  // Runs first: nothing else has connected yet.
  it('showing the view connects', async () => {
    assert.equal((await api()).status().kind, 'hidden');
    await vscode.commands.executeCommand('dynotable.explorer.focus');
    await waitForStatus('connected');
  });

  it("lists the fake's tables and indices", async () => {
    await group('OpenSearch');
    assert.deepEqual(labels(await children()), ['DynamoDB', 'OpenSearch']);
    assert.deepEqual(labels(await children(await group('DynamoDB'))), ['orders', 'customers']);
    const targets = await children(await group('OpenSearch'));
    assert.deepEqual(labels(targets), ['search-1']);
    assert.deepEqual(labels(await children(targets[0])), ['products']);
  });

  // Without `fresh`, the server answers from its cache, so Refresh would show nothing new.
  it('Refresh sends fresh: true to both requests', async () => {
    const counts = {tables: sent(LIST_TABLES).length, indices: sent(LIST_INDICES).length};
    await vscode.commands.executeCommand('dynotable.refreshExplorer');
    await waitFor('both refreshed listings', () =>
      [sent(LIST_TABLES).slice(counts.tables), sent(LIST_INDICES).slice(counts.indices)].every(
        (params) => params.some((p) => (p as {fresh?: boolean}).fresh === true)
      )
    );
  });

  // A VPC-only OpenSearch domain off the VPN takes about 30 s to fail.
  it('tables show while the index listing is still in flight', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fake.handle(LIST_INDICES, async () => {
      await held;
      return INDICES;
    });
    try {
      await vscode.commands.executeCommand('dynotable.refreshExplorer');
      assert.deepEqual(labels(await children()), ['DynamoDB']);
    } finally {
      release();
      fake.handle(LIST_INDICES, () => INDICES);
    }
    await group('OpenSearch');
  });

  it("drops a replaced session's listing", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    fake.handle(LIST_TABLES, async () => {
      await held;
      return {tables: ['old-session']};
    });
    let old: Promise<Node[]>;
    try {
      const listed = sent(LIST_TABLES).length;
      await vscode.commands.executeCommand('dynotable.refreshExplorer');
      old = children();
      await waitFor('the held listing', () => sent(LIST_TABLES).length > listed);
      fake.handle(LIST_TABLES, () => ({tables}));
      await vscode.commands.executeCommand('dynotable.reconnect');
      await waitForStatus('connected');
    } finally {
      release();
    }
    assert.deepEqual(await old, []);
  });

  it('New query on an index that cannot be pinned warns and opens nothing', async () => {
    fake.handle(LIST_INDICES, () => ({
      indices: [
        {name: 'logs', target: 'search 1'},
        {name: 'logs', target: 'search-2'}
      ],
      unreachable: []
    }));
    try {
      await vscode.commands.executeCommand('dynotable.refreshExplorer');
      const target = (await children(await group('OpenSearch'))).find(
        (node) => node.kind === 'target' && node.label === 'search 1'
      );
      const [index] = await children(target);
      const opened = vscode.workspace.textDocuments.length;
      toasts.length = 0;
      await vscode.commands.executeCommand('dynotable.newQuery', index);
      assert.deepEqual(toasts, [
        {
          kind: 'warning',
          message:
            '"logs" is on more than one OpenSearch target, and the target name "search 1" contains a space, so it cannot be pinned.'
        }
      ]);
      assert.equal(vscode.workspace.textDocuments.length, opened);
    } finally {
      fake.handle(LIST_INDICES, () => INDICES);
      await vscode.commands.executeCommand('dynotable.refreshExplorer');
    }
  });

  // Another profile has other tables; the old profile's tree must not stay.
  it('a profile change refetches', async () => {
    tables = ['after-switch'];
    quickPicks.answer = 'profile-2-name';
    await vscode.commands.executeCommand('dynotable.selectProfile');
    await waitForStatus('connected');
    assert.deepEqual(labels(await children(await group('DynamoDB'))), ['after-switch']);
  });

  it('New query on an index opens an opensearch buffer with a directive', async () => {
    const targets = await children(await group('OpenSearch'));
    const [index] = await children(targets[0]);
    await vscode.commands.executeCommand('dynotable.newQuery', index);
    const document = vscode.window.activeTextEditor?.document;
    assert.equal(document?.languageId, 'opensearch');
    assert.equal(document.lineAt(0).text, '// dynotable: index=products');
  });

  it('the unbound state shows its reason as the tree message', async () => {
    const refusal = fake.fixture('error-profile-required.json') as WireError;
    fake.handle(LIST_TABLES, () => {
      throw new RpcFailure(refusal);
    });
    await vscode.commands.executeCommand('dynotable.reconnect');
    await waitForStatus('unbound');
    assert.equal(
      (await api()).explorer.message(),
      'Select a DynoTable profile to run queries and list tables.'
    );
    assert.deepEqual(await children(), []);
  });
});

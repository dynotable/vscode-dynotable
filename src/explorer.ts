import * as vscode from 'vscode';
import type {LanguageClient} from 'vscode-languageclient/node';
import {LIST_INDICES, LIST_TABLES, requestListing} from './client';
import {treeOf, type Listing, type Node} from './explorer-model';
import {
  listIndicesSchema,
  listTablesSchema,
  type ListIndicesResult,
  type ListTablesResult
} from './protocol';
import {REASONS} from './reasons';
import type {StatusModel} from './status';

const VIEW_ID = 'dynotable.explorer';

/**
 * One session's listings. Indices are fetched when the tree is first drawn. Tables never wait for
 * them: a slow OpenSearch target can take 30 s to answer.
 */
interface Listings {
  client: LanguageClient;
  tables: Promise<Listing<ListTablesResult>>;
  indices?: Listing<ListIndicesResult> | 'pending';
}

const ICONS: Record<Node['kind'], string> = {
  group: 'database',
  target: 'server',
  table: 'table',
  index: 'search',
  message: 'warning'
};

export class Explorer implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  readonly view: vscode.TreeView<Node>;
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private listings: Listings | undefined;

  constructor(
    private readonly status: () => StatusModel,
    onVisible: () => void
  ) {
    this.view = vscode.window.createTreeView(VIEW_ID, {treeDataProvider: this});
    this.view.onDidChangeVisibility(({visible}) => {
      if (visible) onVisible();
    });
  }

  /** A new session, with the answer of its connect-time `dynotable/listTables`. */
  connected(client: LanguageClient, tables: Promise<Listing<ListTablesResult>>): void {
    this.listings = {client, tables};
    this.render();
  }

  /** Sends `fresh: true` to both requests. */
  refresh(): void {
    const client = this.listings?.client;
    if (!client) return;
    const listings: Listings = {
      client,
      tables: requestListing(client, LIST_TABLES, listTablesSchema, true)
    };
    this.listings = listings;
    this.requestIndices(listings, true);
    this.render();
  }

  /** Redraws for the current status. */
  render(): void {
    this.view.message = messageOf(this.status());
    this.changed.fire();
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node) return node.kind === 'group' || node.kind === 'target' ? node.children : [];
    const listings = this.listings;
    if (!listings || this.status().kind !== 'connected') return [];
    if (!listings.indices) this.requestIndices(listings, false);
    const tables = await listings.tables;
    // A newer session or an unbound answer arrived meanwhile; its own redraw follows.
    if (listings !== this.listings || this.status().kind !== 'connected') return [];
    return treeOf(tables, listings.indices === 'pending' ? undefined : listings.indices);
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const label =
      node.kind === 'group' || node.kind === 'target'
        ? node.label
        : node.kind === 'message'
          ? node.text
          : node.name;
    const item = new vscode.TreeItem(
      label,
      node.kind === 'group' || node.kind === 'target'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None
    );
    item.iconPath = new vscode.ThemeIcon(ICONS[node.kind]);
    item.contextValue = node.kind;
    if (node.kind === 'message') item.tooltip = node.text;
    if (node.kind === 'table' || node.kind === 'index') {
      item.command = {command: 'dynotable.newQuery', title: 'New Query', arguments: [node]};
    }
    return item;
  }

  /** The OpenSearch group shows when its own listing arrives. */
  private requestIndices(listings: Listings, fresh: boolean): void {
    listings.indices = 'pending';
    void requestListing(listings.client, LIST_INDICES, listIndicesSchema, fresh).then((indices) => {
      listings.indices = indices;
      if (listings === this.listings) this.changed.fire();
    });
  }

  dispose(): void {
    this.view.dispose();
    this.changed.dispose();
  }
}

function messageOf(model: StatusModel): string | undefined {
  switch (model.kind) {
    case 'starting':
      return 'Connecting to DynoTable…';
    case 'unbound':
      return REASONS.unbound.sentence;
    case 'disconnected':
      return REASONS[model.reason].sentence;
    default:
      return undefined;
  }
}

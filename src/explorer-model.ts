import {directiveLine, pinFor, type Pin} from './directive';
import type {FailureCode, ListIndicesResult, ListTablesResult} from './protocol';

/** One listing request's answer. A refusal keeps the server's sentence. */
export type Listing<T> =
  | {kind: 'ok'; value: T}
  | {kind: 'failed'; message: string; code?: number; failure?: FailureCode};

export type Node =
  | {kind: 'group'; label: string; children: Node[]}
  | {kind: 'target'; label: string; children: Node[]}
  | {kind: 'table'; name: string}
  /** `pin` is what New query writes into the directive, or why the index cannot be pinned. */
  | {kind: 'index'; name: string; pin: Pin | {error: string}}
  | {kind: 'message'; text: string};

/** A new buffer's dialect and text. */
export interface Query {
  language: 'sql' | 'partiql' | 'opensearch';
  text: string;
}

const message = (text: string): Node => ({kind: 'message', text});

/**
 * DynamoDB → tables, OpenSearch → target → indices. An engine with nothing to show gets no group,
 * and neither does a listing that has not arrived (`undefined`).
 */
export function treeOf(
  tables: Listing<ListTablesResult>,
  indices: Listing<ListIndicesResult> | undefined
): Node[] {
  const groups: Array<Extract<Node, {kind: 'group'}>> = [
    {kind: 'group', label: 'DynamoDB', children: tableNodes(tables)},
    {kind: 'group', label: 'OpenSearch', children: indexNodes(indices)}
  ];
  return groups.filter((group) => group.children.length > 0);
}

function tableNodes(listing: Listing<ListTablesResult>): Node[] {
  if (listing.kind === 'failed') return [message(listing.message)];
  const {tables, tableListingFailed} = listing.value;
  return [
    ...(tableListingFailed ? [message(tableListingFailed.message)] : []),
    ...tables.map((name): Node => ({kind: 'table', name}))
  ];
}

function indexNodes(listing: Listing<ListIndicesResult> | undefined): Node[] {
  if (!listing) return [];
  if (listing.kind === 'failed') return [message(listing.message)];
  const {indices} = listing.value;
  const targets = new Map<string, Node[]>();
  for (const row of indices) {
    const children = targets.get(row.target) ?? [];
    targets.set(row.target, children);
    children.push({kind: 'index', name: row.name, pin: pinFor(row, listing.value)});
  }
  return [
    ...indexFailures(listing.value).map(message),
    ...[...targets].map(([label, children]): Node => ({kind: 'target', label, children}))
  ];
}

/** Why the index list can be incomplete, one sentence per failure. */
export function indexFailures({
  indexListingFailed,
  partial,
  unreachable
}: ListIndicesResult): string[] {
  return [
    indexListingFailed?.message,
    partial?.message,
    ...unreachable.map((row) => `${row.target}: ${row.message}`)
  ].filter((text) => text !== undefined);
}

/** New query on a table or an index. */
export function queryOf(node: Node): Query | {error: string} | undefined {
  switch (node.kind) {
    case 'table':
      return {language: 'sql', text: `SELECT * FROM "${node.name.replaceAll('"', '""')}"`};
    case 'index':
      return 'error' in node.pin
        ? node.pin
        : {language: 'opensearch', text: `${directiveLine(node.pin)}\n`};
    default:
      return undefined;
  }
}

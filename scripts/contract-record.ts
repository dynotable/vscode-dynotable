/**
 * Records a running DynoTable's answers into `contract/` (`record`), or diffs them against the
 * committed fixtures (`check`). See `docs/publishing.md`, "Gate: recording and the live subset",
 * for the preconditions.
 *
 *   pnpm contract:record --profile <id|slug> --table <name> --large-table <name> --index <name>
 *     --set-table <name> --sql <a SELECT that names its columns>
 *     --projection-sql <a SELECT that names Set columns>
 *     --key-sql <a SELECT * whose WHERE bounds the partition key>
 *     --hidden-profile <id|slug of a profile not available to agents> [--user-data-dir <dir>]
 *   pnpm contract:check  (same options)
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {connect} from 'node:net';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {isDeepStrictEqual, parseArgs} from 'node:util';
import {currentPlatform, portFilePath, readPortFile, userDataDir} from '../src/discovery';
import {METHOD_NOT_FOUND, problem, type PortFile, type ProfileRow} from '../src/protocol';
import {GUARDS, leaks, readManifest, scrub, strings, type Manifest} from './contract';
import {Peer, RpcFailure} from '../src/rpc';

const CONTRACT_DIR = 'contract';

/** All three capabilities that gate a server feature. */
const CAPABILITIES = {
  window: {showMessage: {}, workDoneProgress: true},
  textDocument: {completion: {completionItem: {snippetSupport: true}}}
};

interface Options {
  profile: string;
  table: string;
  /** Large enough that a run is still in flight when its cancel arrives. */
  largeTable: string;
  /** Holds string, number and binary Sets, also inside a map. */
  setTable: string;
  index: string;
  sql: string;
  /** Names Set columns, so a projected Set answers the shape of `SELECT *`. */
  projectionSql: string;
  /** Plans as a Query, so the run takes the server's key-read route, not a Scan. */
  keySql: string;
  /** A profile in the roster that is not available to agents. */
  hiddenProfile: string;
  userDataDir: string | undefined;
}

interface Session {
  peer: Peer;
  result: unknown;
  notifications: Array<{method: string; params: unknown}>;
}

function fail(message: string): never {
  throw new Error(message);
}

function open(port: number): Promise<Peer> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => resolve(new Peer(socket)));
    socket.once('error', reject);
  });
}

async function session(file: PortFile, profile?: string, purpose?: 'agent'): Promise<Session> {
  const peer = await open(file.port);
  const notifications: Session['notifications'] = [];
  peer.onNotification = (method, params) => notifications.push({method, params});
  peer.onRequest = (method) => {
    if (method === 'window/workDoneProgress/create') return null;
    throw new RpcFailure({
      code: METHOD_NOT_FOUND,
      message: `The recorder does not handle ${method}`
    });
  };
  const result = await peer.request('initialize', {
    processId: process.pid,
    rootUri: null,
    capabilities: CAPABILITIES,
    initializationOptions: {
      token: file.token,
      ...(profile ? {profile} : {}),
      ...(purpose ? {purpose} : {})
    }
  }).response;
  peer.notify('initialized', {});
  return {peer, result, notifications};
}

async function close({peer}: Session): Promise<void> {
  await peer.request('shutdown').response;
  peer.notify('exit');
  peer.socket.destroy();
}

/** The error a request answered with. A success means a precondition does not hold. */
async function refusal(response: Promise<unknown>, precondition: string): Promise<unknown> {
  try {
    await response;
  } catch (error) {
    if (error instanceof RpcFailure) return error.error;
    throw error;
  }
  return fail(`Expected a refusal. Precondition: ${precondition}.`);
}

function openDocument(peer: Peer, uri: string, languageId: string, text: string): void {
  peer.notify('textDocument/didOpen', {textDocument: {uri, languageId, version: 1, text}});
}

const execute = (peer: Peer, command: string, args: object) =>
  peer.request('workspace/executeCommand', {command, arguments: [args]});

/** Keeps the recorded rows few. */
const ROW_CAP = 3;
const run = (peer: Peer, args: object) =>
  execute(peer, 'dynotable.runStatement', {...args, rowCap: ROW_CAP});

async function waitFor<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let i = 0; i < 40; i++) {
    const value = read();
    if (value !== undefined) return value;
    await sleep(50);
  }
  return fail(`Timed out waiting for ${what}.`);
}

/** Every answer and refusal the fixtures hold, keyed by fixture file. Unscrubbed. */
async function capture(file: PortFile, options: Options): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  const {table, largeTable, setTable, index, sql, projectionSql, keySql} = options;

  const stranger = await open(file.port);
  out.set(
    'error-auth.json',
    await refusal(
      stranger.request('initialize', {
        processId: null,
        rootUri: null,
        capabilities: {},
        initializationOptions: {token: 'not-the-token'}
      }).response,
      'the server refuses a wrong token'
    )
  );
  stranger.socket.destroy();

  const unbound = await session(file);
  out.set('initialize.json', unbound.result);
  out.set('list-profiles.json', await unbound.peer.request('dynotable/listProfiles').response);
  out.set(
    'error-profile-required.json',
    await refusal(
      unbound.peer.request('dynotable/listTables', {}).response,
      'a roster of more than one profile, so a session with no profile starts unbound'
    )
  );
  await close(unbound);

  const agent = await session(file, options.hiddenProfile, 'agent');
  out.set(
    'error-profile-not-exposed.json',
    await refusal(
      agent.peer.request('dynotable/listTables', {}).response,
      `profile "${options.hiddenProfile}" is in the roster and not available to agents`
    )
  );
  await close(agent);

  const bound = await session(file, options.profile);
  const {peer} = bound;
  out.set('list-tables.json', await peer.request('dynotable/listTables', {}).response);
  out.set('list-indices.json', await peer.request('dynotable/listIndices', {}).response);

  const sqlUri = 'file:///contract/query.dynotable.sql';
  openDocument(peer, sqlUri, 'sql', `${sql};\nSELECT COUNT(*) FROM "${table}";`);
  const lenses = (await peer.request('textDocument/codeLens', {textDocument: {uri: sqlUri}})
    .response) as Array<{command: {command: string; arguments: [object]}}> | null;
  out.set('code-lens.json', lenses);
  const runLens =
    lenses?.find((lens) => lens.command.command === 'dynotable.runStatement') ??
    fail(`No Run lens. Precondition: the profile lists table "${table}".`);

  bound.notifications.length = 0;
  out.set('run-sql.json', await run(peer, runLens.command.arguments[0]).response);
  out.set(
    'progress.json',
    bound.notifications.filter((n) => n.method === '$/progress').map((n) => n.params)
  );

  const starUri = 'file:///contract/star.dynotable.sql';
  openDocument(peer, starUri, 'sql', `SELECT * FROM "${table}"`);
  out.set('run-sql-star.json', await run(peer, {uri: starUri}).response);

  const partiqlUri = 'file:///contract/query.partiql';
  openDocument(peer, partiqlUri, 'partiql', `SELECT * FROM "${table}"`);
  out.set('run-partiql.json', await run(peer, {uri: partiqlUri}).response);

  for (const [fixture, uri, languageId] of [
    ['run-sql-set.json', 'file:///contract/set.dynotable.sql', 'sql'],
    ['run-partiql-set.json', 'file:///contract/set.partiql', 'partiql']
  ] as const) {
    openDocument(peer, uri, languageId, `SELECT * FROM "${setTable}"`);
    out.set(fixture, await run(peer, {uri}).response);
  }

  const projectionUri = 'file:///contract/projection.dynotable.sql';
  openDocument(peer, projectionUri, 'sql', projectionSql);
  out.set('run-sql-projection.json', await run(peer, {uri: projectionUri}).response);

  const keyUri = 'file:///contract/key.dynotable.sql';
  openDocument(peer, keyUri, 'sql', keySql);
  out.set('run-sql-key.json', await run(peer, {uri: keyUri}).response);

  const openSearchUri = 'file:///contract/query.opensearch';
  openDocument(
    peer,
    openSearchUri,
    'opensearch',
    `// dynotable: index=${index}\n{"match_all": {}}`
  );
  out.set('run-opensearch.json', await run(peer, {uri: openSearchUri}).response);

  out.set(
    'error-profile-window-required.json',
    await refusal(
      execute(peer, 'dynotable.openInApp', runLens.command.arguments[0]).response,
      'no DynoTable window is open on the chosen profile'
    )
  );

  const writeUri = 'file:///contract/write.partiql';
  openDocument(peer, writeUri, 'partiql', `INSERT INTO "${table}" VALUE {'pk': 'contract'}`);
  out.set(
    'error-stage-in-app.json',
    await refusal(
      execute(peer, 'dynotable.runStatement', {uri: writeUri}).response,
      'a PartiQL write is refused for staging'
    )
  );

  const begins = () =>
    bound.notifications.filter(
      (n) =>
        n.method === '$/progress' && (n.params as {value: {kind: string}}).value.kind === 'begin'
    ).length;
  // The cancel goes out once the run reports `begin`, so the reply is that of a run in flight. The
  // live subset covers a cancel sent at once.
  const cancelSqlUri = 'file:///contract/cancel.dynotable.sql';
  openDocument(peer, cancelSqlUri, 'sql', `SELECT * FROM "${largeTable}"`);
  const cancelPartiqlUri = 'file:///contract/cancel.partiql';
  openDocument(peer, cancelPartiqlUri, 'partiql', `SELECT * FROM "${largeTable}"`);
  for (const [fixture, uri] of [
    ['error-cancel-sql.json', cancelSqlUri],
    ['error-cancel-partiql.json', cancelPartiqlUri]
  ] as const) {
    const begun = begins();
    const pending = execute(peer, 'dynotable.runStatement', {uri});
    await waitFor(
      () => (begins() > begun ? true : undefined),
      `the $/progress begin of ${fixture}`
    );
    peer.notify('$/cancelRequest', {id: pending.id});
    out.set(
      fixture,
      await refusal(
        pending.response,
        `table "${largeTable}" is large enough that a run is still in flight when the cancel arrives`
      )
    );
  }

  bound.notifications.length = 0;
  out.set(
    'validate-query.json',
    await execute(peer, 'dynotable.validateQuery', {uri: openSearchUri}).response
  );
  out.set(
    'validate-query-message.json',
    await waitFor(
      () => bound.notifications.find((n) => n.method === 'window/showMessage')?.params,
      'the window/showMessage that validateQuery sends'
    )
  );
  await close(bound);
  return out;
}

const HOST =
  /https?:\/\/([^/\s:"'<>()]+)|\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:amazonaws\.com(?:\.cn)?|on\.aws))\b/gi;

/** Secret → placeholder: every roster name, slug and id, every target and endpoint host, and the token. */
function secretsOf(captured: Map<string, unknown>, token: string): Map<string, string> {
  const secrets = new Map<string, string>([[token, 'token']]);
  const profiles = (captured.get('list-profiles.json') ?? []) as ProfileRow[];
  for (const [i, row] of profiles.entries()) {
    secrets.set(row.id, `profile-${i + 1}-id`);
    secrets.set(row.name, `profile-${i + 1}-name`);
    secrets.set(row.slug, `profile-${i + 1}-slug`);
  }
  const indices = captured.get('list-indices.json') as
    | {indices: Array<{target: string}>; unreachable: Array<{target: string}>}
    | undefined;
  const targets = new Set(
    [...(indices?.indices ?? []), ...(indices?.unreachable ?? [])].map((row) => row.target)
  );
  for (const [i, target] of [...targets].entries()) secrets.set(target, `target-${i + 1}`);
  const hosts = new Set<string>();
  for (const text of strings([...captured.values()])) {
    for (const match of text.matchAll(HOST)) hosts.add((match[1] ?? match[2]) as string);
  }
  for (const [i, host] of [...hosts].entries()) {
    if (!secrets.has(host)) secrets.set(host, `host-${i + 1}`);
  }
  return secrets;
}

function record(captured: Map<string, unknown>, token: string): void {
  const secrets = secretsOf(captured, token);
  const scrubbed = new Map([...captured].map(([file, value]) => [file, scrub(value, secrets)]));
  // The secrets list stays in memory, and is never printed: the repo must never hold it.
  const leaked = [...scrubbed].filter(([, value]) => leaks(value, secrets.keys()).length > 0);
  if (leaked.length > 0) {
    fail(`Refusing to write: a secret survived the scrub in ${leaked.map(([f]) => f).join(', ')}.`);
  }
  const manifest = readManifest(CONTRACT_DIR);
  for (const [file, value] of scrubbed) {
    const entry = manifest[file] ?? fail(`${file} is not listed in contract/manifest.json`);
    writeFileSync(join(CONTRACT_DIR, file), JSON.stringify(value, null, 2) + '\n');
    entry.provenance = 'recorded';
    const found = problem(GUARDS[entry.guard], value, 'strict');
    if (found) console.warn(`${file} fails its strict guard (${found}); update src/protocol.ts.`);
  }
  writeFileSync(join(CONTRACT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(`Recorded ${scrubbed.size} fixtures.`);
}

const typeName = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

/** Key set and `typeof` per field. An array is read through its first element. */
function shape(value: unknown): string {
  const item = Array.isArray(value) ? value[0] : value;
  if (typeof item !== 'object' || item === null) return typeName(item);
  return Object.entries(item)
    .map(([key, field]) => `${key}:${typeName(field)}`)
    .toSorted()
    .join(', ');
}

const capabilitiesOf = (value: unknown) => (value as {capabilities: unknown}).capabilities;

const codesOf = (value: unknown) => {
  const error = value as {code: number; data?: {code?: string}};
  return `${error.code}/${error.data?.code ?? '-'}`;
};

function compare(file: string, manifest: Manifest, actual: unknown): string | undefined {
  const expected: unknown = JSON.parse(readFileSync(join(CONTRACT_DIR, file), 'utf8'));
  const entry = manifest[file];
  // The comparisons below look only at keys, codes and capabilities, not at value types.
  const invalid = entry && problem(GUARDS[entry.guard], actual, 'strict');
  if (invalid) return invalid;
  switch (entry?.guard) {
    case 'initializeResult':
      return isDeepStrictEqual(capabilitiesOf(actual), capabilitiesOf(expected))
        ? undefined
        : 'capabilities differ';
    case 'responseError':
      return codesOf(actual) === codesOf(expected)
        ? undefined
        : `refusal ${codesOf(actual)}, fixture ${codesOf(expected)}`;
    case 'runResult': {
      // The guard does not look inside a row, so a changed cell type (a Set as an array) shows here.
      const row = (value: unknown) => shape((value as {rows: unknown}).rows);
      if (shape(actual) !== shape(expected)) {
        return `shape {${shape(actual)}}, fixture {${shape(expected)}}`;
      }
      return row(actual) === row(expected)
        ? undefined
        : `first row {${row(actual)}}, fixture {${row(expected)}}`;
    }
    default:
      return shape(actual) === shape(expected)
        ? undefined
        : `shape {${shape(actual)}}, fixture {${shape(expected)}}`;
  }
}

function check(captured: Map<string, unknown>): void {
  const manifest = readManifest(CONTRACT_DIR);
  const drift = [...captured]
    .map(([file, value]) => [file, compare(file, manifest, value)] as const)
    .filter(([, found]) => found !== undefined);
  for (const [file, found] of drift) console.error(`${file}: ${found}`);
  if (drift.length > 0) fail(`${drift.length} fixture(s) drifted from the server.`);
  console.log(`${captured.size} fixtures match the server.`);
}

async function main(): Promise<void> {
  const {positionals, values} = parseArgs({
    allowPositionals: true,
    options: {
      profile: {type: 'string'},
      table: {type: 'string'},
      'large-table': {type: 'string'},
      'set-table': {type: 'string'},
      index: {type: 'string'},
      sql: {type: 'string'},
      'projection-sql': {type: 'string'},
      'key-sql': {type: 'string'},
      'hidden-profile': {type: 'string'},
      'user-data-dir': {type: 'string'}
    }
  });
  const mode = positionals[0];
  if (mode !== 'record' && mode !== 'check') fail('Usage: contract-record <record|check> …');
  const options: Options = {
    profile: values.profile ?? fail('--profile is required'),
    table: values.table ?? fail('--table is required'),
    largeTable: values['large-table'] ?? fail('--large-table is required'),
    setTable: values['set-table'] ?? fail('--set-table is required'),
    index: values.index ?? fail('--index is required'),
    sql: values.sql ?? fail('--sql is required'),
    projectionSql: values['projection-sql'] ?? fail('--projection-sql is required'),
    keySql: values['key-sql'] ?? fail('--key-sql is required'),
    hiddenProfile: values['hidden-profile'] ?? fail('--hidden-profile is required'),
    userDataDir: values['user-data-dir']
  };
  const platform = currentPlatform();
  const userData = options.userDataDir ?? userDataDir(platform, process.env, homedir());
  const fs = {readFile: (path: string) => readFileSync(path, 'utf8')};
  const file =
    readPortFile(fs, portFilePath(platform, userData)) ??
    fail('No port file. Start DynoTable with the Editor integration on.');
  const captured = await capture(file, options);
  if (mode === 'record') record(captured, file.token);
  else check(captured);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

/**
 * Wire types and runtime guards for the DynoTable Language Server's custom surface.
 *
 * `lenient` is the client's mode: the server's surface is additive, so an extra key or a new enum
 * value must not break an installed extension. `strict` refuses both, so this repo's fixtures and
 * fake server see drift first.
 */

export type Mode = 'lenient' | 'strict';

export const AUTH_FAILED = -32898;
export const REQUEST_FAILED = -32803;
export const METHOD_NOT_FOUND = -32601;
export const INTERNAL_ERROR = -32603;

const FAILURE_CODES = [
  'profile-required',
  'profile-window-required',
  'reauth-required',
  'premium-required',
  'signed-out',
  'stage-in-app',
  'busy',
  'planner-refused',
  'run-failed'
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export interface PortFile {
  port: number;
  token: string;
  /** Absent when an older app wrote the file. */
  pid?: number;
}

export interface Position {
  line: number;
  character: number;
}

export interface Range {
  start: Position;
  end: Position;
}

export interface CommandArgs {
  uri: string;
  range?: Range;
  rowCap?: number;
  index?: string;
  target?: string;
}

export interface RunResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  returnedRows: number;
  /** `null` means unknown. */
  totalRows: number | null;
  truncated: boolean;
  itemsScanned?: number;
  approximateBytes: number;
  elapsedMs: number;
  executedStatement: string;
  effectiveRowCap: number;
}

export interface ProfileRow {
  id: string;
  name: string;
  slug: string;
  kind: 'online' | 'offline';
  bindable: boolean;
  reason?: 'incomplete';
  engines: {dynamodb: boolean; opensearch: boolean};
}

export interface ListingFailure {
  message: string;
}

export interface ListTablesResult {
  tables: string[];
  tableListingFailed?: ListingFailure;
}

export interface IndexRow {
  name: string;
  target: string;
}

export interface ListIndicesResult {
  indices: IndexRow[];
  unreachable: Array<{target: string; message: string}>;
  indexListingFailed?: ListingFailure;
  partial?: ListingFailure;
}

export interface FailureData {
  code: FailureCode;
}

export interface InitializeResult {
  capabilities: Record<string, unknown>;
  serverInfo: {name: string; version: string};
}

/** A Run or Open lens. Its own range is a zero-width anchor; the statement is in the argument. */
export interface CodeLens {
  range: Range;
  command: {title: string; command: string; arguments: [CommandArgs]};
}

export interface ProgressParams {
  token: string | number;
  value: {kind: 'begin'; title: string; cancellable?: boolean} | {kind: 'end'};
}

export interface ShowMessageParams {
  type: number;
  message: string;
}

/** An error response on the wire. */
export interface WireError {
  code: number;
  message: string;
  data?: FailureData;
}

/** Returns the first problem as a path and a sentence, or `undefined` when the value fits. */
type Check = (value: unknown, mode: Mode, path: string) => string | undefined;

/** A guard. `T` exists only for the type predicate in `is`. */
export interface Schema<T> {
  readonly check: Check;
  readonly _type?: T;
}

const schema = <T>(check: Check): Schema<T> => ({check});

const typeOf = (expected: 'string' | 'number' | 'boolean') =>
  schema((value, _mode, path) =>
    typeof value === expected ? undefined : `${path}: expected ${expected}`
  );

export const str = typeOf('string') as Schema<string>;
const num = typeOf('number') as Schema<number>;
const bool = typeOf('boolean') as Schema<boolean>;

const integer = (min: number, max = Number.MAX_SAFE_INTEGER) =>
  schema<number>((value, _mode, path) =>
    Number.isInteger(value) && (value as number) >= min && (value as number) <= max
      ? undefined
      : `${path}: expected an integer in [${min}, ${max}]`
  );

const nonEmpty = schema<string>((value, _mode, path) =>
  typeof value === 'string' && value !== '' ? undefined : `${path}: expected a non-empty string`
);

const nullable = <T>(inner: Schema<T>) =>
  schema<T | null>((value, mode, path) =>
    value === null ? undefined : inner.check(value, mode, path)
  );

/** A strict guard knows every member; a lenient one accepts any string. */
const oneOf = <T extends string>(members: readonly T[]) =>
  schema<T>((value, mode, path) => {
    if (typeof value !== 'string') return `${path}: expected string`;
    if (mode === 'strict' && !members.includes(value as T)) {
      return `${path}: unknown value "${value}"`;
    }
    return undefined;
  });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const arrayOf = <T>(item: Schema<T>) =>
  schema<T[]>((value, mode, path) => {
    if (!Array.isArray(value)) return `${path}: expected array`;
    for (const [i, element] of value.entries()) {
      const found = item.check(element, mode, `${path}[${i}]`);
      if (found) return found;
    }
    return undefined;
  });

/** Row values are free-form; only the row's own shape is checked. */
const anyRecord = schema<Record<string, unknown>>((value, _mode, path) =>
  isObject(value) ? undefined : `${path}: expected object`
);

type Shape = Record<string, Schema<unknown>>;

const object = <T>(required: Shape, optional: Shape = {}) =>
  schema<T>((value, mode, path) => {
    if (!isObject(value)) return `${path}: expected object`;
    for (const [key, field] of Object.entries(required)) {
      if (!Object.hasOwn(value, key)) return `${path}.${key}: missing`;
      const found = field.check(value[key], mode, `${path}.${key}`);
      if (found) return found;
    }
    for (const [key, field] of Object.entries(optional)) {
      if (value[key] === undefined) continue;
      const found = field.check(value[key], mode, `${path}.${key}`);
      if (found) return found;
    }
    if (mode === 'strict') {
      // A wire key such as `constructor` must not match an inherited property of the shape.
      const extra = Object.keys(value).find(
        (key) => !Object.hasOwn(required, key) && !Object.hasOwn(optional, key)
      );
      if (extra !== undefined) return `${path}.${extra}: unexpected key`;
    }
    return undefined;
  });

const position = object<Position>({line: integer(0), character: integer(0)});
const range = object<Range>({start: position, end: position});
const listingFailure = object<ListingFailure>({message: str});

export const portFileSchema = object<PortFile>(
  {port: integer(1, 65535), token: nonEmpty},
  {pid: integer(1)}
);

export const commandArgsSchema = object<CommandArgs>(
  {uri: str},
  {range, rowCap: num, index: str, target: str}
);

export const runResultSchema = object<RunResult>(
  {
    columns: arrayOf(str),
    rows: arrayOf(anyRecord),
    returnedRows: num,
    totalRows: nullable(num),
    truncated: bool,
    approximateBytes: num,
    elapsedMs: num,
    executedStatement: str,
    effectiveRowCap: num
  },
  {itemsScanned: num}
);

export const profileListSchema = arrayOf(
  object<ProfileRow>(
    {
      id: str,
      name: str,
      slug: str,
      kind: oneOf(['online', 'offline']),
      bindable: bool,
      engines: object({dynamodb: bool, opensearch: bool})
    },
    {reason: oneOf(['incomplete'])}
  )
);

export const listTablesSchema = object<ListTablesResult>(
  {tables: arrayOf(str)},
  {tableListingFailed: listingFailure}
);

export const listIndicesSchema = object<ListIndicesResult>(
  {
    indices: arrayOf(object<IndexRow>({name: str, target: str})),
    unreachable: arrayOf(object({target: str, message: str}))
  },
  {indexListingFailed: listingFailure, partial: listingFailure}
);

export const failureDataSchema = object<FailureData>({code: oneOf(FAILURE_CODES)});

export const initializeResultSchema = object<InitializeResult>({
  capabilities: anyRecord,
  serverInfo: object({name: str, version: str})
});

const lensArguments = schema<[CommandArgs]>((value, mode, path) =>
  Array.isArray(value) && value.length === 1
    ? commandArgsSchema.check(value[0], mode, `${path}[0]`)
    : `${path}: expected one argument`
);

export const codeLensListSchema = arrayOf(
  object<CodeLens>({
    range,
    command: object({title: str, command: str, arguments: lensArguments})
  })
);

const progressToken = schema<string | number>((value, _mode, path) =>
  typeof value === 'string' || typeof value === 'number'
    ? undefined
    : `${path}: expected string or number`
);

const progressValue = schema<ProgressParams['value']>((value, mode, path) => {
  if (!isObject(value)) return `${path}: expected object`;
  return value.kind === 'end'
    ? object({kind: str}).check(value, mode, path)
    : object({kind: oneOf(['begin']), title: str}, {cancellable: bool}).check(value, mode, path);
});

export const progressListSchema = arrayOf(
  object<ProgressParams>({token: progressToken, value: progressValue})
);

export const showMessageSchema = object<ShowMessageParams>({type: integer(1, 5), message: str});

export const responseErrorSchema = object<WireError>(
  {code: integer(Number.MIN_SAFE_INTEGER), message: str},
  {data: failureDataSchema}
);

export function problem<T>(guard: Schema<T>, value: unknown, mode: Mode = 'lenient') {
  return guard.check(value, mode, '$');
}

export function is<T>(guard: Schema<T>, value: unknown, mode: Mode = 'lenient'): value is T {
  return problem(guard, value, mode) === undefined;
}

/** The `data.code` of a `-32803` refusal. */
export function failureCodeOf(error: {code: number; data?: unknown}): FailureCode | undefined {
  return error.code === REQUEST_FAILED && is(failureDataSchema, error.data)
    ? error.data.code
    : undefined;
}

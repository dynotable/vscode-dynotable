import {
  listIndicesSchema,
  listTablesSchema,
  profileListSchema,
  type Schema
} from '../../../src/protocol';
import type {Result} from '../output';
import type {Connection} from '../session';

export type ListingCommand = 'profiles' | 'tables' | 'indices';

/** Requests one listing and prints the whole answer. An incomplete one prints its rows, then fails. */
async function print<T>(
  connection: Connection,
  method: string,
  params: unknown,
  guard: Schema<T>,
  incomplete: (value: T) => boolean
): Promise<Result> {
  const answer = await connection.request(method, params, guard);
  if (!answer.ok) return {failure: answer.failure};
  return incomplete(answer.value)
    ? {value: answer.value, failure: {code: 'listing-failed'}}
    : {value: answer.value};
}

export function list(command: ListingCommand): (connection: Connection) => Promise<Result> {
  switch (command) {
    case 'profiles':
      return (connection) =>
        print(connection, 'dynotable/listProfiles', undefined, profileListSchema, () => false);
    case 'tables':
      return (connection) =>
        print(
          connection,
          'dynotable/listTables',
          {fresh: true},
          listTablesSchema,
          (value) => value.tableListingFailed !== undefined
        );
    case 'indices':
      return (connection) =>
        print(
          connection,
          'dynotable/listIndices',
          undefined,
          listIndicesSchema,
          (value) =>
            value.indexListingFailed !== undefined ||
            value.partial !== undefined ||
            value.unreachable.length > 0
        );
  }
}

import type {ProfileRow} from './protocol';

const EMPTY_ROSTER = 'DynoTable has no profiles. Create a profile in DynoTable.';
const INCOMPLETE = 'This profile is incomplete. Finish setting it up in DynoTable.';
const NOT_BINDABLE = 'DynoTable cannot use this profile. Check it in DynoTable.';

/** The id goes on the wire; the name is for display only. */
export interface RequestedProfile {
  id: string;
  name: string;
}

export interface ProfileItem {
  label: string;
  description: string;
  detail: string;
  profile: ProfileRow;
  /** Why the row cannot be chosen. The server's `reason` is a code, not a sentence. */
  refusal?: string;
}

export type Picker = {kind: 'empty'; sentence: string} | {kind: 'pick'; items: ProfileItem[]};

export function pickerOf(rows: ProfileRow[]): Picker {
  if (rows.length === 0) return {kind: 'empty', sentence: EMPTY_ROSTER};
  return {
    kind: 'pick',
    items: rows.map((row) => {
      const refusal = row.bindable
        ? undefined
        : row.reason === 'incomplete'
          ? INCOMPLETE
          : NOT_BINDABLE;
      const engines = [
        row.engines.dynamodb && 'DynamoDB',
        row.engines.opensearch && 'OpenSearch'
      ].filter(Boolean);
      return {
        label: row.name,
        description: row.slug,
        detail: [engines.join(', '), refusal].filter(Boolean).join(' — '),
        profile: row,
        refusal
      };
    })
  };
}

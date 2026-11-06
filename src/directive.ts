import type {IndexRow, ListIndicesResult} from './protocol';

/** What line 0 of an `opensearch` buffer names: an index, and a target when `pinFor` needs one. */
export interface Pin {
  index: string;
  target?: string;
}

const DIRECTIVE = /^([ \t]*\/\/[ \t]*dynotable:)(.*)$/;

/**
 * A `target=` pin is needed when more than one target lists the name, or when the listing is
 * incomplete: a target that did not list its indices can also host the name. Directive tokens are
 * whitespace-delimited, so a display name with whitespace cannot be pinned.
 */
export function pinFor(pick: IndexRow, listing: ListIndicesResult): Pin | {error: string} {
  const repeated = listing.indices.filter((row) => row.name === pick.name).length > 1;
  const incomplete =
    listing.unreachable.length > 0 ||
    listing.partial !== undefined ||
    listing.indexListingFailed !== undefined;
  if (!repeated && !incomplete) return {index: pick.name};
  if (/\s/.test(pick.target)) {
    const why = repeated
      ? 'is on more than one OpenSearch target'
      : 'can also be on a target that did not list its indices';
    return {
      error: `"${pick.name}" ${why}, and the target name "${pick.target}" contains a space, so it cannot be pinned.`
    };
  }
  return {index: pick.name, target: pick.target};
}

export function directiveLine(pin: Pin): string {
  return `// dynotable: index=${pin.index}${pin.target === undefined ? '' : ` target=${pin.target}`}`;
}

/**
 * Writes the pin into line 0. An existing directive keeps its prefix and its unknown tokens; each
 * key it sets twice collapses to one token. Other text gets a directive line inserted above it.
 */
export function applyPin(text: string, pin: Pin): string {
  const eol = /\r\n|\r|\n/.exec(text);
  const line0 = eol ? text.slice(0, eol.index) : text;
  const rest = eol ? text.slice(eol.index) : '';
  const match = DIRECTIVE.exec(line0);
  if (!match) return `${directiveLine(pin)}${eol?.[0] ?? '\n'}${text}`;

  const wanted: Record<string, string | undefined> = {index: pin.index, target: pin.target};
  const written = new Set<string>();
  const tokens: string[] = [];
  for (const token of (match[2] ?? '').split(/[ \t]+/).filter(Boolean)) {
    const key = token.includes('=') ? token.slice(0, token.indexOf('=')) : undefined;
    if (key === undefined || !Object.hasOwn(wanted, key)) {
      tokens.push(token);
    } else if (!written.has(key)) {
      written.add(key);
      if (wanted[key] !== undefined) tokens.push(`${key}=${wanted[key]}`);
    }
  }
  for (const key of ['index', 'target']) {
    if (!written.has(key) && wanted[key] !== undefined) tokens.push(`${key}=${wanted[key]}`);
  }
  return `${match[1]} ${tokens.join(' ')}${rest}`;
}

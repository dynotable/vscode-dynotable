import type {InlayHint, Position, Range} from './protocol';

/** A server lens as the plan placement reads it: its anchor and its statement. */
export interface StatementLens {
  anchor: Range;
  statement: Range;
}

export interface PlanLens {
  anchor: Range;
  title: string;
}

const before = (a: Position, b: Position) =>
  a.line < b.line || (a.line === b.line && a.character <= b.character);

export const contains = (range: Range, position: Position) =>
  before(range.start, position) && before(position, range.end);

const textOf = ({label}: InlayHint) =>
  typeof label === 'string' ? label : label.map((part) => part.value).join('');

/**
 * The server puts each plan at the end of its statement, where it sits after the caret while the
 * user types. Each one moves to the lens row above its statement, or to the start of its own line
 * when no statement holds it.
 */
export function planLenses(statements: StatementLens[], hints: InlayHint[]): PlanLens[] {
  return hints.map((hint) => {
    const owner = statements.find(({statement}) => contains(statement, hint.position));
    const start = {line: hint.position.line, character: 0};
    return {anchor: owner?.anchor ?? {start, end: start}, title: textOf(hint).trim()};
  });
}

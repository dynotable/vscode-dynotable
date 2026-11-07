import {describe, expect, it} from 'vitest';
import {planLenses} from './plan-lens';

const at = (line: number, character: number) => ({line, character});
const span = (a: [number, number], b: [number, number]) => ({start: at(...a), end: at(...b)});

// Two statements: a plan must land on its own statement's lens row, not the first one's.
const statements = [
  {anchor: span([0, 0], [0, 0]), statement: span([0, 0], [0, 23])},
  {anchor: span([1, 0], [1, 0]), statement: span([1, 0], [2, 10])}
];

describe('planLenses', () => {
  // The server anchors a plan at its statement's last character: the range end must count.
  it('moves a plan at the end of a statement to that statement lens row', () => {
    expect(planLenses(statements, [{position: at(2, 10), label: 'Scan customers'}])).toEqual([
      {anchor: span([1, 0], [1, 0]), title: 'Scan customers'}
    ]);
  });

  it('puts a plan that no statement holds at the start of its own line', () => {
    expect(planLenses(statements, [{position: at(4, 7), label: ' Query orders'}])).toEqual([
      {anchor: span([4, 0], [4, 0]), title: 'Query orders'}
    ]);
  });

  it('joins the parts of a label', () => {
    const label = [{value: 'Query orders'}, {value: ' · ~2 RCU'}];
    expect(planLenses(statements, [{position: at(0, 23), label}])[0]?.title).toBe(
      'Query orders · ~2 RCU'
    );
  });
});

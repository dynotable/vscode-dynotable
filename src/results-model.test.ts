import {describe, expect, it} from 'vitest';
import type {RunResult} from './protocol';
import {parseMessage, renderHtml, resultView, summary, toCsv, toJson} from './results-model';

const result = (overrides: Partial<RunResult>): RunResult => ({
  columns: [],
  rows: [],
  returnedRows: 0,
  totalRows: null,
  truncated: false,
  approximateBytes: 0,
  elapsedMs: 5,
  executedStatement: 'SELECT * FROM "t"',
  effectiveRowCap: 500,
  ...overrides
});

/** The CSV of a one-column result holding `cell`. */
const csvOf = (cell: unknown) => toCsv(result({columns: ['v'], rows: [{v: cell}]}));

describe('summary', () => {
  // The server's cap, not the 500 default; an absent itemsScanned leaves no trace.
  it('shows an exact total beside a truncated result, with the cap the server applied', () => {
    expect(
      summary(result({returnedRows: 3, totalRows: 120, truncated: true, effectiveRowCap: 3}))
    ).toBe('3 of 120 rows · limited to 3 rows · 5 ms');
  });

  // A null total is unknown: the returned count must not stand in for it.
  it('says the total is unknown when totalRows is null', () => {
    expect(
      summary(
        result({
          returnedRows: 3,
          truncated: true,
          effectiveRowCap: 3,
          itemsScanned: 150,
          elapsedMs: 207
        })
      )
    ).toBe('3 rows · limited to 3 rows, total unknown · 150 items scanned · 207 ms');
  });
});

describe('cells', () => {
  // A path reader would answer "B".
  it('reads a qualified column as a literal key', () => {
    const view = resultView(
      result({columns: ['o.orderId'], rows: [{'o.orderId': 'A', o: {orderId: 'B'}}]})
    );
    expect(view.cells).toEqual([['A']]);
  });

  // `toString` is inherited by every row: a plain `row[column]` would print a function. A SQL Set
  // keeps its type tag, also inside a map, so it does not read as a list. The columns are not in
  // sorted order, so a sorted header fails.
  it('keeps the column order, renders missing keys empty and nested values as JSON', () => {
    const view = resultView(
      result({
        columns: ['id', 'tags', 'nestedMap', 'scores', 'toString'],
        rows: [
          {
            id: 1,
            tags: ['a', 'b'],
            nestedMap: {innerLabel: 'inner', innerTags: {SS: ['inner-a', 'inner-b']}},
            scores: {NS: ['10', '20', '30']}
          },
          {id: 2}
        ]
      })
    );
    expect(view.columns).toEqual(['id', 'tags', 'nestedMap', 'scores', 'toString']);
    expect(view.cells).toEqual([
      [
        '1',
        '["a","b"]',
        '{"innerLabel":"inner","innerTags":{"SS":["inner-a","inner-b"]}}',
        '{"NS":["10","20","30"]}',
        ''
      ],
      ['2', '', '', '', '']
    ]);
  });

  // A number JSON cannot hold arrives as {"N": "<exact>"}; the copy must not turn it into a lossy number.
  it('keeps an exact-decimal number as its tagged text in the JSON copy', () => {
    const json = toJson(result({columns: ['n'], rows: [{n: {N: '12345678901234567890.123'}}]}));
    expect(json).toContain('"N": "12345678901234567890.123"');
  });
});

describe('CSV', () => {
  it.each([
    ['=x', "'=x"],
    ['+x', "'+x"],
    ['-x', "'-x"],
    ['@x', "'@x"],
    ['\tx', "'\tx"],
    ['\rx', `"'\rx"`],
    ['\nx', `"'\nx"`]
  ])('guards a cell that starts with %j', (cell, expected) => {
    expect(csvOf(cell)).toBe(`v\r\n${expected}`);
  });

  it('guards a header cell, and guards before it quotes', () => {
    expect(toCsv(result({columns: ['=HYPERLINK("x")', 'b'], rows: [{b: '=1,2'}]}))).toBe(
      `"'=HYPERLINK(""x"")",b\r\n,"'=1,2"`
    );
  });

  // Each passes a loose "looks numeric" check.
  it.each([
    ['-1+1', "'-1+1"],
    ['+1)', "'+1)"],
    ["-2+cmd|'/C calc'!A0", "'-2+cmd|'/C calc'!A0"],
    ['-1.5abc', "'-1.5abc"]
  ])('guards the bypass form %j', (cell, expected) => {
    expect(csvOf(cell)).toBe(`v\r\n${expected}`);
  });

  it.each(['-12345678901.5', '-1e5'])('leaves the number literal %j intact', (cell) => {
    expect(csvOf(cell)).toBe(`v\r\n${cell}`);
  });
});

const policyOf = (html: string) => /Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1];
const nonceOf = (html: string) => /'nonce-([^']+)'/.exec(html)?.[1];

describe('webview HTML', () => {
  it('allows only its own nonce, which changes per render', () => {
    const first = renderHtml('run()');
    const second = renderHtml('run()');
    expect(policyOf(first)).toMatch(/^default-src 'none';/);
    expect(first).not.toContain('unsafe-inline');
    expect(first).not.toMatch(/https?:|src=/);
    expect(nonceOf(first)).toBeTruthy();
    expect(nonceOf(first)).not.toBe(nonceOf(second));
  });
});

describe('panel messages', () => {
  it('accepts a cancel that names its run', () => {
    expect(parseMessage({type: 'cancel', runId: 'r1'})).toEqual({type: 'cancel', runId: 'r1'});
  });

  it('rejects an unknown type and a cancel whose run id is not a string', () => {
    expect(parseMessage({type: 'eval', code: 'x'})).toBeUndefined();
    expect(parseMessage({type: 'cancel', runId: 1})).toBeUndefined();
  });
});

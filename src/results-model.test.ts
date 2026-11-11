import {describe, expect, it} from 'vitest';
import type {RunResult} from './protocol';
import {
  columnText,
  delimitedText,
  formatText,
  jsonText,
  parseMessage,
  renderHtml,
  resultView,
  summary,
  toJson
} from './results-model';

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
const csvOf = (cell: unknown) =>
  delimitedText(result({columns: ['v'], rows: [{v: cell}]}), [0], [0], true, ',', true);

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
    const guarded = result({columns: ['=HYPERLINK("x")', 'b'], rows: [{b: '=1,2'}]});
    expect(delimitedText(guarded, [0], [0, 1], true, ',', true)).toBe(
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

describe('copy formats', () => {
  const mixed = result({
    columns: ['a', 'b'],
    rows: [
      {a: '=1+1', b: {qty: 1}},
      {a: 'x,y', b: 'p\tq'}
    ]
  });

  // CSV must keep the guard; TSV (a paste into a grid) must not, and each quotes its own delimiter
  // only. A trailing CRLF would paste an empty last row.
  it('maps CSV and TSV to their delimiter and guard', () => {
    expect(formatText(mixed, [0, 1], [0, 1], 'csv', false)).toBe(
      `'=1+1,"{""qty"":1}"\r\n"x,y",p\tq`
    );
    expect(formatText(mixed, [0, 1], [0, 1], 'tsv', false)).toBe(
      `=1+1\t"{""qty"":1}"\r\nx,y\t"p\tq"`
    );
  });

  // An unescaped pipe splits a cell, and a line break ends the table row.
  it('escapes Markdown cells and joins the lines with LF', () => {
    const text = result({columns: ['v'], rows: [{v: 'a\\|b'}, {v: '1\r\n2\r3\n4'}]});
    expect(formatText(text, [0, 1], [0], 'markdown', true)).toBe(
      '| v |\n| --- |\n| a\\\\\\|b |\n| 1 2 3 4 |'
    );
  });

  // A JavaScript object would put "2024" first and drop "__proto__"; an inherited name would add
  // a key; a lossy number would lose the tagged digits.
  it('writes JSON keys in column order, with only own keys, at the depth of each value', () => {
    const hostile = result({
      columns: ['constructor', 'b', '2024', '__proto__', 'a"b\\c', 'toString'],
      rows: [
        JSON.parse('{"b":1,"2024":2,"__proto__":3,"a\\"b\\\\c":4}') as Record<string, unknown>,
        {},
        {b: {N: '12345678901234567890.123'}, '2024': {x: [1]}}
      ]
    });
    const text = jsonText(hostile, [0, 1, 2], [0, 1, 2, 3, 4, 5]);
    expect(text).toBe(
      [
        '[',
        '  {',
        '    "b": 1,',
        '    "2024": 2,',
        '    "__proto__": 3,',
        '    "a\\"b\\\\c": 4',
        '  },',
        '  {},',
        '  {',
        '    "b": {',
        '      "N": "12345678901234567890.123"',
        '    },',
        '    "2024": {',
        '      "x": [',
        '        1',
        '      ]',
        '    }',
        '  }',
        ']'
      ].join('\n')
    );
    expect(() => JSON.parse(text) as unknown).not.toThrow();
    expect(jsonText(hostile, [], [1])).toBe('[]');
  });

  // Column text is for a paste as plain text: a header, quotes or a guard would change the values.
  it('gives the column values with no header, quotes or guard, joined by LF', () => {
    const column = result({columns: ['v', 'toString'], rows: [{v: '=a'}, {v: 'b c'}]});
    expect(columnText(column, 0, [1, 0])).toBe('b c\n=a');
    expect(columnText(column, 1, [0])).toBe('');
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

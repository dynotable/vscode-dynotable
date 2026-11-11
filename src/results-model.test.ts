import {describe, expect, it} from 'vitest';
import type {RunResult} from './protocol';
import {
  columnText,
  copyText,
  delimitedText,
  formatText,
  jsonText,
  parseMessage,
  renderHtml,
  resultView,
  savedStatus,
  summary,
  toJson,
  type CopyMessage
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
  // The webview needs the run's id and typed cells, and no longer shows the statement.
  it('builds the view with the result id and a typed cell per column', () => {
    const view = resultView(
      result({columns: ['id', 'toString'], rows: [{id: 1}], returnedRows: 1}),
      'run-1'
    );
    expect(view).toEqual({
      kind: 'result',
      resultId: 'run-1',
      summary: '1 row · 5 ms',
      columns: ['id', 'toString'],
      cells: [
        [
          {text: '1', kind: 'number'},
          {text: '', kind: 'missing'}
        ]
      ]
    });
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

  // A field the parser does not know must not reach the host.
  it('accepts each copy and export message as a new object with only its fields', () => {
    expect(
      parseMessage({
        type: 'copySelection',
        resultId: 'r1',
        format: 'markdown',
        rows: [2, 0],
        columns: [1],
        header: true,
        extra: 'x'
      })
    ).toEqual({
      type: 'copySelection',
      resultId: 'r1',
      format: 'markdown',
      rows: [2, 0],
      columns: [1],
      header: true
    });
    expect(
      parseMessage({type: 'copyValue', resultId: 'r1', row: 0, column: 3, pretty: true})
    ).toEqual({type: 'copyValue', resultId: 'r1', row: 0, column: 3, pretty: true});
    expect(parseMessage({type: 'copyColumn', resultId: 'r1', column: 0, rows: [1]})).toEqual({
      type: 'copyColumn',
      resultId: 'r1',
      column: 0,
      rows: [1]
    });
    expect(parseMessage({type: 'copyColumnName', resultId: 'r1', column: 2})).toEqual({
      type: 'copyColumnName',
      resultId: 'r1',
      column: 2
    });
    expect(parseMessage({type: 'export', resultId: 'r1'})).toEqual({
      type: 'export',
      resultId: 'r1'
    });
  });

  // `at` throws on a bad index, and a copy of nothing is not a copy. The toolbar copy knows only
  // CSV and JSON: `copyText` would give JSON for any other format.
  it('rejects a bad index, an empty row list, a missing result id and a bad field type', () => {
    const selection = {
      type: 'copySelection',
      resultId: 'r1',
      format: 'tsv',
      rows: [0],
      columns: [0],
      header: false
    };
    expect(parseMessage({...selection, rows: [0.5]})).toBeUndefined();
    expect(parseMessage({...selection, columns: [-1]})).toBeUndefined();
    expect(parseMessage({...selection, rows: []})).toBeUndefined();
    expect(parseMessage({type: 'copy', format: 'csv'})).toBeUndefined();
    expect(parseMessage({type: 'copy', resultId: 'r1', format: 'tsv'})).toBeUndefined();
    expect(
      parseMessage({type: 'copyValue', resultId: 'r1', row: 0, column: 0, pretty: 'yes'})
    ).toBeUndefined();
  });
});

describe('copyText', () => {
  const orders = result({
    columns: ['id', '$(alert)', 'doc'],
    rows: [
      {id: 1, '$(alert)': 'a', doc: {q: [1, 2]}},
      {id: 2, '$(alert)': 'b'}
    ]
  });

  // A copy for an earlier result, or past the end of this one, must copy nothing.
  it('copies nothing for an old result id or an index out of range', () => {
    const cases: CopyMessage[] = [
      {type: 'copyColumnName', resultId: 'old', column: 0},
      {type: 'copyValue', resultId: 'r1', row: 2, column: 0, pretty: false},
      {type: 'copyColumnName', resultId: 'r1', column: 3},
      {
        type: 'copySelection',
        resultId: 'r1',
        format: 'csv',
        rows: [0],
        columns: [0, 3],
        header: true
      },
      {type: 'copyColumn', resultId: 'r1', column: 0, rows: [2]}
    ];
    for (const message of cases) expect(copyText(orders, 'r1', message)).toBeUndefined();
  });

  // Copy CSV of an empty result still gives its columns.
  it('copies the header of a result with columns and no rows', () => {
    expect(
      copyText(result({columns: ['a', 'b']}), 'r1', {type: 'copy', resultId: 'r1', format: 'csv'})
    ).toEqual({text: 'a,b', status: 'Copied 0 rows as CSV.'});
  });

  // The count is the size of the copy, not the result's returned rows; `$(` would show an icon.
  it('counts the copied rows and values, and escapes icon syntax in a column name', () => {
    expect(
      copyText(orders, 'r1', {
        type: 'copySelection',
        resultId: 'r1',
        format: 'csv',
        rows: [1],
        columns: [0],
        header: true
      })?.status
    ).toBe('Copied 1 row as CSV.');
    expect(
      copyText(orders, 'r1', {
        type: 'copySelection',
        resultId: 'r1',
        format: 'markdown',
        rows: [0, 1],
        columns: [0],
        header: true
      })?.status
    ).toBe('Copied 2 rows as Markdown.');
    expect(
      copyText(orders, 'r1', {type: 'copyColumn', resultId: 'r1', column: 1, rows: [1, 0]})
    ).toEqual({text: 'b\na', status: 'Copied 2 values of \\$(alert).'});
  });

  // Export's own message: one saved row reads as singular, and a file name never shows an icon.
  it('names the saved file and the row count', () => {
    expect(savedStatus(1, 'a$(alert).csv')).toBe('Saved 1 row to a\\$(alert).csv.');
    expect(savedStatus(120, 'orders.csv')).toBe('Saved 120 rows to orders.csv.');
  });

  const jsonValue = (pretty: boolean) =>
    copyText(orders, 'r1', {type: 'copyValue', resultId: 'r1', row: 0, column: 2, pretty})?.text;

  // The viewer copies the indented form; the grid copies the value as the cell shows it.
  it('copies a JSON value indented only when pretty is set', () => {
    expect(jsonValue(true)).toBe('{\n  "q": [\n    1,\n    2\n  ]\n}');
    expect(jsonValue(false)).toBe('{"q":[1,2]}');
  });
});

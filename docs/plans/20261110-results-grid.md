# Results Grid

## Overview

- Replace the plain `<table>` of the results panel with a read-only data grid.
- Stop rendering `executedStatement`. For SQL and PartiQL it repeats the editor. `RunResult` and
  `src/protocol.ts` keep the field.
- The JetBrains plugin gets the same feature set in its own PR
  (https://github.com/dynotable/jetbrains-dynotable/pull/4). **Parity rule (user decision,
  2026-11-10):** the two plugins share the features and the exact copy output (formats, formula guard,
  scope). Labels, layout and shortcuts follow each host: DataGrip conventions in JetBrains, VS Code
  conventions here.
- A run returns up to 500 rows (the server's default `rowCap`; `PROTOCOL.md` clamps a sent `rowCap`
  to 1000, and the extension sends none). The grid has no paging and no virtualization.

## Context (from discovery)

- `src/results-model.ts`: `ResultView`, `parseMessage`, `summary`, `resultView`, `cellText`,
  `csvField`, `toCsv`, `toJson`, `renderHtml` and `STYLE`. It imports `node:crypto`, so the webview
  cannot import it at runtime. The webview imports only its types.
- `src/results.ts`: `ResultsPanel`. `execute` makes a UUID per run (`run.id`, line 45) and stores the
  result in the private `result` field only on success (line 65). `receive` validates a message and
  writes the clipboard through `vscode.env.clipboard` (it imports `toCsv`/`toJson`, lines 8-9, 90).
- `src/extension.ts:61-66, 323-328`: the Test-mode hook `TestApi.panel` (`view()`, `receive()`).
- `media/results.ts`: the webview. It builds every node with `textContent`. Its tests are in
  `media/results.test.ts` (jsdom 30.1.3: no canvas 2D context, no `HTMLDialogElement.showModal`, no
  `ClipboardEvent`, no `scrollIntoView`, no `DragEvent`/`DataTransfer`, no `setPointerCapture`, no
  `elementFromPoint`, zero-size `getBoundingClientRect`; it has `PointerEvent`; the file imports the
  webview once for all tests).
- `src/results-model.test.ts`: summary, cells, the CSV formula guard and its bypass forms (through
  `csvOf` → `toCsv`, plus direct `toCsv` at :106 and `toJson` at :87), the CSP, and the messages.
- `src/test-integration/run.test.ts:234`: the copy test sends messages through `hook.receive`;
  `:253` is the unreadable-answer test. `src/test-integration/harness.ts:40-73` replaces
  `window.showQuickPick` (`quickPicks`: `answer` matched by item label, `during` hook). Nothing resets
  it between `run.test.ts` tests (`:231` is in `bindLiveProfile`, live only); `run.test.ts`'s
  `beforeEach` resets only `fake` and `toasts`. The fake server answers each run of a dialect with the
  same fixture (`fake-server.ts:289`), unless a test sets `fake.handle(…)`. There is no
  `showSaveDialog` stub.
- `src/test-integration/live.test.ts:39-42` has a local `result()` that returns the panel view; `:318`
  reads `(await result()).executedStatement`.
- `esbuild.mjs`: it bundles `media/results.ts` to `dist/results.js` as an iife (es2022). The panel
  inlines it under a per-render nonce. The CSP is `style-src 'nonce-…'`: `setAttribute('style', …)`
  is blocked; CSSOM setters (`el.style.width = …`) work. `engines.vscode` is `^1.91.0`, so the
  webview runs on Chromium 122 at the floor.
- `pnpm lint` runs `oxfmt --check` on the repo, Markdown included (this plan too).
- `README.md:87-93`: the **Results.** bullet describes the rows, Copy CSV and Copy JSON.
- The VS Code panel has no selection and no Cmd/Ctrl+C today.

## Development Approach

- **Testing approach**: Regular (code first, then tests in the same task).
- Complete each task fully before you start the next.
- Make small, focused changes.
- Tests follow Rule 8 of the user's instructions. Each test names the bug that it catches. Write no
  tautological, redundant or subset tests.
- **Each task ends with `pnpm typecheck` and `pnpm test` green** (vitest does not typecheck). Tasks
  that touch the host also run `pnpm test:integration`. After an edit to this plan, run `pnpm format`
  on it.
- In `media/results.test.ts`, each test renders with its own `resultId` (the webview keeps view state
  per `resultId`); only the "same id keeps state" test reuses one.
- Update this plan when the scope changes.

## Testing Strategy

- **Unit tests (vitest)**: the pure functions in `src/grid-model.ts` and `src/results-model.ts`.
- **Webview (vitest + jsdom)**: the wiring tests named in Tasks 5 and 7–9, the security tests for
  every new place that renders data, and the existing hostile-text, cancel and ready tests. The tests
  stub `HTMLDialogElement.prototype.showModal`/`close` and `Element.prototype.scrollIntoView`. Copy is
  tested by dispatching `new Event('copy', {cancelable: true})` with the focus set.
- **Integration (`pnpm test:integration`, container)**: the stale-copy guard, the current id after an
  unreadable answer, Export with a stubbed save dialog, and the existing copy test.
- No UI e2e framework exists. The real webview keys (Cmd/Ctrl+C, A, F; Ctrl on Windows/Linux) and the
  VS Code 1.91 runtime are checked in the Post-Completion QA with computer use.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly found tasks with the ➕ prefix.
- Write issues and blockers with the ⚠️ prefix.

## Solution Overview

- **Library**: `@tanstack/table-core` at the exact version `9.3.1` (MIT). Its one dependency is
  `@tanstack/store` (MIT). It adds about 57 KB minified (16 KB gzipped) to `dist/results.js`.
  TanStack holds: sort, global filter, column filters, column order, column visibility, column pinning
  and column sizes. **Selection is our own state** (a set of rows, a set of columns, an anchor and a
  focused cell); `rowSelectionFeature` is not used. Task 1 checks `cellSelectionFeature` and uses it
  only if it holds the rows × columns model.
- We write the DOM, the drag and resize handles, the menus, the find field, the value viewer, Record
  View and the JSON highlighter.
- **Public-repo rule**: use the library from its own docs and its published types only.
- **Copies in the host**: the webview sends row indices and **column indices**. The host builds every
  copy from the stored `RunResult` and writes the clipboard, as today. One builder per format, so the
  toolbar copy, Export and the selection copies give the same bytes for the same rows.
- **Shared pure functions**: `src/grid-model.ts`, with no Node.js imports, holds only what the webview
  needs too: `cellKind`, `isNumericColumn`, `compareCells`, `cellMatches`, `inValueSet`,
  `distinctValues`, `exactSum`, `totals`, `fitWidth`, `selectionCells`, `jsonTokens`, `prettyText`. The copy
  builders are host-only and stay in `src/results-model.ts`.
- **View order** everywhere (display, selection, copies) is TanStack's visible leaf column order:
  pinned columns first, then the rest in their order.

## Technical Details

### Cell kinds (`cellKind`)

| kind      | value                                                       | text            | display                                                            |
| --------- | ----------------------------------------------------------- | --------------- | ------------------------------------------------------------------ |
| `missing` | the row has no own key (an inherited `toString` too)        | `''`            | empty                                                              |
| `null`    | `null`                                                      | `null`          | dimmed                                                             |
| `number`  | a JSON number                                               | `String(value)` | right-aligned                                                      |
| `string`  | a string, or a boolean (text `true` / `false`)              | as is           | normal                                                             |
| `json`    | an object or an array, a tagged `{"N":…}` or `{"SS":…}` too | compact JSON    | dimmed; tooltip: `prettyText`, max 2000 characters, built on hover |

A tagged exact number stays `json`. Its exact text must not become a lossy number.

### Columns

- TanStack column ids are the column **index** as a string, with an explicit `id` and an `accessorFn`
  that reads `row.cells[index]`. Never `accessorKey`: it reads `o.orderId` as a path and rewrites the
  dot. Index ids also allow duplicate column names.
- Sort: the accessor returns `undefined` for `missing` and `null` cells; each column sets
  `sortUndefined: 'last'`, `sortDescFirst: false`; the table sets `enableMultiSort: false`. The
  `sortFn` compares defined cells with `compareCells(a, b, numeric)`, where
  `numeric = isNumericColumn(cells)`: true when every cell that is not `missing` and not `null` is a
  `number`. Task 1 checks that `undefined` stays last in descending order and that rows with
  `undefined` keep a stable order among themselves; if not, the `sortFn` orders the empties itself and
  reads the direction from the column.
- Global filter: a per-cell `globalFilterFn` that reads `row.original.cells[i].text` (not the accessor
  value, which is `undefined` for `null`) with `cellMatches`, and a `getColumnCanGlobalFilter`
  that returns true for visible columns only (TanStack's default reads the first row's value type and
  would skip a column whose first row is missing). A visibility change re-runs the filter.
- Task 1 confirms these TanStack v9 behaviours and writes them under "TanStack v9 notes".

### View (host → webview)

`ResultView` = `{kind: 'result', resultId, summary, columns, cells: {text, kind}[][]}`.
`resultId` is the `run.id` of the run that produced the result. The host stores it with
`this.result`, on success only, so a failed run that restores the old view keeps the old id current.
`executedStatement` is removed from the view only. The webview resets its view state (sort, find query
and Filter rows, column filters, order, hidden columns, widths, pinned columns, selection) only when
`resultId` changes (the **Filter rows** checkbox keeps its state); `running` and `cancelled` renders
in between do not reset it.

### Messages (webview → host)

All go through `parseMessage`. Anything else is dropped. Row and column fields are non-negative
integers. `rows` and `columns` must be non-empty.

- `copy {resultId, format: 'csv' | 'json'}`: the toolbar buttons. All rows, all columns, with a
  header.
- `copySelection {resultId, format: 'csv' | 'tsv' | 'json' | 'markdown', rows: number[], columns: number[], header: boolean}`:
  rows are indices into `result.rows` in view order; columns are indices into `result.columns` in view
  order. Cmd/Ctrl+C sends `tsv` with `header: false`; the menu sends `csv`, `json` or `markdown` with
  `header: true`.
- `copyValue {resultId, row, column, pretty: boolean}`: Copy Value, and Cmd/Ctrl+C on one cell, send
  `pretty: false`. The viewer's Copy sends `pretty: true`.
- `copyColumn {resultId, column, rows: number[]}`: the shown rows in view order.
- `copyColumnName {resultId, column}`.
- `export {resultId}`: the host asks for the format.

The pure function `copyText(result, resultId, message)` returns `{text, status}` or `undefined`.
`undefined` when the `resultId` is not the current one, or a row index (`row` or in `rows`) or a column
index (`column` or in `columns`) is out of range. `parseMessage` already rejects negative and fractional
indices and an empty `rows` / `columns` list in `copySelection` and `copyColumn`. The toolbar `copy` and
`export` take all rows, so a result with columns and no rows still copies its header. On
`undefined` the host copies nothing; for a stale `resultId` it shows `The results changed. Copy
again.` in the status bar.

### Copy formats (host, `src/results-model.ts`)

- **CSV and TSV**: `delimitedText(result, rows, columns, header, delimiter, guard)` is the only
  delimited builder. `csvField(text, delimiter, guard)`: the formula guard (only when `guard`), then
  quoting. A field is quoted when it holds the delimiter, a quote, CR or LF; inner quotes are doubled.
  The header goes through the same function. CSV and TSV lines are joined with CRLF, with none after
  the last line. One function `formatText(result, rows, columns, format, header)` maps a format to its builder
  and guard (`csv` → `,` with the guard; `tsv` → tab, no guard; `json`; `markdown`); `copyText` and
  Export both call it.
  - **CSV** (menu, toolbar, Export): `,` with the guard.
  - **TSV** (Cmd/Ctrl+C, 2 or more cells): tab, **no guard** (user decision, 2026-11-10, both
    plugins). Example: `=1+1` and `{"qty":1}` copy as `=1+1\t"{""qty"":1}"`.
- **JSON**: `jsonText(result, rows, columns)`. The bytes equal `JSON.stringify(arrayOfObjects, null,
  2)` with each object's keys in the given column order (JetBrains confirmed). It is **written by hand**, so the key order holds (a JavaScript object moves integer-like
  keys such as `"2024"` first, and `obj["__proto__"] = …` loses the key). Each key is written with
  `JSON.stringify(name)`. Each value is `JSON.stringify(value, null, 2)` re-indented to its depth. A
  missing key (an inherited name such as `toString` too) is left out, with no stray comma; a row with
  none of the columns is `{}` and no rows is `[]`, as `JSON.stringify` writes them. Copy Selection as
  JSON and Export JSON use `jsonText`. The toolbar's **Copy JSON** stays as today:
  `toJson(result)` = `JSON.stringify(result.rows, null, 2)` (the rows as returned; JetBrains keeps the
  same). `toCsv` is deleted; the toolbar's Copy CSV uses `formatText` with all rows and columns.
- **Markdown**: `markdownTable(result, rows, columns)`: a header row, a `| --- |` row, then one row
  per record. In each cell, `\` becomes `\\` first, then `|` becomes `\|`; CRLF, CR and LF each become
  one space. Lines are joined with **LF**, with none after the last line (both plugins; JetBrains
  agreed).
- **Value**: `valueText(row, column)` = `cellKind(row, column).text`: a string as is; missing `''`
  (an inherited name such as `toString` too); any other value compact JSON. The pretty form is
  `prettyText(valueText(row, column), kind)`.
- **Pretty text** (`prettyText(text, kind)`, shared): for a `json` cell, and for a string that
  `JSON.parse` accepts as an object or an array, it re-indents the **original text** with
  `jsonTokens` (2 spaces). It never prints parsed values, so `12345678901234567890`, `1.0` and
  duplicate keys stay as written. Any other text comes back as it is.
- **Column**: `columnText(result, column, rows)`: the value text of each given row, joined by `\n`,
  with no header. It is plain text, not CSV, so it has no formula guard.
- **Status bar**: `Copied 3 rows as Markdown.` (`Copied 1 row as …`), `Copied the value.`,
  `Copied 42 values of status.` (`Copied 1 value of …`), `Copied the column name.`,
  `Saved 120 rows to orders.csv.` (`Saved 1 row to …`). The count is the size of the copy, not `returnedRows`. Column names
  in a status text have `$(` written as `\$(`, so the status bar shows no icon syntax.

### Export (host)

- Check the `resultId` and keep a reference to that `RunResult` before any dialog, so a run that ends
  during the dialog does not change what is saved.
- Quick pick: `CSV`, `JSON`, `Markdown` (as `QuickPickItem`s with labels). Then `showSaveDialog` with
  `defaultUri` = `dynotable-results.<ext>` in the first workspace folder, else in the home folder.
  Write `new TextEncoder().encode(text)` with `vscode.workspace.fs.writeFile`. Rows in query order
  (not the grid's sort), all columns, with a header.
- A cancelled pick or dialog writes nothing. A failed write shows an error message with the reason.

### Grid behaviour (webview)

- **Toolbar**: the summary, the find field (placeholder `Find`) with **Previous**, **Next** and a
  **Filter rows** checkbox, the note `N of M rows shown` only while a filter hides rows (N = TanStack's
  filtered row count), **Copy CSV**, **Copy JSON**, **Export…**.
- **Focus**: the grid's scroll box has `tabindex="0"` and holds the DOM focus for the grid; it is not
  rebuilt. The focused cell is a class, not DOM focus. Every mousedown in the grid (cell, row number,
  header) calls `scrollBox.focus({preventScroll: true})` and does not call `preventDefault`
  (`user-select: none` already stops text selection). The focus goes back to the scroll box when a
  menu, the column filter popup or a dialog closes, or when the focused node was removed. It never
  moves while the find field has the focus (the find filter re-renders the table as the user types).
- **Open popups on a render**: a render that changes the kind or the `resultId` closes every menu,
  popup and dialog. A menu, popup or dialog sends the `resultId` it captured when it opened, so an
  action on old content is stale for the host, never applied to the new result.
- **Find**: Cmd/Ctrl+F focuses the find field. A cell matches when `cellMatches(text, query)`:
  case-insensitive part match, on visible columns only. Matching cells are highlighted. Enter and
  **Next** move the focused cell to the next match in view order; Shift+Enter and **Previous** to the
  previous one; Enter applies a pending query first. With **Filter rows** on, the query is TanStack's
  global filter; with it off, only the highlight shows. The query applies 150 ms after the last key
  press; the timer reads the input when it fires, and Esc or a new `resultId` cancels it. Esc in the
  find field clears the query. **Filter rows** starts unticked (as in DataGrip; JetBrains confirmed) and keeps its state
  while the panel's document lives; a new result clears the find text and keeps the checkbox.
- **Per-column filter**: a filter icon in each header opens a value list: a search field,
  **Select All**, `(empty)` first (it stands for `missing` and `null`), then one checkbox per distinct
  value (`distinctValues`, in the column's sort order), then **Apply** and **Clear**. The filter state
  is `{empty: boolean, values: Set<string>}`, so a string cell that reads `(empty)` or `null` is a
  value, not the empty entry. It is TanStack's column filter with the `filterFn` `inValueSet`, which reads
  `row.original.cells[i]`. Apply
  with every value checked removes the filter. The icon is highlighted while the column has a filter.
  Column filters and the find filter must all match. Hiding a column (Hide Column or Hide Other
  Columns) clears the filter of each column it hides.
- **Grid**: a scroll box in both directions with a `table-layout: fixed` table whose `width` is the
  sum of its column widths (set with CSSOM, updated on resize). The header row stays at the top. The
  row-number column stays at the left. Rows are striped. Colours come from `--vscode-*` variables only.
  Long text ends in an ellipsis. `user-select: none` on the page, except the inputs and the viewer
  body.
- **Widths**: `fitWidth(headerLength, cellLengths)` returns the column width in characters (the
  longest text, plus padding). The webview measures the character width once from a `<span>` of ten
  `0` characters with `visibility: hidden; position: absolute` and the same font family and size as
  the cells (`getBoundingClientRect`); when it measures 0 (jsdom), it uses 8 px. The px width is clamped to 60–400 px and goes into TanStack's column sizing.
- **CSSOM only**: every runtime style (widths, table width, pinned columns' `left`, menu position) is
  set through `el.style.*`. Never `setAttribute('style', …)` and never a `<style>` without the nonce.
- **Rendering cost**: the table is built once per result and once per sort, filter, order, visibility
  or pin change. Focus, selection and find highlight change classes on existing nodes. Tooltips are
  built on hover.
- **Sort**: a header click sorts ascending, then descending, then not at all, with a ▲/▼ mark. One
  sort key; Shift-click does not add a key. The header menu also has Sort Ascending, Sort Descending
  and Clear Sort.
- **Resize**: drag the right edge of a header. **Reorder**: drag a header onto another header. Both
  use mouse events on the header elements (mousedown, then mousemove and mouseup on the document; the
  drop target is the mouseup's target header), not HTML5 drag and drop and not pointer capture. A drag
  that moved suppresses the click that follows it with a flag that is cleared on the next tick after
  the mouseup, so a resize or a reorder never sorts and the next real click still does. A drag also
  ends on a mousemove with `buttons === 0` and on window `blur`. A drop across the pinned boundary is
  refused (pin or unpin with the menu); a drop inside the pinned group reorders
  `columnPinning.left`.
- **Row numbers**: the position in the view, 1…N after sort and filter.
- **Selection (cells and ranges)**: a click selects one cell and focuses it. Shift-click and
  Shift+arrows extend a rectangular range from the anchor. The add modifier (Cmd on macOS, Ctrl
  elsewhere; on macOS a Ctrl-click is a right-click) adds a cell or range. A row-number click selects
  the row; Shift and the add modifier work there too. The header menu's **Select Column** selects a
  column. An arrow moves the focused cell, selects only that cell and moves the anchor there; arrows
  call `preventDefault` and scroll the focused cell into view (also for find Next/Previous) with
  `scrollIntoView({block: 'nearest', inline: 'nearest'})`; for a cell in a pinned column, the code saves `scrollBox.scrollLeft`, calls
  `scrollIntoView({block: 'nearest'})` and restores `scrollLeft`, so the scroll is vertical only (a
  sticky cell never leaves the padded zone). The scroll
  box sets `scroll-padding-top` to the header height and `scroll-padding-left` to the row-number width
  plus the visible pinned widths (CSSOM). The scroll padding and the pinned columns' cumulative `left`
  offsets are recomputed together on every table rebuild and on every width change (drag resize, Reset
  Column Widths), so an
  unpinned cell never stays under the sticky header or the pinned columns.
  Cmd/Ctrl+A selects all shown cells. The selection is stored as original row indices and column
  ids, so it follows the data through a sort, a reorder or a pin. When the
  focused cell's row or column stops being shown, the focus moves to the nearest shown cell; when none
  is left, the selection clears.
- **Selection → copy (shared with JetBrains, match exactly)**: the selection is a set of rows, a set
  of columns and a `wholeRows` flag (set by a row-number click; whole rows count every visible column,
  and every visible column counts as in the selection for the totals). An add-click of cells in different rows and columns selects every cell where they
  cross. Every copy, the totals and Cmd/Ctrl+C use rows × columns: the distinct rows in view order,
  then the distinct visible columns in view order (`selectionCells`). With `wholeRows`, every visible
  column counts. Without it, a column set whose columns are all hidden gives no cells. Rows the filter
  hides are left out.
  An empty selection copies nothing and shows no message. Cmd/Ctrl+C on ONE selected cell sends
  `copyValue` (no guard, no quoting). Two or more cells send `copySelection` with `tsv`.
- **Reference output (JetBrains, live)**: a 3×2 block copies as
  `79.03\tNedra Gislason\r\n160.95\tMaxwell Parisian\r\n373.97\tLucinda Conroy`.
- **Keys**: grid keys (arrows, Shift+arrows, Cmd/Ctrl+A, Shift+Enter, Esc) act only when the scroll box
  has the focus. Copy runs only from the document's `copy` event (VS Code cancels the Cmd/Ctrl+C
  keydown in the frame and then runs `execCommand('copy')`): when the scroll box has the focus, the
  handler calls `preventDefault` and posts the message; elsewhere it does nothing, so the native copy
  in the find field and in the viewer works. There is no keydown handler for C. Cmd/Ctrl+A in the grid
  calls `preventDefault`. Esc in the grid closes the menu, else clears the find query; the dialogs
  close on Esc natively.
- **Selection totals**: a status line under the grid,
  `Count 3 · Sum 60 · Avg 20 · Min 10 · Max 30`. It covers the focused cell's column, and only when
  that column is in the selection and holds 2 or more selected cells. Count is the cells that are not
  `missing` and not `null`. Sum, Avg, Min and Max use the `number` cells only. **Sum is exact**
  (JetBrains: decimal): `exactSum` parses each number's `String(n)` (exponent forms too) into a
  `BigInt` mantissa and a decimal scale and adds them exactly, so the order does not matter; Sum prints
  as `String(Number(exactSum))`. Avg = `Number(exactSum) / n` in double arithmetic, where `n` is the
  number of `number` cells (⚠️ asked JetBrains to confirm the division; its sample fits). A tagged
  `{"N":…}` is left out. No `number` cell means no line. Numbers print as `String(n)` does. JetBrains live
  reference: `Count 46 · Sum 11519.75 · Avg 250.42934782608697 · Min 15.97 · Max 484.6`.
- **Pin Column** (user decision, 2026-11-10, both plugins): the header menu's **Pin Column** pins the
  right-clicked column, wherever it is; several columns can be pinned. Pinned columns sit next to the
  row numbers (TanStack column pinning, left; `position: sticky` with cumulative `left` offsets) and
  come first in view order, so they also copy first. A pinned header's menu shows **Unpin Column**. A
  new result unpins all. Pinned columns keep the order they were pinned in. **Unpin Column** puts the
  column back at the start of the unpinned columns (JetBrains confirmed both).
- **Context menu** on a cell (a right-click on an unselected cell selects only that cell and focuses
  it; a right-click inside the selection keeps it; `preventDefault` stops the VS Code menu;
  Up/Down/Enter/Esc work): `Copy Value`, `Copy Selection as CSV`, `Copy Selection as JSON`,
  `Copy Selection as Markdown`, `Copy Column`, separator, `Hide Column` (disabled on the last visible
  column), `Show All Columns` (disabled when no column is hidden), separator, `Record View`.
- **Header menu**: `Copy Column Name`, `Copy Column`, `Select Column`, separator, `Sort Ascending`,
  `Sort Descending`, `Clear Sort`, separator, `Pin Column` / `Unpin Column`, `Hide Column`,
  `Hide Other Columns`, `Show All Columns`, `Reset Column Widths`. `Hide Column` is disabled on the
  last visible column here too. Labels follow VS Code conventions;
  JetBrains uses DataGrip labels for the same features. `Reset Column Widths` sets every width back to
  `fitWidth`. `Copy Column` and `Select Column` are disabled when no row is shown (a result with no rows,
  or filters that hide every row).
- **Value viewer**: a double-click, or Shift+Enter in the grid, opens a `<dialog>` with `showModal`.
  Title: the column name and the view row number (built with `textContent`). Body: a `<pre>` with
  `prettyText`. A pretty JSON body is highlighted with `jsonTokens`: one `<span>` per token, built with
  `textContent`. **Copy** sends `copyValue` with `pretty: true`. Esc or **Close** closes it.
- **Record View**: the same dialog with a `Column | Value` table of the focused row. It shows the
  visible columns in view order, with typed cells. A double-click on a value opens the viewer.
- **State lifetime**: a new `resultId` resets all view state, the find field's text too. A hidden
  panel reloads its document, so hide and show also reset the view state.

### TanStack v9 notes

(Task 1 writes the confirmed API calls here.)

## What Goes Where

- **Implementation Steps**: code, tests and docs in this repository.
- **Post-Completion**: QA with computer use, screenshots, the JetBrains comparison, the release.

## Implementation Steps

### Task 1: Add TanStack Table v9 and confirm its API

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml`
- Modify: `docs/plans/20261110-results-grid.md` ("TanStack v9 notes")

- [ ] read the TanStack Table v9 docs and the published `.d.ts` and `.js` of table-core:
      `tableFeatures`, `constructTable`, the `*Feature` exports, `createSortedRowModel`,
      `createFilteredRowModel`, how a vanilla (no framework) table reads and sets state
- [ ] confirm: how left-pinned columns are ordered (`columnPinning.left` vs `columnOrder`); an explicit
      column `id` with `accessorFn`; `sortUndefined: 'last'` in descending order
      and a stable order of `undefined` rows; `sortDescFirst`, `enableMultiSort`; a custom `sortFn`; a
      per-cell `globalFilterFn` with `getColumnCanGlobalFilter`; that a visibility change re-filters; a
      column `filterFn`; column order, visibility, pinning (left) and sizing
- [ ] check `cellSelectionFeature`: use it if it holds rows × columns with an anchor, else record why
      selection stays our own state
- [ ] check the bundle's built-ins against Chromium 122 (the VS Code 1.91 webview), and that table-core
      and `@tanstack/store` use no `eval` or `new Function` (the CSP has no `unsafe-eval`); write the
      results
- [ ] add `@tanstack/table-core` at the exact version `9.3.1` to `dependencies`
- [ ] write the confirmed calls under "TanStack v9 notes" and run `pnpm format` on the plan
- [ ] run `pnpm typecheck`, `pnpm build` and `pnpm test` - must pass before task 2

### Task 2: Add the cell, sort, filter, totals and width rules

**Files:**

- Create: `src/grid-model.ts`, `src/grid-model.test.ts`
- Modify: `src/results-model.ts`

- [ ] create `src/grid-model.ts` with no Node.js import: `cellKind(row, column)` returning
      `{text, kind}`, `isNumericColumn(cells)`, `compareCells(a, b, numeric)`,
      `cellMatches(text, query)`, `inValueSet(cell, filter)`, `distinctValues(cells)`, `exactSum(numbers)`, `totals(cells)`,
      `fitWidth(headerLength, cellLengths)`
- [ ] move the literal, own-key read into `cellKind`: `resultView` uses `cellKind(…).text`, and
      `cellText` is deleted
- [ ] test `cellKind`: one row per kind (the inherited `toString` key is the `missing` row),
      `{'o.orderId': 'A', o: {orderId: 'B'}}` reads `A` for `o.orderId`, a tagged `N` as `json`, a
      boolean as `string`
- [ ] test `isNumericColumn` + `compareCells`: a column of `9`, `10` and `null` is numeric and sorts
      `9` before `10`; a mixed column sorts as text
- [ ] test `cellMatches`: case-insensitive with `Ä`/`ä`
- [ ] test `distinctValues` + `inValueSet` in one case: `(empty)` comes first and matches `missing` and
      `null` but not the string `"null"` or `"(empty)"`; the values come in the column's sort order
- [ ] test `totals`: Count skips `missing` and `null`; Sum/Avg/Min/Max skip the string `"10"` and a
      tagged `N`;
      `[0.1, 0.2, 0.3]` and `[0.3, 0.2, 0.1]` both give `Sum 0.6` (exact, not `0.6000000000000001`);
      `1e-7` and `0.1` give `Sum 0.1000001`; Avg of `[1, 2]` is `1.5`; no `number` cell gives no totals
- [ ] run `pnpm typecheck` and `pnpm test` - must pass before task 3

### Task 3: Add the JSON tokens and the pretty text

**Files:**

- Modify: `src/grid-model.ts`, `src/grid-model.test.ts`

- [ ] add `jsonTokens(text)`: key, string, number, literal (`true`, `false`, `null`) and punctuation
      tokens, whitespace kept
- [ ] add `prettyText(text, kind)`: re-indent with `jsonTokens` (2 spaces) for a `json` cell and for a
      string that parses to an object or an array; else the text as is
- [ ] test `jsonTokens`: a string value holding `\"` and `":` stays one string token; the tokens join
      back to the input
- [ ] test `prettyText` with `kind: 'string'`: `{"id":12345678901234567890,"v":1.0}` keeps both
      numbers as written and is indented; a plain string comes back unchanged
- [ ] run `pnpm typecheck` and `pnpm test` - must pass before task 4

### Task 4: Add the host copy builders

**Files:**

- Modify: `src/results-model.ts`, `src/results-model.test.ts`
- Modify: `src/results.ts`

- [ ] give `csvField` a delimiter and a guard flag; add `delimitedText`, `jsonText` (written by hand),
      `markdownTable`, `valueText`, `columnText` and `formatText`; delete `toCsv` and point the CSV `copy`
      case in `src/results.ts` at `formatText` with all rows and columns; keep `toJson` for the toolbar's
      Copy JSON
- [ ] point the existing CSV guard and bypass tests at `delimitedText` (through `csvOf`, and the header
      case at :106); keep every case and the `toJson` tagged-`N` case at :87
- [ ] test `formatText`: `csv` on `=1+1` gives `'=1+1`; TSV quotes a tab, not a comma, and `=1+1` with
      `{"qty":1}` gives exactly `=1+1\t"{""qty"":1}"` (no guard); two CSV rows have one CRLF between them
      and none at the end; Markdown joins with LF
- [ ] test JSON: a row from `JSON.parse('{"b":1,"2024":2,"__proto__":3,"a\\"b\\\\c":4}')` with the
      columns `constructor`, `b`, `2024`, `__proto__`, `a"b\c` and a last column `toString` gives the exact literal text
      (keys in that order, `constructor` and `toString` left out, no stray comma), and `JSON.parse` accepts it; a row with
      none of the columns gives `{}`; no rows gives `[]`; a tagged `N` stays exact; a nested object is
      indented at its depth
- [ ] test Markdown: `a\|b` becomes `a\\\|b`; CRLF, CR and LF each become one space
- [ ] test `valueText` and `columnText`: a string is not JSON-quoted; a `toString` column the row lacks
      gives `''`; the column text has no header, joins with `\n` and has no guard
- [ ] run `pnpm typecheck`, `pnpm test` and `pnpm test:integration` - must pass before task 5

### Task 5: Change the view model, the messages and their callers together

**Files:**

- Modify: `src/results-model.ts`, `src/results-model.test.ts`
- Modify: `src/results.ts`, `src/extension.ts`
- Modify: `media/results.ts`, `media/results.test.ts`
- Modify: `src/test-integration/run.test.ts`, `src/test-integration/live.test.ts`

- [ ] `ResultView`: remove `executedStatement`, add `resultId`, make the cells `{text, kind}`;
      `resultView(result, resultId)`
- [ ] `parseMessage`: accept `copy`, `copySelection`, `copyValue`, `copyColumn`, `copyColumnName` and
      `export` with `resultId`, non-negative integer indices and non-empty lists; reject any other shape
- [ ] add `copyText(result, resultId, message)` returning `{text, status}` or `undefined`, with the
      status texts, the singular forms and the `$(` escape
- [ ] `ResultsPanel`: store `run.id` as the current `resultId` together with `this.result`, on success
      only; send every copy message through `copyText`; show `The results changed. Copy again.` for a
      stale id; add a public `runResult` getter, and `runResult()` to `TestApi.panel` in
      `src/extension.ts`
- [ ] `media/results.ts`: the minimum to compile and keep working: render `cell.text`, send `resultId`
      with Copy CSV and Copy JSON, no statement block; update the jsdom fixtures to the new view shape
- [ ] `live.test.ts:318`: read `executedStatement` from `(await api()).panel.runResult()`
- [ ] test `parseMessage`: one accept case per new type (`copySelection`, `copyValue` with `pretty`,
      `copyColumn`, `copyColumnName`, `export`) gives the exact parsed object; a fractional index, `-1`, an
      empty `rows` in `copySelection` and a message with no `resultId` are rejected
- [ ] test `copyText`: an old `resultId`, `copyValue` with `row: rows.length`, `copyColumnName` with
      `column: columns.length`, `copySelection` with an unknown column index, and `copyColumn` with
      `rows: [rows.length]` each return
      `undefined`; toolbar `copy` on a result with columns and no rows returns the header; `copySelection` status counts the selection (`Copied 1 row as
      CSV.` for one row); `copyColumn` on a column named `$(alert)` gives `Copied 2 values of
      \$(alert).`; `copyValue` on a json cell gives the literal indented text with `pretty: true` and the compact
      text with `pretty: false`
- [ ] cut the old `resultView` cells tests (`src/results-model.test.ts:47`, `:57`) to one wiring case
      (the cell rules, the dotted key too, now live in `grid-model.test.ts`)
- [ ] jsdom test: clicking Copy CSV and Copy JSON posts `copy` with the format and the `resultId`
- [ ] integration: update the copy test to send `resultId`; add the stale case (put a known text on the
      clipboard, run twice, send `copySelection` with the first run's id, the clipboard still holds the
      known text; then the same message with the current id changes the clipboard); extend the unreadable test (`run.test.ts:253`): write a known text to the clipboard,
      then after the unreadable answer a copy with `(await view()).resultId` replaces it
- [ ] run `pnpm typecheck`, `pnpm test` and `pnpm test:integration` - must pass before task 6

### Task 6: Add Export

**Files:**

- Modify: `src/results.ts`
- Modify: `src/test-integration/harness.ts`, `src/test-integration/run.test.ts`
- Modify: `media/results.ts`, `media/results.test.ts`

- [ ] `export`: check the `resultId` and keep that `RunResult`; quick pick of format items; save dialog
      with the default URI; `TextEncoder` + `workspace.fs.writeFile`; `Saved N rows to <name>.`; a
      cancelled pick or dialog writes nothing; a failed write shows an error with the reason
- [ ] the **Export…** toolbar button posts `export` with the `resultId` (add it to the Task 5 button
      test)
- [ ] add a `saveDialogs` stub to the harness in the style of `quickPicks` (`answer` URI, the last
      `defaultUri`); reset `saveDialogs` and `quickPicks` (`answer`, `during`, `shown`) in `run.test.ts`'s
      `beforeEach`; each Export test uses a fresh file URI
- [ ] integration: Export as JSON writes the expected bytes in query order to the stubbed URI and the
      `defaultUri` ends in `dynotable-results.json`; a run with DIFFERENT rows (a `.partiql` file, or
      `fake.handle`) that ends during the quick pick (`quickPicks.during`, cleared in `finally`) does not
      change what is saved (inside `during`, assert the view's `resultId` and columns changed; the expected
      bytes are a literal from `contract/run-sql.json`, not a `jsonText` call); Export as CSV of a
      `fake.handle` result with a `=1+1` cell writes `'=1+1`; `export` with an old `resultId` (both
      answers set) writes nothing and shows no quick pick; a cancelled pick (save answer set) and a
      cancelled dialog leave no file at the URI or at the `defaultUri` path; a write to a path under a
      file shows an error
- [ ] run `pnpm typecheck`, `pnpm test` and `pnpm test:integration` - must pass before task 7

### Task 7: Render the grid

**Files:**

- Modify: `media/results.ts`, `media/results.test.ts`
- Modify: `src/results-model.ts` (`STYLE`)

- [ ] build the TanStack table from the view: index ids with `accessorFn`, the sort settings,
      `compareCells` with `isNumericColumn`
- [ ] render the toolbar and the grid (the focusable scroll box, sticky header, row numbers, striped
      rows, typed cells, tooltips on hover, px widths from `fitWidth` and the measured character width,
      the table width, `user-select: none`); reset view state only on a new `resultId`
- [ ] header click sorts; the table rebuilds on sort, filter, order, visibility and pin changes only; a
      render that changes the kind or the `resultId` closes open menus, popups and dialogs
- [ ] update `STYLE` with `--vscode-*` colours only
- [ ] point the hostile-text test at a data cell (not the row-number cell); keep the empty, cancel and
      ready tests
- [ ] jsdom test: one header click sorts a numeric column ascending; a second click puts the `null` and
      the missing value last
- [ ] jsdom test: render result A, then `running`, then A again: the sort is kept; a new `resultId`
      resets it
- [ ] run `pnpm typecheck`, `pnpm test` and `pnpm build` - must pass before task 8

### Task 8: Add cell selection, keys, copy, find, resize, reorder and totals

**Files:**

- Modify: `src/grid-model.ts`, `src/grid-model.test.ts`
- Modify: `media/results.ts`, `media/results.test.ts`
- Modify: `src/results-model.ts` (`STYLE`)

- [ ] add `selectionCells(selection, viewRows, viewColumns)`: selected rows × selected visible columns,
      both in view order; `wholeRows` means all visible columns; hidden rows left out
- [ ] click, Shift-click and Shift+arrows (range), the add modifier, row-number click (row), arrows
      (selection follows, `preventDefault`, scroll into view), Cmd/Ctrl+A; the focus rules (mousedown
      focuses the scroll box; no focus move while the find field has it); the selection stored as
      original rows and column ids; a focused cell that stops being shown moves to the nearest shown cell
- [ ] copy from the `copy` event with `preventDefault` when the scroll box has the focus:
      `copySelection` (`tsv`, `header: false`), or `copyValue` for one cell; nothing when no selected
      cell is shown
- [ ] the find field: Cmd/Ctrl+F, `cellMatches` highlight, Enter/Shift+Enter (Enter applies a pending
      query) and Next/Previous, the Filter rows checkbox as TanStack's global filter (visible columns
      only), `N of M rows shown`
- [ ] the selection totals line, from `totals`
- [ ] header edge drag resizes (table width follows); header drag reorders; mouse events, no HTML5 drag
      and drop; a drag suppresses the next click (flag cleared next tick); a drag ends on `buttons === 0`
      and `blur`; a drop across the pinned boundary is refused, inside it reorders `columnPinning.left`
- [ ] test `selectionCells`: rows and columns added in an order other than view order come out in view
      order; two add-clicked cells in different rows and columns give the 2×2 cross; `wholeRows` gives all
      visible columns; a selection whose columns are all hidden gives no cells; a selected row that the
      filter hides is left out
- [ ] jsdom test: a `copy` event with the focus in the find field is not prevented and posts nothing; with
      the focus on the scroll box it is prevented and posts; keydown `a` with the add modifier in the find
      field is not prevented, and on the scroll box it is (send the modifier the code uses for the
      platform jsdom reports)
- [ ] jsdom test: mousedown → mousemove → mouseup → click on a header resizes and does not sort; a reorder
      whose mouseup is on another header, then a separate click on a header, sorts
- [ ] jsdom test: Filter rows on, a query that matches a column whose first row is missing keeps the
      matching rows
- [ ] jsdom test: the totals line shows for 2 selected number cells of the focused column and not for one
      cell
- [ ] run `pnpm typecheck`, `pnpm test` and `pnpm build` - must pass before task 9

### Task 9: Add the menus, pinning, the column filter, the viewer and Record View

**Files:**

- Modify: `media/results.ts`, `media/results.test.ts`
- Modify: `src/results-model.ts` (`STYLE`)

- [ ] the cell menu and the header menu with the exact labels, the disabled states and keyboard
      control; a right-click on an unselected cell selects only that cell, inside the selection keeps it
- [ ] Hide Column, Hide Other Columns, Show All Columns (TanStack visibility; hiding clears the hidden
      columns' filters), Select Column, Sort Ascending/Descending, Clear Sort, Reset Column Widths, Copy
      Column Name, Copy Column, Pin Column / Unpin Column (TanStack pinning, cumulative CSSOM `left`)
- [ ] the per-column filter popup (search, Select All, values, `(empty)`, Apply, Clear) as a TanStack
      column filter with `inValueSet`, and the highlighted header icon
- [ ] the value viewer (`<dialog>`, `prettyText`, `jsonTokens` spans, Copy, Close, Esc); double-click and
      Shift+Enter in the grid open it
- [ ] Record View: the `Column | Value` table of the focused row; a double-click on a value opens the
      viewer
- [ ] the wiring test: render with a column named `o.orderId`, sort a column descending, hide one column,
      reorder two others and pin one, select a 2×2 range and dispatch `copy`; check the posted
      `copySelection`: the ORIGINAL row indices, the column indices in view order (pinned first), `tsv`,
      the `resultId`; then select one cell and check `copyValue` with its original `row` and `column`;
      then Copy Column and Copy Column Name from the header menu with the original `column` and the shown
      `rows`; then Shift+Enter and the viewer's Copy send `copyValue` with the original `row` and
      `column` and `pretty: true`; then select two rows, sort again, dispatch `copy`: the same original
      rows are posted
- [ ] jsdom test: right-click an unselected cell and choose Copy Selection as CSV (that one cell, `csv`,
      `header: true`); right-click inside a 2×2 selection and choose it again (both rows, both columns)
- [ ] jsdom test: a column filter, then Hide Column on that column: the rows come back; Apply with every
      value checked removes the filter; with every row filtered out, the header menu's Copy Column is
      disabled; on a one-column result, Hide Column is disabled in the cell menu and in the header menu
- [ ] security test: a hostile column name and a hostile JSON value render as text in the viewer title,
      the viewer body, Record View, the column filter list and the JSON cell tooltip (after `mouseover`)
      (no element made from them)
- [ ] jsdom test: open the viewer and a cell menu on result A, render a new `resultId`: the dialog is
      closed and no menu is in the DOM
- [ ] run `pnpm typecheck`, `pnpm test` and `pnpm build` - must pass before task 10

### Task 10: Update documentation

**Files:**

- Modify: `README.md`, `CHANGELOG.md`

- [ ] README › Use it: rewrite the **Results.** bullet for the grid (sort, find and filters, cell
      selection, copy as TSV, CSV, JSON or Markdown, export, totals, pinned columns, value viewer,
      Record View) and keep its row limit at 500
- [ ] CHANGELOG: add an `## Unreleased` entry for the grid and the removed statement block
- [ ] run `pnpm lint`

### Task 11: Verify acceptance criteria

- [ ] check each item in "Grid behaviour", "Copy formats" and "Export" against the code; resolve every ⚠️
      from the JetBrains answers or record it as open
- [ ] check the size of `dist/results.js` after `node esbuild.mjs --production` (the shipped, minified
      build) and write it in the PR description
- [ ] check that `renderHtml`'s CSP is unchanged and that no code calls `setAttribute('style'`
- [ ] run `pnpm gate`: typecheck, lint, unit, integration, CLI build and binary tests, package; no test
      skipped

## Post-Completion

_Informational only. These run after the code is done, in this order (user instruction,
2026-11-10)._

**QA with computer use** (`codex-computer-use` skill): drive VS Code with the built extension against
an isolated test app, on VS Code 1.91 and on stable. Check the real webview: Cmd/Ctrl+C (one cell and
a range), Cmd/Ctrl+A (no page text selected), Cmd/Ctrl+F; drag resize and reorder; menus near the
window edge; the focused cell never under the sticky header or the pinned columns, and arrows in a
pinned column do not scroll sideways; pinning; the viewer and Record View; the column filter; Export; totals; light and dark
themes; a 500-row result.

**Screenshots and JetBrains comparison**: capture the grid states, send them to the JetBrains thread
to confirm and compare with its grid, then update
`media/screenshot.png` and the listing.

**Release**: if the comparison is good, release (version, CHANGELOG, `pnpm gate`, publish to both
registries, tag), as the user asked.

**External**

- Update the dynotable.com editors guide if it describes the results panel.
- The planning rules ask for a Trello feature card. No `feature-card` skill is installed, and this
  project has no known Trello board, so no card was made.

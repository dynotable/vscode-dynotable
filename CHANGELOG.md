# Changelog

## 0.3.0 — 2026-11-11

- The results panel shows the rows in a grid. Sort, find and filter the rows, and filter a column
  by its values. Select cells and copy them as TSV, CSV, JSON or Markdown. Pin, hide, resize and
  move columns. A line shows the count, sum, average, minimum and maximum of the selected cells in
  the focused cell's column. Double-click a cell to see its full value, or open Record View to see a
  row.
- Export saves all rows to a CSV, JSON or Markdown file.
- The results panel no longer shows the statement that ran.
- PartiQL (`.partiql`) and OpenSearch (`.opensearch`) files show the DynoTable file icon.

## 0.2.0 — 2026-11-09

- `*.dtsql` files are DynoTable SQL files. They attach without a `dynotable.sqlFiles` entry, and
  New Query creates them. `*.dynotable.sql` files still work.
- This repository now also holds `dynotable-cli`, a command line client for AI agents and other
  editors, and a Claude Code plugin. See the README. They need DynoTable 1.20.0 or later; the
  extension still works with 1.19.0.

## 0.1.3 — 2026-11-09

- The README shows a SQL JOIN, a PartiQL query and an OpenSearch query.

## 0.1.2 — 2026-11-08

- The Marketplace listing says which query language works with which engine. Its name and tags
  name DynamoDB, OpenSearch and SQL.
- The README says that OpenSearch queries run on the free licence.

## 0.1.1 — 2026-11-07

- A click on a table or an index in the explorer opens a query for it, as its New Query button
  does.
- The query plan shows in the lens row above the statement, after Run and Open in DynoTable. It no
  longer sits after the cursor while you type.
- Cmd+Enter (Ctrl+Enter) runs the query. Cmd+Shift+Enter (Ctrl+Shift+Enter) opens the statement at
  the cursor in DynoTable. Change them in Keyboard Shortcuts.

## 0.1.0 — 2026-11-07

First release. Needs DynoTable 1.19.0 or later.

- Language features from the DynoTable app for `*.dynotable.sql`, `*.partiql` and `*.opensearch`
  files: completion, diagnostics with quick fixes, hover, inlay hints, formatting and alias
  rename.
- Run a statement. The rows show in a results panel, with Copy CSV, Copy JSON and Cancel.
- An explorer of the profile's DynamoDB tables and OpenSearch indices, with Refresh.
- Open in DynoTable, Validate against the index, and Stage in DynoTable for PartiQL writes.
- New Query, Attach SQL File, Pick Index, Select Profile, Reconnect and Open Documentation
  commands.
- Starts DynoTable in the background when it is not running.

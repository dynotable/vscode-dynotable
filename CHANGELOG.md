# Changelog

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

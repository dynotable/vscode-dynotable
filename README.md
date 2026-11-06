# DynoTable for VS Code

Write SQL, PartiQL and OpenSearch queries in VS Code. The [DynoTable](https://dynotable.com)
desktop app serves the language features and runs the queries.

- Completion from your real table schemas and index mappings.
- Diagnostics with quick fixes, hover, inlay hints (the query plan), formatting, and rename of
  table aliases.
- **Run** a statement. The rows show in a results panel.
- An explorer of the tables and indices of your DynoTable profile.
- **Open in DynoTable** opens the app at the statement's table or index.

Full guide: [dynotable.com/docs/editors](https://dynotable.com/docs/editors).

## Requirements

- The DynoTable desktop app, version 1.19.0 or later, installed on the same computer.
- The Editor integration switched on in the app. **It is off by default.**
- VS Code 1.91 or later, in a trusted workspace.

### Switch on the Editor integration

1. Open DynoTable.
2. Go to **Settings → Editor integration**.
3. Switch on **Editor integration**.

You do this one time. After that, the extension starts DynoTable when it needs the app.

## Query files

| File              | Language                                 |
| ----------------- | ---------------------------------------- |
| `*.dynotable.sql` | DynoTable SQL (tables and indices)       |
| `*.partiql`       | DynamoDB PartiQL                         |
| `*.opensearch`    | One OpenSearch query: JSON DSL or Lucene |

DynoTable does not attach to other `.sql` files. To attach one, open it and run
**DynoTable: Attach SQL File**. The command adds the file to the `dynotable.sqlFiles` setting of
its workspace folder. Each folder's own `dynotable.sqlFiles` decides which of its files attach. In a
window with no folder, name the file `*.dynotable.sql`. In a window with folders, a `.sql` file
outside them does not attach.

An OpenSearch query names its index on its first line:

```
// dynotable: index=orders
{"query": {"match": {"status": "shipped"}}}
```

When two OpenSearch targets have an index with the same name, add `target=<target name>`. Also add
it when DynoTable could not list the indices of all targets. **Pick Index** and the explorer's New
Query do this for you. A target name that contains a space cannot be written there.

## Use it

- **New query.** Run **DynoTable: New Query** and choose SQL, PartiQL or OpenSearch. In the
  explorer, the New Query button on a table or an index opens a query for it.
- **Run.** Click the **Run** lens above a statement, or run **DynoTable: Run**. Run uses the
  selection. With no selection, it uses the statement at the cursor, or else the whole file. An
  OpenSearch query runs the selection or the whole file.
- **Results.** One panel shows the rows of the last run. It shows the total only when DynoTable
  knows it. A run returns up to 500 rows. **Copy CSV** and **Copy JSON** copy the rows. **Cancel**
  stops the run. Closing the panel also stops it. You can run one statement at a time.
- **Explorer.** The DynoTable icon in the activity bar opens it. It shows your DynamoDB tables and,
  for each OpenSearch target, its indices. **Refresh** reads the lists again.
- **Pick index.** In an OpenSearch query, run **DynoTable: Pick Index** to write the index line.
- **Validate against the index.** In an OpenSearch JSON query, this code action asks the index if
  the query is valid. Nothing runs.
- **PartiQL writes** do not run from the editor. **Stage in DynoTable** opens the statement's table
  in the app. The statement stays in the editor.
- **Open Documentation.** Run **DynoTable: Open Documentation** to open the full guide.

## Profiles

A connection uses one DynoTable profile.

- When DynoTable has one profile, the extension uses it.
- When it has more, run **DynoTable: Select Profile**. While no profile is selected, a click on the
  status bar also offers it. VS Code keeps your choice for this workspace.

The status bar shows the profile you selected. Click the status bar to see what to do when
DynoTable is not connected. **DynoTable: Reconnect** connects again.

## DynoTable runs in the background

When DynoTable is not running, the extension starts it with no window. The app then keeps running
after you close VS Code, and the next VS Code window uses it again.

- **Get a window back:** open DynoTable as usual (Dock, Start menu or app launcher), or click
  **Open DynoTable** in a DynoTable message.
- Some actions need an app window: signing in to DynoTable, an expired AWS sign-in, and **Open in
  DynoTable** on a profile with no open window.
- **macOS:** a permission prompt from DynoTable can name Visual Studio Code. This is because VS Code
  started the app.
- **Linux:** the extension cannot read the app version before it starts the app. An app that is too
  old opens a window one time. An AppImage install needs `dynotable.appPath`.
- If you updated DynoTable but did not restart it, the old app can open a window one time. Restart
  DynoTable.

## Free and paid

The extension is free. What runs depends on your DynoTable licence, as in the app:

- **Free (signed in):** completion, diagnostics, and PartiQL `SELECT`.
- **Trial or paid:** running SQL statements, as in the SQL Workbench.
- **Signed out:** nothing. Sign in to DynoTable.

See [Activation](https://dynotable.com/docs/activation) for the licence states.

## Settings

| Setting                 | Default                  | Description                                                                         |
| ----------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| `dynotable.sqlFiles`    | `["**/*.dynotable.sql"]` | Glob patterns of the `.sql` files that DynoTable serves.                            |
| `dynotable.appPath`     | empty                    | The path of the DynoTable app. Set it when the app is not in its standard location. |
| `dynotable.userDataDir` | empty                    | The app's user data directory. When set, the extension does not start the app.      |

## Privacy

The extension connects only to the DynoTable app on your computer (`127.0.0.1`). It reads the
connection token from the app's port file and does not store it.

## Platforms

Tested on macOS. Windows and Linux are not verified yet. A Flatpak install of VS Code is not
supported.

Remote workspaces (SSH, WSL, Dev Containers) are not supported. DynoTable serves only files on this
computer and new untitled queries.

## For client authors

[PROTOCOL.md](PROTOCOL.md) describes the wire protocol of the DynoTable language server.
[CONTRIBUTING.md](CONTRIBUTING.md) tells how to build and test this extension.

## License

[MIT](LICENSE)

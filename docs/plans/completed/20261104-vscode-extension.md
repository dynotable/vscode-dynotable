# DynoTable for VS Code — the first client of the Editor integration channel

## Overview

A VS Code extension that connects to the Language Server the DynoTable desktop app serves. SQL,
PartiQL and OpenSearch query buffers get the app's own completion, diagnostics, quick fixes, hover,
inlay hints, formatting and alias rename. The extension adds:

- a Run command whose rows land in a results panel;
- a sidebar explorer of the bound profile's tables and indices;
- the server's own lens and code actions, which open the app at the right table or index.

**Why it exists.** Editor marketplaces are where a DynamoDB buyer already searches. The listing is a
distribution surface and a crawlable page. The extension competes with standalone explorers that
need no desktop app, so the first minute must work:

- there is something to type into;
- the app starts by itself;
- a clear sentence appears when it cannot.

This plan replaces the 2026-09-06 draft, which was written against a much smaller server.

## Context (verified 2026-11-04)

**The spec** is private. This repo will be public, so this plan names behaviour only.
`PROTOCOL.md` in this repo is a wire-only description written fresh for client authors (Task 3).

**Release state.** The latest app release (1.18.2) carries only the first LSP drop. The next
release ships these together:

- the full capability set and `--headless`;
- exit code `3` when the integration is off;
- a headless second instance that restarts a stopped listener and opens no window;
- complete, refreshable listings;
- `dynotable/listTables` and `dynotable/listIndices`.

That release's version is this extension's minimum app version.

**Transport and auth.**
- **Port file.** The server writes `<userData>/lsp-port.json`, mode 0600, `{port, token, pid}`:
  - `port` is the bound port: the configured preferred port (41120 by default), or an ephemeral
    rebind.
  - `token` is minted fresh at every server start. Validate it only as a non-empty string.
  - `pid` is the serving app's main process. An older app omits it.
  - The server writes the file atomically (temp + rename). It deletes the file synchronously on a
    clean stop. A killed process leaves a stale file behind.
- **userData** is `<appData>/DynoTable`, where `appData` is:
  - `~/Library/Application Support` on macOS;
  - `%APPDATA%` on Windows;
  - `$XDG_CONFIG_HOME` (default `~/.config`) on Linux.
- **Connection.** TCP to `127.0.0.1:<port>` with standard LSP framing, and
  `initializationOptions: {token, profile?}`, where `profile` is a profile uuid or slug.
  - One port-file read supplies both the port and the token.
  - Connect and initialize are one unit. A request on a connection that has not finished
    `initialize` is refused with the same `-32898` and message as a bad token. A second `initialize`
    on one connection is refused. Switching profile means a new connection.
  - `-32898` at initialize ⇒ re-read the port file once, retry on a new connection, then fail. The
    server drops the refused socket about 250 ms later.
  - The server's handshake deadline is 30 s.
- **`-32803`** carries `data.code`: `profile-required`, `profile-window-required`,
  `reauth-required`, `premium-required`, `signed-out`, `stage-in-app`, `busy`, `planner-refused` or
  `run-failed`. `signed-out` can also answer `initialize`.
- **Unbound sessions.** A session starts unbound in any of these cases:
  - no profile was requested and the roster has more than one row;
  - the requested profile is not found, ambiguous or incomplete;
  - the roster is a single incomplete row;
  - a bind threw.

  Vocabulary completion and schemaless diagnostics still work. Anything that needs a profile
  answers `profile-required`.

**Headless.** `DynoTable --headless` serves the channel with no window.
- **Readiness.** A process that becomes the primary and serves **never exits**. Readiness is the
  port file appearing.
- **Exit codes:**
  - `0` — another instance holds the lock and has been nudged to restart a stopped listener. Poll
    the port file for about 20 s. If nothing appears, spawn once more, because the holder may have
    been quitting.
  - `1` — start failed.
  - `3` — integration off.
  - any other code or a signal — a crash.
- **Getting a window back.** A **plain** second launch opens a window in a running instance. That
  is the route back to the GUI.
- **Limits of the background app:**
  - An expired AWS sign-in cannot be repaired from the editor (`reauth-required`).
  - `openInApp` answers `profile-window-required` while no window is open on the profile and
    region. Under headless that is the normal state.
  - The process has no tray and no quit affordance.
- **The client never fires a deep link.** Spawning `--headless` starts a cold app and nudges a
  running one. A cold `dynotable://` link would boot the full GUI instead.

**App install locations.**
- **macOS:** `/Applications/DynoTable.app` (verified) or `~/Applications`.
  - The binary is `Contents/MacOS/DynoTable`.
  - The version is in `Info.plist` `CFBundleShortVersionString`.
- **Windows:** Squirrel, which serves direct download, Chocolatey and winget alike. The install root
  is `%LOCALAPPDATA%\dynotable\`.
  - The top-level `dynotable.exe` is a stub that starts `app-<version>\dynotable.exe`. Per
    Squirrel's design it does not forward the child's exit code, so the launcher spawns the newest
    complete `app-*\dynotable.exe` directly.
  - Folder names use NuGet-style versions. Dots inside a pre-release part are stripped, so
    `1.19.0-beta.1` becomes `app-1.19.0-beta1`.
  - ⚠️ Not run on a machine.
- **Linux:** deb, rpm and AUR install `/usr/bin/dynotable`. This follows from the installer defaults
  and the executable name.
  - The version is not readable before launch.
  - An AppImage can live anywhere, so it needs `dynotable.appPath`.
  - ⚠️ Not run on a machine.
  - A Flatpak VS Code sees neither the host's config directory nor `/usr/bin`. It is unsupported in
    v1.

**Server capabilities** (all negotiated):
- incremental sync;
- completion with resolve (triggers `.` `'` `"`, not space);
- code actions of kind `quickfix` and the empty kind ("Validate against the index");
- code lens: Run and Open in DynoTable per statement, none for `opensearch`. A lens's own `range`
  is a zero-width anchor at the statement start. The statement's range is in
  `command.arguments[0].range`, already a protocol range.
- whole-document formatting;
- hover;
- inlay hints (the static query plan);
- definition, document highlight, and rename with prepare (alias only);
- `executeCommand` for `dynotable.runStatement`, `dynotable.openInApp` and
  `dynotable.validateQuery`;
- pushed diagnostics.

Three client capabilities gate features: `window.showMessage`, completion `snippetSupport` and
`window.workDoneProgress`. The library sends all three by default.

The server does **not** send `client/registerCapability`, `workspace/applyEdit` or
`window/showDocument`. Rename returns its edit as the response.

Not advertised: semantic tokens, document symbols, folding, pull diagnostics, configuration change
and signature help. Ask upstream instead of working around them.

**Commands** take one object `{uri, range?, rowCap?, index?, target?, seedStatement?}`.
- `runStatement` → `RunResult`. It reports `$/progress` begin and end, and is cancellable by
  `$/cancelRequest`. For `opensearch`, a blank-text range is refused, so a run with no selection
  sends no range.
- `openInApp` → `null`. An `opensearch` document is always refused.
- `validateQuery` → a sentence. The server **also** sends it as `window/showMessage` when the client
  advertised that.

**`RunResult`** carries `columns`, `rows`, `returnedRows`, `totalRows: number | null`, `truncated`,
`itemsScanned?`, `approximateBytes`, `elapsedMs`, `executedStatement` and `effectiveRowCap`.

Rendering rules:
- **Totals.** `totalRows` null means unknown; never substitute the returned count. `truncated` with
  an exact total is legal (SQL aggregates, OpenSearch).
- **Columns** render exactly as returned. A qualified column (`o.orderId`) is a literal key in each
  row, never a path. On PartiQL and OpenSearch, columns are a first-seen union, so rows are sparse.
- **Values.** A precision-losing number arrives as exact decimal **text**. Sets arrive as arrays and
  binary as base64. Maps arrive as objects.
- **Empty.** An empty result can carry `columns: []`.
- **`executedStatement`** is what ran. For OpenSearch it is the request body.
- **`rowCap`** defaults to 500 and is clamped server-side to `[1, 1000]`.
- **Cancellation.**
  - A cancelled PartiQL or OpenSearch run answers `run-failed` ("The run was cancelled before it
    finished.").
  - A cancelled SQL run answers its own pipeline error.
  - Whatever the dialect, a run **this client cancelled** is silent.

**Custom requests.** All three require an initialized session. The last two also require a bound
one.
- `dynotable/listProfiles` → an **array** of `{id, name, slug, kind, bindable,
  reason?: 'incomplete', engines: {dynamodb, opensearch}}`.
- `dynotable/listTables {fresh?}` → `{tables, tableListingFailed?: {message}}`.
- `dynotable/listIndices {fresh?}` → `{indices: [{name, target}], unreachable: [{target, message}],
  indexListingFailed?: {message}, partial?: {message}}`.
  - `target` is a display name. A name hosted on two targets appears twice.
  - Two targets that share a display name cannot be told apart.

`fresh` refreshes that listing first, even inside a failure cooldown. An older server answers
`-32601`.

**The `opensearch` dialect** takes its index from line 0: `// dynotable: index=<name>`.
- An optional `target=<display name>` pin is needed when two targets host the name, or when the
  listing is incomplete (`unreachable`, `partial`, `indexListingFailed`).
- Tokens are whitespace-delimited, so a display name containing a space cannot be pinned.
- After the directive line is blanked, a buffer whose first non-blank character is `{` is JSON query
  DSL. Anything else is a Lucene one-liner.

**Library facts.** These are for `vscode-languageclient` 11.0.0, read from the published tarball
during review. Task 4 re-verifies each one and records file:line.

- **Retrying needs a new client.** A client whose start failed does not start again on its own
  terms, so a retry builds a **new** `LanguageClient`. The failed client still gets a late
  `handleConnectionClosed` when the server drops its socket. That calls `errorHandler.closed()`,
  which can auto-restart it with the stale token.
- **`stop()` can fail.** `dispose()` / `stop()` on a client that never ran rejects with "Client is
  not running". A `stop()` that loses its 2 s shutdown race throws and leaves the connection open.
- **A failed start forces toasts.** It calls the public `error()` with `'force'`, which ignores
  `revealOutputChannelOn`. An `initializationFailedHandler` that returns `false` stops a second
  toast. The default `errorHandler.error` always forces a toast. The default `closed` restarts
  silently up to 4 times, then forces one.
- **Sockets.** A `StreamInfo` can carry a socket the caller already connected. On a clean stop the
  library calls `writer.end()` and `connection.dispose()`, never `destroy()`.
- **Tracing.** Tracing turns on when the **trace channel's log level** is Trace.
  `<clientId>.trace.server` only sets verbosity. `traceOutputChannel` is typed `LogOutputChannel`.
  An object with a fixed `logLevel` of Off and an `onDidChangeLogLevel` that never fires keeps
  tracing off. JSON-format traces log whole messages, including the token.
- **Server-to-client requests.** The library answers `client/registerCapability`,
  `workspace/applyEdit` and `window/showDocument` (with `external` → `env.openExternal`) by default.
- **Document selectors.** `documentSelector` is converted with the protocol `asGlobPattern`. A
  relative pattern's `baseUri` must be a **string**: a `vscode.RelativePattern` whose `baseUri` is a
  `Uri` object is dropped silently, and the filter then matches by language alone.
- **Dependencies.** `vscode-jsonrpc` is re-exported and pinned exactly. A second direct copy would
  break `instanceof ResponseError`. `engines.vscode` is `^1.91.0`.

## Decisions (made with the user, 2026-11-04)

- **SQL scope.** `sql` attaches to:
  - untitled buffers that DynoTable's own New query created (decided with the user, 2026-11-04).
    Untitled `sql` buffers from other extensions (SQLTools, mssql) or from VS Code's language
    auto-detect get nothing.
  - files matching `dynotable.sqlFiles`, default `**/*.dynotable.sql` (engine-neutral, because SQL
    reads tables and indices);
  - files the user attaches.

  It never attaches to every `.sql`.
- **Languages.**
  - `partiql` → `.partiql`, highlighted with the built-in SQL grammar.
  - `opensearch` → `.opensearch`, highlighted with the built-in JSON-with-comments grammar.
- **Explorer:** in v1.
- **Launcher:** spawn `--headless`.
- **Results:** one reusable webview panel. Notebooks stay a v2 idea.
- **Overrides:** `dynotable.userDataDir` and `dynotable.appPath`, both machine-scoped. There is no
  port override.
- **Profile choice:** stored in workspace state.
- **Contract:** a wire-only `PROTOCOL.md`.
- **Version gate:** on `serverInfo.version`.

Resolved during review (2026-11-04):

- **One new `LanguageClient` per attempt; no probe.**
  - The connection module creates and owns each attempt's socket. It destroys that socket after
    every dispose, whether the dispose resolves or rejects. A rejected stop counts as finished.
  - Every handler is fenced by an attempt id, so a late close from a failed attempt cannot touch a
    live one.
  - The subclass routes `error()` to our notifier. `initializationFailedHandler` returns `false`.
    `errorHandler.error` and `errorHandler.closed` both answer do-not-restart, handled.
  - After `start()` resolves, the gate reads `initializeResult.serverInfo.version`.
- **The launcher.**
  - **Triggers.** It runs when:
    - the port file is missing;
    - the file's `pid` is not live;
    - the file is present but the connect is refused (`ECONNREFUSED`: a stale file left by a killed
      process);
    - a crash exit.
  - **Version check.** A pre-spawn version check runs on macOS and Windows. A version below the
    minimum latches "Update DynoTable" and nothing is spawned, because an old app would open its
    full GUI. Linux has no pre-spawn version, so there an old app opens a window once. That is
    documented.
    - Residual: the check reads the **installed** version. An older app that is still running
      (an update was installed but the app was not restarted) holds the lock, handles the
      headless second instance the old way and opens a window. The client cannot see that
      version before the spawn: a running app with its integration stopped has no port file to
      connect to. The window appears once, and after the connect the version gate latches
      "Update DynoTable". That is documented.
  - **What it waits for.** It races the child's `exit`, a new `(port, token)` in the port file, and
    a timeout.
    - Exit `0`: poll the port file for up to 20 s, then spawn once more. A second exit `0` with no
      port file latches "DynoTable is running but not serving — open it".
    - A cold-start child that is still alive with no port file after 30 s latches "timed out".
    - Exit `3` and exit `1` each map to their own reason.
    - A crash or a spawn error (`EACCES`, `ENOENT`) maps to its own reason.
  - **Spawn options.** The spawn is detached and unref'd, with `stdio: 'ignore'`, because piped
    stdio dies with `EPIPE` once VS Code exits. `cwd` is the home directory.
  - **Environment.** It approximates a desktop launch, per platform. The long-lived app must not
    inherit a terminal's AWS credentials, Node or Electron switches, or development variables.
    - **Linux snap first.** A snap-installed VS Code points `GTK_*`, `GDK_*` and `XDG_*` into its
      own runtime, and keeps the host values in `<NAME>_VSCODE_SNAP_ORIG`. Before filtering, each
      `<NAME>_VSCODE_SNAP_ORIG` is restored into `<NAME>`, or `<NAME>` is deleted when the original
      is empty. ⚠️ Verify the variable names against VS Code's own sanitizer when Linux is checked.
    - **macOS / Linux: an allow-list.**
      - Shell and locale: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `LANG`, `LC_*`, `TMPDIR`.
      - Desktop session: `XDG_*`, `DISPLAY`, `WAYLAND_DISPLAY`, `XAUTHORITY`,
        `DBUS_SESSION_BUS_ADDRESS`, `DESKTOP_SESSION`, `KDE_*`, `GNOME_*`, `GTK_*`, `QT_*`,
        `GDK_*`, `XMODIFIERS`. These choose Chromium's secret-store backend and the IME.
    - **Windows: the inherited environment minus a deny-list.** The Explorer environment is the
      registry environment, which VS Code's own process already reflects. Matching is
      case-insensitive, so `Path` survives and `electron_run_as_node` is denied. Denied:
      `ELECTRON_*`, `NODE_*`, `npm_*`, `VSCODE_*` and every `AWS_*`. That includes
      `AWS_ENDPOINT_URL*`, which the SDK honours, and which would otherwise send every profile's
      calls to a local emulator for the life of the app.
    - Proxy variables and `AWS_CONFIG_FILE` are not passed on macOS or Linux, because a Dock launch
      does not have them either. Electron uses the system proxy.
  - **`appPath` resolution.**
    - A `.app` resolves to its binary.
    - The Windows stub resolves to its newest `app-*`.
    - Windows folders sort by version after the NuGet name is mapped back, and folders without an
      executable are skipped.
  - **macOS limit.** A process spawned from VS Code has VS Code as its "responsible process", so
    macOS permission prompts in that app name Visual Studio Code. This is documented and accepted,
    because a LaunchServices launch loses the exit code.
- **No binary found** ⇒ "DynoTable is not installed", with a download link and a "Set app path"
  action. No deep link is fired.
- **With `dynotable.userDataDir` set, the launcher is off.** The user starts the app.
- **Every failure latches.** The latched reasons are:
  - integration off, start failed, crash, spawn error, timeout
  - running but not serving
  - auth failed twice, signed out
  - update app, not installed, launcher off
  - app build lacks a request
  - **connection ended**: an established session dropped. The client cannot tell the causes apart on
    the wire: the app quit, the app crashed, the integration was switched off, or the licence flipped
    to signed out (which ends every editor session). So the sentence names all four, and Reconnect
    turns a signed-out app into the `signed-out` reason.

  A latched reason holds until the port-file watcher sees a new `(port, token)` or the user runs
  Reconnect. Nothing respawns or re-toasts per document, so an app the user just quit never comes
  back invisibly.

  **Every latched reason offers Reconnect as its second action**, and clicking the status bar offers
  it too. Some fixes write no new port file: activating the licence keeps the same server, an app
  can be installed while nothing runs, and a permission fix leaves the app as it was. In those cases
  Reconnect is the only way out, so it must always be one click away.
- **Connect is lazy.** Activation registers languages and commands only. The first connection
  happens when:
  - a document matching the selector opens, including editors restored at startup;
  - the explorer becomes visible;
  - a DynoTable command runs.
- **The port-file watcher.**
  - It watches the containing directory, because an atomic rename replaces the inode. It falls back
    to a slow poll while that directory does not exist.
  - It acts only on a `(port, token)` that no current or in-flight attempt uses.
  - A delete never launches anything.
  - After a drop, it re-reads the file once.
- **Restarts are serialized and wait for runs.** A restart arrives on a `dynotable.sqlFiles` change,
  a workspace-folder change, a profile change or Reconnect.
  - During a start, it waits for that start and disposes it.
  - During a run, it waits for the run to end. The status bar says why.
- **Selectors.**
  - [decision, review] Each folder's own `dynotable.sqlFiles` value decides what attaches in that
    folder, `[]` included. Every entry, `**/` ones too, is a pattern relative to that folder, with a
    **string** `baseUri`, so it cannot attach a file in another folder.
  - With no folder open, the entries that begin with `**/` are plain string patterns. They match the
    absolute path.
  - In a window with folders, a `sql` file outside every folder does not attach. A plain pattern
    for it would also match inside the folders, and a filter cannot exclude them. Attach SQL File
    says so for such a file.
  - A `vscode.RelativePattern` object is never used.
  - Untitled `sql` attaches only when the uri's path ends in `.dynotable.sql`. New query creates its
    untitled buffers with such a path, for example `untitled:Query-1.dynotable.sql`.
    - ⚠️ Task 4 verifies that a DocumentFilter `pattern` matches an untitled uri's path.
    - If it does not, the fallback is a middleware `didOpen` filter over the uris New query created.
- **Workspace trust:** `untrustedWorkspaces: {supported: false}`.
- **A stale port file is never trusted** (decided with the user, 2026-11-04). After a crash, a port
  file can point at a port that another local user now holds.
  - The app writes its `pid` into the port file. Before connecting, the client signals that `pid`
    with signal 0. `ESRCH` (dead) and `EPERM` (another user's process) both mean stale, so the
    client runs the launcher instead of connecting.
  - A file with no `pid` is from an older app. The check is skipped, and the version gate decides.
  - As defence in depth, the client also refuses `client/registerCapability`,
    `workspace/applyEdit`, `window/showDocument` and `workspace/configuration`. It uses the 11.0.0
    middleware hooks `handleRegisterCapability`, `workspace.handleApplyEdit`, `window.showDocument`
    and `workspace.configuration`. The server sends none of these requests.
  - Residual: a same-user process that reuses the dead app's pid. That is a coincidence, not an
    attack another user can stage.
  - Residual [decision, review]: a live pid does not prove that the process holds the port. If a
    live app's listener stopped and left its file, another process can bind the freed port and get
    the token. The app deletes the file synchronously when its server stops, so the window is
    short. The wire has no server authentication, and no cheap client check proves who holds a
    port on every platform. `PROTOCOL.md` states this limit.
- **Tracing is closed at the sink.** The client gets a trace channel with a fixed Off level and a
  no-op `trace()`, plus an output channel we own.
- **Unbound comes only from the server.** After connect and the version gate, the client sends one
  `dynotable/listTables`. The answer decides the state:
  - `profile-required` ⇒ unbound;
  - `-32601` ⇒ the latched "this app build lacks a required request";
  - any other refusal ⇒ nothing.

  The client shows the bound state (the explorer loading) until that answer arrives. An unbound
  session answers `profile-required` at once, before any AWS call. A bound one answers only after
  a complete, paged table listing, which can take seconds on a cold large account, so the client
  never waits on the answer to leave the connecting state.

  The explorer refetches on connect, on profile change and on token rotation. Tables never wait
  for `dynotable/listIndices`: the OpenSearch group shows when its own answer arrives, because a
  VPC-only domain off the VPN takes about 30 s to fail.
- **Pick index and the explorer read `dynotable/listIndices`**, never completion.
- **Explorer actions:** New query and Refresh only.
- **No `rowCap` setting.**
- **Version compare:** `semver.gte(serverVersion, minimum)` with pre-releases included, and the
  minimum written `X.Y.Z-0`. A pre-release of the minimum passes, and so does a pre-release of any
  later version. Outside `ExtensionMode.Production`, `DYNOTABLE_MIN_APP_VERSION` overrides the
  minimum.
- **Test seams are gated to `ExtensionMode.Test`.**
  - `DYNOTABLE_TEST_USER_DATA_DIR` replaces the userData directory.
  - `DYNOTABLE_TEST_APP_ROOT` replaces the install locations.
  - The real `openExternal` and `spawn` throw unless a seam replaces them.
- **The profile id is persisted**, not the slug.
- **"Open DynoTable"** launches the located binary with no flag, in the filtered environment. On
  macOS it uses `open -a <app>` so the app comes to the front.
- **Out of scope for v1:** `seedStatement`, and Flatpak VS Code.

## Development Approach

- **testing approach**: Regular (code first, then tests), in the same task
- complete each task fully before moving to the next; small, focused changes
- **CRITICAL: every task MUST include new/updated tests** for the code it changes. The one
  carve-out: a module that imports `vscode` or `vscode-languageclient` is covered by integration
  tests, and their harness lands in Task 3, before the first such module.
- **CRITICAL: all tests must pass before starting the next task.** Zero-failure policy: a skipped
  lane is a failure.
- **CRITICAL: update this plan file when scope changes during implementation**
- tests encode why: before writing a test, name the real bug only it would catch
- a pure rule is tested once at its own layer; higher layers test only that it is wired in
- the extension implements the contract; it never invents protocol
- no claim in README or listing copy that the app's public feature docs do not support

## Testing Strategy

- **unit** (vitest, node env) covers every module with no `vscode` import, including the webview
  script under jsdom.
- **integration** (`@vscode/test-electron`) covers everything that touches the client, against a
  **fake LSP server** on loopback.
  - **The fake server** answers from `contract/` fixtures through the same runtime guards the
    client uses (`src/protocol.ts`). It records the `initialize` params it receives. It can rotate
    its token, rebind its port, play an old version, and hold a run open until `$/cancelRequest`
    arrives.
  - **Notifications.** The extension's own copy goes through an injected notifier. The library's
    `window.show*Message` calls are counted through stubs. Test files load from the extension's own
    folder, so they share its API object. A positive control has the fake send `window/showMessage`
    of types 1, 2 and 3, and asserts each is counted.
  - **Panel messages.** They are injected through a Test-mode hook that feeds the panel's real
    receive path, so validation and run-id wiring are exercised.
  - **Isolation.** Every run gets a temp `--user-data-dir` and `--extensions-dir`,
    `--disable-extensions`, and a fixture workspace folder whose `.vscode/settings.json` is written
    before launch. State resets between files.
  - **Guard rails.** Before the first test, the harness asserts that the resolved port-file path and
    app locations sit under its temp directory, and that the real `openExternal` and `spawn` throw.
    After each test, it puts back any seam a test replaced. A launch in which no test ran fails.
  - **VS Code versions.** The suite runs at the `engines` floor and on current stable.
  - **Off-screen** [decision]: `pnpm test:integration` (the gate's step) builds on the host, then
    runs `out/` and VS Code in a Linux container under Xvfb (`scripts/integration-container.sh`,
    image `scripts/integration.Dockerfile`, VS Code cache `.vscode-test-linux/`). No window opens
    on the host. It fails when Docker is not reachable. `pnpm test:integration:host` runs the same
    suite on the host: Linux CI under `xvfb-run`, or a machine with no Docker. It opens windows.
    The gate's launches are Linux; macOS paths keep their unit tests and the host run.
  - **Launcher runs** (Phase B, added after completion): `pnpm test:live:launcher` runs the
    `@live-launcher` tests on macOS against a packaged build that the extension starts through a
    wrapper, with the launcher on. See `docs/manual-e2e.md`, Launcher runs. Not part of the gate.
- **contract fixtures** live in `contract/`. They start hand-authored from `PROTOCOL.md`.
  `contract/manifest.json` lists each fixture's provenance as `authored` or `recorded`; nothing is
  marked inside the fixture itself.
- **the recorder** (`pnpm contract:record`) replaces authored fixtures with real server answers.
  - It is a small raw JSON-RPC client. It advertises all three gating capabilities and drives a
    running local app.
  - **Recorded answers:**
    - the capabilities;
    - each dialect's `RunResult`;
    - `listProfiles`, `listTables`, `listIndices`;
    - the lens argument shape;
    - `$/progress`.
  - **Recorded refusals:**
    - `-32898` for a bad token;
    - `profile-required` (a multi-row roster with no profile requested);
    - `profile-window-required` (no window open);
    - `stage-in-app` (a PartiQL INSERT);
    - the cancel replies of a SQL run **and** a PartiQL run;
    - the `validateQuery` result together with its `window/showMessage`.
  - **The scrub.** It walks every string, deeply. Every roster name, slug and id, and every
    OpenSearch endpoint host, becomes a fixture placeholder.
    - Before writing anything, the recorder runs the leak check itself against the in-memory list of
      what it saw. It refuses to write if any of those strings survived the scrub.
    - That list is never persisted, so the repo never holds it.
    - The unit test covers only the check function, with synthetic input.
  - **Cancel shapes.** A run on a small table can finish before the cancel arrives. The recorder
    cancels when the run's `$/progress` begin arrives, and records which shape came back. If the run
    finished first, the recorder fails and names the precondition: a table large enough that the
    run is still in flight.
  - **Options:** `--user-data-dir`, `--profile`, `--table`, `--large-table`, `--set-table`,
    `--index` and `--sql` (a `SELECT` that names its columns). `docs/publishing.md` has the command.
  - **Table names.** The scrub keeps table names, index names and regions. Record on a profile
    that holds only the seed tables, or trim the listing, and read the diff before the commit.
  - **Fixtures that stay authored.** These are optional shapes a healthy local app does not
    produce: `indexListingFailed`, `partial`, `unreachable`, `reason: 'incomplete'`, and the
    `signed-out` refusal (a development build cannot sign out).
- **check mode** (`pnpm contract:check`) diffs the real server against the committed fixtures:
  - capabilities, deeply;
  - results by key set **and** `typeof` per field;
  - refusals by code and `data.code`.
- **live subset** (`pnpm test:live`) runs the integration tests tagged `@live` against the real app,
  in a harness mode that drops the temp-path guard.
  - **What `@live` covers:** connect; one run per dialect, with rows; a SQL `GROUP BY` column;
    `listTables`/`listIndices` rendering in the explorer; the profile picker; refusal copy for
    `profile-required` and `profile-window-required`; the **Use brackets** quick fix; completion
    after `FROM`; the Run lens of the second statement; Pick Index; Validate against the index; every
    advertised capability in each dialect; the cancel races; the teardown run that is not `busy`;
    and the version gate (`live-version.test.ts`, its own launch).
  - **Fake-only by design:** token rotation, port rebind, held runs, and recorded `initialize`
    params. The old-version case runs against the fake too.
  - **How it runs** [decision]: `pnpm test:live` launches only the test files that hold `@live`
    tests, and mocha greps `@live`. `pnpm gate` launches only the other files, so it never needs
    the app. A file with `@live` tests holds no fake-backed test, and the harness refuses to make a
    fake in a live run: a fake would overwrite the real app's port file. The env sets:
    - `DYNOTABLE_LIVE_USER_DATA_DIR` (required): read through the Test-mode userData override. The
      launcher refuses it when it resolves to the real app's userData directory. The port-file
      guard then asserts that exact path; the app-root, `spawn` and `openExternal` guards stay.
    - `DYNOTABLE_LIVE_PROFILE` (required): the name or slug of the roster row with no window.
    - `DYNOTABLE_LIVE_LARGE_TABLE` (required): the table of the cancel races.
    - `DYNOTABLE_MIN_APP_VERSION`: taken from the shell, not from `initialize.json`. The one
      exception is `live-version.test.js`: the runner sets `99.0.0`, so the running app is too old.
    - `DYNOTABLE_TEST_DISPLAY` (optional, macOS, also for `test:integration:host`): the name of
      the display where VS Code's windows open. An extension test window ignores stored window
      state and opens on the display under the cursor. So the launcher holds the cursor on that
      display until the window shows, puts it back, and gives the focus back to the app that had
      it. It fails when no display has that name, or when a window opens outside it.
  - **Added to the coverage** [deviation]: a cancel sent at once, for `sql` and `partiql`, is
    refused with `run-failed` and shows no rows. The recorder keeps its after-`begin` cancel.
  - **Coordinated** [decision]: `pnpm test:live:coordinated <name>` runs the one `@live-coordinated`
    test whose title holds `<name>`. Each one waits up to 10 minutes for a person to change the
    app's state (`docs/manual-e2e.md`, Coordinated runs). It runs on stable only, unless
    `DYNOTABLE_VSCODE_VERSIONS` is set. It writes `dynotable.userDataDir` into user settings, so the
    launcher is off as for an app on a custom user data directory. `signed-out` needs a licensed
    packaged build on its own user data directory; otherwise that walk is manual.
  - **Who runs it.** A human runs it as a publish gate (Post-Completion). Its preconditions:
    - a running local app build of the minimum release, with the integration on;
    - an offline profile on DynamoDB Local with the tables `orders` and `customers`, a large table
      and a table that holds Sets (`docs/publishing.md` has the details);
    - OpenSearch with one seeded index;
    - a multi-row roster;
    - no app window open on the chosen profile (the `profile-window-required` case needs that);
    - an active or trial licence;
    - `DYNOTABLE_MIN_APP_VERSION` set when the build is unreleased.

## Progress Tracking

- mark completed items with `[x]` immediately when done
- add newly discovered tasks with ➕ prefix; blockers with ⚠️ prefix
- keep the plan in sync with actual work done

## Solution Overview

```
VS Code (extensionKind: ui, untrusted: unsupported)
 ├─ connect(): port file → owned socket → new LanguageClient per attempt (attempt-fenced)
 │     → version gate → listTables (bound / unbound / -32601)
 │     └─ launcher (missing file | ECONNREFUSED | crash): [pre-spawn version] → spawn --headless
 │          (stdio ignore, platform env) → race(exit 3 | 1 | 0→poll→respawn once | new port file | timeout)
 ├─ LanguageClient (library-native): diagnostics · completion+resolve · actions · lens · hover
 │                  · hints · format · definition/highlight/rename · $/progress · showMessage
 │                  (registerCapability / applyEdit / showDocument refused)
 ├─ one executeCommand middleware (never calls next): runStatement → results panel,
 │                                                    openInApp → server's sentence
 ├─ commands: run · newQuery · attachSqlFile · pickIndex · selectProfile · reconnect · openDocs
 ├─ explorer: listTables + listIndices → tables / target → indices; TreeView.message for state
 ├─ results webview: grid (textContent only) · banner · executedStatement · copy CSV/JSON · cancel
 └─ status bar: starting | connected | unbound | disconnected(reason) — one reason → sentence map
```

## Technical Details

- **Modules** (`src/`), pure ones marked ★:
  - ★`protocol`: the wire types plus hand-written runtime guards, in two modes.
    - **Lenient** (the client): checks required keys and their types, and ignores extra keys and
      unknown enum values. The server's surface is additive, so a new field must not break an
      installed extension.
    - **Strict** (the fake server, `contract.test` and check mode): refuses any extra key, so drift
      is seen in this repo first.
  - ★`discovery`: userData, port file, app locator, installed-version read.
  - ★`reasons`: reason → `{sentence, action}`, read by status, notifications and the explorer
    message.
  - ★`connect-core`: the attempt loop, launcher race, env filter, retry, latch and restart queue.
    It works over seams for fs, net, spawn, clock and a **session starter**, which returns typed
    outcomes: ok + version, `-32898`, `signed-out`, refused, closed, or timeout.
  - `client`: the `LanguageClient` subclass implementing the session starter, plus handlers,
    middleware, request refusals and selectors.
  - ★`results-model`, `results`, and the webview script `media/results.ts`.
  - ★`profiles`, ★`explorer-model` + `explorer`, ★`directive`, ★`attach`.
  - `commands`, `status`, `extension`.
- **Manifest:**
  - publisher `dynotable`, MIT, `repository`;
  - `engines.vscode` equal to the pinned library's floor;
  - `extensionKind: ["ui"]`;
  - `untrustedWorkspaces.supported: false`;
  - an exact `vscode-languageclient` pin, plus `semver`;
  - activation on the three languages, the view and the commands;
  - the extension's own command ids, including `dynotable.selectProfile`, are contributed in
    Task 1;
  - the server's three ids are not contributed: the library registers them while connected.
- **Attach** appends the file's path, relative to its workspace folder, to that folder's
  `dynotable.sqlFiles` (the `WorkspaceFolder` configuration target). Glob metacharacters are
  escaped and separators are normalized to `/`. The write is a `sqlFiles` change, so it triggers
  the normal restart. It refuses when no folder is open (the default glob
  already covers a `*.dynotable.sql` there) and when the file already matches.
- **Middleware.** One `executeCommand` middleware sends every server command itself, with a
  `CancellationTokenSource`:
  - `runStatement` → the results panel;
  - `openInApp` → refusals in the server's own sentence;
  - `validateQuery` → nothing extra.
- **Run with no selection:**
  - `sql` / `partiql`: the `command.arguments[0].range` of the server's Run lens whose argument
    range contains the caret (one `textDocument/codeLens` request), else the whole buffer;
  - `opensearch`: no range.

  A selection goes through the protocol converter. A lens argument range passes through unchanged.
- **Errors** map a code to an **action**, and the server's sentence is kept:
  - `profile-required` → the `dynotable.selectProfile` command.
  - `signed-out` → Open DynoTable.
  - `profile-window-required` / `reauth-required` → the sentence, plus Open DynoTable. The action is
    offered but never implied as the fix.
  - `stage-in-app` from a Run → the sentence plus **Stage in DynoTable** (`openInApp` on the same
    uri and range).
  - everything else → the message.
  - A client-cancelled run → silent.
  - `ConnectionInactive` → the current status reason.
- **Results panel:**
  - one reusable webview with CSP `default-src 'none'`, a fresh nonce per render, no
    `unsafe-inline` and no remote source;
  - the webview script builds the grid with `textContent` only;
  - a cell is read as `row[column]`, a literal key. A missing key renders empty. An object or array
    renders as compact JSON.
  - state is restored on view-state change;
  - a fixed, validated message set, where `cancel` carries its run id;
  - one run at a time;
  - closing the panel or `deactivate` cancels the run.
- **CSV guard.** It applies to every cell's final CSV text, header included, when that text starts
  with `= + - @ \t \r \n`. The one exemption is text matching the strict number literal
  `^-?\d+(\.\d+)?([eE][+-]?\d+)?$`, so exact-decimal text survives. Guarding comes before quoting.
- **Explorer:**
  - a DynoTable view container: DynamoDB → tables, OpenSearch → target → indices;
  - `TreeView.message` carries the disconnected or unbound reason from `reasons`;
  - message nodes for `tableListingFailed`, `indexListingFailed`, `partial` and each unreachable
    target;
  - an engine that answers an empty list with no failure shows no group;
  - **New query**: SQL `SELECT * FROM "<table>"` with `"` doubled, or an `opensearch` buffer whose
    directive comes from ★`directive`;
  - **Refresh**: `fresh: true` to both requests.

  Showing the view is a lazy-connect trigger, owned by Task 7.
- **Pick index:** a QuickPick over `listIndices`, with the target in the detail. Line 0 is rewritten
  through ★`directive`; a directive is inserted when line 0 has none.
- **Directive pin rules**, in one place, ★`directive`: add `target=` when the picked name repeats
  across targets, or [decision, review] when the listing is incomplete: the server refuses an
  unpinned name that a target it could not list can also host. Never write a display name
  containing a space; say instead that it cannot be pinned.
- **Profiles:**
  - the picker shows name, slug and engines;
  - a non-bindable row gets the extension's own sentence for `incomplete`;
  - an empty roster gets "create a profile in DynoTable";
  - the status bar shows the profile as **requested**, never as confirmed.
- **Configuration:**
  - `dynotable.sqlFiles`: array of globs, default `["**/*.dynotable.sql"]`;
  - `dynotable.userDataDir`: machine scope;
  - `dynotable.appPath`: machine scope.

## What Goes Where

- **Implementation Steps**: everything an automated executor can do inside this repo
- **Post-Completion**: the app release, recording and the live subset, publishing, public docs,
  repo visibility, and sibling clients

## Implementation Steps

### Task 1: Repo scaffold and manifest

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.mjs`, `vitest.config.mts`, `.oxlintrc.json`,
  `.oxfmtrc.json`, `.gitignore`, `.vscodeignore`
- ➕ Create: `pnpm-workspace.yaml` (build-script approvals), `media/dynotable.svg` (view container
  icon)
- Create: `syntaxes/partiql.tmLanguage.json`, `syntaxes/opensearch.tmLanguage.json`
- Create: `src/extension.ts` (activation stub), `src/manifest.test.ts`

- [x] pnpm project (pnpm 12, current Node LTS or newer), TypeScript strict, esbuild bundle with
      `vscode` external, oxlint + oxfmt
- [x] the manifest per Technical Details: the languages and grammars, the configuration, every
      extension command id, the view container
- [x] `@vscode/vsce` as a devDependency; `pnpm package` runs `vsce package --no-dependencies`
      non-interactively (with the existing `LICENSE`, and `repository` set)
- [x] write manifest tests:
  - `engines.vscode` equals the pinned library's own `engines.vscode`
  - no server command id is contributed
  - each grammar path resolves to a file
  - both path settings are machine-scoped
  - `untrustedWorkspaces.supported` is `false`
- [x] run the gate (typecheck, lint, unit, package) — must pass before next task

### Task 2: The pure core — protocol guards, discovery, reasons, directive, attach, connect-core

**Files:**
- Create: `src/protocol.ts`, `src/discovery.ts`, `src/reasons.ts`, `src/directive.ts`,
  `src/attach.ts`, `src/connect-core.ts`, and their tests

- [x] implement `protocol`, `discovery`, `reasons`, `directive` and `attach` per Technical Details
- [x] implement `connect-core` per the review decisions
- [x] pin the spawn options in a test, with a comment naming each failure they prevent:
  - `stdio: 'ignore'` (`EPIPE`)
  - `detached` + `unref`
  - `cwd` = home (a locked VS Code folder on Windows)
- [x] write protocol guard tests:
  - **strict mode:** refuses each of an extra key, a missing required key and a wrong field type
  - **lenient mode:** accepts an extra key and an unknown enum value; still refuses a missing
    required key and a wrong field type
- [x] write discovery tests:
  - each platform's userData path, with `XDG_CONFIG_HOME` / `APPDATA` from the env
  - the mode gates: in Production, the Test-only seams **and** the min-version override are ignored;
    in Development, the Test-only seams are ignored and the override applies
  - a corrupt port file (truncated JSON; `port` as a string)
  - `app-1.10.0` beats `app-1.9.0`
  - `app-1.19.0-beta1` maps back to `1.19.0-beta.1`
  - a folder without an executable is skipped
  - a `.app` path resolves to its binary
  - a Windows stub path resolves to its newest `app-*`
- [x] write version tests: the minimum's pre-release passes; a later version's pre-release
      (`1.20.0-beta.1` over minimum `1.19.0-0`) passes; one below the minimum fails
- [x] write environment tests:
  - macOS/Linux: `ELECTRON_RUN_AS_NODE`, `AWS_PROFILE`, `NODE_OPTIONS` and `NODE_ENV` are dropped;
    `HOME`, `PATH` and `XAUTHORITY` survive
  - Windows: `Path` survives (case-insensitive). `electron_run_as_node`, `Node_Options` and
    `AWS_ENDPOINT_URL` are dropped.
  - Linux snap: `GTK_PATH` is restored from `GTK_PATH_VSCODE_SNAP_ORIG`, and a variable whose
    original is empty is deleted
- [x] write launcher tests:
  - **cold start:** a child with no `exit` event whose port file appears connects
  - **stale file:** a present file whose connect is `ECONNREFUSED` runs the launcher
  - **dead pid:** a present file whose `pid` answers `ESRCH`, or `EPERM`, runs the launcher and never
    connects. A file with no `pid` connects.
  - **exit codes:** exit `3`, `1` and a crash each latch their reason
  - **exit 0:** poll from a **stale** file to a new `(port, token)`; on timeout, spawn once more. A
    second exit `0` latches "running but not serving", with no third spawn.
  - **connection ended:** an established session that drops latches "connection ended", and the
    next in-scope document spawns nothing
  - **initialize timeout:** a session starter that never answers `initialize` times out at 40 s,
    which is longer than the server's 30 s handshake deadline
  - **Open DynoTable:** launches the located binary **without** `--headless`, through the spawn
    seam with the filtered env. On darwin it uses `open -a`.
  - **Reconnect:** every latched reason carries the Reconnect action, and Reconnect clears the
    latch
  - **plain timeout:** a live child that writes nothing times out
  - **no binary:** "not installed", with no deep link and no spawn
  - **old app:** an old pre-spawn version means no spawn
  - **spawn error:** maps to its reason
  - **`userDataDir` set:** no spawn
  - **`-32898` twice:** give up
  - **`signed-out` at initialize:** latches
- [x] write concurrency tests:
  - concurrent triggers produce one spawn
  - a restart during a start waits and disposes before the next start, through the session-starter
    seam
  - a restart during a run waits for the run
  - a latched reason does not respawn on the next trigger
  - a watcher event for the in-flight attempt's `(port, token)` is ignored
  - a watcher delete does nothing
- [x] write `reasons` tests: every reason has a non-empty sentence and an action. This is a
      completeness gate over the reason union.
- [x] write `directive` tests:
  - insert when line 0 is not a directive
  - replace `index=`
  - collapse a duplicated key
  - keep unknown tokens and leading whitespace
  - handle CRLF and CR line endings
  - add `target=` for a repeated name
  - refuse a display name with a space
- [x] write `attach` tests:
  - Windows backslashes become `/`
  - `[prod].sql` and `{a}.sql` are escaped
  - no folder open → refused
  - an already-matching file → refused
- [x] run the gate — must pass before next task

### Task 3: `PROTOCOL.md`, contract fixtures, the recorder and the integration harness

**Files:**
- Create: `PROTOCOL.md`, `contract/*.json`, `contract/manifest.json`, `scripts/contract-record.ts`
- Create: `src/test-integration/` (runner, fake server, smoke test), `src/contract.test.ts`
- Modify: `package.json`
- ➕ Create: `scripts/rpc.ts` (raw JSON-RPC peer shared by the recorder and the fake),
  `scripts/contract.ts` (manifest, guard map, scrub, leak check), `src/test-integration/harness.ts`,
  `src/test-integration/index.ts` (mocha entry), `src/test-integration/run.ts` (launcher)
- ➕ Modify: `src/protocol.ts` (guards for initialize, code lens, progress, showMessage, errors),
  `src/extension.ts` (Test-mode API and seams), `esbuild.mjs` (`--tests`), `tsconfig.json`,
  `.gitignore`, `.oxlintrc.json`, `.oxfmtrc.json`

- [x] write `PROTOCOL.md` fresh and wire-only. Cover:
  - discovery and the handshake
  - the initialize options
  - the languages and the directive
  - the commands and `RunResult`
  - the custom requests
  - the error codes
  - the headless readiness rule and exit codes

  It must contain no app file paths, module names, architecture or security internals.
- [x] hand-author `contract/` from `PROTOCOL.md` and list each fixture in `contract/manifest.json`
      as `authored`
- [x] write the recorder (record + check modes and the scrub) per Testing Strategy. This task does
      not run it, because a running app is a human precondition.
- [x] build the fake server and the harness per Testing Strategy, with the isolation assertions,
      the toast stubs, the panel-message hook and the mode-gated seams
  - ➕ the panel-message hook moves to Task 5: the panel and its receive path do not exist yet
- [x] write `contract.test.ts`:
  - every fixture passes its `protocol` guard
  - every fixture also passes its **strict** guard
  - the leak-check function rejects synthetic input that holds a listed name or host
- [x] write the smoke test (a harness check): the extension activates against the fake in the
      fixture workspace, at the floor and on stable. Record the first green run on macOS in this
      plan.
  - First green run: 2026-11-06, macOS arm64 (Darwin 27.0.0), VS Code 1.91.0 (floor) and 1.145.1
    (stable), 2/2 passing on each.
- [x] run the gate, including integration — must pass before next task

### Task 4: The client, the status bar and the connect-time listing

**Files:**
- Create: `src/client.ts`, `src/status.ts`
- Create: `src/test-integration/connect.test.ts`
- Modify: `src/connect-core.ts`, `src/extension.ts`
- ➕ Create: `src/test-integration/no-folder.test.ts`, `restored.test.ts`,
  `workspace-folders.test.ts` (each needs its own launch layout)
- ➕ Modify: `src/test-integration/{harness,run,index,fake-server}.ts` (window stubs with toast
  answers and channel recording, launch layouts, `--log <extId>:trace`, initialize delay and hook)

- [x] re-verify every "Library facts" item against the installed 11.0.0, record file:line here, and
      record how the three server-to-client requests are refused
  - Verified 2026-11-06 in `node_modules/vscode-languageclient/lib/` (`common/client.js` unless
    named):
    - **Retry needs a new client.** `start()` returns the kept `_onStart` (932), so a failed start
      stays rejected (state `StartFailed`, 1054). A late close still calls `errorHandler.closed()`
      (1483) and `Restart` starts the same client again (1511).
    - **`stop()` can fail.** `shutdown` throws "Client is not running" (1252); losing the 2 s race
      throws "Stopping the server timed out" (1282) with no `end()`/`dispose()`.
    - **Forced toasts.** The failed start calls `error(…, 'force')` (1055); `'force'` ignores
      `revealOutputChannelOn` (858). `initializationFailedHandler` replaces the default toast
      (1173–1196). The default handler restarts up to 4 times (172–203, 820).
    - ➕ **An error hides the close.** `errorHandler.error` → `Shutdown` stops the client; a client
      in `Stopping` never calls `errorHandler.closed()` (1480–1484). The error handler therefore
      ends the session itself. Found by the Open DynoTable integration test.
    - **Sockets.** `node/main.js` 281–283 takes a `StreamInfo`; a clean stop calls `end()` and
      `dispose()` (1277–1278), never `destroy()`.
    - **Tracing.** The trace channel's `logLevel` sets `_traceLogLevel` (466); only `Trace` turns
      tracing on (1540); the level listener is on the trace channel (1533); JSON traces log whole
      messages (889).
    - **Server-to-client requests.** `window/showDocument` with `external` → `env.openExternal`
      (1014–1047); `client/registerCapability` (1142) and `workspace/applyEdit` (1148) are answered
      by default. Refused through `middleware.handleRegisterCapability` (1734),
      `middleware.workspace.handleApplyEdit` (1793) and `middleware.window.showDocument` (1041):
      each answers a `RequestFailed` error.
    - **Selectors.** `common/protocolConverter.js` 1110–1124: a relative pattern's `baseUri` must be
      a string URI or a protocol workspace folder; anything else becomes `undefined`.
    - **Dependencies.** `vscode-languageserver-protocol` 3.18.5 pins `vscode-jsonrpc` 10.0.0 and
      re-exports it (`lib/node/main.d.ts` 2); `engines.vscode` is `^1.91.0`.
- [x] build the subclass as the session starter, per the review decisions:
  - the handlers and the request refusals
  - the owned output channel and the sink trace channel
  - the selectors
  - the version gate
  - lazy connect (documents and commands)
  - the watcher
  - the connect-time `listTables`
- [x] the status bar's four states, reading `reasons`
- [x] write integration tests (one wiring case each):
  - **capabilities:** the fake's recorded `initialize` params carry the three gating capabilities
  - **late close:** after a `-32898` and a rotated token, a new client connects. The test waits
    past the server's socket drop of the refused attempt, then asserts one live client and an
    unchanged count of `initialize` calls.
  - **version gate:** an old version shows the update reason, leaves no client running, and does not
    reconnect on the next in-scope document
  - **refused start:** shows only our notifier's copy, and the stubs count no library toast
  - **trace sink:** the fixture `settings.json` sets `dynotable.trace.server: verbose`, and the
    extension log level is Trace (`--log <extId>:trace`). No channel created during the session
    contains the fake's token. As a positive control, a second `LanguageClient` built in test code
    without the sink shows the token appearing.
  - **storage:** neither workspaceState nor globalState holds the token
  - **squatter requests:** a fake `workspace/applyEdit`, `client/registerCapability` and
    `window/showDocument {external}` are refused; nothing is edited, registered or opened
  - **Open DynoTable:** the action reaches the spawn seam without `--headless`
  - **watcher:** a new port file reconnects a dropped client; deleting the port file spawns nothing
  - **selectors:** a `.sql` file outside the globs gets no `didOpen` and starts no connection; an
    untitled `sql` buffer from New query gets `didOpen`, while a plain untitled `sql` buffer does
    not; a `*.dynotable.sql` file opened with no folder gets
    `didOpen` (this case runs in its own harness launch with no workspace folder)
  - **restored editors:** an in-scope editor already open at activation connects
    - No fake serves at activation, so activation's own attempt latches `not-installed`; the
      test then starts the fake and the watcher connects. With no activation scan the state stays
      idle and the watcher never acts.
  - **restart storm:** two quick `sqlFiles` changes during a start leave one client whose server
    commands still run
  - **workspace folders:** adding a folder attaches its attached-file patterns
    - Runs on a `.code-workspace` launch: a single-folder window that gains a folder enters a
      workspace and never reports the change to the test.
  - **`-32601`:** a fake answering `listTables` with `-32601` latches the "app build lacks a
    request" reason
  - **unbound:** an unbound fake shows the unbound state right after connect; a `signed-out` answer
    to the connect-time listing does not set unbound
  - ➕ **toast positive control** (moved from Task 3, it needs a connected client): the fake sends
    `window/showMessage` of types 1, 2 and 3, and the harness stubs count each
- [x] run the gate — must pass before next task

### Task 5: Run, the middleware and the results panel

**Files:**
- Create: `src/results-model.ts`, `src/results-model.test.ts`, `src/results.ts`,
  `media/results.ts`, `media/results.test.ts`
- Create: `src/commands.ts`, `src/test-integration/run.test.ts`
- Modify: `src/client.ts`, `src/extension.ts`
- ➕ Create: `src/refusals.ts`, `src/refusals.test.ts` (the pure error → action map),
  `media/tsconfig.json` (DOM types for the webview only)
- ➕ Modify: `esbuild.mjs` (builds `dist/results.js`), `.vscodeignore`, `.oxlintrc.json`,
  `package.json` (`jsdom`; typecheck of `media/`)

- [x] the middleware, the error actions and Run with no selection, per Technical Details. The
      `profile-required` action invokes `dynotable.selectProfile`, whose handler is Task 6's.
- [x] the results model, the webview and its script, per Technical Details
- [x] register `run`, `reconnect` and `openDocs`
- [x] write unit tests:
  - a truncated result with an exact total; `totalRows` null; `effectiveRowCap` below 500
  - `itemsScanned` absent; `columns: []`
  - a qualified column `o.orderId` read as a literal key
  - sparse rows render empty cells; a Map and an array cell render as compact JSON
  - exact-decimal text stays text in JSON copy
  - CSV: each guard character on a string cell; a header cell; `=1,2` → `"'=1,2"`
  - CSV bypass forms each guarded: `-1+1`, `+1)`, `-2+cmd|'/C calc'!A0`, `1.5abc`, and an array
    cell whose JSON text starts with a guard character
    - Written as `-1.5abc`: `1.5abc` starts with no guard character, so the rule never guards it.
      The array case is not written: an array's JSON text always starts with `[`.
  - CSV exemption: `-12345678901.5` and `-1e5` stay intact
  - webview HTML: `default-src 'none'`, a different nonce per render, no `unsafe-inline`, no remote
    source
  - message set: an unknown type is rejected; a `cancel` whose run id is not a string is rejected
  - error actions: an unknown code; a `-32803` with no `data`
- [x] ➕ the Test-mode panel-message hook (moved from Task 3): it feeds the panel's real receive path
- [x] write a jsdom test of the webview script: a hostile column name and cell (`<img onerror>`)
      render as text, and no element is created from them
- [x] write integration tests:
  - **lens Run:** reaches the panel with that statement's argument range
  - **caret Run:** a caret inside the second statement runs the second statement
  - **selection Run:** an explicit selection reaches the wire as `{start, end}`
  - **opensearch Run:** with no selection, sends no range
  - **cancel:** for a held SQL run and a held PartiQL run, each answering its own recorded or
    authored cancel shape, the cancel sends `$/cancelRequest` and shows nothing
  - **stale cancel:** a stale run-id cancel (through the panel hook) leaves the current run alone
  - **one run at a time:** a second Run while one runs is refused
  - **panel close:** closing the panel cancels the run
  - **refusal copy:** `profile-window-required` shows the server's sentence once
  - **validateQuery:** produces exactly one toast
  - **stage:** `stage-in-app` offers Stage
- [x] run the gate — must pass before next task

### Task 6: Profile picker and the unbound state

**Files:**
- Create: `src/profiles.ts`, `src/profiles.test.ts`, `src/test-integration/profiles.test.ts`
- Modify: `src/commands.ts`, `src/extension.ts`
- ➕ Modify: `src/client.ts` (`profile` in `initializationOptions`), `src/status.ts` (the requested
  profile), `src/test-integration/harness.ts` (quick-pick stub)

- [x] the `dynotable.selectProfile` handler from `dynotable/listProfiles`, per Technical Details.
      Choosing persists the **id** in workspace state and reconnects. From a disconnected state, the
      picker says so.
- [x] write unit tests:
  - a non-bindable `incomplete` row gets our sentence
  - an empty roster gets "create a profile in DynoTable"
- [x] write integration tests:
  - choosing a profile produces a new connection whose `initializationOptions.profile` is the chosen
    id
  - an unbound Run lens click opens the picker
  - the status bar shows the chosen profile as requested
  - after the extension host restarts, the first connection sends the stored id
    - VS Code keeps storage in memory under extension tests, so a relaunch loses it. The test
      writes the stored profile through the Test API before the first connection instead.
- [x] run the gate — must pass before next task

### Task 7: Explorer

**Files:**
- Create: `src/explorer-model.ts`, `src/explorer-model.test.ts`, `src/explorer.ts`
- Create: `src/test-integration/explorer.test.ts`
- Modify: `src/extension.ts`
- ➕ Modify: `src/client.ts` (one listing request for the connect-time `listTables` and the
  explorer), `src/commands.ts` (`newQuery` on an explorer node), `package.json` (item menu)

- [x] the tree, `TreeView.message`, New query, Refresh, the refetch triggers and the
      view-visibility lazy-connect trigger, per Technical Details
  - New query with no explorer node says to choose a table or an index; Task 8 replaces it with
    the dialect choice.
- [x] write unit tests:
  - a name on two targets yields two nodes (that the directive rule is wired in, not the rule
    itself)
  - each failure field yields a message node
  - an engine with an empty list and no failure yields no group
  - a table name containing `"` is quoted
- [x] write integration tests:
  - the tree lists the fake's tables and indices
  - showing the view connects
  - Refresh sends `fresh: true` to both requests
  - a profile change refetches
  - New query on an index opens an `opensearch` buffer with a directive
  - the unbound state shows its reason as the tree message
- [x] run the gate — must pass before next task

### Task 8: New query, Attach SQL file and Pick index

**Files:**
- Create: `src/test-integration/editor-commands.test.ts`
- Modify: `src/commands.ts`
- ➕ Modify: `src/extension.ts` (registrations, platform in the command deps), `src/explorer-model.ts`
  (the `partiql` dialect; index failures shared with Pick index)

- [x] `newQuery`: choose SQL, PartiQL or OpenSearch, and open an untitled buffer whose path carries
      the dialect suffix (`Query-<n>.dynotable.sql`, `.partiql`, `.opensearch`). An OpenSearch buffer
      gets a directive line.
- [x] `attachSqlFile` and `pickIndex`, per Technical Details
- [x] write integration tests (wiring only; the rules are tested in Task 2):
  - attaching a file writes its folder's `dynotable.sqlFiles`, and the fake receives its `didOpen`
    after the restart
  - Pick index writes line 0
- [x] run the gate — must pass before next task

### Task 9: README, CHANGELOG, publishing notes and the manual checklist

**Files:**
- Create: `README.md`, `CHANGELOG.md`, `docs/publishing.md`, `docs/manual-e2e.md`

- [x] write the README, user-facing only. It covers:
  - that the extension requires the desktop app, and the integration ships off
  - how to switch the integration on
  - the three file kinds and `*.dynotable.sql`
  - New query, Run, the explorer, Pick index, profiles
  - the background process: how to get a window back, and the macOS note that permission prompts
    may name VS Code
  - the free/paid split
  - a link to `/docs/editors`
- [x] write `docs/publishing.md`:
  - the `vsce` and `ovsx` steps
  - the accounts
  - the recording and live-subset gate
  - the hard prerequisite: the app release ships first
- [x] write `docs/manual-e2e.md` per Post-Completion
- [x] boundary audit of README, `PROTOCOL.md`, the manual checklist, `contract/` and this plan:
      nothing names app internals
  - README, `CHANGELOG.md`, `docs/`, `PROTOCOL.md` and `contract/`: clean. This plan and the
    branch's commit messages: a few references to the private app; listed in the progress file.
- [x] run the gate — must pass before next task

### Task 10: Verify acceptance criteria

- [x] typed refusals reach the user in the server's own sentence, exactly once (Task 5 refusal
      copy, Task 4 refused start)
  - `connect.test` refused start; `run.test` refusal copy; ➕ `run.test` stage now asserts the
    Run path's sentence once (only `@live` covered it before). Each turned red under a mutation.
- [x] the results panel never reports a total it does not have, renders columns as returned and
      escapes everything (Task 5 unit + jsdom)
  - `results-model.test` summary and ➕ column order (a sorted header passed before);
    `media/results.test` hostile text. Each turned red under a mutation.
- [x] no token in any channel or storage (Task 4 trace sink + storage)
  - `connect.test` trace sink (channels) and storage (mementos); ➕ the trace sink also scans the
    launch's settings, state and log files, with the control's trace as the positive control.
    Each turned red under a mutation. The panel takes only server answers and run ids. The live
    token is not in tracked files, git history, `out/`, `dist/` or the vsix.
- [x] an out-of-scope `.sql` file gets nothing and starts nothing (Task 4 selectors)
  - `connect.test` selectors: red when the selector takes every `sql` file, and when it takes
    every untitled `sql` buffer.
- [x] full gate: typecheck, lint, unit, integration at the floor and on stable, and
      `vsce package --no-dependencies`. Every lane is green; none is skipped.

### Task 11: Update documentation

- [x] README and `docs/publishing.md` match what shipped
- [x] `PROTOCOL.md` matches the committed `contract/` fixtures

## Post-Completion

*Items requiring manual intervention or external systems — informational only*

**Blocking prerequisites:**
1. **The app release** that ships the full capability set, `--headless` and the app-side
   prerequisites. Its version is the minimum in the version gate.
2. **Recording and the live subset — REQUIRED before publishing.** Against a local build of that
   release:
   - run `pnpm contract:record` and commit the scrubbed fixtures;
   - re-run the fake-backed integration suite on them;
   - run `pnpm contract:check` green;
   - run `pnpm test:live` green.

   Until then, an `authored` fixture is a second reading of the spec, not evidence.
3. **Public docs — REQUIRED:** `/docs/editors` on the website. It is currently a 404, and it is the
   destination of the Open Documentation command and action, and the README. It must cover:
   - switching the integration on and installing the extension;
   - the three file kinds and `*.dynotable.sql`;
   - picking a profile;
   - the background process: start, invisible, getting a window back;
   - what needs the app's window: sign-in, Open in DynoTable.

   User-facing only, audited against the website's writing rules.

**Manual end-to-end** (`docs/manual-e2e.md`, run by a human against a local app build):
- **Setup:** an offline profile on DynamoDB Local, OpenSearch with a seeded index, a multi-row
  roster, and the integration on.
- **Expected values:**
  - a PartiQL `IN ('a')` offers a quick fix titled **Use brackets** that leaves `IN ['a']`
  - completion after `FROM ` (invoked explicitly) lists the seeded tables
  - a SQL `GROUP BY customerId` returns columns `["customerid", "COUNT(*)"]`
  - a lens Run on the second statement runs the second statement
  - Pick index writes the directive
  - Validate against the index shows one toast
  - every advertised capability answers in a buffer of each dialect
- **Failure paths:** not installed, integration off, the app quit mid-session, the app killed (stale
  port file), the app restarted (new token), signed out, an unbound multi-profile roster, an old app
  version.
- **Teardown:**
  - reload the window mid-run, and the next run is not `busy`
  - quit VS Code, and the headless process survives and the next window reuses it
- Record the app commit. State plainly that Windows and Linux are unverified.

**Resolved with the user (2026-11-04):**
- `.dynotable.json` is not read in v1. It comes with the stdio shim, so all clients adopt it at
  once.
- Only DynoTable-created untitled buffers attach.
- A stale port file is detected by its `pid`.

**Before flipping the repo public:** remove or scrub `docs/plans/`, and squash the whole history,
branch commits included, or start a fresh public repo from the final tree. `docs/publishing.md`
lists both.

**Accounts:** a Visual Studio Marketplace publisher `dynotable` and an Open VSX namespace. Open VSX
also serves VSCodium, Cursor, Windsurf and Gitpod.

**CI:** none during development. Decide at publish time whether the public repo gets a free Actions
lane for contributors.

**Unverified platforms:** check these on real machines before the listing claims those platforms:
- the Windows Squirrel stub, the `app-*` launch and the NuGet naming;
- the Linux binary path and the environment allow-list on GNOME and KDE.

**Listing assets:** an icon, and one screenshot of a SQL JOIN across a table and an index, with the
results panel and the explorer visible.

**Upstream follow-up (optional):** server authentication would also close the same-user pid-reuse
residual and the live-pid port residual. v1 does not need it.

**Then the siblings:** the stdio shim (`dynotable/dynotable-lsp`, for Neovim, Zed, Helix, Emacs) and
`dynotable/jetbrains-dynotable`.

# Manual end-to-end checklist

Run this against a local DynoTable build before a publish. Each item says how it is checked:

- **automated** — a `@live` test checks it against the running app. `pnpm test:live` runs it (see
  [publishing](publishing.md#gate-recording-and-the-live-subset)). Tick the item when that test
  passes.
- **coordinated** — a `@live-coordinated` test checks it, but a person must change the app's state
  while it runs. See [Coordinated runs](#coordinated-runs). Tick the item when that test passes.
- **automated by @live-launcher** — a `@live-launcher` test checks it against a packaged build that
  the extension starts itself. `pnpm test:live:launcher` runs it. See
  [Launcher runs](#launcher-runs). Tick the item when that test passes.
- **gate** — no app takes part, so the gate's test against the fake server checks all of it.
- **manual** — a person checks it in VS Code. The reason is given.

"Phase B" is a packaged app build that the extension starts itself, with its launcher on. The
`@live-launcher` tests do Phase B through a wrapper that starts the build on its own user data
directory. The `@live` and `@live-coordinated` runs use a development build on its own user data
directory, so the extension never starts the app in them.

Record:

- app commit: \_\_\_\_
- app version: \_\_\_\_
- VS Code version: \_\_\_\_
- OS: \_\_\_\_

Windows and Linux are not verified. Say so in the release notes until someone runs this list there.

## Setup

A person prepares these. The live tests fail when one is missing.

- [ ] An offline profile on DynamoDB Local, with the seeded tables `orders` and `customers` and a
      large table. — manual (setup)
- [ ] OpenSearch with one seeded index. — manual (setup)
- [ ] More than one profile in the roster. — manual (setup)
- [ ] The Editor integration is on. — manual (setup)

## Connect and profiles

- [ ] With more than one profile and none selected, Run shows the server's `profile-required`
      sentence once. — automated by @live test "profile-required: an unbound Run shows the server
      sentence once"
- [ ] Select Profile connects with the chosen profile, and the status bar shows it. — automated by
      @live test "profile picker: choosing the profile connects with it"
- [ ] The explorer lists the profile's tables and indices. — automated by @live test "explorer:
      lists the profile's tables and indices"

## Launcher

- [ ] With no app running, opening an in-scope file starts the app with `--headless` once. The
      extension connects when the port file shows, no app window opens, and a run returns rows. —
      automated by @live-launcher test "cold spawn: with no app, a lazy connect starts it headless
      and a run returns rows"
- [ ] A second `--headless` launch while the app serves exits 0. The first app keeps serving, the
      session stays, and no window opens. — automated by @live-launcher test "nudge: a second
      headless launch exits 0 and the first app keeps serving". The test starts the second launch
      itself: no extension path launches while an app serves.

## Expected values

- [ ] A PartiQL `IN ('a')` offers a quick fix titled **Use brackets**. It leaves `IN ['a']`. —
      automated by @live test "quick fix: PartiQL IN ('a') offers Use brackets, which leaves IN
      ['a']"
- [ ] Completion after `FROM ` (invoked explicitly) lists the seeded tables. — automated by @live
      test "completion: invoked after FROM, it lists the seeded tables"
- [ ] A SQL `GROUP BY customerId` returns the columns `["customerid", "COUNT(*)"]`. — automated by
      @live test 'run: SQL GROUP BY customerId answers the columns ["customerid", "COUNT(*)"]'
- [ ] A `SELECT *` run shows rows in the results panel, in each dialect. — automated by @live tests
      "run: run.dynotable.sql shows its rows in the panel", "run: run.partiql shows its rows in the
      panel" and "run: run.opensearch shows its rows in the panel"
- [ ] A Run lens on the second statement runs the second statement. — automated by @live test "lens
      Run: the Run lens of the second statement runs the second statement"
- [ ] Pick Index writes the directive. — automated by @live test "Pick Index: writes the listed index
      into the directive"
- [ ] Validate against the index shows one message. — automated by @live test "validate: Validate
      against the index shows one message"
- [ ] Open in DynoTable with no app window on the profile shows the server's
      `profile-window-required` sentence once. — automated by @live test "refusal copy:
      profile-window-required shows the server sentence once"
- [ ] A SQL and a PartiQL run cancelled at once are refused and show no rows. — automated by @live
      tests "cancel: a cancel.dynotable.sql run cancelled at once is refused and shows no rows" and
      "cancel: a cancel.partiql run cancelled at once is refused and shows no rows"
- [ ] Every advertised capability answers in a buffer of each dialect: completion, diagnostics,
      quick fixes, code lens, hover, inlay hints, formatting, definition, highlight, rename. —
      automated by @live tests "capabilities: every advertised capability answers in a sql buffer",
      "capabilities: every advertised capability answers in a partiql buffer" and "capabilities:
      every advertised capability answers in a opensearch buffer". The list comes from the app's
      `initialize` answer. Where the protocol gives no answer for a dialect (PartiQL formatting;
      definition, highlight and rename outside SQL; OpenSearch lenses and inlay hints), the test
      checks only that the request does not fail.

## Failure paths

Each one shows its own sentence once, with Reconnect among its actions.

- [ ] DynoTable not installed: "not installed", with Download DynoTable and Set App Path. — gate:
      `no-app.test.ts`, `restored.test.ts` and `connect-core.test.ts` check the reason, and
      `no-app.test.ts` checks Download. No app takes part, so a live run adds nothing. The Set App
      Path label comes from `src/reasons.ts`; no test checks it.
- [ ] Editor integration off: the sentence names Settings → Editor integration. — automated by
      @live-launcher test "integration-off: the launched app exits 3; the Settings sentence shows
      once". Also coordinated by @live-coordinated test "integration-off: turning the Editor
      integration off ends the connection" (the session ends with "connection ended"; with the
      launcher off, Reconnect starts nothing).
- [ ] The app quit mid-session: "connection ended". Nothing starts the app again until Reconnect.
      — coordinated by @live-coordinated test "quit: the app quit ends the connection; nothing
      starts it until Reconnect"
- [ ] The app killed (a stale port file): "connection ended". After Reconnect, the extension starts
      the app again and connects. — automated by @live-launcher test "killed: after a SIGKILL,
      Reconnect starts a new app and a run works". Also coordinated by @live-coordinated test
      "killed: a killed app ends the connection and leaves a stale port file" (with the launcher
      off, Reconnect starts nothing).
- [ ] The app restarted (a new token): the extension connects again with no action. — coordinated
      by @live-coordinated test "restarted: after an app restart, the extension connects again by
      itself"
- [ ] Signed out: the signed-out sentence, with Open DynoTable. — manual, Phase B: a development
      build cannot sign out. On a licensed packaged build, sign out in DynoTable. Expect "connection
      ended" once. Run Reconnect. Expect the signed-out sentence with Open DynoTable. Sign in again.
      On a licensed packaged build that runs on its own user data directory, the @live-coordinated
      test "signed-out" can do this walk.
- [ ] An unbound roster with more than one profile: covered by the first two items under
      [Connect and profiles](#connect-and-profiles). — automated
- [ ] An app older than the minimum version: "update DynoTable", and no window opens (macOS,
      Windows). — automated by @live test "version gate: an app older than the minimum shows update
      DynoTable and opens nothing" (macOS; Windows is not verified)

## Teardown

- [ ] Reload the window during a run. The next run is not refused as `busy`. — automated by @live
      test "teardown: after the client goes away mid-run, the next run is not refused as busy". The
      test does not reload the window: it stops the extension's connection during a run on the
      large table, connects again and runs at once.
- [ ] Quit VS Code. The background app keeps running, and the next VS Code window uses it. —
      automated by @live-launcher tests "reuse 1: the extension starts the app, which outlives this
      VS Code" and "reuse 2: the next VS Code uses the app the last one started, with no spawn".
      They are one case over two VS Code launches.

## Coordinated runs

Each coordinated test waits up to 10 minutes for one step in DynoTable. Run one test at a time, with
the same environment as `pnpm test:live`:

```sh
DYNOTABLE_LIVE_USER_DATA_DIR=<dir> DYNOTABLE_LIVE_PROFILE=<name|slug> \
  DYNOTABLE_LIVE_LARGE_TABLE=<large table> pnpm test:live:coordinated <name>
```

Set `DYNOTABLE_MIN_APP_VERSION=<version>` too when the build is not released yet. Without it, an
unreleased development build is older than the minimum version, and each run latches "update
DynoTable".

It runs on the stable VS Code only, unless `DYNOTABLE_VSCODE_VERSIONS` is set. Before each run,
DynoTable runs on `<dir>` with the Editor integration on and the person signed in. The test connects
first. When the log shows `waiting for: <step>`, do that step. After the test ends, put DynoTable
back as it was before the run.

- **`integration-off`.** When the log shows `waiting for: turn the Editor integration off in
  DynoTable`, open DynoTable, go to Settings → Editor integration and turn it off. The test expects
  "connection ended" once, then Reconnect. After the run, turn the Editor integration on again.
- **`quit`.** When the log shows `waiting for: quit DynoTable`, quit DynoTable from its menu. The
  test expects "connection ended" once, and nothing for 5 s after it. After the run, start DynoTable
  again on `<dir>`.
- **`killed`.** When the log shows `waiting for: kill the DynoTable process (SIGKILL)`, stop the
  DynoTable process abruptly, for example with `kill -9 <pid>` or Force Quit. The test expects
  "connection ended" once, and a port file that stays. After the run, start DynoTable again on
  `<dir>`.
- **`restarted`.** When the log shows `waiting for: quit DynoTable and start it again`, quit
  DynoTable, then start it again on `<dir>`. Do not touch VS Code. The test expects a new
  connection with no Reconnect.
- **`signed-out`.** Only on a licensed packaged build that runs on `<dir>`: a development build
  cannot sign out. When the log shows `waiting for: sign out of DynoTable`, sign out in DynoTable.
  The test expects "connection ended", then Reconnect gives the signed-out sentence. After the run,
  sign in again.

## Launcher runs

`pnpm test:live:launcher` runs the `@live-launcher` tests against a packaged build, on macOS only.
The extension starts the app itself, with `dynotable.appPath` set to a wrapper and
`dynotable.userDataDir` not set. The spawn seam is real only for the wrapper with `--headless`.
Every other launch, Open DynoTable included, fails the test.

```sh
DYNOTABLE_TEST_DISPLAY=<display> DYNOTABLE_LIVE_APP_PATH=<wrapper> \
  DYNOTABLE_LIVE_USER_DATA_DIR=<dir> DYNOTABLE_LIVE_PROFILE=<name|slug> pnpm test:live:launcher
```

- **The wrapper** is an executable file. It must not be an app bundle, a file inside one, or a
  file under `/Applications`. It runs the build's binary on `<dir>` with its own arguments, through
  `exec`, so that the pid and the exit code pass through:

  ```sh
  #!/bin/sh
  exec <bundle>/Contents/MacOS/DynoTable --user-data-dir=<dir> --use-mock-keychain "$@"
  ```

- **`<dir>`** is the build's own user data directory, never the standard one. Before the run, no
  app runs on it, the Editor integration is on, the build is signed in, and the roster has more
  than one profile. `<name|slug>` names a profile on DynamoDB Local with the seeded `orders` table.
  Set `DYNOTABLE_LIVE_DENY_USER_DATA_DIR=<other dir>` to refuse a directory that another app
  uses, for example a development build that runs at the same time.
- Set `DYNOTABLE_MIN_APP_VERSION=<version>` when the build is not released yet.
- It runs at the `engines` floor and on stable, unless `DYNOTABLE_VSCODE_VERSIONS` is set. The
  app has no window, so if an app window shows, a test fails.
- The tests quit, kill and start apps on `<dir>` only: a process whose command line holds
  `--user-data-dir=<dir>`. The integration-off test sets `enabled` to `false` in
  `<dir>/lsp-config.json` while no app runs, and sets it back after the test.
- The `live-launcher-reuse-1` and `-2` files are one case over two VS Code launches. The runner
  runs them in that order. Do not run `-2` alone.
- **Cleanup.** At the end, the runner stops every app on `<dir>`. Then make sure that
  `pgrep -fl -- '--user-data-dir=<dir>'` shows nothing and that `<dir>/lsp-config.json` holds
  `"enabled": true`. After a run that was stopped by force, set them back by hand.

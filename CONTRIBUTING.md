# Contributing

## Prerequisites

- Node.js 26 or later, and pnpm 12.
- Docker, for the integration tests.
- Bun 1.4.4, to compile `dynotable-cli`. The CLI uses Node.js APIs only; Bun is only its compiler.

## Build and test

```sh
pnpm install
pnpm build              # dist/extension.js and the results webview script
pnpm test               # unit tests (vitest)
pnpm test:integration   # integration tests in a Linux container under Xvfb
pnpm cli:build          # dynotable-cli for this computer, in cli/dist/<os>-<arch>/
pnpm cli:binary         # the compiled-binary tests, against the fake language server
pnpm cli:build:all      # the release build: all targets, platform packages and archives
pnpm gate               # typecheck, lint, unit, integration, cli:build, cli:binary and package
```

`pnpm test:integration` opens no window on your displays. It runs each test file in its own VS
Code launch, at the `engines` floor and on stable. `pnpm test:integration:host` runs the same
tests on the host and opens VS Code windows. Use it on Linux CI under `xvfb-run`. On macOS, set
`DYNOTABLE_TEST_DISPLAY=<display name>` to keep the windows on one display.

`pnpm cli:build` and `pnpm cli:build:all` need Bun 1.4.4 exactly. The build stamps the version of
`cli/npm/dynotable-cli/package.json` into the binary, and fails on an import that does not resolve.
`--min-app-version <x.y.z>` sets the app version floor of a dev build, to test against a dev app. A
release build (`--all`) refuses a floor lower than `CLI_MIN_APP_VERSION` in `cli/src/version.ts`.
There is no runtime override.

`pnpm cli:binary` runs `cli/test-binary/` on the host binary. It covers what only the real process
shows: exit codes, signals, and the name that the binary was started under (`dynotable-cli` or
`dynotable-lsp`).

## Layout

- `src/`: the extension. A module with no `vscode` import has unit tests next to it.
  - `src/node-seams.ts`: the Node.js file system, TCP connect and port file watch. The extension
    and the CLI share them.
  - `src/rpc.ts`: the JSON-RPC peer and the one frame parser. The CLI session and the
    `dynotable-cli lsp` bridge use it.
- `src/test-integration/`: the integration harness and a fake language server. The fake answers
  from the fixtures in `contract/`.
- `contract/`: the protocol fixtures. `contract/manifest.json` gives each one's provenance.
- `cli/`: the `dynotable-cli` command line tool. It shares the connection code and the protocol
  guards in `src/`, and it imports no `vscode` module.
  - `cli/src/`: the arguments, the session, and the subcommands and the stdio bridge
    (`commands/`). `cli/src/main.ts` binds the real process. The subcommands get it through
    `cli/src/io.ts` and do not touch `process`.
  - `cli/scripts/build.mjs`: the Bun build.
  - `cli/test-binary/`: the compiled-binary tests (`pnpm cli:binary`).
  - `cli/npm/`: the npm wrapper `dynotable-cli` (bins `dynotable-cli` and `dynotable-lsp`) and the
    template of the `@dynotable/cli-<os>-<arch>` platform packages.
- `claude-plugin/`: the Claude Code plugin: the `dynotable` skill and the `.lsp.json` language
  server entry. `claude-plugin/plugin.test.ts` keeps the entry in line with the CLI.
- `.claude-plugin/marketplace.json`: the Claude Code marketplace that lists the plugin.
- `scripts/`: the fixture recorder (`pnpm contract:record`, `pnpm contract:check`). See
  [docs/publishing.md](docs/publishing.md).

A test whose title starts with `@live` runs only against the real app (`pnpm test:live`). A file
that holds `@live` tests holds no test against the fake.

## Rules

- This repository is public. Write only what the wire protocol ([PROTOCOL.md](PROTOCOL.md)) and
  this extension show. Do not name the app's modules, files or internals, in code, fixtures, docs or
  commit messages.
- Read the diff of a recorded fixture before you commit it.
- Write docs in ASD-STE100 Simplified Technical English.

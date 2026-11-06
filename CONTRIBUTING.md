# Contributing

## Prerequisites

- Node.js 26 or later, and pnpm 12.
- Docker, for the integration tests.

## Build and test

```sh
pnpm install
pnpm build              # dist/extension.js and the results webview script
pnpm test               # unit tests (vitest)
pnpm test:integration   # integration tests in a Linux container under Xvfb
pnpm gate               # typecheck, lint, unit, integration and package
```

`pnpm test:integration` opens no window on your displays. It runs each test file in its own VS
Code launch, at the `engines` floor and on stable. `pnpm test:integration:host` runs the same
tests on the host and opens VS Code windows. Use it on Linux CI under `xvfb-run`. On macOS, set
`DYNOTABLE_TEST_DISPLAY=<display name>` to keep the windows on one display.

## Layout

- `src/`: the extension. A module with no `vscode` import has unit tests next to it.
- `src/test-integration/`: the integration harness and a fake language server. The fake answers
  from the fixtures in `contract/`.
- `contract/`: the protocol fixtures. `contract/manifest.json` gives each one's provenance.
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

@CONTRIBUTING.md

## Agent rules

- The DynoTable app is private. Use only `PROTOCOL.md` for its behaviour. Copy nothing from the
  app's code or docs into this repository, its fixtures or its commit messages.
- Run `pnpm gate` to validate. Do not run `pnpm test:integration:host` on macOS without
  `DYNOTABLE_TEST_DISPLAY`: it opens VS Code windows.
- Test seams (`DYNOTABLE_TEST_*`) apply only in `ExtensionMode.Test`.
- The integration tests run on the Node.js of VS Code 1.91 (20.9). Keep mocha 11: mocha 12 is
  ESM-only and needs Node.js 20.19.
- Keep `vscode-languageclient` at an exact version, with one `vscode-jsonrpc` in the tree. The
  client tells errors apart with `instanceof ResponseError`.

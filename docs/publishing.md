# Publishing

## Hard prerequisite: the app release ships first

Do not publish before the DynoTable release that serves the full Editor integration is out. That
release is the minimum app version.

- `MIN_APP_VERSION` in `src/discovery.ts` is that version, written `X.Y.Z`. It is `1.19.0`.
  Change it if the release has a different version.
- The README and `CHANGELOG.md` state the same version.
- [dynotable.com/docs/editors](https://dynotable.com/docs/editors) is live. The README, the
  **Open Documentation** command and the **Open Documentation** action on a DynoTable message link
  to it.

## Gate: recording and the live subset

Run these against a local app build of that release. Each step must pass.

Preconditions:

- the app runs with its own user data directory, not the default one, and the Editor integration
  is on;
- an offline profile on DynamoDB Local with the tables `orders` (with `customerId`, `orderId` and
  `status`) and `customers`, a table large enough that a run is still in flight when its cancel
  arrives, and a table whose items hold string, number and binary Sets, also inside a map;
- OpenSearch with one seeded index;
- more than one profile in the roster, and no app window open on the profile under test;
- a profile that is not available to agents. It can be the profile under test;
- an active or trial licence.

Steps:

1. Record the fixtures. Commit the scrubbed result. The scrub replaces roster names, slugs, ids and
   hosts. It keeps table names, index names and regions as they are, so read the diff before you
   commit it.

   ```sh
   pnpm contract:record --user-data-dir <dir> --profile <id|slug> --table <table> \
     --large-table <large table> --set-table <table with Sets> --index <index> \
     --sql '<a SELECT that names its columns>' \
     --projection-sql '<a SELECT that names Set columns of the Set table>' \
     --key-sql '<a SELECT * whose WHERE sets the partition key of the table>' \
     --hidden-profile <id|slug of the profile that is not available to agents>
   ```

2. Run `pnpm gate` on the new fixtures.
3. Run `pnpm contract:check` with the same options. It must report no drift.
4. Run the live subset:

   ```sh
   DYNOTABLE_LIVE_USER_DATA_DIR=<dir> DYNOTABLE_LIVE_PROFILE=<name|slug> \
     DYNOTABLE_LIVE_LARGE_TABLE=<large table> pnpm test:live
   ```

   Set `DYNOTABLE_MIN_APP_VERSION=<version>` too when the build is not released yet. On macOS, set
   `DYNOTABLE_TEST_DISPLAY=<display name>` to keep the test windows on one display.

5. Walk [the manual checklist](manual-e2e.md) and record the app commit.

## Accounts

- **Visual Studio Marketplace:** the publisher `dynotable`, managed at
  [marketplace.visualstudio.com/manage](https://marketplace.visualstudio.com/manage). Publish with
  an Azure DevOps personal access token with the **Marketplace (Manage)** scope.
- **Open VSX:** the namespace `dynotable`, owned by an Eclipse account that signed the Open VSX
  publisher agreement. Publish with an Open VSX access token. Open VSX also serves VSCodium, Cursor,
  Windsurf and Gitpod.

Keep both tokens in the environment (`VSCE_PAT`, `OVSX_PAT`). Do not write them into a file in this
repo.

## Steps

1. Set `version` in `package.json` and move the `CHANGELOG.md` entry out of "unreleased".
2. Run `pnpm gate`. It ends with `pnpm package`, which writes `vscode-dynotable-<version>.vsix`.
   The gate needs Docker: it runs the integration tests in a Linux container under a virtual
   display, so no VS Code window opens. Without Docker, it stops with an error.
3. Publish the same file to both registries:

   ```sh
   pnpm exec vsce publish --packagePath vscode-dynotable-<version>.vsix
   pnpm dlx ovsx publish vscode-dynotable-<version>.vsix
   ```

   The first Open VSX publish needs `pnpm dlx ovsx create-namespace dynotable` before it.

4. Tag the commit `v<version>`.

## Before the first publish

- Make sure no commit from before the history squash is still reachable on GitHub. Ask GitHub
  Support to purge unreachable commits, or publish from a new repository.
- Check Windows and Linux on real machines before the listing claims them.

---
name: dynotable
description: Read DynamoDB and OpenSearch data and schemas through the user's DynoTable profiles with the dynotable-cli command. Use when the task needs table rows, index documents, table or index names, or a query result from DynamoDB or OpenSearch.
---

# DynoTable

`dynotable-cli` reads DynamoDB and OpenSearch through the DynoTable desktop app. It only reads. Its
output is JSON.

## First step

Run `dynotable-cli --version`.

If the command is not found, tell the user to install the CLI:

- `npm install -g dynotable-cli`, or
- download the binary from https://github.com/dynotable/vscode-dynotable/releases and put it on
  the PATH.

The DynoTable app must be installed, and **Settings → Editor integration** must be on.

## Profiles

`dynotable-cli profiles` lists only the profiles that the user made available to agents.

- When `.dynotable.json` is in the current directory, the CLI uses its profile. Do not give
  `--profile`.
- Else, when the list has one profile, the CLI uses it.
- Else, show the list to the user and ask which profile to use. Then give `--profile <id or slug>`
  to each command.

## Commands

| Command                                                             | Output                                   |
| ------------------------------------------------------------------- | ---------------------------------------- |
| `dynotable-cli tables [--profile <p>]`                              | The DynamoDB tables of the profile.      |
| `dynotable-cli indices [--profile <p>]`                             | The OpenSearch indices of the profile.   |
| `dynotable-cli run <file> [--profile <p>] [--row-cap <n>]`          | The result of the statement in the file. |
| `dynotable-cli run - --lang <lang> [--profile <p>] [--row-cap <n>]` | The result of the statement on stdin.    |
| `dynotable-cli run -e '<statement>' --lang <lang> [--profile <p>]`  | The result of the statement in the text. |

- `<lang>` is `sql`, `partiql` or `opensearch`.
- A file must end in `.dtsql`, `.dynotable.sql`, `.partiql` or `.opensearch`. The name gives the
  language. Do not give `--lang` with a file.
- Give one statement per input.
- `--row-cap` sets the most rows to return. The default is 500, and the maximum is 1000.
- An `opensearch` query names its index on the first line: `// dynotable: index=<name>`.

Examples:

```sh
dynotable-cli run -e "SELECT * FROM \"orders\" WHERE customerId = 'C1'" --lang partiql
printf '// dynotable: index=orders\n{"query": {"match": {"status": "shipped"}}}' | dynotable-cli run - --lang opensearch
```

## Output

- Success: exit code `0`. Stdout holds one JSON document.
- Failure: exit code `1`. Stderr holds `{"code": "...", "message": "..."}`.
- Usage error: exit code `2`. Read `dynotable-cli --help`.
- In a `run` result, `truncated: true` means more rows exist. `totalRows: null` means the total is
  not known. Do not report `returnedRows` as the total.
- `listing-failed` means the listing is not complete. Stdout still holds the rows that DynoTable
  could read.

## What to tell the user

| `code`                            | Tell the user                                               |
| --------------------------------- | ----------------------------------------------------------- |
| `profile-not-exposed`             | Make the profile available to agents in DynoTable.          |
| `profile-required`                | Choose a profile from `dynotable-cli profiles`.             |
| `stage-in-app`                    | The CLI only reads. Make writes in DynoTable.               |
| `reauth-required`, `signed-out`   | Open DynoTable and sign in.                                 |
| `launcher-off`, `integration-off` | Start DynoTable, or turn on Settings → Editor integration.  |
| `agent-refused`                   | This action is not available to agents. Do it in DynoTable. |
| any other code                    | Show the `message`.                                         |

## Rules

- Use the subcommands only. Never write Language Server frames into `dynotable-cli lsp`.
- Each `tables`, `indices` and `run` request appears in the audit log of the profile in DynoTable.
  `profiles` does not.

## Known limitation

The plugin's language server stops when DynoTable quits, and Claude Code restarts it at most twice
in a session. When diagnostics stop after DynoTable was closed for a while, tell the user to start
a new Claude Code session. This is not verified yet.

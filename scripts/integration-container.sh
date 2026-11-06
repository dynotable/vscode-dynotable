#!/bin/sh
# Runs the built integration suite in a Linux container under Xvfb, so no VS Code window opens on
# the host's displays. The host builds; the container runs only out/ and VS Code. Arguments are
# file-name filters, as for run.js.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
image=vscode-dynotable-integration
if ! docker info >/dev/null 2>&1; then
  echo 'Docker is not reachable. Start it, or run pnpm test:integration:host (opens VS Code windows).' >&2
  exit 1
fi
docker build -q -t "$image" - <"$root/scripts/integration.Dockerfile" >/dev/null
# Linux VS Code builds go to their own cache, mounted over .vscode-test, the host's cache.
mkdir -p "$root/.vscode-test" "$root/.vscode-test-linux"
exec docker run --rm --init --shm-size=1g --user node \
  -v "$root:/work:ro" -v "$root/.vscode-test-linux:/work/.vscode-test" -w /work \
  ${DYNOTABLE_VSCODE_VERSIONS:+-e DYNOTABLE_VSCODE_VERSIONS} \
  "$image" xvfb-run -a node out/src/test-integration/run.js "$@"

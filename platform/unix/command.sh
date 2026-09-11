#!/bin/sh
# Stable Linux CLI entrypoint. The active version is resolved at invocation time so
# lifecycle managers and user commands never bind to a retired version directory.
set -eu

SELF=$(readlink -f "$0")
ROOT=$(CDPATH= cd -- "$(dirname -- "$SELF")/.." && pwd)
ACTIVE="$ROOT/active-path"

[ -f "$ACTIVE" ] || { echo 'No verified Team DevSpace version is active. Re-run the offline installer.' >&2; exit 1; }
APP=$(sed -n '1p' "$ACTIVE")
case "$APP" in "$ROOT/versions"/*) ;; *) echo 'Invalid active version pointer.' >&2; exit 1 ;; esac
[ -x "$APP/runtime/bin/node" ] && [ -f "$APP/client/cli.mjs" ] || {
  echo 'The active Team DevSpace installation is incomplete. Re-run the offline installer to repair it.' >&2
  exit 1
}

export TEAM_DEVSPACE_DISTRIBUTION_ROOT="$ROOT"
if [ -z "${TEAM_DEVSPACE_HOME:-}" ] && [ -f "$ROOT/state-home" ]; then
  TEAM_DEVSPACE_HOME=$(sed -n '1p' "$ROOT/state-home")
  case "$TEAM_DEVSPACE_HOME" in /*) ;; *) echo 'Invalid retained state path.' >&2; exit 1 ;; esac
  export TEAM_DEVSPACE_HOME
fi
exec "$APP/runtime/bin/node" "$APP/client/cli.mjs" "$@"

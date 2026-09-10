#!/bin/sh
# Stable Linux CLI entrypoint. The active version is resolved at invocation time so
# systemd and user commands never bind to a retired version directory.
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
exec "$APP/runtime/bin/node" "$APP/client/cli.mjs" "$@"

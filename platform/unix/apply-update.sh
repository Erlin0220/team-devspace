#!/bin/sh
set -eu
PACKAGE=$1
ROOT=$2
STATE_HOME=$3
STAGE=$4
VERSION=$5
RESULT=$6
ATTEMPT_ID=${7:-}
case "$ATTEMPT_ID" in *[!a-f0-9-]*) echo 'Invalid update attempt' >&2; exit 2 ;; esac
export TEAM_DEVSPACE_HOME="$STATE_HOME" TEAM_DEVSPACE_DISTRIBUTION_ROOT="$ROOT"
unset NODE_OPTIONS
finish() {
  code=$?
  printf '{"version":"%s","attemptId":"%s","exitCode":%s}\n' "$VERSION" "$ATTEMPT_ID" "$code" > "$RESULT.tmp"
  mv "$RESULT.tmp" "$RESULT"
  rm -rf -- "$STAGE"
  exit "$code"
}
trap finish EXIT
mkdir "$STAGE"
tar -xzf "$PACKAGE" -C "$STAGE"
# Existing bootstrap owns activation, retained Enrollment, startup and rollback.
sh "$STAGE/install.sh" --offline "$STAGE" --root "$ROOT" --setup none

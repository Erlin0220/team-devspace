#!/bin/sh
set -eu
RESOURCES="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd)"
HOME_ROOT="$HOME/Library/Application Support/TeamDevSpace"
ROOT="$HOME_ROOT/distribution"
LOG_DIR="$HOME_ROOT/logs"
LOG="$LOG_DIR/setup.log"
APP_STARTED="$HOME_ROOT/.app-started"
/bin/mkdir -p "$LOG_DIR"
/bin/chmod 700 "$HOME_ROOT" "$LOG_DIR" 2>/dev/null || true
/usr/bin/printf '%s\n' "$(/bin/date -u '+%Y-%m-%dT%H:%M:%SZ')" > "$APP_STARTED"
/bin/chmod 600 "$APP_STARTED" 2>/dev/null || true
: > "$LOG"
/bin/chmod 600 "$LOG" 2>/dev/null || true
# Setup progress, validation errors and cancellation belong to the AppKit form.
# The marker only confirms entry into this wrapper, not successful enrollment.
if ! "$RESOURCES/bootstrap.sh" --root "$ROOT" --manifest "$RESOURCES/release-manifest.json" --setup gui >> "$LOG" 2>&1; then
  /usr/bin/osascript -e 'display alert "Team DevSpace 启动失败" message "本地程序启动失败。请重新打开 Team DevSpace；如果仍然失败，请查看 ~/Library/Application Support/TeamDevSpace/logs/setup.log。" as critical' >/dev/null 2>&1 || true
  exit 1
fi
# No success/cancellation notifications. The form and menu bar are authoritative.

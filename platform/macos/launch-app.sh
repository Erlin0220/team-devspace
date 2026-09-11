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
ACTIVE="$ROOT/active-path"
TRAY_LABEL="com.teamdevspace.tray"
TRAY_PLIST="$HOME/Library/LaunchAgents/$TRAY_LABEL.plist"
current=''
if [ -f "$ACTIVE" ]; then
  current=$(/usr/bin/sed -n '1p' "$ACTIVE")
  case "$current" in "$ROOT"/versions/*) ;; *) current='' ;; esac
fi
# Reuse the existing launchd-owned tray before any package/bootstrap work. This
# keeps the visible UI responsive without introducing a second controller or
# another lifecycle owner. Upgrade work may continue after the current tray is visible.
if [ -n "$current" ] && [ -f "$TRAY_PLIST" ]; then
  domain="gui/$(/usr/bin/id -u)"
  if ! /bin/launchctl print "$domain/$TRAY_LABEL" >/dev/null 2>&1; then
    /bin/launchctl bootstrap "$domain" "$TRAY_PLIST" >/dev/null 2>&1 || true
  fi
  /bin/launchctl kickstart "$domain/$TRAY_LABEL" >/dev/null 2>&1 || true
fi
# Opening the same installed release should not unpack and verify the offline
# payload again. Refresh its existing current-user startup entries instead; a
# missing/partial local install falls through to the transactional bootstrap.
if [ -n "$current" ] && [ -f "$current/install-manifest.json" ] &&
   /usr/bin/cmp -s "$current/install-manifest.json" "$RESOURCES/release-manifest.json" &&
   [ -x "$current/runtime/bin/node" ] && [ -f "$current/client/cli.mjs" ]; then
  if "$current/runtime/bin/node" "$current/client/cli.mjs" startup install --runtime-root "$current" >> "$LOG" 2>&1; then
    exit 0
  fi
  /usr/bin/printf '%s\n' 'Existing release fast start failed; falling back to bootstrap.' >> "$LOG"
fi
# Setup progress, validation errors and cancellation belong to the AppKit form.
# The marker only confirms entry into this wrapper, not successful enrollment.
if ! "$RESOURCES/bootstrap.sh" --root "$ROOT" --manifest "$RESOURCES/release-manifest.json" --setup gui >> "$LOG" 2>&1; then
  /usr/bin/osascript -e 'display alert "Team DevSpace 启动失败" message "本地程序启动失败。请重新打开 Team DevSpace；如果仍然失败，请查看 ~/Library/Application Support/TeamDevSpace/logs/setup.log。" as critical' >/dev/null 2>&1 || true
  exit 1
fi
# No success/cancellation notifications. The form and menu bar are authoritative.

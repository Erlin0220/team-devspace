#!/bin/sh
set -eu
RESOURCES="$(CDPATH= cd -- "$(dirname -- "$0")/../Resources" && pwd)"
HOME_ROOT="$HOME/Library/Application Support/TeamDevSpace"
ROOT="$HOME_ROOT/distribution"
LOG_DIR="$HOME_ROOT/logs"
LOG="$LOG_DIR/setup.log"
UI_READY="$HOME_ROOT/.ui-ready"
LAUNCH_LOCK="$HOME_ROOT/app-launch.lock"
/bin/mkdir -p "$HOME_ROOT"
/bin/chmod 700 "$HOME_ROOT"
/bin/mkdir -p "$LOG_DIR" 2>/dev/null || true
/bin/chmod 700 "$LOG_DIR" 2>/dev/null || true
acquire_launch_lock() {
  if /bin/mkdir "$LAUNCH_LOCK" 2>/dev/null; then /usr/bin/printf '%s\n' "$$" > "$LAUNCH_LOCK/pid"; return 0; fi
  owner=$(/usr/bin/sed -n '1p' "$LAUNCH_LOCK/pid" 2>/dev/null || true)
  # A missing PID may be a concurrent owner still publishing it. Never steal it.
  case "$owner" in ''|*[!0-9]*) return 1 ;; esac
  if /bin/kill -0 "$owner" 2>/dev/null || /bin/ps -p "$owner" >/dev/null 2>&1; then return 1; fi
  # Serialize stale-lock reclamation; never recursively remove another launcher's lock.
  /bin/mkdir "$LAUNCH_LOCK/reclaim" 2>/dev/null || return 1
  if [ "$(/usr/bin/sed -n '1p' "$LAUNCH_LOCK/pid" 2>/dev/null || true)" != "$owner" ]; then
    /bin/rmdir "$LAUNCH_LOCK/reclaim" 2>/dev/null || true
    return 1
  fi
  /bin/rm -f "$LAUNCH_LOCK/pid"
  /bin/rmdir "$LAUNCH_LOCK/reclaim" "$LAUNCH_LOCK" 2>/dev/null || return 1
  if /bin/mkdir "$LAUNCH_LOCK" 2>/dev/null; then /usr/bin/printf '%s\n' "$$" > "$LAUNCH_LOCK/pid"; return 0; fi
  return 1
}
if ! acquire_launch_lock; then exit 0; fi
cleanup_launch() {
  if [ "$(/usr/bin/sed -n '1p' "$LAUNCH_LOCK/pid" 2>/dev/null || true)" = "$$" ]; then
    /bin/rm -f "$LAUNCH_LOCK/pid"
    /bin/rmdir "$LAUNCH_LOCK" 2>/dev/null || true
  fi
}
trap cleanup_launch EXIT
trap 'exit 1' HUP INT TERM
# Open the optional sink once; later redirection failures must not rerun setup.
open_setup_log() { exec 3>&1; }
open_setup_log > "$LOG" 2>/dev/null || open_setup_log > /dev/null
/bin/chmod 600 "$LOG" 2>/dev/null || true
/bin/rm -f "$UI_READY" 2>/dev/null || true
export TEAM_DEVSPACE_UI_READY_MARKER="$UI_READY"
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
# payload again or stop healthy services to recreate startup entries. The
# visible tray re-confirms its marker on its normal status refresh. A missing
# startup entry or partial local install falls through to the transactional bootstrap.
if [ -n "$current" ] && [ -f "$current/install-manifest.json" ] &&
   /usr/bin/cmp -s "$current/install-manifest.json" "$RESOURCES/release-manifest.json" &&
   [ -x "$current/runtime/bin/node" ] && [ -f "$current/client/cli.mjs" ]; then
  if [ ! -f "$HOME_ROOT/state.json" ]; then
    # Cancelling first-run setup leaves a valid payload, but no enrolled device.
    # Reopen the form rather than calling startup install/stop on missing state.
    if "$current/runtime/bin/node" "$current/client/cli.mjs" setup-gui >&3 2>&1; then exit 0; fi
  elif "$current/runtime/bin/node" "$current/client/cli.mjs" start >&3 2>&1; then
    exit 0
  fi
  /usr/bin/printf '%s\n' 'Existing release fast start failed; falling back to bootstrap.' >&3
fi
# Setup progress, validation errors and cancellation belong to the AppKit form.
# Only the native form/menu writes the visibility marker; wrapper entry is not readiness.
if ! "$RESOURCES/bootstrap.sh" --root "$ROOT" --manifest "$RESOURCES/release-manifest.json" --setup gui >&3 2>&1; then
  /usr/bin/osascript -e 'display alert "Team DevSpace 启动失败" message "本地程序启动失败。请重新打开 Team DevSpace；如果仍然失败，请查看 ~/Library/Application Support/TeamDevSpace/logs/setup.log。" as critical' >/dev/null 2>&1 || true
  exit 1
fi
# No success/cancellation notifications. The form and menu bar are authoritative.

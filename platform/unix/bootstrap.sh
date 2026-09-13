#!/bin/sh
set -eu

MODE=install
if [ "$(uname -s)" = Darwin ]; then DEFAULT_ROOT="$HOME/Library/Application Support/TeamDevSpace/distribution"
else DEFAULT_ROOT="${XDG_STATE_HOME:-$HOME/.local/state}/team-devspace/distribution"; fi
ROOT="${TEAM_DEVSPACE_DISTRIBUTION_ROOT:-$DEFAULT_ROOT}"
MANIFEST="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/release-manifest.json"
OFFLINE_ROOT=""
SETUP=none
REQUEST_FILE=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode) MODE=$2; shift 2 ;;
    --root) ROOT=$2; shift 2 ;;
    --manifest) MANIFEST=$2; shift 2 ;;
    --offline) OFFLINE_ROOT=$2; shift 2 ;;
    --setup) SETUP=$2; shift 2 ;;
    --request-file) REQUEST_FILE=$2; shift 2 ;;
    *) echo "Unknown bootstrap option: $1" >&2; exit 2 ;;
  esac
done

SYSTEM_NAME=$(uname -s)
KERNEL_ARCH=$(uname -m)
MACHINE_ARCH=$KERNEL_ARCH
# A shell launched from an app bundle can run translated under Rosetta and report
# x86_64 even on Apple Silicon. Release compatibility follows the machine, not the
# current shell process, so use the hardware capability bit when macOS provides it.
if [ "$SYSTEM_NAME" = Darwin ] && [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then
  MACHINE_ARCH=arm64
fi
case "$SYSTEM_NAME-$MACHINE_ARCH" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
  *) echo "Unsupported operating system or architecture: $SYSTEM_NAME-$MACHINE_ARCH." >&2; exit 2 ;;
esac

case "$TARGET" in
  darwin-*) STATE_HOME="${TEAM_DEVSPACE_HOME:-$HOME/Library/Application Support/TeamDevSpace}" ;;
  linux-*)
    [ "$(id -u)" -ne 0 ] || { echo 'Install Team DevSpace as the employee user, not root or sudo.' >&2; exit 2; }
    case "$ROOT" in /*) ;; *) echo 'Linux distribution root must be an absolute path.' >&2; exit 2 ;; esac
    glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)
    [ -n "$glibc" ] && awk -v v="$glibc" 'BEGIN { split(v,p,"."); exit ! (p[1] > 2 || (p[1] == 2 && p[2] >= 34)) }' || {
      echo 'Team DevSpace Linux x64 requires glibc 2.34 or newer.' >&2; exit 2;
    }
    export TEAM_DEVSPACE_DISTRIBUTION_ROOT="$ROOT"
    retained_home=''
    if [ -f "$ROOT/state-home" ]; then retained_home=$(sed -n '1p' "$ROOT/state-home"); fi
    if [ -n "$retained_home" ] && [ -n "${TEAM_DEVSPACE_HOME:-}" ] && [ "$retained_home" != "$TEAM_DEVSPACE_HOME" ]; then
      echo 'This distribution already owns a different state directory; refusing to replace its Enrollment.' >&2; exit 2
    fi
    STATE_HOME="${TEAM_DEVSPACE_HOME:-${retained_home:-${XDG_STATE_HOME:-$HOME/.local/state}/team-devspace}}"
    case "$STATE_HOME" in /*) ;; *) echo 'Linux state home must be an absolute path.' >&2; exit 2 ;; esac
    case "$STATE_HOME" in "$ROOT"|"$ROOT"/*) echo 'Keep device state outside the replaceable distribution directory.' >&2; exit 2 ;; esac
    export TEAM_DEVSPACE_HOME="$STATE_HOME"
    retained_cli=''
    if [ -f "$ROOT/cli-directory" ]; then retained_cli=$(sed -n '1p' "$ROOT/cli-directory"); fi
    if [ -n "$retained_cli" ] && [ -n "${TEAM_DEVSPACE_CLI_DIR:-}" ] && [ "$retained_cli" != "$TEAM_DEVSPACE_CLI_DIR" ]; then
      echo 'This distribution already owns a different command directory; refusing to leave a stale CLI link.' >&2; exit 2
    fi
    CLI_DIR="${TEAM_DEVSPACE_CLI_DIR:-${retained_cli:-$HOME/.local/bin}}"
    case "$CLI_DIR" in /*) ;; *) echo 'Linux command directory must be an absolute path.' >&2; exit 2 ;; esac
    CLI_LINK="$CLI_DIR/team-devspace"
    STABLE_CLI="$ROOT/bin/team-devspace"
    ;;
esac

VERSIONS="$ROOT/versions"
STAGING="$ROOT/staging"
CACHE="$ROOT/cache/sha256"
ACTIVE="$ROOT/active-path"
OWNER_MARKER="$ROOT/.team-devspace-distribution"
OWNER_VALUE='team-devspace-distribution-v1'
LOCK="$ROOT/install.lock"

legacy_owned_root() {
  [ -f "$ACTIVE" ] && [ -d "$VERSIONS" ] || return 1
  value=$(sed -n '1p' "$ACTIVE" 2>/dev/null || true)
  case "$value" in "$VERSIONS"/*) return 0 ;; *) return 1 ;; esac
}
owned_root() {
  [ -f "$OWNER_MARKER" ] && [ "$(sed -n '1p' "$OWNER_MARKER" 2>/dev/null || true)" = "$OWNER_VALUE" ] && return 0
  legacy_owned_root
}
assert_distribution_root() {
  [ ! -L "$ROOT" ] || { echo "Distribution root must not be a symlink: $ROOT" >&2; exit 2; }
  [ ! -e "$ROOT" ] || [ -d "$ROOT" ] || { echo "Distribution root is not a directory: $ROOT" >&2; exit 2; }
  if [ -d "$ROOT" ] && ! owned_root && [ -n "$(ls -A "$ROOT" 2>/dev/null)" ]; then
    echo "Refusing to install into a non-empty directory not owned by Team DevSpace: $ROOT" >&2
    exit 2
  fi
  mkdir -p "$ROOT"
  marker_tmp="$OWNER_MARKER.$$.tmp"
  printf '%s\n' "$OWNER_VALUE" > "$marker_tmp"
  chmod 600 "$marker_tmp"
  mv "$marker_tmp" "$OWNER_MARKER"
}

if [ "$MODE" = uninstall ]; then
  [ -e "$ROOT" ] || exit 0
  [ ! -L "$ROOT" ] || { echo "Refusing to uninstall through a symlinked distribution root: $ROOT" >&2; exit 2; }
  owned_root || { echo "Refusing to uninstall an unowned distribution directory: $ROOT" >&2; exit 2; }
else
  assert_distribution_root
  mkdir -p "$VERSIONS" "$STAGING" "$CACHE"
fi

# POSIX mkdir is atomic on both macOS and Linux. A killed installer can leave a
# lock directory behind; reclaim it only when it contains a numeric PID that no
# longer exists. Missing/invalid ownership metadata remains fail-closed.
acquire_install_lock() {
  if mkdir "$LOCK" 2>/dev/null; then printf '%s\n' "$$" > "$LOCK/pid"; return 0; fi
  owner_pid=$(sed -n '1p' "$LOCK/pid" 2>/dev/null || true)
  case "$owner_pid" in
    ''|*[!0-9]*)
      echo "Another installer may be active. Lock has a missing or invalid owner PID: $LOCK" >&2
      return 1
      ;;
  esac
  if kill -0 "$owner_pid" 2>/dev/null || ps -p "$owner_pid" >/dev/null 2>&1; then
    echo "Another installer is active. Lock: $LOCK (owner PID: $owner_pid)." >&2
    return 1
  fi
  # Another stale reader may already have replaced this lock. Serialize reclaim
  # and recheck ownership before removing anything; never recursively erase it.
  mkdir "$LOCK/reclaim" 2>/dev/null || return 1
  if [ "$(sed -n '1p' "$LOCK/pid" 2>/dev/null || true)" != "$owner_pid" ]; then
    rmdir "$LOCK/reclaim" 2>/dev/null || true
    return 1
  fi
  echo "Reclaiming stale installer lock from exited PID $owner_pid." >&2
  retired_lock="$LOCK.reclaimed.$$"
  if [ -e "$retired_lock" ] || ! mv "$LOCK" "$retired_lock"; then
    rmdir "$LOCK/reclaim" 2>/dev/null || true
    return 1
  fi
  rm -rf "$retired_lock"
  if mkdir "$LOCK" 2>/dev/null; then printf '%s\n' "$$" > "$LOCK/pid"; return 0; fi
  echo "Another installer acquired the lock while stale-lock recovery was in progress: $LOCK" >&2
  return 1
}
acquire_install_lock || exit 1
components_file=''
stage=''
partial=''
remove_root_on_exit=0
cleanup() {
  [ -z "$components_file" ] || rm -f "$components_file"
  [ -z "$partial" ] || rm -f "$partial"
  [ -z "$stage" ] || rm -rf "$stage"
  if [ "$(sed -n '1p' "$LOCK/pid" 2>/dev/null || true)" = "$$" ]; then
    rm -f "$LOCK/pid"
    rmdir "$LOCK" 2>/dev/null || true
  fi
  [ "$remove_root_on_exit" = 1 ] || return 0
  rmdir "$ROOT" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

active_path() {
  [ -f "$ACTIVE" ] || return 1
  value=$(sed -n '1p' "$ACTIVE")
  case "$value" in "$VERSIONS"/*) printf '%s\n' "$value" ;; *) return 1 ;; esac
}

invoke_client() {
  version=$1; shift
  "$version/runtime/bin/node" "$version/client/cli.mjs" "$@"
}

install_linux_cli() {
  case "$TARGET" in linux-*) ;;
    *) return 0 ;;
  esac
  mkdir -p "$ROOT/bin" "$CLI_DIR"
  # Deployment metadata, not another device state: the stable command must find
  # retained Enrollment in a new shell without installer-only environment vars.
  printf '%s\n' "$STATE_HOME" > "$ROOT/state-home.$$"
  chmod 600 "$ROOT/state-home.$$"
  mv "$ROOT/state-home.$$" "$ROOT/state-home"
  printf '%s\n' "$CLI_DIR" > "$ROOT/cli-directory.$$"
  chmod 600 "$ROOT/cli-directory.$$"
  mv "$ROOT/cli-directory.$$" "$ROOT/cli-directory"
  temporary_cli="$ROOT/bin/team-devspace.$$"
  cp "$candidate/platform/unix/command.sh" "$temporary_cli"
  chmod 755 "$temporary_cli"
  mv "$temporary_cli" "$STABLE_CLI"
  if [ -e "$CLI_LINK" ] || [ -L "$CLI_LINK" ]; then
    if [ ! -L "$CLI_LINK" ] || [ "$(readlink "$CLI_LINK" 2>/dev/null || true)" != "$STABLE_CLI" ]; then
      echo "Refusing to replace an existing non-Team-DevSpace command: $CLI_LINK" >&2
      return 1
    fi
    rm -f "$CLI_LINK"
  fi
  ln -s "$STABLE_CLI" "$CLI_LINK"
}

remove_linux_cli() {
  case "$TARGET" in linux-*) ;;
    *) return 0 ;;
  esac
  if [ -L "$CLI_LINK" ] && [ "$(readlink "$CLI_LINK" 2>/dev/null || true)" = "$STABLE_CLI" ]; then rm -f "$CLI_LINK"; fi
}

remove_native_startup_fallback() {
  case "$TARGET" in
    darwin-*)
      domain="gui/$(id -u)"
      directory="$HOME/Library/LaunchAgents"
      fallback_home="${TEAM_DEVSPACE_HOME:-$HOME/Library/Application Support/TeamDevSpace}"
      for component in runtime tunnel tray; do
        label="com.teamdevspace.$component"
        plist="$directory/$label.plist"
        [ -f "$plist" ] && /usr/bin/grep -F "$fallback_home" "$plist" >/dev/null 2>&1 || continue
        /bin/launchctl bootout "$domain/$label" >/dev/null 2>&1 || true
        # bootout may return while launchd is still unloading the owned job.
        # Match the normal CLI stop path: wait, but retain recovery files on timeout.
        attempt=0
        while /bin/launchctl print "$domain/$label" >/dev/null 2>&1; do
          [ "$attempt" -lt 100 ] || {
            echo "launchd still owns $label; startup files were retained. Retry uninstall after it stops." >&2
            return 1
          }
          /bin/sleep 0.1
          attempt=$((attempt + 1))
        done
        rm -f "$plist"
      done
      ;;
    linux-*)
      for component in runtime tunnel; do
        [ ! -f "$STATE_HOME/startup/$component.standalone.json" ] || {
          echo 'Standalone startup still exists; re-run the installer to repair before uninstalling.' >&2
          return 1
        }
      done
      directory="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
      for unit in team-devspace-runtime.service team-devspace-tunnel.service; do
        unit_file="$directory/$unit"
        [ -f "$unit_file" ] && grep -F "$STATE_HOME" "$unit_file" >/dev/null 2>&1 || continue
        command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 || {
          echo 'systemd user manager is unavailable; re-run the installer to repair before uninstalling.' >&2
          return 1
        }
        systemctl --user stop "$unit" >/dev/null 2>&1 || true
        systemctl --user is-active --quiet "$unit" && return 1
        systemctl --user disable "$unit" >/dev/null 2>&1 || true
        rm -f "$unit_file"
      done
      command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload >/dev/null 2>&1 || true
      ;;
  esac
}

remove_distribution_payload() {
  rm -rf "$VERSIONS" "$STAGING" "$ROOT/cache" "$ROOT/bin"
  rm -f "$ACTIVE" "$ROOT/previous-path" "$ROOT/state-home" "$ROOT/cli-directory" "$OWNER_MARKER"
}

restore_active() {
  if [ -n "$current" ]; then
    restore_tmp="$ACTIVE.$$.restore"
    printf '%s\n' "$current" > "$restore_tmp" && mv "$restore_tmp" "$ACTIVE"
  else
    rm -f "$ACTIVE"
  fi
}

rollback_candidate() {
  failure=$1
  cleanup_failed=0
  restore_failed=0
  # A form can fail before Enrollment creates state.json. In that case there is
  # no device identity for the CLI to load; use the existing owned-startup fallback.
  if [ -f "$STATE_HOME/state.json" ]; then
    invoke_client "$candidate" uninstall || cleanup_failed=1
  else
    remove_native_startup_fallback || cleanup_failed=1
  fi
  if [ -n "$current" ] && [ -f "$STATE_HOME/state.json" ] &&
     ! invoke_client "$candidate" startup install --runtime-root "$current"; then restore_failed=1; fi
  if [ -z "$current" ]; then remove_linux_cli; fi
  if [ "$cleanup_failed" = 0 ]; then rm -rf "$candidate"; fi
  if [ "$cleanup_failed" = 1 ] && [ "$restore_failed" = 1 ]; then
    echo "$failure; candidate startup cleanup and previous startup restoration both failed." >&2
  elif [ "$restore_failed" = 1 ]; then
    echo "$failure; previous startup restoration also failed." >&2
  elif [ "$cleanup_failed" = 1 ] && [ -n "$current" ]; then
    echo "$failure; candidate startup cleanup failed. Previous startup entries were reinstalled, but running state is not confirmed." >&2
  elif [ "$cleanup_failed" = 1 ]; then
    echo "$failure; candidate startup cleanup also failed." >&2
  elif [ -n "$current" ]; then
    echo "$failure; previous startup state was restored." >&2
  else
    echo "$failure; partial candidate startup state was removed." >&2
  fi
}

if [ "$MODE" = uninstall ]; then
  current=$(active_path || true)
  if [ ! -f "$STATE_HOME/state.json" ]; then
    # An intentionally unconfigured installation is not a damaged client.
    # Reuse the same owned-startup cleanup as first-run rollback, without trying
    # to load a device identity that software-only installation never creates.
    remove_native_startup_fallback
  elif [ -n "$current" ] && invoke_client "$current" uninstall; then
    :
  else
    echo 'Installed client uninstall failed; using native startup cleanup fallback.' >&2
    remove_native_startup_fallback
  fi
  remove_linux_cli
  remove_distribution_payload
  remove_root_on_exit=1
  exit 0
fi

[ -f "$MANIFEST" ] || { echo 'Embedded release manifest is missing.' >&2; exit 2; }
schema=$(sed -n 's/^[[:space:]]*"schema": \([0-9][0-9]*\),$/\1/p' "$MANIFEST")
trust=$(sed -n 's/^[[:space:]]*"trust": "\([^"]*\)",$/\1/p' "$MANIFEST")
release=$(sed -n 's/^[[:space:]]*"release": "\([^"]*\)",$/\1/p' "$MANIFEST")
manifest_target=$(sed -n 's/^[[:space:]]*"target": "\([^"]*\)",$/\1/p' "$MANIFEST")
install_mode=$(sed -n 's/^[[:space:]]*"installMode": "\([^"]*\)",$/\1/p' "$MANIFEST")
node_version=$(sed -n 's/^[[:space:]]*"nodeVersion": "\([^"]*\)",$/\1/p' "$MANIFEST")
devspace_version=$(sed -n 's/^[[:space:]]*"devspaceVersion": "\([^"]*\)",$/\1/p' "$MANIFEST")
cloudflared_version=$(sed -n 's/^[[:space:]]*"cloudflaredVersion": "\([^"]*\)".*$/\1/p' "$MANIFEST")
[ "$schema" = 1 ] && [ "$trust" = bootstrap-embedded-manifest ] || {
  echo "Invalid embedded release manifest contract (schema=${schema:-missing}, trust=${trust:-missing})." >&2; exit 2;
}
# Match the PKG preflight: keep native ARM as the default, but permit an explicit
# Intel payload on Apple Silicon when the system can actually execute x86_64.
if [ "$TARGET" = darwin-arm64 ] && [ "$manifest_target" = darwin-x64 ] &&
   /usr/bin/arch -x86_64 /usr/bin/true >/dev/null 2>&1; then TARGET=darwin-x64; fi
[ "$manifest_target" = "$TARGET" ] || {
  echo "Release manifest target ${manifest_target:-missing} does not match detected platform $TARGET (kernel=$SYSTEM_NAME-$KERNEL_ARCH, machine=$MACHINE_ARCH)." >&2; exit 2;
}
case "$release" in ''|*[!0-9A-Za-z.-]*) echo 'Invalid fixed release version.' >&2; exit 2 ;; esac
[ "$install_mode" = offline ] || { echo 'This bootstrap only accepts the offline release contract.' >&2; exit 2; }
if [ -z "$OFFLINE_ROOT" ]; then
  OFFLINE_ROOT=$(CDPATH= cd -- "$(dirname -- "$MANIFEST")" && pwd)
fi

manifest_sha() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}
file_size() {
  if [ "$(uname -s)" = Darwin ]; then stat -f %z "$1"; else stat -c %s "$1"; fi
}
verify_artifact() {
  path=$1 expected_size=$2 expected_sha=$3
  [ -f "$path" ] && [ "$(file_size "$path")" = "$expected_size" ] && [ "$(manifest_sha "$path")" = "$expected_sha" ]
}

components_file="$STAGING/components.$$"
stage="$STAGING/$release-$$"
awk '
  /"components": \[/ { inside=1; next }
  inside && /^  \]/ { exit }
  inside && /"name":/ { name=$0; sub(/^.*"name": "/,"",name); sub(/".*$/,"",name) }
  inside && /"version":/ { version=$0; sub(/^.*"version": "/,"",version); sub(/".*$/,"",version) }
  inside && /"required":/ { required=($0 ~ /true/) ? "true" : "false" }
  inside && /"condition":/ { condition=$0; sub(/^.*"condition": "/,"",condition); sub(/".*$/,"",condition) }
  inside && /"format":/ { format=$0; sub(/^.*"format": "/,"",format); sub(/".*$/,"",format) }
  inside && /"path":/ { path=$0; sub(/^.*"path": "/,"",path); sub(/".*$/,"",path) }
  inside && /"sha256":/ { sha=$0; sub(/^.*"sha256": "/,"",sha); sub(/".*$/,"",sha) }
  inside && /"size":/ { size=$0; sub(/^.*"size": /,"",size); sub(/,.*/,"",size) }
  inside && /^    }/ { print name "|" version "|" required "|" condition "|" path "|" sha "|" size "|" format; name=version=required=condition=path=sha=size=format="" }
' "$MANIFEST" > "$components_file"
awk -F'|' '{ if (seen[$1]++) bad=1; count++ } END { exit bad || count != 4 }' "$components_file" || {
  echo 'Manifest must have exactly four unique Unix components.' >&2; exit 2;
}

rm -rf "$stage"
mkdir -p "$stage"
while IFS='|' read -r name version required condition relative sha size format; do
  case "$name" in app|devspace-runtime|node|cloudflared) ;; *) echo "Unexpected component: $name" >&2; exit 2 ;; esac
  [ "$format" = tar.gz ] && [ "$required" = true ] && [ -z "$condition" ] || { echo "Invalid component contract: $name" >&2; exit 2; }
  case "$sha" in ''|*[!a-f0-9]*) echo "Invalid SHA-256 for $name" >&2; exit 2 ;; esac
  [ "${#sha}" -eq 64 ] || { echo "Invalid SHA-256 for $name" >&2; exit 2; }
  [ "$relative" = "objects/sha256/$sha/$name.tar.gz" ] || { echo "Unsafe artifact path for $name" >&2; exit 2; }
  directory="$CACHE/$sha"
  artifact="$directory/${relative##*/}"
  mkdir -p "$directory"
  if ! verify_artifact "$artifact" "$size" "$sha"; then
    rm -f "$artifact"
    partial="$artifact.$$.partial"
    if [ -n "$OFFLINE_ROOT" ] && [ -f "$OFFLINE_ROOT/$relative" ]; then
      cp "$OFFLINE_ROOT/$relative" "$partial"
    else
      echo "Artifact $name is missing from the offline release package. Re-run setup from the complete package supplied by your administrator." >&2
      exit 1
    fi
    verify_artifact "$partial" "$size" "$sha" || { echo "Artifact verification failed: $name" >&2; exit 1; }
    mv "$partial" "$artifact"
    partial=''
  fi
  tar -tzf "$artifact" | awk '/^\// || /^[A-Za-z]:/ || /(^|\/)\.\.(\/|$)/ { bad=1 } END { exit bad }' || {
    echo "Unsafe archive paths: $name" >&2; exit 1;
  }
  tar -xzf "$artifact" -C "$stage"
done < "$components_file"

node="$stage/runtime/bin/node"
cloudflared="$stage/bin/cloudflared"
[ -x "$node" ] && [ -x "$cloudflared" ] && [ -f "$stage/client/cli.mjs" ] || { echo 'Staged version is incomplete.' >&2; exit 1; }
[ "$("$node" --version)" = "v$node_version" ] || { echo 'Node version verification failed.' >&2; exit 1; }
(cd "$stage" && "$node" --input-type=module -e "import{createRequire}from'node:module';const r=createRequire(import.meta.url),p=r('@waishnav/devspace/package.json');if(p.version!='$devspace_version'||r('./release.config.json').version!='$release')process.exit(1);const D=r('better-sqlite3'),d=new D(':memory:');d.prepare('SELECT 1').get();d.close();r('node-pty')")
"$cloudflared" --version | grep -F "$cloudflared_version" >/dev/null
cp "$MANIFEST" "$stage/install-manifest.json"

manifest_hash=$(manifest_sha "$MANIFEST")
candidate="$VERSIONS/$release-$(printf '%s' "$manifest_hash" | cut -c1-12)-$$"
mv "$stage" "$candidate"
stage=''
current=$(active_path || true)
if [ -n "$current" ] && [ -f "$STATE_HOME/state.json" ]; then
  # Repair must not depend on executable files in the damaged installed tree.
  # The verified candidate stops the same state-home-owned native services.
  if ! invoke_client "$candidate" stop; then
    rm -rf "$candidate"
    if invoke_client "$current" start; then
      echo 'Current version could not be fully stopped; it was restarted and the upgrade was cancelled.' >&2
    else
      echo 'Current version could not be fully stopped or restarted; the upgrade was cancelled before activation.' >&2
    fi
    exit 1
  fi
fi

case "$SETUP" in
  gui) setup_args='setup-gui' ;;
  existing) setup_args='setup' ;;
  none) setup_args='' ;;
  *) echo 'Invalid setup mode.' >&2; exit 2 ;;
esac
if [ -n "$setup_args" ]; then
  case "$TARGET" in
    linux-*)
      if [ -n "$REQUEST_FILE" ]; then
        if ! invoke_client "$candidate" setup --no-startup --request-file "$REQUEST_FILE"; then setup_failed=1; else setup_failed=0; fi
      elif ! invoke_client "$candidate" "$setup_args" --no-startup; then setup_failed=1
      else setup_failed=0; fi
      ;;
    *)
      if [ -n "$REQUEST_FILE" ]; then
        if ! invoke_client "$candidate" setup --request-file "$REQUEST_FILE"; then setup_failed=1; else setup_failed=0; fi
      elif ! invoke_client "$candidate" "$setup_args"; then setup_failed=1
      else setup_failed=0; fi
      ;;
  esac
  if [ "$setup_failed" = 1 ]; then
    rollback_candidate 'New version failed setup'
    exit 1
  fi
fi

tmp="$ACTIVE.$$.tmp"
if ! { printf '%s\n' "$candidate" > "$tmp" && mv "$tmp" "$ACTIVE"; }; then
  rm -f "$tmp"
  rollback_candidate 'Activation failed'
  exit 1
fi

case "$TARGET" in
  linux-*)
    if ! install_linux_cli; then
      restore_active
      rollback_candidate 'Linux command entrypoint installation failed'
      exit 1
    fi
    refresh_startup=0
    if [ -n "$setup_args" ]; then
      refresh_startup=1
    elif [ -f "$STATE_HOME/state.json" ] && [ -s "$STATE_HOME/tunnel.token" ] && grep -q '"bindingId"' "$STATE_HOME/state.json"; then
      refresh_startup=1
    fi
    if [ "$refresh_startup" = 1 ] && ! invoke_client "$candidate" startup install; then
      restore_active
      rollback_candidate 'Linux startup activation failed'
      exit 1
    fi
    ;;
esac
# The old version is only a pre-commit recovery candidate, not a supported
# post-upgrade rollback product. Keep repair artifacts for the current manifest.
rm -f "$ROOT/previous-path"
for directory in "$VERSIONS"/*; do
  [ -d "$directory" ] || continue
  if [ "$directory" != "$candidate" ]; then
    rm -rf "$directory" || echo 'Old version cleanup deferred until next repair.' >&2
  fi
done
for directory in "$CACHE"/*; do
  [ -d "$directory" ] || continue
  hash=${directory##*/}
  case "$hash" in *[!a-f0-9]*) continue ;; esac
  [ "${#hash}" -eq 64 ] || continue
  if ! awk -F'|' -v hash="$hash" '$6 == hash { found=1 } END { exit !found }' "$components_file"; then
    rm -rf "$directory" || echo 'Unused artifact cache cleanup deferred until next repair.' >&2
  fi
done
echo "Team DevSpace $release is active ($TARGET)."
case "$TARGET" in
  linux-*)
    if [ ! -f "$STATE_HOME/state.json" ]; then
      echo "Run $CLI_LINK setup to enter your Access Key privately and choose a project directory."
      echo "Use $CLI_LINK access-key change later to switch credentials without reinstalling."
    elif [ "$refresh_startup" = 1 ]; then
      echo "Linux services were refreshed through the stable $CLI_LINK entrypoint."
      if ! command -v systemctl >/dev/null 2>&1; then
        echo 'Standalone services run independently of this terminal. After a full host/container recreation, run team-devspace repair through your host startup hook or cloud-computer terminal.'
      fi
    fi
    ;;
esac

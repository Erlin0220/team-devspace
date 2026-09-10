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

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) TARGET=darwin-arm64 ;;
  Darwin-x86_64) TARGET=darwin-x64 ;;
  Linux-x86_64) TARGET=linux-x64 ;;
  Linux-aarch64|Linux-arm64) TARGET=linux-arm64 ;;
  *) echo 'Unsupported operating system or architecture.' >&2; exit 2 ;;
esac

case "$TARGET" in
  linux-*)
    [ "$(id -u)" -ne 0 ] || { echo 'Install Team DevSpace as the employee user, not root or sudo.' >&2; exit 2; }
    case "$ROOT" in /*) ;; *) echo 'Linux distribution root must be an absolute path.' >&2; exit 2 ;; esac
    glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}' || true)
    [ -n "$glibc" ] && awk -v v="$glibc" 'BEGIN { split(v,p,"."); exit ! (p[1] > 2 || (p[1] == 2 && p[2] >= 34)) }' || {
      echo 'Team DevSpace Linux x64 requires glibc 2.34 or newer.' >&2; exit 2;
    }
    export TEAM_DEVSPACE_DISTRIBUTION_ROOT="$ROOT"
    STATE_HOME="${TEAM_DEVSPACE_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/team-devspace}"
    CLI_DIR="${TEAM_DEVSPACE_CLI_DIR:-$HOME/.local/bin}"
    CLI_LINK="$CLI_DIR/team-devspace"
    STABLE_CLI="$ROOT/bin/team-devspace"
    ;;
esac

VERSIONS="$ROOT/versions"
STAGING="$ROOT/staging"
CACHE="$ROOT/cache/sha256"
ACTIVE="$ROOT/active-path"
mkdir -p "$VERSIONS" "$STAGING" "$CACHE"
# POSIX mkdir is atomic on both macOS and Linux. Never run activation/cache GC
# concurrently. Traps release this lock; SIGKILL recovery fails closed with a
# diagnostic rather than stealing a potentially live installer's lock.
LOCK="$ROOT/install.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "Another installer may be active. Lock: $LOCK (owner PID: $(cat "$LOCK/pid" 2>/dev/null || echo unknown)). If no installer is running, remove this stale lock directory and retry." >&2
  exit 1
fi
printf '%s\n' "$$" > "$LOCK/pid"
components_file=''
stage=''
partial=''
cleanup() {
  [ -z "$components_file" ] || rm -f "$components_file"
  [ -z "$partial" ] || rm -f "$partial"
  [ -z "$stage" ] || rm -rf "$stage"
  rm -rf "$LOCK"
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
  invoke_client "$candidate" uninstall || cleanup_failed=1
  if [ -n "$current" ] && ! invoke_client "$candidate" startup install --runtime-root "$current"; then restore_failed=1; fi
  if [ -z "$current" ]; then remove_linux_cli; fi
  rm -rf "$candidate"
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
  [ -z "$current" ] || invoke_client "$current" uninstall
  remove_linux_cli
  rm -rf "$ROOT"
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
[ "$schema" = 1 ] && [ "$trust" = bootstrap-embedded-manifest ] && [ "$manifest_target" = "$TARGET" ] || {
  echo 'Release manifest does not match this platform.' >&2; exit 2;
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
if [ -n "$current" ]; then
  case "$TARGET" in linux-*) stop_version="$candidate" ;; *) stop_version="$current" ;; esac
  if ! invoke_client "$stop_version" stop; then
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
      echo "Run $CLI_LINK setup --credential-file <employee-key.json> --root <project-directory> to enroll this device."
    elif [ "$refresh_startup" = 1 ]; then
      echo "Linux user services were refreshed through the stable $CLI_LINK entrypoint."
    fi
    ;;
esac

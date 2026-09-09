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

VERSIONS="$ROOT/versions"
STAGING="$ROOT/staging"
CACHE="$ROOT/cache/sha256"
ACTIVE="$ROOT/active-path"
PREVIOUS="$ROOT/previous-path"
mkdir -p "$VERSIONS" "$STAGING" "$CACHE"

active_path() {
  [ -f "$ACTIVE" ] || return 1
  value=$(sed -n '1p' "$ACTIVE")
  case "$value" in "$VERSIONS"/*) printf '%s\n' "$value" ;; *) return 1 ;; esac
}

invoke_client() {
  version=$1; shift
  "$version/runtime/bin/node" "$version/client/cli.mjs" "$@"
}

if [ "$MODE" = uninstall ]; then
  current=$(active_path || true)
  [ -z "$current" ] || invoke_client "$current" uninstall
  rm -rf "$ROOT"
  exit 0
fi

[ -f "$MANIFEST" ] || { echo 'Embedded release manifest is missing.' >&2; exit 2; }
schema=$(sed -n 's/^[[:space:]]*"schema": \([0-9][0-9]*\),$/\1/p' "$MANIFEST")
trust=$(sed -n 's/^[[:space:]]*"trust": "\([^"]*\)",$/\1/p' "$MANIFEST")
release=$(sed -n 's/^[[:space:]]*"release": "\([^"]*\)",$/\1/p' "$MANIFEST")
manifest_target=$(sed -n 's/^[[:space:]]*"target": "\([^"]*\)",$/\1/p' "$MANIFEST")
source_base=$(sed -n 's/^[[:space:]]*"sourceBase": "\([^"]*\)",$/\1/p' "$MANIFEST")
node_version=$(sed -n 's/^[[:space:]]*"nodeVersion": "\([^"]*\)",$/\1/p' "$MANIFEST")
devspace_version=$(sed -n 's/^[[:space:]]*"devspaceVersion": "\([^"]*\)",$/\1/p' "$MANIFEST")
cloudflared_version=$(sed -n 's/^[[:space:]]*"cloudflaredVersion": "\([^"]*\)".*$/\1/p' "$MANIFEST")
[ "$schema" = 1 ] && [ "$trust" = bootstrap-embedded-manifest ] && [ "$manifest_target" = "$TARGET" ] || {
  echo 'Release manifest does not match this platform.' >&2; exit 2;
}
case "$release" in ''|*[!0-9A-Za-z.-]*) echo 'Invalid fixed release version.' >&2; exit 2 ;; esac
case "$source_base" in https://*/"$release"/"$TARGET"/) ;; *) echo 'Release source is not a fixed HTTPS version path.' >&2; exit 2 ;; esac
case "$source_base" in */latest/*) echo 'Release source must never follow latest.' >&2; exit 2 ;; esac

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
trap 'rm -f "$components_file"; [ ! -d "$stage" ] || rm -rf "$stage"' EXIT HUP INT TERM
awk '
  /"components": \[/ { inside=1; next }
  inside && /^  \]/ { exit }
  inside && /"name":/ { name=$0; sub(/^.*"name": "/,"",name); sub(/".*$/,"",name) }
  inside && /"version":/ { version=$0; sub(/^.*"version": "/,"",version); sub(/".*$/,"",version) }
  inside && /"required":/ { required=($0 ~ /true/) ? "true" : "false" }
  inside && /"condition":/ { condition=$0; sub(/^.*"condition": "/,"",condition); sub(/".*$/,"",condition) }
  inside && /"path":/ { path=$0; sub(/^.*"path": "/,"",path); sub(/".*$/,"",path) }
  inside && /"sha256":/ { sha=$0; sub(/^.*"sha256": "/,"",sha); sub(/".*$/,"",sha) }
  inside && /"size":/ { size=$0; sub(/^.*"size": /,"",size); sub(/,.*/,"",size) }
  inside && /^    }/ { print name "|" version "|" required "|" condition "|" path "|" sha "|" size; name=version=required=condition=path=sha=size="" }
' "$MANIFEST" > "$components_file"
[ "$(wc -l < "$components_file" | tr -d ' ')" -ge 4 ] || { echo 'Manifest has too few components.' >&2; exit 2; }

rm -rf "$stage"
mkdir -p "$stage"
while IFS='|' read -r name version required condition relative sha size; do
  case "$name" in app|devspace-runtime|node|cloudflared) ;; *) echo "Unexpected component: $name" >&2; exit 2 ;; esac
  case "$sha" in ???????*) ;; *) echo "Invalid SHA-256 for $name" >&2; exit 2 ;; esac
  [ "${#sha}" -eq 64 ] || { echo "Invalid SHA-256 for $name" >&2; exit 2; }
  case "$relative" in objects/sha256/"$sha"/*.tar.gz) ;; *) echo "Unsafe artifact path for $name" >&2; exit 2 ;; esac
  directory="$CACHE/$sha"
  artifact="$directory/${relative##*/}"
  mkdir -p "$directory"
  if ! verify_artifact "$artifact" "$size" "$sha"; then
    rm -f "$artifact"
    partial="$artifact.$$.partial"
    if [ -n "$OFFLINE_ROOT" ] && [ -f "$OFFLINE_ROOT/$relative" ]; then
      cp "$OFFLINE_ROOT/$relative" "$partial"
    else
      echo "Downloading $name $version from immutable release $release..."
      curl --fail --location --proto '=https' --tlsv1.2 --output "$partial" "$source_base$relative"
    fi
    verify_artifact "$partial" "$size" "$sha" || { echo "Artifact verification failed: $name" >&2; exit 1; }
    mv "$partial" "$artifact"
  fi
  tar -tzf "$artifact" | awk '/^\// || /^[A-Za-z]:/ || /(^|\/)\.\.(\/|$)/ { bad=1 } END { exit bad }' || {
    echo "Unsafe archive paths: $name" >&2; exit 1;
  }
  tar -xzf "$artifact" -C "$stage"
done < "$components_file"

node="$stage/runtime/bin/node"
cloudflared="$stage/bin/cloudflared"
[ -x "$node" ] && [ -x "$cloudflared" ] && [ -f "$stage/client/cli.mjs" ] || { echo 'Staged version is incomplete.' >&2; exit 1; }
[ "$($node --version)" = "v$node_version" ] || { echo 'Node version verification failed.' >&2; exit 1; }
"$node" --input-type=module -e "import{createRequire}from'node:module';const r=createRequire(import.meta.url),p=r('@waishnav/devspace/package.json');if(p.version!='$devspace_version')process.exit(1);const D=r('better-sqlite3'),d=new D(':memory:');d.prepare('SELECT 1').get();d.close()"
"$cloudflared" --version | grep -F "$cloudflared_version" >/dev/null
cp "$MANIFEST" "$stage/install-manifest.json"

manifest_hash=$(manifest_sha "$MANIFEST")
candidate="$VERSIONS/$release-$(printf '%s' "$manifest_hash" | cut -c1-12)-$$"
mv "$stage" "$candidate"
stage=''
current=$(active_path || true)
if [ -n "$current" ]; then invoke_client "$current" stop || { rm -rf "$candidate"; echo 'Current version could not be stopped.' >&2; exit 1; }; fi

case "$SETUP" in
  gui) setup_args='setup-gui' ;;
  existing) setup_args='setup' ;;
  none) setup_args='' ;;
  *) echo 'Invalid setup mode.' >&2; exit 2 ;;
esac
if [ -n "$setup_args" ]; then
  if [ -n "$REQUEST_FILE" ]; then
    if ! invoke_client "$candidate" setup --request-file "$REQUEST_FILE"; then setup_failed=1; else setup_failed=0; fi
  elif ! invoke_client "$candidate" "$setup_args"; then setup_failed=1
  else setup_failed=0; fi
  if [ "$setup_failed" = 1 ]; then
    invoke_client "$candidate" stop || true
    [ -z "$current" ] || invoke_client "$current" setup || true
    rm -rf "$candidate"
    echo 'New version failed setup; previous version was restored.' >&2
    exit 1
  fi
fi

tmp="$ACTIVE.$$.tmp"
printf '%s\n' "$candidate" > "$tmp"
mv "$tmp" "$ACTIVE"
if [ -n "$current" ]; then printf '%s\n' "$current" > "$PREVIOUS"; else rm -f "$PREVIOUS"; fi
for directory in "$VERSIONS"/*; do
  [ -d "$directory" ] || continue
  if [ "$directory" != "$candidate" ] && { [ -z "$current" ] || [ "$directory" != "$current" ]; }; then
    rm -rf "$directory"
  fi
done
echo "Team DevSpace $release is active ($TARGET)."

#!/usr/bin/env bash
# Small SSH-driven static publisher. No HTTP write API, daemon or package service.
set -euo pipefail
ROOT=${1:?server root required}
ACTION=${2:?action required}
ARG=${3:-}
STAGE=${4:-}
[[ "$ROOT" =~ ^/[a-zA-Z0-9_./-]+$ && "$ROOT" != / && "$ROOT" != /srv && "$ROOT" != /tmp && "$ROOT" != /home && "$ROOT" != *'/../'* && "$ROOT" != */.. ]] || { echo 'Unsafe server root' >&2; exit 2; }
[[ ! -L "$ROOT" && "$(realpath -m "$ROOT")" = "$ROOT" ]] || { echo 'Server root must not be a symlink' >&2; exit 2; }
PUBLIC="$ROOT/public"
OWNER='team-devspace-static-distribution-v1'
version_ok() { [[ "$1" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; }
owned() { [[ -f "$ROOT/.owner" && "$(cat "$ROOT/.owner")" = "$OWNER" && -O "$ROOT/.owner" ]] || { echo 'Unowned distribution root' >&2; exit 2; }; }

if [[ "$ACTION" = prepare ]]; then
  if [[ ! -e "$ROOT" ]]; then
    if [[ -w "$(dirname "$ROOT")" ]]; then mkdir "$ROOT"; else sudo -n install -d -m 0755 -o "$(id -un)" "$ROOT"; fi
  fi
  if [[ ! -e "$ROOT/.owner" ]]; then
    [[ -z "$(find "$ROOT" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo 'Refusing to adopt a nonempty directory' >&2; exit 2; }
    printf '%s\n' "$OWNER" > "$ROOT/.owner"
    chmod 600 "$ROOT/.owner"
  fi
  owned
  mkdir -p "$PUBLIC/releases" "$ROOT/.incoming" "$ROOT/backups"
  chmod 755 "$ROOT" "$PUBLIC" "$PUBLIC/releases"
  chmod 700 "$ROOT/.incoming" "$ROOT/backups"
  echo 'Distribution directories ready'
  exit 0
fi
owned

if [[ "$ACTION" = configure ]]; then
  [[ "$ARG" =~ ^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$ && "$ARG" != *'..'* ]] || { echo 'Invalid hostname' >&2; exit 2; }
  sudo -n grep -Fxq 'import /etc/caddy/conf.d/*.caddy' /etc/caddy/Caddyfile || { echo 'Existing Caddy conf.d import required; main configuration was not changed' >&2; exit 2; }
  config=/etc/caddy/conf.d/team-devspace-downloads.caddy
  previous=''
  if sudo -n test -e "$config"; then
    sudo -n grep -Fxq "# $OWNER" "$config" || { echo 'Refusing to replace an unowned Caddy site' >&2; exit 2; }
    previous="$ROOT/backups/caddy-$(date -u +%Y%m%dT%H%M%SZ)-$$.caddy"
    sudo -n cp -p "$config" "$previous"
  fi
  candidate="$ROOT/.caddy-candidate-$$"
  trap 'rm -f "$candidate"' EXIT
  cat > "$candidate" <<EOF
# $OWNER
$ARG {
    root * $PUBLIC
    encode zstd gzip
    header {
        X-Content-Type-Options nosniff
        Referrer-Policy no-referrer
        X-Frame-Options DENY
        Strict-Transport-Security "max-age=31536000"
        Content-Security-Policy "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; script-src-attr 'none'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'"
        -Server
    }
    @home path /
    rewrite @home /index.html
    @entry path /install.sh /install.ps1 /catalog.json /update.json
    rewrite @entry /stable{path}
    @immutable path /releases/*
    header @immutable Cache-Control "public, max-age=31536000, immutable"
    @mutable not path /releases/*
    header @mutable Cache-Control no-store
    @history path /releases /releases/
    header @history Cache-Control no-store
    file_server {
        hide .*
    }
}
EOF
  # During the one-time migration from release-bound homepages, keep / available
  # before Caddy starts serving the independently managed public index.
  if [[ ! -e "$PUBLIC/index.html" && -f "$PUBLIC/stable/index.html" && ! -L "$PUBLIC/stable/index.html" ]]; then
    install -m 0444 "$PUBLIC/stable/index.html" "$PUBLIC/index.html"
  fi
  sudo -n install -m 0644 "$candidate" "$config"
  if ! sudo -n caddy validate --config /etc/caddy/Caddyfile || ! sudo -n systemctl reload caddy; then
    if [[ -n "$previous" ]]; then sudo -n cp -p "$previous" "$config"; else sudo -n rm -f "$config"; fi
    sudo -n systemctl reload caddy || true
    echo 'Caddy configuration failed; the owned site configuration was restored' >&2
    exit 1
  fi
  echo "HTTPS site configured: https://$ARG"
  exit 0
fi

exec 9>"$ROOT/.publish.lock"
flock -w 60 9
if [[ "$ACTION" = current ]]; then readlink "$PUBLIC/stable" || printf '%s\n' '-'; exit 0; fi
if [[ "$ACTION" = site-stage || "$ACTION" = site-discard || "$ACTION" = site-publish ]]; then
  [[ "$ARG" =~ ^[a-f0-9]{32}$ ]] || { echo 'Invalid site staging identity' >&2; exit 2; }
  incoming="$ROOT/.incoming/site-$ARG"
  [[ ! -L "$incoming" ]] || { echo 'Invalid site staging directory' >&2; exit 2; }
  if [[ "$ACTION" = site-stage ]]; then
    mkdir -m 0700 "$incoming"
    exit 0
  fi
  if [[ "$ACTION" = site-discard ]]; then
    rm -rf -- "$incoming"
    exit 0
  fi
  [[ -d "$incoming" ]] || { echo 'Invalid homepage staging directory' >&2; exit 2; }
  if [[ -n "$STAGE" ]]; then
    version_ok "$STAGE" && [[ "$(readlink "$PUBLIC/stable")" = "releases/$STAGE" ]] || { echo 'Stable changed; refusing stale homepage' >&2; exit 1; }
  fi
  for file in index.html download-site.js devspace-logo-light.png; do
    [[ -f "$incoming/$file" && ! -L "$incoming/$file" ]] || { echo "Missing homepage asset: $file" >&2; exit 2; }
  done
  [[ -z "$(find "$incoming" -mindepth 1 -maxdepth 1 ! -name index.html ! -name download-site.js ! -name devspace-logo-light.png -print -quit)" ]] || { echo 'Unexpected homepage staging content' >&2; exit 2; }
  bytes=$(wc -c < "$incoming/index.html")
  script_bytes=$(wc -c < "$incoming/download-site.js")
  logo_bytes=$(wc -c < "$incoming/devspace-logo-light.png")
  [[ "$bytes" -ge 1024 && "$bytes" -le 131072 ]] || { echo 'Homepage size is outside the allowed range' >&2; exit 2; }
  [[ "$script_bytes" -ge 128 && "$script_bytes" -le 16384 ]] || { echo 'Homepage script size is outside the allowed range' >&2; exit 2; }
  [[ "$logo_bytes" -ge 1024 && "$logo_bytes" -le 1048576 ]] || { echo 'Homepage logo size is outside the allowed range' >&2; exit 2; }
  grep -Fq '<html lang="zh-CN">' "$incoming/index.html" || { echo 'Homepage marker missing' >&2; exit 2; }
  grep -Fq 'data-copy-command' "$incoming/download-site.js" || { echo 'Homepage script marker missing' >&2; exit 2; }
  temporary_index="$PUBLIC/.index-$$"
  temporary_script="$PUBLIC/.download-site-$$"
  temporary_logo="$PUBLIC/.devspace-logo-$$"
  trap 'rm -f "$temporary_index" "$temporary_script" "$temporary_logo"' EXIT
  install -m 0444 "$incoming/index.html" "$temporary_index"
  install -m 0444 "$incoming/download-site.js" "$temporary_script"
  install -m 0444 "$incoming/devspace-logo-light.png" "$temporary_logo"
  mv -Tf "$temporary_script" "$PUBLIC/download-site.js"
  mv -Tf "$temporary_logo" "$PUBLIC/devspace-logo-light.png"
  mv -Tf "$temporary_index" "$PUBLIC/index.html"
  rm -rf -- "$incoming"
  echo 'Published public homepage assets'
  exit 0
fi
version_ok "$ARG" || { echo 'Invalid release version' >&2; exit 2; }
DEST="$PUBLIC/releases/$ARG"
verify() {
  local directory=$1 suffix
  [[ -d "$directory" && ! -L "$directory" && -s "$directory/SHA256SUMS" ]] || return 1
  for suffix in windows-x64-setup.exe macos-arm64.pkg macos-x64.pkg linux-x64-offline.tar.gz; do
    [[ -s "$directory/Team-DevSpace-$ARG-$suffix" && ! -L "$directory/Team-DevSpace-$ARG-$suffix" ]] || return 1
  done
  for suffix in catalog.json install.sh install.ps1 index.html release-notes.txt; do
    [[ -s "$directory/$suffix" && ! -L "$directory/$suffix" ]] || return 1
  done
  (cd "$directory" && sha256sum --check --strict SHA256SUMS)
}

if [[ "$ACTION" = verify ]]; then
  verify "$DEST"
  exit 0
fi

# Only the publisher calls this after verifying the activated scripts/homepage.
# The lock and stable comparison prevent a concurrent activation being pruned.
if [[ "$ACTION" = prune ]]; then
  [[ "$(readlink "$PUBLIC/stable")" = "releases/$ARG" ]] || { echo 'Stable changed; refusing to prune' >&2; exit 1; }
  verify "$DEST"
  [[ "$STAGE" =~ ^[0-9]{10}:[0-9A-Za-z.,-]+$ ]] || { echo 'Explicit policy retention and a live publication lease are required' >&2; exit 2; }
  expires=${STAGE%%:*}
  versions=${STAGE#*:}
  [[ "$expires" -gt $(( $(date +%s) + 120 )) ]] || { echo 'Publication lease expired; refusing to prune' >&2; exit 1; }
  IFS=',' read -ra retained <<< "$versions"
  for value in "${retained[@]}"; do
    version_ok "$value" && [[ -d "$PUBLIC/releases/$value" && ! -L "$PUBLIC/releases/$value" ]] || { echo 'A retained policy release is missing' >&2; exit 1; }
  done
  # Reuse the activation log, rather than a second mutable rollback pointer.
  previous=$(awk -F '\t' -v current="releases/$ARG" '$3 == current && $2 != current && $2 ~ /^releases\// { value=$2 } END { print value }' "$ROOT/activations.log")
  previous=${previous#releases/}
  keep=",$ARG,$versions,"
  if version_ok "$previous"; then keep="$keep$previous,"; fi
  for candidate in "$PUBLIC/releases/"*; do
    [[ -d "$candidate" && ! -L "$candidate" && "$candidate" != "$DEST" ]] || continue
    value=${candidate##*/}
    version_ok "$value" || continue
    if [[ "$keep" = *",$value,"* ]]; then printf 'Retained recovery/policy release: %s\n' "$value"; continue; fi
    [[ "$expires" -gt $(( $(date +%s) + 120 )) ]] || { echo 'Publication lease is expiring; remaining releases retained' >&2; exit 1; }
    find "$candidate" -type d -exec chmod u+w {} +
    rm -rf -- "$candidate"
    printf 'Removed unused release: %s\n' "$value"
  done
  index="$PUBLIC/.releases-json-$$"
  printf '{"schema":1,"versions":[' > "$index"
  first=1
  while IFS= read -r value; do
    if [[ "$first" -eq 0 ]]; then printf ',' >> "$index"; fi
    first=0
    printf '"%s"' "$value" >> "$index"
  done < <(for candidate in "$PUBLIC/releases/"*; do
    [[ -d "$candidate" && ! -L "$candidate" ]] || continue
    value=${candidate##*/}
    version_ok "$value" && printf '%s\n' "$value"
  done | sort -Vr)
  printf ']}\n' >> "$index"
  chmod 0444 "$index"
  mv -Tf "$index" "$PUBLIC/releases.json"
  exit 0
fi

if [[ "$ACTION" = stage || "$ACTION" = discard ]]; then
  [[ "$STAGE" =~ ^[a-f0-9]{32}$ ]] || { echo 'Invalid staging identity' >&2; exit 2; }
  incoming="$ROOT/.incoming/$STAGE"
  [[ ! -L "$incoming" ]] || { echo 'Invalid staging directory' >&2; exit 2; }
  if [[ "$ACTION" = stage ]]; then mkdir -m 0700 "$incoming"; else rm -rf -- "$incoming"; fi
  exit 0
fi

if [[ "$ACTION" = publish ]]; then
  [[ "$STAGE" =~ ^[a-f0-9]{32}$ ]] || { echo 'Invalid staging identity' >&2; exit 2; }
  incoming="$ROOT/.incoming/$STAGE"
  [[ -d "$incoming" && ! -L "$incoming" && -z "$(find "$incoming" -type l -print -quit)" ]] || { echo 'Invalid staging directory' >&2; exit 2; }
  verify "$incoming"
  if [[ -e "$DEST" ]]; then
    [[ ! -L "$DEST" ]] && cmp -s "$incoming/SHA256SUMS" "$DEST/SHA256SUMS" && verify "$DEST" || { echo 'Immutable release already exists with different content' >&2; exit 1; }
    rm -rf -- "$incoming"
    echo "Release already present: $ARG"
    exit 0
  fi
  for pair in 'windows-x64.exe:windows-x64-setup.exe' 'macos-arm64.pkg:macos-arm64.pkg' 'macos-x64.pkg:macos-x64.pkg' 'linux-x64.tar.gz:linux-x64-offline.tar.gz'; do
    alias=${pair%%:*}; suffix=${pair#*:}
    ln -s "Team-DevSpace-$ARG-$suffix" "$incoming/$alias"
    ln -s "Team-DevSpace-$ARG-$suffix.sha256" "$incoming/$alias.sha256"
  done
  find "$incoming" -type f -exec chmod 0444 {} +
  # Moving a directory between parents needs write permission on its inode.
  # Restrict directories only AFTER rename; files are already read-only.
  find "$incoming" -type d -exec chmod 0755 {} +
  mv -T "$incoming" "$DEST"
  find "$DEST" -type d -exec chmod 0555 {} +
  echo "Published immutable release: $ARG (stable unchanged)"
  exit 0
fi

if [[ "$ACTION" = activate ]]; then
  verify "$DEST"
  previous=$(readlink "$PUBLIC/stable" || true)
  if [[ -n "$STAGE" && "$STAGE" != "${previous:--}" ]]; then
    echo 'Stable changed during publication; refusing to overwrite another activation' >&2; exit 1
  fi
  [[ ! -e "$PUBLIC/stable" || -L "$PUBLIC/stable" ]] || { echo 'Stable is not an owned symlink' >&2; exit 2; }
  temporary="$PUBLIC/.stable-$$"
  trap 'rm -f "$temporary"' EXIT
  ln -s "releases/$ARG" "$temporary"
  mv -Tf "$temporary" "$PUBLIC/stable"
  printf '%s\t%s\treleases/%s\n' "$(date -u +%FT%TZ)" "$previous" "$ARG" >> "$ROOT/activations.log"
  chmod 600 "$ROOT/activations.log"
  echo "Activated stable: $ARG"
  exit 0
fi
echo 'Unknown action' >&2
exit 2

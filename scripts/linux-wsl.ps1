param(
  [string]$Distribution = 'Ubuntu-22.04',
  [string]$LinuxWorkspace = '~/team-devspace-linux'
)

$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'The WSL Linux acceptance helper must be started from Windows.' }

$repository = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$wsl = (Get-Command wsl.exe -ErrorAction Stop).Source

& $wsl -d $Distribution -- true
if ($LASTEXITCODE -ne 0) {
  throw "WSL distribution '$Distribution' is unavailable. Install or start it before Linux packaging."
}

if ($repository -notmatch '^([A-Za-z]):\\(.*)$') {
  throw 'The WSL Linux acceptance helper currently requires a repository on a local Windows drive.'
}
$drive = $Matches[1].ToLowerInvariant()
$relative = $Matches[2] -replace '\\', '/'
$linuxSource = "/mnt/$drive/$relative"

$sourceBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($linuxSource))
$workspaceBase64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($LinuxWorkspace))
$script = @'
set -euo pipefail
SOURCE=$(printf '%s' '__SOURCE_BASE64__' | base64 -d)
WORK=$(printf '%s' '__WORKSPACE_BASE64__' | base64 -d)
case "$WORK" in
  '~') WORK="$HOME" ;;
  '~/'*) WORK="$HOME/${WORK:2}" ;;
esac

if [ "$(id -u)" -eq 0 ]; then
  echo 'Team DevSpace Linux packaging must run as the normal WSL user, not root.' >&2
  exit 2
fi
systemctl --user show-environment >/dev/null
for command in bash curl git make python3 rsync sha256sum tar; do
  command -v "$command" >/dev/null || { echo "Missing WSL build dependency: $command" >&2; exit 2; }
done

# rsync --delete is safe only inside our source-bound disposable mirror.
# Never remove a caller-selected directory to make room for a clone.
[ ! -L "$WORK" ] || { echo 'The WSL build mirror must not be a symlink.' >&2; exit 2; }
SOURCE=$(realpath -e "$SOURCE")
WORK=$(realpath -m "$WORK")
case "$WORK" in /|"$HOME"|"$SOURCE"|/mnt/*)
  echo "Unsafe WSL build mirror: $WORK" >&2; exit 2 ;;
esac
case "$SOURCE/" in "$WORK/"*) echo 'The build mirror must not contain its source.' >&2; exit 2 ;; esac
if [ -e "$WORK" ] && [ ! -d "$WORK/.git" ]; then
  echo "Refusing to overwrite a directory not owned by this build mirror: $WORK" >&2
  exit 2
fi
if [ -d "$WORK/.git" ]; then
  origin=$(git -C "$WORK" remote get-url origin)
  [ "$origin" = "$SOURCE" ] || { echo 'Refusing to synchronize a mirror belonging to another repository.' >&2; exit 2; }
else
  git clone --quiet "$SOURCE" "$WORK"
fi

# Keep Linux-native dependencies and package caches on the WSL ext4 filesystem.
# Only source files are mirrored from Windows, including uncommitted work.
rsync -a --delete \
  --exclude '/.git/' \
  --exclude '/node_modules/' \
  --exclude '/build/' \
  --exclude '/release/' \
  --exclude '/dist/' \
  --exclude '/coverage/' \
  --exclude '/.runtime/' \
  --exclude '/.artifacts/' \
  --exclude '/.wrangler/' \
  --exclude '/.codegraph/' \
  --exclude '/assets/mcp-app-assets/' \
  "$SOURCE/" "$WORK/"

git -C "$WORK" fetch --quiet "$SOURCE" HEAD
git -C "$WORK" reset --mixed --quiet FETCH_HEAD
cd "$WORK"

# DrvFS synthesizes executable bits from Windows ACLs. Restore the tracked Unix
# modes in the ext4 mirror instead of hiding real changes with core.fileMode=false.
while IFS= read -r -d '' tracked; do
  mode=${tracked%% *}
  path=${tracked#*$'\t'}
  [ -f "$path" ] && [ ! -L "$path" ] || continue
  # Re-checkout only canonically unchanged files so Git applies .gitattributes
  # EOLs as well. Edited source has a different blob and is never replaced.
  blob=${tracked#* }; blob=${blob%% *}
  if [ "$(git hash-object --path="$path" -- "$path")" = "$blob" ]; then
    checkout=$(git checkout-index --temp -- "$path")
    mv -- "${checkout%%$'\t'*}" "$path"
  fi
  case "$mode" in
    100644) chmod 644 -- "$path" ;;
    100755) chmod 755 -- "$path" ;;
  esac
done < <(git ls-files --stage -z)

expected_node="$(python3 -c 'import json; print(json.load(open("release.config.json"))["nodeVersion"])')"
expected_npm="$(python3 -c 'import json; print(json.load(open("package.json"))["packageManager"].split("@", 1)[1])')"
pinned_node="/opt/node-v${expected_node}-linux-x64/bin"
if [ -x "$pinned_node/node" ]; then export PATH="$pinned_node:$PATH"; fi

actual_node="$(node --version 2>/dev/null || true)"
actual_npm="$(npm --version 2>/dev/null || true)"
if [ "$actual_node" != "v$expected_node" ] || [ "$actual_npm" != "$expected_npm" ]; then
  echo "WSL must provide Node v$expected_node and npm $expected_npm (found node=${actual_node:-missing}, npm=${actual_npm:-missing})." >&2
  exit 2
fi

mkdir -p build
root_fingerprint="$({ sha256sum package.json package-lock.json .npmrc; printf '%s\n' "node=$actual_node" "npm=$actual_npm"; } | sha256sum | awk '{print $1}')"
root_marker='build/.wsl-root-dependencies.sha256'
if [ ! -d node_modules ] || [ "$(cat "$root_marker" 2>/dev/null || true)" != "$root_fingerprint" ]; then
  npm ci --no-fund --no-audit
  printf '%s\n' "$root_fingerprint" > "$root_marker"
fi

npm run acceptance:local

version="$(python3 -c 'import json; print(json.load(open("release.config.json"))["version"])')"
artifact="Team-DevSpace-${version}-linux-x64-offline.tar.gz"
(
  cd release
  sha256sum -c "$artifact.sha256"
)
mkdir -p "$SOURCE/release"
cp -f "release/$artifact" "release/$artifact.sha256" "$SOURCE/release/"
# Keep the source-bound acceptance beside the copied artifact; an old report
# from a previous WSL run must not be mistaken for evidence of these bytes.
mkdir -p "$SOURCE/release/offline/$version/linux-x64"
cp -f "release/$artifact" "release/$artifact.sha256" "release/offline/$version/linux-x64/acceptance.json" "$SOURCE/release/offline/$version/linux-x64/"
sha256sum "$SOURCE/release/$artifact"
printf 'Linux x64 acceptance passed.\nArtifact: %s\n' "$SOURCE/release/$artifact"
'@
$script = $script.Replace("`r`n", "`n").Replace('__SOURCE_BASE64__', $sourceBase64).Replace('__WORKSPACE_BASE64__', $workspaceBase64)

$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
& $wsl -d $Distribution -- bash -lc "echo '$encoded' | base64 -d | bash"
if ($LASTEXITCODE -ne 0) { throw "WSL Linux acceptance failed with exit code $LASTEXITCODE." }

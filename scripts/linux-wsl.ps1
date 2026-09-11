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

if [ ! -d "$WORK/.git" ]; then
  rm -rf "$WORK"
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
sha256sum "$SOURCE/release/$artifact"
printf 'Linux x64 acceptance passed.\nArtifact: %s\n' "$SOURCE/release/$artifact"
'@
$script = $script.Replace('__SOURCE_BASE64__', $sourceBase64).Replace('__WORKSPACE_BASE64__', $workspaceBase64)

$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($script))
& $wsl -d $Distribution -- bash -lc "echo '$encoded' | base64 -d | bash"
if ($LASTEXITCODE -ne 0) { throw "WSL Linux acceptance failed with exit code $LASTEXITCODE." }

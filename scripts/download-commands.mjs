import { packageUrls } from './download-catalog.mjs';

const shQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
const psQuote = value => `'${value.replaceAll("'", "''")}'`;

// Each generated script pins ONE immutable release. A stable-channel switch
// between fetching the script and fetching its package cannot mix versions.
export function installScripts(catalog, origin) {
  const urls = packageUrls(catalog, origin);
  const windows = catalog.targets['win32-x64'];
  const powershell = [
    'param([switch]$DownloadOnly, [string]$Destination)',
    "$ErrorActionPreference='Stop'",
    "if ([Environment]::OSVersion.Platform -ne 'Win32NT' -or ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64')) { throw 'This package requires Windows x64' }",
    '[Net.ServicePointManager]::SecurityProtocol=[Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12',
    "$d=Join-Path ([IO.Path]::GetTempPath()) ('tds-'+[guid]::NewGuid().ToString('N'))",
    'New-Item -ItemType Directory -Path $d | Out-Null',
    'try {',
    `  $f=Join-Path $d ${psQuote(windows.file)}`,
    `  Write-Host ${psQuote(`Downloading Team DevSpace ${catalog.version} (Windows x64)...`)}`,
    `  Invoke-WebRequest -UseBasicParsing -Uri ${psQuote(urls['win32-x64'])} -OutFile $f`,
    `  if ((Get-Item -LiteralPath $f).Length -ne ${windows.size} -or (Get-FileHash -LiteralPath $f -Algorithm SHA256).Hash -ne ${psQuote(windows.sha256)}) { throw 'Package verification failed; nothing was installed' }`,
    '  if ($DownloadOnly) {',
    "    if (-not $Destination) { $Destination=Join-Path $HOME 'Downloads' }",
    '    New-Item -ItemType Directory -Path $Destination -Force | Out-Null',
    `    $saved=Join-Path $Destination ${psQuote(windows.file)}`,
    '    Copy-Item -LiteralPath $f -Destination $saved',
    '    Write-Output $saved',
    '  } else {',
    '    $p=Start-Process -FilePath $f -Wait -PassThru',
    "    if ($p.ExitCode -notin @(0,3010)) { throw ('Installer failed: '+$p.ExitCode) }",
    "    Write-Host 'Software installation finished. Enter or change Access Key inside Team DevSpace.'",
    '  }',
    '} finally { Remove-Item -LiteralPath $d -Recurse -Force }',
  ].join('\r\n') + '\r\n';
  const branches = ['darwin-arm64', 'darwin-x64', 'linux-x64'].map(target => {
    const asset = catalog.targets[target];
    return `  ${target}) url=${shQuote(urls[target])}; hash=${shQuote(asset.sha256)}; size=${asset.size}; name=${shQuote(asset.file)};;`;
  }).join('\n');
  const unix = [
    '#!/bin/sh',
    'set -eu',
    'umask 077',
    'download_only=0',
    'case "${1:-}" in "") ;; --download-only) download_only=1;; *) echo "Usage: install.sh [--download-only]" >&2; exit 2;; esac',
    'os=$(uname -s); arch=$(uname -m)',
    'case "$os" in',
    'Darwin)',
    '  if [ "$(/usr/sbin/sysctl -n hw.optional.arm64 2>/dev/null || true)" = 1 ]; then arch=arm64; fi',
    '  case "$arch" in arm64) target=darwin-arm64;; x86_64) target=darwin-x64;; *) echo "Unsupported Mac architecture" >&2; exit 2;; esac;;',
    'Linux)',
    '  [ "$(id -u)" -ne 0 ] || { echo "Run as your normal user, not sudo/root" >&2; exit 2; }',
    '  [ "$arch" = x86_64 ] || { echo "Only Linux x64 is supported" >&2; exit 2; }',
    '  target=linux-x64',
    '  glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true); glibc=${glibc#glibc }',
    '  awk -v v="$glibc" \'BEGIN { split(v,p,"."); exit !(p[1]>2 || (p[1]==2 && p[2]>=34)) }\' || { echo "glibc 2.34+ is required" >&2; exit 2; };;',
    '*) echo "Unsupported operating system" >&2; exit 2;;',
    'esac',
    'command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }',
    `case "$target" in\n${branches}\nesac`,
    'd=$(mktemp -d)',
    'trap \'rm -rf "$d"\' EXIT',
    'trap \'exit 130\' INT; trap \'exit 143\' HUP TERM',
    'f="$d/$name"; printf "Downloading Team DevSpace (%s)...\\n" "$target"',
    'curl --fail --silent --show-error --proto "=https" --tlsv1.2 --connect-timeout 30 --max-time 1800 --retry 2 --output "$f" "$url"',
    'actual_size=$(wc -c < "$f" | tr -d "[:space:]")',
    'if [ "$os" = Darwin ]; then actual=$(shasum -a 256 "$f"); else actual=$(sha256sum "$f"); fi; actual=${actual%% *}',
    '[ "$actual" = "$hash" ] && [ "$actual_size" = "$size" ] || { echo "Package verification failed; nothing was installed" >&2; exit 1; }',
    'if [ "$os" = Darwin ] || [ "$download_only" = 1 ]; then',
    '  mkdir -p "$HOME/Downloads"; saved=$(mktemp -d "$HOME/Downloads/TeamDevSpace.XXXXXX"); mv "$f" "$saved/$name"',
    '  printf "Verified package: %s\\n" "$saved/$name"',
    '  if [ "$download_only" = 0 ]; then',
    '    printf "Complete the macOS Installer and normal security confirmations; no security settings were changed.\\n"',
    '    /usr/bin/open "$saved/$name"',
    '  fi',
    'else',
    '  mkdir "$d/media"; tar -xzf "$f" -C "$d/media"',
    '  sh "$d/media/install.sh" --offline "$d/media" --setup none',
    '  printf "Software installed. Run ~/.local/bin/team-devspace setup to enter your Access Key; use access-key change later.\\n"',
    'fi',
  ].join('\n') + '\n';
  return { windows: powershell, unix };
}

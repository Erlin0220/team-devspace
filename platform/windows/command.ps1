param([Parameter(ValueFromRemainingArguments=$true)][string[]]$ClientArguments)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$activeFile = Join-Path $root 'active.json'
if (-not (Test-Path -LiteralPath $activeFile)) { throw 'No verified Team DevSpace version is active. Run Repair connection.' }
$active = Get-Content -LiteralPath $activeFile -Raw -Encoding UTF8 | ConvertFrom-Json
$versions = [IO.Path]::GetFullPath((Join-Path $root 'v')).TrimEnd('\') + '\'
$version = [IO.Path]::GetFullPath([string]$active.path)
if (-not $version.StartsWith($versions, [StringComparison]::OrdinalIgnoreCase)) { throw 'The active version pointer is invalid.' }
$node = Join-Path $version 'runtime\node.exe'
$cli = Join-Path $version 'client\cli.mjs'
if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $cli)) { throw 'The active version is incomplete. Run Repair connection.' }
& $node $cli @ClientArguments
exit $LASTEXITCODE

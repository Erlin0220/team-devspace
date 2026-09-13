param([switch]$Desktop, [Parameter(ValueFromRemainingArguments=$true)][string[]]$ClientArguments)
$ErrorActionPreference = 'Stop'
try {
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
  if ($LASTEXITCODE -ne 0) { throw "Team DevSpace could not complete the operation (exit $LASTEXITCODE). Run Repair connection from the Start menu. Logs: $env:LOCALAPPDATA\TeamDevSpace\logs\open.error.log" }
} catch {
  if ($Desktop) {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Team DevSpace', 'OK', 'Error')
  } else { Write-Error -Message $_.Exception.Message -ErrorAction Continue }
  exit 1
}
exit 0

param(
  [Parameter(Mandatory=$true)][ValidateSet('runtime','tunnel')][string]$Component,
  [Parameter(Mandatory=$true)][string]$HomePath,
  [Parameter(Mandatory=$true)][string]$InstallPath
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'process-job.ps1')
$state = Get-Content -LiteralPath (Join-Path $HomePath 'state.json') -Raw | ConvertFrom-Json
$env:TEAM_DEVSPACE_HOME = $HomePath
$env:NODE_OPTIONS = $null
# Prefer a verified fallback only when the artifact was needed. Otherwise expose Git for Windows' sibling
# bin directory without changing the employee's user/system PATH.
$pathParts = @()
$bundledBash = Join-Path $InstallPath 'git\bin'
if (Test-Path -LiteralPath (Join-Path $bundledBash 'bash.exe')) {
  $pathParts += $bundledBash
} else {
  $systemGit = Get-Command git.exe -ErrorAction SilentlyContinue
  if ($systemGit) {
    $systemBash = [IO.Path]::GetFullPath((Join-Path (Split-Path $systemGit.Source) '..\bin'))
    if (Test-Path -LiteralPath (Join-Path $systemBash 'bash.exe')) { $pathParts += $systemBash }
  }
}
$pathParts += $env:PATH, (Join-Path $InstallPath 'git\cmd'), (Join-Path $InstallPath 'runtime'), (Join-Path $InstallPath 'bin')
$env:PATH = $pathParts -join ';'
if ($Component -eq 'tunnel') {
  $exe = Join-Path $InstallPath 'bin\cloudflared.exe'
  $arguments = @('--no-autoupdate','tunnel','--metrics',('127.0.0.1:' + $state.ports.metrics),'--loglevel','warn','run','--token-file',(Join-Path $HomePath 'tunnel.token'))
} else {
  $exe = Join-Path $InstallPath 'runtime\node.exe'
  if (-not (Test-Path -LiteralPath $exe)) { throw 'Packaged Node runtime is missing. Run repair installation.' }
  $arguments = @((Join-Path $InstallPath 'client\cli.mjs'),'run',$Component,'--home',$HomePath)
}
$logDirectory = Join-Path $HomePath 'logs'
New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
# Task Scheduler owns recovery. This wrapper only hides the child console and forwards exit status.
$quotedArguments = $arguments | ForEach-Object { '"' + ($_ -replace '"','\"') + '"' }
$child = Start-Process -FilePath $exe -ArgumentList ($quotedArguments -join ' ') -WorkingDirectory $InstallPath -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $logDirectory ($Component + '.log')) -RedirectStandardError (Join-Path $logDirectory ($Component + '.error.log'))
exit $child.ExitCode

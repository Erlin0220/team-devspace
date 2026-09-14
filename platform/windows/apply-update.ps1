param([Parameter(Mandatory=$true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
$request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json
$code = 1
try {
  $env:TEAM_DEVSPACE_HOME = $request.home
  Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = $request.installer
  # NSIS requires /D to be the final, unquoted remainder of the command line.
  $info.Arguments = '/S /D=' + $request.installRoot
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $process = [System.Diagnostics.Process]::Start($info)
  $process.WaitForExit()
  $code = $process.ExitCode
} finally {
  $result = @{ version=$request.version; attemptId=$request.attemptId; exitCode=$code; completedAt=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json -Compress
  $temporary = $request.resultFile + '.tmp'
  [IO.File]::WriteAllText($temporary, $result, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $request.resultFile -Force
  # The task is a single installer handoff outside the tray Job Object, not a daemon.
  Unregister-ScheduledTask -TaskName $request.taskName -Confirm:$false -ErrorAction SilentlyContinue
}
exit $code

param(
  [ValidateSet('Install', 'Uninstall')][string]$Mode = 'Install',
  [string]$InstallPath,
  [string]$ManifestPath,
  [string]$OfflineRoot,
  [string]$RequestFile,
  [switch]$NoStartup
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2
$env:NODE_NO_WARNINGS = '1'

if (-not $InstallPath) { $InstallPath = $PSScriptRoot }
if (-not $ManifestPath) { $ManifestPath = Join-Path $InstallPath 'release-manifest.json' }
$InstallPath = [IO.Path]::GetFullPath($InstallPath)
$ManifestPath = [IO.Path]::GetFullPath($ManifestPath)
$versionsRoot = Join-Path $InstallPath 'v'
$stagingRoot = Join-Path $InstallPath 's'
$activeFile = Join-Path $InstallPath 'active.json'
$stateHome = if ($env:TEAM_DEVSPACE_HOME) { [IO.Path]::GetFullPath($env:TEAM_DEVSPACE_HOME) }
  else { Join-Path $env:LOCALAPPDATA 'TeamDevSpace' }
$shaPattern = '^[a-f0-9]{64}$'
$elevatedSystemDirectory = Join-Path $env:SystemRoot 'System32'
# NSIS is a 32-bit process, so its Windows PowerShell child is also commonly
# 32-bit. In that process, System32 is redirected to SysWOW64 and Sysnative is
# the supported escape hatch for this process's direct native-tool access.
# Never pass Sysnative to a -Verb RunAs launch: the UAC/ShellExecute side no
# longer has the originating WOW64 virtual-path context.
$nativeSystemDirectory = if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
  Join-Path $env:SystemRoot 'Sysnative'
} else {
  $elevatedSystemDirectory
}

function Write-Step([string]$Message) {
  Write-Host "[Team DevSpace] $Message"
}

function Read-Json([string]$Path) {
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Get-DeviceTaskNames {
  $stateFile = Join-Path $stateHome 'state.json'
  if (-not (Test-Path -LiteralPath $stateFile)) { return @() }
  try { $deviceId = [string](Read-Json $stateFile).deviceId } catch { return @() }
  if ($deviceId -notmatch '^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$') { return @() }
  $compact = $deviceId.Replace('-', '')
  return @('runtime', 'tunnel', 'tray') | ForEach-Object { "com.teamdevspace.$compact.$_" }
}

function Get-OwnerTaskNames {
  $stateFile = Join-Path $stateHome 'state.json'
  if (-not (Test-Path -LiteralPath $stateFile)) { return @() }
  try { $ownerToken = [string](Read-Json $stateFile).ownerToken } catch { return @() }
  if ($ownerToken -notmatch '^[A-Za-z0-9_-]{43}$') { return @() }
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($ownerToken)
    $owner = ([BitConverter]::ToString($algorithm.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant().Substring(0, 16)
  } finally { $algorithm.Dispose() }
  return @('runtime', 'tunnel', 'tray') | ForEach-Object { "com.teamdevspace.$owner.$_" }
}

function Get-OwnedLifecycleTaskNames {
  $schtasks = Join-Path $nativeSystemDirectory 'schtasks.exe'
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $names = @()
  $savedPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $lines = @(& $schtasks /Query /FO CSV /NH 2>$null)
    foreach ($line in $lines) {
      if ([string]$line -notmatch '^"([^"]+)"') { continue }
      $name = $Matches[1].TrimStart('\\')
      if ($name -notmatch '^com\.teamdevspace\.(?:[a-f0-9]{16}|[a-f0-9]{32})\.(?:runtime|tunnel|tray)$') { continue }
      $taskXml = @(& $schtasks /Query /TN $name /XML 2>$null) -join "`n"
      if ($LASTEXITCODE -ne 0 -or -not $taskXml) { continue }
      try { $task = [xml]$taskXml } catch { continue }
      $taskSid = [string]$task.Task.Triggers.LogonTrigger.UserId
      $arguments = [string]$task.Task.Actions.Exec.Arguments
      $expectedHome = '"TEAM_DEVSPACE_HOME=' + $stateHome + '"'
      if ($taskSid -eq $sid -and $arguments.Contains($expectedHome)) { $names += $name }
    }
  } finally { $ErrorActionPreference = $savedPreference }
  return @($names | Select-Object -Unique)
}

function Get-KnownTaskNames {
  $names = @(Get-OwnerTaskNames) + @(Get-DeviceTaskNames) + @(Get-OwnedLifecycleTaskNames)
  return @($names | Select-Object -Unique)
}

function Test-LegacyTaskNeedsElevation([string]$Name) {
  try {
    # Query Task Scheduler through its own API instead of inspecting
    # System32\Tasks. NSIS launches a 32-bit PowerShell process on x64 Windows,
    # where filesystem redirection can make the task-file view misleading.
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $registered = $service.GetFolder('\').GetTask($Name)
    $owner = [string]$registered.GetSecurityDescriptor(1) # OWNER_SECURITY_INFORMATION
    return $owner -in @('O:BA', 'O:SY')
  } catch { return $false }
}

function Remove-KnownStartupEntries {
  $schtasks = Join-Path $nativeSystemDirectory 'schtasks.exe'
  $failures = @()
  foreach ($name in @(Get-KnownTaskNames)) {
    # Windows PowerShell 5 can promote native stderr to a terminating error when
    # ErrorActionPreference=Stop. Missing tasks are expected here, so inspect the
    # native exit code explicitly instead of letting stderr bypass the fallback.
    $savedPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      & $schtasks /Query /TN $name *> $null
      $queryCode = $LASTEXITCODE
      if ($queryCode -ne 0) { continue }
      & $schtasks /End /TN $name *> $null
      & $schtasks /Delete /TN $name /F *> $null
      $deleteCode = $LASTEXITCODE
    } finally { $ErrorActionPreference = $savedPreference }
    if ($deleteCode -ne 0) { $failures += $name }
  }
  if ($failures.Count) { throw "Could not remove Team DevSpace startup tasks: $($failures -join ", ")" }
}

function Invoke-LegacyTaskCleanupIfNeeded {
  $known = @(Get-KnownTaskNames)
  $legacy = @($known | Where-Object { Test-LegacyTaskNeedsElevation $_ })
  if ($legacy.Count -eq 0) { return }
  Write-Step 'Migrating legacy administrator-owned startup tasks once...'
  # UAC launches through ShellExecute, outside the originating WOW64 virtual
  # path context. Use a single hidden PowerShell helper instead of a console shell so
  # the one-time legacy migration never flashes a console window.
  $schtasks = Join-Path $elevatedSystemDirectory 'schtasks.exe'
  $elevatedPowerShell = Join-Path $elevatedSystemDirectory 'WindowsPowerShell\v1.0\powershell.exe'
  $escapedTool = $schtasks.Replace("'", "''")
  $commands = foreach ($name in $legacy) {
    # Names are derived only from validated Team DevSpace lifecycle labels.
    $escapedName = $name.Replace("'", "''")
    "& '$escapedTool' /End /TN '$escapedName' *> `$null; & '$escapedTool' /Delete /TN '$escapedName' /F *> `$null; if (`$LASTEXITCODE -ne 0) { exit 1 }"
  }
  $script = "`$ErrorActionPreference = 'SilentlyContinue'; $($commands -join '; '); exit 0"
  $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $arguments = @('-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', $encoded)
  $process = Start-Process -FilePath $elevatedPowerShell -Verb RunAs -ArgumentList $arguments -WindowStyle Hidden -Wait -PassThru
  if ($process.ExitCode -ne 0) { throw 'Legacy Team DevSpace startup tasks require one-time administrator cleanup.' }
}

function Get-InstallProcessIds {
  $root = [IO.Path]::GetFullPath($InstallPath).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  $names = @('tds-launcher.exe', 'node.exe', 'cloudflared.exe', 'team-devspace-tray.exe')
  return @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    $path = [string]$_.ExecutablePath
    $path -and $names -contains ([string]$_.Name).ToLowerInvariant() -and
      $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
  } | ForEach-Object { [int]$_.ProcessId })
}

function Stop-OwnedInstallProcess([int]$ProcessId) {
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if (-not $process) { return }
  try {
    # Pin the native process object before validating its executable. A stale
    # numeric PID must never authorize stopping a newly reused foreign process.
    [void]$process.Handle
    $path = [string]$process.Path
    $root = [IO.Path]::GetFullPath($InstallPath).TrimEnd([IO.Path]::DirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $names = @('tds-launcher.exe', 'node.exe', 'cloudflared.exe', 'team-devspace-tray.exe')
    if ($path -and $names -contains ([IO.Path]::GetFileName($path).ToLowerInvariant()) -and
        $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { $process.Kill() }
  } finally { $process.Dispose() }
}
function Stop-InstallProcesses {
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  do {
    $ids = @(Get-InstallProcessIds)
    if ($ids.Count -eq 0) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)

  foreach ($processId in $ids) {
    try { Stop-OwnedInstallProcess $processId } catch { } # The final ownership query still decides success.
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(3)
  do {
    $remaining = @(Get-InstallProcessIds)
    if ($remaining.Count -eq 0) { return }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Team DevSpace processes are still running after startup removal: $($remaining -join ', ')"
}

function Get-Sha256([string]$Path) {
  $stream = [IO.File]::OpenRead($Path)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $algorithm.Dispose(); $stream.Dispose() }
}

function Write-AtomicJson([string]$Path, [object]$Value) {
  $temporary = "$Path.$([guid]::NewGuid().ToString('N')).tmp"
  try {
    [IO.File]::WriteAllText($temporary, (($Value | ConvertTo-Json -Depth 8) + "`n"), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Test-ChildPath([string]$Parent, [string]$Child) {
  $parentPath = [IO.Path]::GetFullPath($Parent).TrimEnd('\') + '\'
  return [IO.Path]::GetFullPath($Child).StartsWith($parentPath, [StringComparison]::OrdinalIgnoreCase)
}

function Get-Active {
  if (-not (Test-Path -LiteralPath $activeFile)) { return $null }
  $value = Read-Json $activeFile
  if (-not $value.path -or -not (Test-ChildPath $versionsRoot ([string]$value.path))) {
    throw 'The active version pointer is invalid. Re-run the trusted Team DevSpace installer.'
  }
  return $value
}

function Invoke-Client([string]$Root, [string[]]$Arguments, [switch]$AllowFailure) {
  $node = Join-Path $Root 'runtime\node.exe'
  $cli = Join-Path $Root 'client\cli.mjs'
  if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $cli)) {
    if ($AllowFailure) { return 1 }
    throw "Installed client is incomplete: $Root"
  }
  $clientArguments = @($Arguments) + '--installer-progress'
  $output = @(& $node $cli @clientArguments 2>&1)
  $code = $LASTEXITCODE
  foreach ($line in $output) { Write-Host $line }
  if ($code -ne 0 -and -not $AllowFailure) {
    $detail = if ($output.Count) { [string]$output[$output.Count - 1] } else { 'No client diagnostic was produced.' }
    throw "Team DevSpace client exited $code. $detail"
  }
  return $code
}

function Test-NeedGitFallback {
  foreach ($entry in @($env:PATH -split ';')) {
    $directory = $entry.Trim('"')
    if ([string]::IsNullOrWhiteSpace($directory)) { continue }
    $git = Join-Path $directory 'git.exe'
    if (-not (Test-Path -LiteralPath $git -PathType Leaf)) { continue }
    $bash = Join-Path (Split-Path $directory -Parent) 'bin\bash.exe'
    if (Test-Path -LiteralPath $bash -PathType Leaf) { return $false }
  }
  return $true
}

function Assert-Manifest([object]$Manifest) {
  if ($Manifest.schema -ne 1 -or $Manifest.trust -ne 'bootstrap-embedded-manifest' -or
      $Manifest.target -ne 'win32-x64' -or $Manifest.release -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$') {
    throw 'This release manifest is not valid for Windows x64.'
  }
  if ($Manifest.installMode -ne 'offline') {
    throw 'This installer only accepts the offline release contract.'
  }
  $names = @{}
  foreach ($component in @($Manifest.components)) {
    $name = [string]$component.name
    if ($names.ContainsKey($name)) { throw "Duplicate component in manifest: $name" }
    $names[$name] = $true
    $suffix = if ($component.format -eq '7z-sfx' -and $name -eq 'git-fallback') { '\.7z\.exe' }
      elseif ($component.format -eq 'tar.gz') { '\.tar\.gz' } else { throw "Unsupported component format: $name" }
    if ($name -notin @('app', 'devspace-runtime', 'node', 'cloudflared', 'git-fallback') -or
        [string]$component.sha256 -notmatch $shaPattern -or
        [int64]$component.size -le 0 -or [int64]$component.size -gt 2147483648 -or
        [string]$component.path -notmatch "^objects/sha256/$($component.sha256)/[A-Za-z0-9._-]+$suffix`$") {
      throw "Invalid artifact metadata for component: $name"
    }
  }
  foreach ($required in @('app', 'devspace-runtime', 'node', 'cloudflared')) {
    if (-not $names.ContainsKey($required)) { throw "Release manifest lacks required component: $required" }
  }
}

function Assert-Artifact([string]$Path, [object]$Component) {
  $item = Get-Item -LiteralPath $Path
  if ($item.Length -ne [int64]$Component.size) { throw "Artifact size mismatch: $($Component.name)" }
  $actual = Get-Sha256 $Path
  if ($actual -ne [string]$Component.sha256) { throw "Artifact SHA-256 mismatch: $($Component.name)" }
}

function Receive-Artifact([object]$Component) {
  if (-not $OfflineRoot) { throw 'The embedded offline payload is unavailable.' }
  $artifact = Join-Path $OfflineRoot (([string]$Component.path) -replace '/', '\')
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "Embedded artifact is missing: $($Component.name)"
  }
  Assert-Artifact $artifact $Component
  return $artifact
}

function Expand-VerifiedArchive([string]$Archive, [string]$Destination) {
  $tar = Join-Path $nativeSystemDirectory 'tar.exe'
  $entries = & $tar -tzf $Archive
  if ($LASTEXITCODE -ne 0) { throw "Cannot inspect artifact archive: $Archive" }
  foreach ($entry in $entries) {
    if ($entry -match '^[\\/]' -or $entry -match '^[A-Za-z]:' -or $entry -match '(^|[\\/])\.\.([\\/]|$)') {
      throw "Artifact contains an unsafe path: $entry"
    }
  }
  & $tar -xzf $Archive -C $Destination
  if ($LASTEXITCODE -ne 0) { throw "Cannot extract artifact archive: $Archive" }
}

function Expand-PortableGit([string]$Archive, [string]$Destination) {
  # Execute only the already SHA-256-verified official SFX, in an isolated
  # staging directory. Its fixed PortableGit/ output never pollutes the cache.
  $temporary = Join-Path $Destination '.git-extract'
  New-Item -ItemType Directory -Path $temporary | Out-Null
  try {
    $extractor = Join-Path $temporary 'PortableGit.7z.exe'
    Copy-Item -LiteralPath $Archive -Destination $extractor
    $process = Start-Process -FilePath $extractor -ArgumentList @('-y', '-gm2') -WorkingDirectory $temporary -Wait -PassThru -WindowStyle Hidden
    if ($process.ExitCode -ne 0) { throw "PortableGit self-extraction failed: $($process.ExitCode)" }
    $expanded = Join-Path $temporary 'PortableGit'
    foreach ($file in @('cmd\git.exe', 'bin\bash.exe')) {
      if (-not (Test-Path -LiteralPath (Join-Path $expanded $file))) { throw "PortableGit is missing $file" }
    }
    Move-Item -LiteralPath $expanded -Destination (Join-Path $Destination 'git')
  } finally { Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction SilentlyContinue }
}

function Remove-PreviousPayload([string]$Current) {
  # Cleanup is post-commit and best effort. A locked old version must not turn a
  # successful activation into an installation failure.
  foreach ($directory in @(Get-ChildItem -LiteralPath $versionsRoot -Directory)) {
    if ([IO.Path]::GetFullPath($directory.FullName) -ne [IO.Path]::GetFullPath($Current)) {
      try { Remove-Item -LiteralPath $directory.FullName -Recurse -Force }
      catch { Write-Warning "Old version cleanup deferred: $($directory.Name)" }
    }
  }
}

function Remove-PayloadTree([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return }
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  do {
    try {
      # Task Scheduler can report /End just before the process releases its executable files.
      [IO.Directory]::Delete($Path, $true)
      return
    } catch {
      if ([DateTime]::UtcNow -ge $deadline) { break }
      Start-Sleep -Milliseconds 100
    }
  } while (Test-Path -LiteralPath $Path)
  if (-not (Test-Path -LiteralPath $Path)) { return }
  # One forceful final attempt also covers unusual read-only attributes.
  Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
  if (Test-Path -LiteralPath $Path) { throw "Could not remove installed payload: $Path" }
}

function Assert-Version([string]$Root, [object]$Manifest) {
  $node = Join-Path $Root 'runtime\node.exe'
  $cloudflared = Join-Path $Root 'bin\cloudflared.exe'
  $upstreamFile = Join-Path $Root 'node_modules\@waishnav\devspace\package.json'
  $releaseFile = Join-Path $Root 'release.config.json'
  $launcher = Join-Path $Root 'platform\windows\tds-launcher.exe'
  foreach ($path in @($node, $cloudflared, $launcher, $upstreamFile, $releaseFile, (Join-Path $Root 'client\cli.mjs'))) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Installed version is missing: $path" }
  }
  if ((& $node --version).Trim() -ne "v$($Manifest.runtime.nodeVersion)") { throw 'Installed Node version differs from manifest.' }
  if ((Read-Json $upstreamFile).version -ne $Manifest.runtime.devspaceVersion) { throw 'Installed DevSpace version differs from manifest.' }
  if ((Read-Json $releaseFile).version -ne $Manifest.release) { throw 'Installed app version differs from manifest.' }
  if ((& $cloudflared --version) -notmatch [regex]::Escape([string]$Manifest.runtime.cloudflaredVersion)) { throw 'Installed cloudflared version differs from manifest.' }
  Push-Location $Root
  try {
    & $node --input-type=module -e "import{createRequire}from'node:module';const r=createRequire(new URL('./package.json',import.meta.url)),D=r('better-sqlite3'),d=new D(':memory:');d.prepare('SELECT 1').get();d.close()" 2>$null
    $nativeCode = $LASTEXITCODE
  } finally { Pop-Location }
  if ($nativeCode -ne 0) { throw 'Installed native SQLite module failed to load.' }
  $git = Join-Path $Root 'git\cmd\git.exe'
  $bash = Join-Path $Root 'git\bin\bash.exe'
  if ((Test-Path -LiteralPath $git) -or (Test-Path -LiteralPath $bash)) {
    if (-not (Test-Path -LiteralPath $git) -or -not (Test-Path -LiteralPath $bash)) { throw 'Git fallback is incomplete.' }
    if ((& $git --version) -notmatch [regex]::Escape([string]$Manifest.runtime.gitFallbackVersion)) { throw 'Git fallback version differs from manifest.' }
    if ((& $bash --version | Out-String) -notmatch 'GNU bash') { throw 'Git fallback Bash did not execute.' }
  }
}

function Stop-CandidateForRollback([string]$Candidate) {
  $removed = $false
  try { $removed = (Invoke-Client $Candidate @('uninstall') -AllowFailure) -eq 0 } catch {}
  $failures = @()
  if (-not $removed) {
    try { Remove-KnownStartupEntries } catch { $failures += $_.Exception.Message }
  }
  # Reuse the existing owned-installation fallback; never delete a possibly live
  # candidate or activate another version until all owned processes are stopped.
  try { Stop-InstallProcesses } catch { $failures += $_.Exception.Message }
  if ($failures.Count) { throw "Candidate cleanup failed; its payload was retained for repair: $($failures -join '; ')" }
}
function Restore-Previous([object]$Previous, [string]$InstallerRoot) {
  if (-not $Previous) { return }
  Write-Warning 'New version did not start successfully; restoring the previous startup entries.'
  [void](Invoke-Client $InstallerRoot @('startup', 'install', '--runtime-root', [string]$Previous.path))
}

New-Item -ItemType Directory -Path $InstallPath -Force | Out-Null
$lockPath = Join-Path $InstallPath 'distribution.lock'
$lock = $null
try {
  $lock = [IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None')
  Write-Step 'Checking the current installation and protected Enrollment state...'
  Invoke-LegacyTaskCleanupIfNeeded
  $active = $null
  try { $active = Get-Active }
  catch {
    if ($Mode -ne 'Uninstall') { throw }
    Write-Warning 'The active version pointer is damaged; uninstall will use the retained device identity instead.'
  }
  if ($Mode -eq 'Uninstall') {
    Write-Step 'Stopping Team DevSpace and removing current-user startup entries...'
    $removedByClient = $false
    if ($active) { $removedByClient = (Invoke-Client ([string]$active.path) @('uninstall') -AllowFailure) -eq 0 }
    if (-not $removedByClient) {
      Write-Warning 'The installed client is unavailable; removing only this device startup entries directly.'
      Remove-KnownStartupEntries
    }
    Stop-InstallProcesses
    Write-Step 'Removing local application payload...'
    foreach ($name in @('versions', 'staging', 'v', 's', 'cache', 'a')) {
      Remove-PayloadTree (Join-Path $InstallPath $name)
    }
    Write-Step 'Application payload and startup entries removed. Enrollment and project files are retained.'
    exit 0
  }

  Write-Step 'Verifying the installer manifest...'
  $manifest = Read-Json $ManifestPath
  Assert-Manifest $manifest
  if (-not $OfflineRoot -or -not (Test-Path -LiteralPath (Join-Path $OfflineRoot 'objects') -PathType Container)) {
    throw 'The installer embedded payload is unavailable.'
  }
  New-Item -ItemType Directory -Path $versionsRoot, $stagingRoot -Force | Out-Null
  $manifestSha = Get-Sha256 $ManifestPath
  $stateFile = Join-Path $stateHome 'state.json'
  $hasEnrollment = $false
  if (Test-Path -LiteralPath $stateFile) {
    try {
      $savedState = Read-Json $stateFile
      $hasEnrollment = -not [string]::IsNullOrWhiteSpace([string]$savedState.bindingId) -and
        -not [string]::IsNullOrWhiteSpace([string]$savedState.keyId)
    } catch {
      Write-Warning 'Existing device state is unreadable. The local application can still be installed; Repair connection will report the state problem.'
    }
  }
  $stage = $stagingRoot
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    foreach ($component in @($manifest.components)) {
      $condition = if ($component.PSObject.Properties['condition']) { [string]$component.condition } else { '' }
      if ($condition -eq 'git-unavailable' -and -not (Test-NeedGitFallback)) { continue }
      $componentName = switch ([string]$component.name) {
        'app' { 'Team DevSpace application' }
        'devspace-runtime' { 'DevSpace runtime dependency set' }
        'node' { 'Node.js runtime' }
        'cloudflared' { 'Cloudflare connection helper' }
        'git-fallback' { 'Git fallback' }
        default { [string]$component.name }
      }
      Write-Step "Verifying and unpacking $componentName..."
      $archive = Receive-Artifact $component
      if ($component.format -eq '7z-sfx') { Expand-PortableGit $archive $stage }
      else { Expand-VerifiedArchive $archive $stage }
      Write-Step "$componentName is ready."
    }
    Copy-Item -LiteralPath $ManifestPath -Destination (Join-Path $stage 'install-manifest.json')
    Write-Step 'Checking executable and native dependency versions...'
    Assert-Version $stage $manifest

    # Keep one verified previous slot only until the new local application is committed.
    # The short A/B paths preserve compatibility with the unmodified upstream dependency tree under MAX_PATH.
    $slot0 = Join-Path $versionsRoot '0'
    $slot1 = Join-Path $versionsRoot '1'
    $candidate = if ($active -and [IO.Path]::GetFullPath([string]$active.path) -eq [IO.Path]::GetFullPath($slot0)) { $slot1 } else { $slot0 }
    Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $stage -Destination $candidate
    $stage = $null

    if ($active) {
      Write-Step 'Stopping the active local version before the atomic switch...'
      if (-not (Test-Path -LiteralPath $stateFile)) {
        # Before first setup, the desktop may run without any Enrollment state.
        # Stop only processes rooted in this owned installation, not other clients.
        Stop-InstallProcesses
      } elseif ((Invoke-Client ([string]$active.path) @('stop') -AllowFailure) -ne 0) {
        $restartCode = Invoke-Client ([string]$active.path) @('start') -AllowFailure
        Remove-Item -LiteralPath $candidate -Recurse -Force
        if ($restartCode -eq 0) {
          throw 'Could not fully stop the current Team DevSpace version; it was restarted and the local upgrade was cancelled.'
        }
        throw 'Could not fully stop or restart the current Team DevSpace version; the local upgrade was cancelled before activation.'
      }
    }

    $setup = @('setup')
    if ($RequestFile) { $setup += @('--request-file', $RequestFile) }
    if ($NoStartup) { $setup += '--no-startup' }

    if ($hasEnrollment) {
      try {
        Write-Step 'Reusing the existing Enrollment and refreshing local startup entries...'
        [void](Invoke-Client $candidate $setup)
      } catch {
        $setupFailure = $_.Exception.Message
        Stop-CandidateForRollback $candidate
        if ($active) { Restore-Previous $active $candidate }
        Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
        throw $setupFailure
      }
    }

    $next = [ordered]@{
      schema = 1; release = [string]$manifest.release; target = [string]$manifest.target
      manifestSha256 = $manifestSha; path = $candidate
      previous = $null
    }
    try {
      Write-AtomicJson $activeFile $next
    } catch {
      $activationFailure = $_.Exception.Message
      $recovery = 'candidate startup was removed'
      if ($hasEnrollment) {
        Stop-CandidateForRollback $candidate
        if ($active) { Restore-Previous $active $candidate; $recovery = 'previous version was restored' }
      }
      Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
      throw "Local activation pointer update failed; ${recovery}: $activationFailure"
    }
    Write-Step "Team DevSpace $($manifest.release) local application is installed."

    # Legacy explicit automation requests remain supported; ordinary installs
    # never require a credential or attempt Enrollment. The application owns setup.
    if (-not $hasEnrollment -and $RequestFile) {
      try {
        Write-Step 'Completing explicitly requested Enrollment after the local installation commit...'
        [void](Invoke-Client $candidate $setup)
        Remove-Item -LiteralPath (Join-Path $InstallPath 'onboarding-error.log') -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $InstallPath 'onboarding-message.txt') -Force -ErrorAction SilentlyContinue
      } catch {
        $setupFailure = $_.Exception.Message
        [void](Invoke-Client $candidate @('uninstall') -AllowFailure)
        $failure = "Team DevSpace is installed, but connection setup did not complete: $setupFailure"
        $displayFailure = $setupFailure
        if ($setupFailure -match 'Team DevSpace:\s*(.+)$') { $displayFailure = $Matches[1] }
        try {
          [IO.File]::AppendAllText((Join-Path $InstallPath 'onboarding-error.log'), "$(Get-Date -Format o) $failure`r`n")
          [IO.File]::WriteAllText((Join-Path $InstallPath 'onboarding-message.txt'), $displayFailure, [Text.Encoding]::Unicode)
        } catch { Write-Warning 'Onboarding diagnostic files are unavailable.' }
        Write-Warning $failure
        Write-Warning 'Use Repair connection after network or credential issues are resolved. The installed application will not be rolled back.'
        exit 10
      }
    }

    Write-Step 'Removing the previous local version...'
    try { Remove-PreviousPayload $candidate }
    catch { Write-Warning 'Old version cleanup was deferred; the active version remains installed.' }
    Write-Step 'Installation complete. Runtime connectivity is reported separately by Status/Tray.'
  } finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue }
  }
} catch {
  $failure = "Team DevSpace bootstrap failed: $($_.Exception.Message)"
  try { [IO.File]::AppendAllText((Join-Path $InstallPath 'bootstrap-error.log'), "$(Get-Date -Format o) $failure`r`n") } catch {}
  Write-Error $failure
  exit 1
} finally {
  if ($lock) { $lock.Dispose() }
}

param(
  [ValidateSet('Install', 'Repair', 'Uninstall')][string]$Mode = 'Install',
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
$cacheRoot = Join-Path $InstallPath 'cache\sha256'
$activeFile = Join-Path $InstallPath 'active.json'
$legacyRoot = Join-Path $InstallPath 'a'
$shaPattern = '^[a-f0-9]{64}$'

function Write-Step([string]$Message) {
  Write-Host "[Team DevSpace] $Message"
}

function Read-Json([string]$Path) {
  return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
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
  if (Test-Path -LiteralPath $activeFile) {
    $value = Read-Json $activeFile
    if (-not $value.path -or -not (Test-ChildPath $versionsRoot ([string]$value.path))) {
      throw 'The active version pointer is invalid. Run Repair from a trusted installer.'
    }
    return $value
  }
  $legacyNode = Join-Path $legacyRoot 'runtime\node.exe'
  $legacyClient = Join-Path $legacyRoot 'client\cli.mjs'
  if ((Test-Path -LiteralPath $legacyNode) -and (Test-Path -LiteralPath $legacyClient)) {
    return [pscustomobject]@{ release = 'legacy'; path = $legacyRoot; manifestSha256 = ''; previous = $null }
  }
  if ((Test-Path -LiteralPath $legacyNode) -or (Test-Path -LiteralPath $legacyClient)) {
    Write-Warning 'Incomplete legacy payload ignored; the verified candidate will replace it.'
  }
  return $null
}

function Invoke-Client([string]$Root, [string[]]$Arguments, [switch]$AllowFailure) {
  $node = Join-Path $Root 'runtime\node.exe'
  $cli = Join-Path $Root 'client\cli.mjs'
  if (-not (Test-Path -LiteralPath $node) -or -not (Test-Path -LiteralPath $cli)) {
    if ($AllowFailure) { return 1 }
    throw "Installed client is incomplete: $Root"
  }
  $clientArguments = @($Arguments) + '--installer-progress'
  & $node $cli @clientArguments | Out-Host
  $code = $LASTEXITCODE
  if ($code -ne 0 -and -not $AllowFailure) { throw "Team DevSpace client exited $code" }
  return $code
}

function Test-NeedGitFallback {
  $git = Get-Command git.exe -ErrorAction SilentlyContinue
  $bash = Get-Command bash.exe -ErrorAction SilentlyContinue
  if ($git -and -not $bash) {
    $candidate = [IO.Path]::GetFullPath((Join-Path (Split-Path $git.Source) '..\bin\bash.exe'))
    if (Test-Path -LiteralPath $candidate) { $bash = $candidate }
  }
  return -not ($git -and $bash)
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

function Receive-Artifact([object]$Manifest, [object]$Component) {
  $directory = Join-Path $cacheRoot ([string]$Component.sha256)
  $fileName = Split-Path ([string]$Component.path) -Leaf
  $destination = Join-Path $directory $fileName
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
  if (Test-Path -LiteralPath $destination) {
    try { Assert-Artifact $destination $Component; return $destination }
    catch { Remove-Item -LiteralPath $destination -Force }
  }
  $temporary = "$destination.$([guid]::NewGuid().ToString('N')).partial"
  try {
    $offlineArtifact = if ($OfflineRoot) { Join-Path $OfflineRoot (([string]$Component.path) -replace '/', '\') } else { '' }
    if ($offlineArtifact -and (Test-Path -LiteralPath $offlineArtifact)) {
      Copy-Item -LiteralPath $offlineArtifact -Destination $temporary
    } else {
      throw "Artifact $($Component.name) is missing from the offline release package. Re-run setup from the complete package supplied by your administrator."
    }
    Assert-Artifact $temporary $Component
    Move-Item -LiteralPath $temporary -Destination $destination
    return $destination
  } finally {
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
  }
}

function Resolve-OfflineRoot([string]$Root, [object]$Manifest) {
  if (-not $Root) { return '' }
  if (Test-Path -LiteralPath (Join-Path $Root 'objects') -PathType Container) { return $Root }
  $nested = Join-Path $Root (Join-Path 'offline' (Join-Path ([string]$Manifest.release) ([string]$Manifest.target)))
  if (Test-Path -LiteralPath (Join-Path $nested 'objects') -PathType Container) { return $nested }
  return $Root
}

function Expand-VerifiedArchive([string]$Archive, [string]$Destination) {
  $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
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

function Remove-UnreferencedPayload([string]$Current, [object]$Manifest) {
  # Cleanup is post-commit and best effort. A locked old file must not report a
  # successful activation as failed; a later repair retries the same cleanup.
  $hashes = @($Manifest.components | ForEach-Object { [string]$_.sha256 })
  foreach ($directory in @(Get-ChildItem -LiteralPath $versionsRoot -Directory)) {
    if ($directory.FullName -ne $Current) {
      try { Remove-Item -LiteralPath $directory.FullName -Recurse -Force }
      catch { Write-Warning "Old version cleanup deferred: $($directory.Name)" }
    }
  }
  if ((Test-Path -LiteralPath $legacyRoot) -and
      [IO.Path]::GetFullPath($legacyRoot) -ne [IO.Path]::GetFullPath($Current)) {
    try { Remove-Item -LiteralPath $legacyRoot -Recurse -Force }
    catch { Write-Warning 'Legacy payload cleanup deferred until next repair.' }
  }
  foreach ($directory in @(Get-ChildItem -LiteralPath $cacheRoot -Directory)) {
    if ($directory.Name -match $shaPattern -and $hashes -notcontains $directory.Name) {
      try { Remove-Item -LiteralPath $directory.FullName -Recurse -Force }
      catch { Write-Warning 'Unused artifact cache cleanup deferred.' }
    }
  }
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
  $active = Get-Active
  if ($Mode -eq 'Uninstall') {
    Write-Step 'Stopping Team DevSpace and removing current-user startup entries...'
    if ($active) { [void](Invoke-Client ([string]$active.path) @('uninstall')) }
    Write-Step 'Startup entries removed. Enrollment and project files are retained.'
    exit 0
  }

  Write-Step 'Verifying the installer manifest...'
  $manifest = Read-Json $ManifestPath
  Assert-Manifest $manifest
  $OfflineRoot = Resolve-OfflineRoot $OfflineRoot $manifest
  New-Item -ItemType Directory -Path $versionsRoot, $stagingRoot, $cacheRoot -Force | Out-Null
  $manifestSha = Get-Sha256 $ManifestPath
  $stage = $stagingRoot
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    foreach ($component in @($manifest.components)) {
      $condition = if ($component.PSObject.Properties['condition']) { [string]$component.condition } else { '' }
      if ($condition -eq 'git-and-bash-unavailable' -and -not (Test-NeedGitFallback)) { continue }
      $componentName = switch ([string]$component.name) {
        'app' { 'Team DevSpace application' }
        'devspace-runtime' { 'DevSpace runtime dependency set' }
        'node' { 'Node.js runtime' }
        'cloudflared' { 'Cloudflare connection helper' }
        'git-fallback' { 'Git and Bash fallback' }
        default { [string]$component.name }
      }
      Write-Step "Verifying and unpacking $componentName..."
      $archive = Receive-Artifact $manifest $component
      if ($component.format -eq '7z-sfx') { Expand-PortableGit $archive $stage }
      else { Expand-VerifiedArchive $archive $stage }
      Write-Step "$componentName is ready."
    }
    Copy-Item -LiteralPath $ManifestPath -Destination (Join-Path $stage 'install-manifest.json')
    Write-Step 'Checking executable and native dependency versions...'
    Assert-Version $stage $manifest

    # Fixed short A/B slots keep the unmodified upstream dependency tree under Windows MAX_PATH.
    # Full release/hash identity stays in active.json. Keep current until setup
    # succeeds; retire it only after the active pointer is committed.
    $slot0 = Join-Path $versionsRoot '0'
    $slot1 = Join-Path $versionsRoot '1'
    $candidate = if ($active -and [IO.Path]::GetFullPath([string]$active.path) -eq [IO.Path]::GetFullPath($slot0)) { $slot1 } else { $slot0 }
    Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $stage -Destination $candidate
    $stage = $null

    if ($active) {
      Write-Step 'Stopping the active version before the atomic upgrade switch...'
      if ((Invoke-Client ([string]$active.path) @('stop') -AllowFailure) -ne 0) {
        $restartCode = Invoke-Client ([string]$active.path) @('start') -AllowFailure
        Remove-Item -LiteralPath $candidate -Recurse -Force
        if ($restartCode -eq 0) {
          throw 'Could not fully stop the current Team DevSpace version; its startup entries were restarted and the upgrade was cancelled.'
        }
        throw 'Could not fully stop or restart the current Team DevSpace version; the upgrade was cancelled before activation.'
      }
    }
    $setup = @('setup')
    if ($RequestFile) { $setup += @('--request-file', $RequestFile) }
    if ($NoStartup) { $setup += '--no-startup' }
    try {
      Write-Step 'Configuring Enrollment and current-user background startup...'
      [void](Invoke-Client $candidate $setup)
      $next = [ordered]@{
        schema = 1; release = [string]$manifest.release; target = [string]$manifest.target
        manifestSha256 = $manifestSha; path = $candidate
        previous = $null
      }
      Write-AtomicJson $activeFile $next
      Write-Step "Team DevSpace $($manifest.release) is now active."
    } catch {
      $setupFailure = $_.Exception.Message
      $cleanupCode = Invoke-Client $candidate @('uninstall') -AllowFailure
      $restoreFailure = $null
      if ($active) {
        try { Restore-Previous $active $candidate }
        catch { $restoreFailure = $_.Exception.Message }
      }
      Remove-Item -LiteralPath $candidate -Recurse -Force -ErrorAction SilentlyContinue
      if ($restoreFailure -and $cleanupCode -ne 0) {
        throw "$setupFailure Candidate startup cleanup also failed. Previous startup restoration also failed: $restoreFailure"
      }
      if ($restoreFailure) { throw "$setupFailure Previous startup restoration also failed: $restoreFailure" }
      if ($cleanupCode -ne 0) {
        if ($active) {
          throw "$setupFailure Candidate startup cleanup also failed. Previous startup entries were reinstalled, but running state is not confirmed."
        }
        throw "$setupFailure Candidate startup cleanup also failed; run Uninstall from this package before retrying."
      }
      throw $setupFailure
    }

    Write-Step 'Removing the previous version and unused verified cache; this can take a moment...'
    try { Remove-UnreferencedPayload $candidate $manifest }
    catch { Write-Warning 'Post-activation cleanup deferred until next repair.' }
    Write-Step 'Installation complete. Payload source: verified offline package/cache.'
  } finally {
    if ($stage -and (Test-Path -LiteralPath $stage)) { Remove-Item -LiteralPath $stage -Recurse -Force }
  }
} catch {
  $failure = "Team DevSpace bootstrap failed: $($_.Exception.Message)"
  [IO.File]::AppendAllText((Join-Path $InstallPath 'bootstrap-error.log'), "$(Get-Date -Format o) $failure`r`n")
  Write-Error $failure
  exit 1
} finally {
  if ($lock) { $lock.Dispose() }
}

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-SignTool([string]$Executable, [string[]]$Arguments, [string]$Stage, [int]$TimeoutSeconds = 60) {
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Executable
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  foreach ($argument in $Arguments) { [void]$startInfo.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::Start($startInfo)
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      try { $process.Kill($true) } catch {}
      throw "signtool $Stage exceeded ${TimeoutSeconds}s"
    }
    $stdout = $stdoutTask.GetAwaiter().GetResult()
    $stderr = $stderrTask.GetAwaiter().GetResult()
    if ($stdout) { Write-Host $stdout.TrimEnd() }
    if ($stderr) { Write-Host $stderr.TrimEnd() }
    if ($process.ExitCode -ne 0) { throw "signtool $Stage failed with exit code $($process.ExitCode)" }
  }
  finally { $process.Dispose() }
}

function Add-CurrentUserCertificate([string]$StoreName, [System.Security.Cryptography.X509Certificates.X509Certificate2]$Certificate) {
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    $StoreName,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
  )
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $store.Add($Certificate)
  }
  finally { $store.Dispose() }
}

function Remove-CurrentUserCertificate([string]$StoreName, [string]$Thumbprint) {
  $store = [System.Security.Cryptography.X509Certificates.X509Store]::new(
    $StoreName,
    [System.Security.Cryptography.X509Certificates.StoreLocation]::CurrentUser
  )
  try {
    $store.Open([System.Security.Cryptography.X509Certificates.OpenFlags]::ReadWrite)
    $matches = $store.Certificates.Find(
      [System.Security.Cryptography.X509Certificates.X509FindType]::FindByThumbprint,
      $Thumbprint,
      $false
    )
    foreach ($match in $matches) { $store.Remove($match) }
  }
  finally { $store.Dispose() }
}

$required = @(
  'WINDOWS_INTERNAL_SIGNING_PFX_BASE64',
  'WINDOWS_INTERNAL_SIGNING_PFX_PASSWORD',
  'TEAM_DEVSPACE_RELEASE_VERSION'
)
foreach ($name in $required) {
  if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($name))) {
    throw "Missing required environment variable: $name"
  }
}

$subject = 'CN=Team DevSpace Internal Publisher'
$codeSigningOid = '1.3.6.1.5.5.7.3.3'
$version = $env:TEAM_DEVSPACE_RELEASE_VERSION
$root = (Get-Location).Path
$installer = Join-Path $root "release\Team-DevSpace-$version-windows-x64-setup.exe"
$layout = Join-Path $root "release\offline\$version\win32-x64"
$pfxPath = Join-Path $env:RUNNER_TEMP 'team-devspace-internal-signing.pfx'
$cerPath = Join-Path $layout 'Team-DevSpace-Internal-Publisher.cer'
$trustScript = Join-Path $root 'platform\windows\Trust-Team-DevSpace-Internal-Publisher.ps1'
$trustScriptDestination = Join-Path $layout 'Trust-Team-DevSpace-Internal-Publisher.ps1'

if (-not (Test-Path -LiteralPath $installer -PathType Leaf)) { throw "Installer not found: $installer" }
if (-not (Test-Path -LiteralPath $layout -PathType Container)) { throw "Offline layout not found: $layout" }
if (-not (Test-Path -LiteralPath $trustScript -PathType Leaf)) { throw "Trust helper not found: $trustScript" }

Write-Host '::notice::Internal signing: loading and validating fixed publisher PFX'
[IO.File]::WriteAllBytes($pfxPath, [Convert]::FromBase64String($env:WINDOWS_INTERNAL_SIGNING_PFX_BASE64))
$flags = [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::Exportable -bor
  [System.Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet
$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new(
  $pfxPath,
  $env:WINDOWS_INTERNAL_SIGNING_PFX_PASSWORD,
  $flags
)
$thumbprint = $certificate.Thumbprint.ToUpperInvariant()
$publicCertificate = $null
$importedRoot = $false
$importedPublisher = $false

try {
  if (-not $certificate.HasPrivateKey) { throw 'Internal signing PFX does not contain a private key' }
  if ($certificate.Subject -ne $subject -or $certificate.Issuer -ne $subject) {
    throw "Internal signing certificate must be self-signed with subject $subject"
  }
  if ($certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -lt (Get-Date).AddMonths(6)) {
    throw 'Internal signing certificate is not currently valid for at least six more months'
  }

  $hasCodeSigningEku = $false
  foreach ($extension in $certificate.Extensions) {
    if ($extension -is [System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]) {
      foreach ($oid in $extension.EnhancedKeyUsages) {
        if ($oid.Value -eq $codeSigningOid) { $hasCodeSigningEku = $true }
      }
    }
    if ($extension -is [System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension] -and
        $extension.CertificateAuthority) {
      throw 'Internal signing certificate must be an end-entity certificate, not a CA certificate'
    }
  }
  if (-not $hasCodeSigningEku) { throw 'Internal signing certificate is missing the Code Signing EKU' }

  $rsa = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::GetRSAPublicKey($certificate)
  if (-not $rsa -or $rsa.KeySize -lt 3072) { throw 'Internal signing certificate must use RSA with at least 3072 bits' }
  $rsa.Dispose()

  [IO.File]::WriteAllBytes(
    $cerPath,
    $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)
  )
  Copy-Item -LiteralPath $trustScript -Destination $trustScriptDestination -Force
  $publicCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($cerPath)

  $signtool = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Filter signtool.exe -Recurse |
    Sort-Object FullName | Select-Object -Last 1
  if (-not $signtool) { throw 'signtool.exe is unavailable' }

  Write-Host '::notice::Internal signing: signing Windows installer'
  Invoke-SignTool -Executable $signtool.FullName -Arguments @(
    'sign', '/fd', 'SHA256', '/f', $pfxPath, '/p', $env:WINDOWS_INTERNAL_SIGNING_PFX_PASSWORD, $installer
  ) -Stage 'sign'

  Write-Host '::notice::Internal signing: reading embedded signer certificate without chain validation'
  $embeddedCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($installer)
  $embeddedSigner = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($embeddedCertificate)
  try {
    if ($embeddedSigner.Thumbprint.ToUpperInvariant() -ne $thumbprint) {
      throw 'Signed installer does not contain the expected internal publisher certificate'
    }
  }
  finally {
    $embeddedSigner.Dispose()
    $embeddedCertificate.Dispose()
  }

  Write-Host '::notice::Internal signing: temporarily trusting publisher certificate for policy verification'
  Add-CurrentUserCertificate -StoreName 'Root' -Certificate $publicCertificate
  $importedRoot = $true
  Add-CurrentUserCertificate -StoreName 'TrustedPublisher' -Certificate $publicCertificate
  $importedPublisher = $true

  Write-Host '::notice::Internal signing: verifying Authenticode policy'
  Invoke-SignTool -Executable $signtool.FullName -Arguments @('verify', '/pa', '/all', $installer) -Stage 'verify'

  Copy-Item -LiteralPath $installer -Destination $layout -Force
  $installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  "$installerHash  $(Split-Path -Leaf $installer)" | Set-Content "$installer.sha256" -Encoding ascii
  Copy-Item -LiteralPath "$installer.sha256" -Destination $layout -Force

  foreach ($path in @($cerPath, $trustScriptDestination)) {
    $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $(Split-Path -Leaf $path)" | Set-Content "$path.sha256" -Encoding ascii
  }

  Write-Output (ConvertTo-Json @{
    signed = $true
    trustProfile = 'internal-free'
    subject = $certificate.Subject
    thumbprint = $thumbprint
    notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
    installer = (Split-Path -Leaf $installer)
  } -Compress)
}
finally {
  if ($importedPublisher) { Remove-CurrentUserCertificate -StoreName 'TrustedPublisher' -Thumbprint $thumbprint }
  if ($importedRoot) { Remove-CurrentUserCertificate -StoreName 'Root' -Thumbprint $thumbprint }
  Remove-Item -LiteralPath $pfxPath -Force -ErrorAction SilentlyContinue
  if ($publicCertificate) { $publicCertificate.Dispose() }
  $certificate.Dispose()
}

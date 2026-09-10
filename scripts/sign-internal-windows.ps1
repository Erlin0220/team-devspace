Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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
$tempRoot = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } elseif ($env:TEMP) { $env:TEMP } else { [IO.Path]::GetTempPath() }
$pfxPath = Join-Path $tempRoot "team-devspace-internal-signing-$PID.pfx"
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

  Write-Host '::notice::Internal signing: signing Windows installer with the built-in Authenticode API'
  $signed = Set-AuthenticodeSignature -FilePath $installer -Certificate $certificate -HashAlgorithm SHA256
  if (-not $signed.SignerCertificate -or $signed.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $thumbprint) {
    throw 'Signed installer does not contain the expected internal publisher certificate'
  }
  if ($signed.Status -in @('NotSigned', 'HashMismatch', 'NotSupportedFileFormat')) {
    throw "Authenticode signing failed: $($signed.Status)"
  }

  Write-Host '::notice::Internal signing: verifying embedded signer and file integrity without mutating Windows trust stores'
  $verified = Get-AuthenticodeSignature -FilePath $installer
  if (-not $verified.SignerCertificate -or $verified.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $thumbprint) {
    throw 'Authenticode verification returned an unexpected signer'
  }
  if ($verified.Status -notin @('Valid', 'UnknownError')) {
    throw "Authenticode verification failed: $($verified.Status)"
  }
  if ($verified.Status -eq 'UnknownError') {
    Write-Host '::notice::Signer is intentionally not trusted on the build runner; employee trust is installed only by the shipped current-user trust helper.'
  }

  $embeddedCertificate = [System.Security.Cryptography.X509Certificates.X509Certificate]::CreateFromSignedFile($installer)
  $embeddedSigner = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($embeddedCertificate)
  try {
    if ($embeddedSigner.Thumbprint.ToUpperInvariant() -ne $thumbprint) {
      throw 'Embedded Authenticode signer does not match the fixed internal publisher certificate'
    }
  }
  finally {
    $embeddedSigner.Dispose()
    $embeddedCertificate.Dispose()
  }

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
    verification = 'embedded-signer-and-integrity-no-trust-store-mutation'
    subject = $certificate.Subject
    thumbprint = $thumbprint
    notAfter = $certificate.NotAfter.ToUniversalTime().ToString('o')
    installer = (Split-Path -Leaf $installer)
  } -Compress)
}
finally {
  Remove-Item -LiteralPath $pfxPath -Force -ErrorAction SilentlyContinue
  $certificate.Dispose()
}

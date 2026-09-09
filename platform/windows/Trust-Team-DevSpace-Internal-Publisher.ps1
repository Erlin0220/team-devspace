param(
  [ValidateSet('Install', 'Remove')]
  [string]$Action = 'Install',
  [string]$CertificatePath = (Join-Path $PSScriptRoot 'Team-DevSpace-Internal-Publisher.cer')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

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

$expectedSubject = 'CN=Team DevSpace Internal Publisher'
$codeSigningOid = '1.3.6.1.5.5.7.3.3'
if (-not (Test-Path -LiteralPath $CertificatePath -PathType Leaf)) {
  throw "Publisher certificate not found: $CertificatePath"
}

$certificate = [System.Security.Cryptography.X509Certificates.X509Certificate2]::new($CertificatePath)
$thumbprint = $certificate.Thumbprint.ToUpperInvariant()
try {
  if ($certificate.Subject -ne $expectedSubject -or $certificate.Issuer -ne $expectedSubject) {
    throw "Refusing unexpected publisher certificate: $($certificate.Subject)"
  }
  if ($certificate.NotBefore -gt (Get-Date) -or $certificate.NotAfter -le (Get-Date)) {
    throw 'Publisher certificate is not currently valid'
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
      throw 'Refusing a CA certificate; the internal publisher certificate must be end-entity only'
    }
  }
  if (-not $hasCodeSigningEku) { throw 'Publisher certificate is missing the Code Signing EKU' }

  $stores = @('Root', 'TrustedPublisher')
  if ($Action -eq 'Remove') {
    foreach ($store in $stores) { Remove-CurrentUserCertificate -StoreName $store -Thumbprint $thumbprint }
    Write-Output "Removed Team DevSpace internal publisher trust for current user: $thumbprint"
    exit 0
  }

  $trustCommitted = $false
  try {
    Add-CurrentUserCertificate -StoreName $stores[0] -Certificate $certificate
    Add-CurrentUserCertificate -StoreName $stores[1] -Certificate $certificate

    $installers = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter 'Team-DevSpace-*-windows-x64-setup.exe' -File)
    if ($installers.Count -gt 1) { throw 'More than one Team DevSpace Windows installer is present beside the trust helper' }
    if ($installers.Count -eq 1) {
      $signature = Get-AuthenticodeSignature -LiteralPath $installers[0].FullName
      if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate -or
          $signature.SignerCertificate.Thumbprint.ToUpperInvariant() -ne $thumbprint) {
        throw "Installer signature verification failed after trusting publisher certificate: $($signature.Status)"
      }
      Write-Output "Trusted and verified Team DevSpace installer for current user: $thumbprint"
    } else {
      Write-Output "Trusted Team DevSpace internal publisher for current user: $thumbprint"
    }
    $trustCommitted = $true
  }
  finally {
    if (-not $trustCommitted) {
      foreach ($store in $stores) { Remove-CurrentUserCertificate -StoreName $store -Thumbprint $thumbprint }
    }
  }
}
finally {
  $certificate.Dispose()
}

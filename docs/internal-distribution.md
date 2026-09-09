# Internal free distribution

This project intentionally uses the `internal-free` trust profile for private administrator handoff. It avoids paid public code-signing and Apple Developer Program requirements without pretending the resulting packages have public-store trust.

## Windows

Published Windows installers are Authenticode-signed with one fixed self-signed certificate:

```text
CN=Team DevSpace Internal Publisher
```

The private key is never shipped in a release. It is retained only in the protected administrator backup and GitHub `production` Environment secrets. Create this identity once on a trusted administrator Windows machine as a self-signed, end-entity Code Signing certificate named `CN=Team DevSpace Internal Publisher`, using RSA 3072 bits or stronger and a long validity period. Export it as a password-protected PFX, keep the PFX/password outside Git, and configure these two `production` secrets:

```text
WINDOWS_INTERNAL_SIGNING_PFX_BASE64
WINDOWS_INTERNAL_SIGNING_PFX_PASSWORD
```

The workflow rejects a PFX that is not self-signed with the exact subject, lacks the Code Signing EKU, is a CA certificate, uses RSA below 3072 bits, or has less than six months of validity remaining. The Windows offline ZIP contains:

```text
Team-DevSpace-<version>-windows-x64-setup.exe
Team-DevSpace-Internal-Publisher.cer
Trust-Team-DevSpace-Internal-Publisher.ps1
objects/...
manifest.json
...
```

On each managed Windows user account, establish trust once before running the installer:

```powershell
pwsh -ExecutionPolicy Bypass -File .\Trust-Team-DevSpace-Internal-Publisher.ps1
```

The helper validates the expected subject, self-signed/end-entity shape, validity period and Code Signing EKU, then imports only the public certificate into the current user's `Root` and `TrustedPublisher` stores. If the installer is present beside the helper, it also requires the installer Authenticode signature to validate against that exact certificate.

To remove this publisher trust for the current user:

```powershell
pwsh -ExecutionPolicy Bypass -File .\Trust-Team-DevSpace-Internal-Publisher.ps1 -Action Remove
```

Self-signed trust is suitable only for devices whose users explicitly trust this publisher certificate. It does not create public SmartScreen reputation or third-party trust. Do not distribute the PFX or its password to employees.

## macOS

The private macOS `.pkg` defaults to unsigned and unnotarized in `internal-free` mode. When all protected Developer ID and App Store Connect credentials are configured, CI instead signs the apps and PKG, notarizes and staples it. Administrators must still distribute it only from the private GitHub Release and verify the published SHA-256 checksum before handoff.

If Gatekeeper blocks the package, do not disable Gatekeeper globally. On the employee Mac, attempt to open the package once, then use **System Settings → Privacy & Security → Open Anyway** for that administrator-supplied package and complete the normal macOS confirmation flow.

For an unsigned package this is an explicit internal exception, not Developer ID trust or Apple notarization. Never apply that exception to a job reported as signed/notarized without separately verifying its signature.

## Linux

Linux handoff remains the fixed-version offline `.tar.gz` plus SHA-256 verification. No new signing subsystem is introduced by the free internal profile.

## Release policy

- GitHub repository must remain private.
- Fixed `v<version>` releases are immutable by policy and are never overwritten.
- CI validates all component sizes and SHA-256 digests before creating the Release.
- Windows publication requires the fixed internal signing PFX in GitHub `production` secrets.
- macOS publication has no Apple signing/notarization credential requirement in this profile; complete optional credentials activate the normal signing/notarization path.
- Moving to public distribution later is a separate trust-profile change and must introduce an appropriate public Windows signing service and Apple Developer ID application/installer signing plus notarization; do not silently reuse the internal-free contract.

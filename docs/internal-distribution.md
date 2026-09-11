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

The workflow rejects a PFX that is not self-signed with the exact subject, lacks the Code Signing EKU, is a CA certificate, uses RSA below 3072 bits, or has less than six months of validity remaining. The Windows administrator handoff ZIP contains only:

```text
Team-DevSpace-<version>-windows-x64-setup.exe
Team-DevSpace-Internal-Publisher.cer
Trust-Team-DevSpace-Internal-Publisher.ps1
```

The installer EXE is self-contained: its fixed manifest and verified Node, DevSpace runtime, cloudflared and conditional PortableGit payload are embedded at build time. Employees do not need an `objects/` directory, a GitHub credential or a runtime download during installation.

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

The private macOS `.pkg` is currently built manually on Codemagic M2 and remains unsigned/unnotarized in `internal-free` mode. The hosted build keeps only cheap structural/compatibility checks; it does not run the system-level Installer transaction. Administrators download the `.pkg` plus `.sha256`, verify the checksum, and hand it to a real Mac user for installation/LaunchAgent/menu-bar/Enrollment validation. A private GitHub Release can still be used as optional fixed-version storage, but it is not part of the build path.

If Gatekeeper blocks the package, do not disable Gatekeeper globally. On the employee Mac, attempt to open the package once, then use **System Settings → Privacy & Security → Open Anyway** for that administrator-supplied package and complete the normal macOS confirmation flow.

For an unsigned package this is an explicit internal exception, not Developer ID trust or Apple notarization. Never apply that exception to a job reported as signed/notarized without separately verifying its signature.

## Linux

Linux handoff remains the fixed-version x64 offline `.tar.gz` plus SHA-256 verification. No new signing subsystem is introduced by the free internal profile. The current runtime baseline is `x86_64`, glibc 2.34 or newer, and a working systemd user manager.

Employees run `install.sh` as their normal account, never through `sudo`. The installer keeps versioned payloads private, installs the stable `~/.local/bin/team-devspace` command, and uses fixed `team-devspace-runtime.service` / `team-devspace-tunnel.service` user units that resolve the current payload through `active-path`. A first installation without retained Enrollment is completed with `team-devspace setup --credential-file <employee-key.json> --root <project-directory>`; an enrolled upgrade only needs the new `install.sh` and refreshes the same fixed units without another device binding. Linux service output is owned by journald and can be read with `team-devspace logs` or followed with `team-devspace logs --follow`.

On a headless server, keeping a user service alive after logout is an explicit administrator choice (`loginctl enable-linger <user>`). The installer never enables linger or installs a root daemon on its own.

## Release policy

- The source repository remains private.
- GitHub Actions no longer builds native client installers; its remaining workflow is infrastructure deployment only.
- Windows/Linux packages are created on matching native hosts when needed.
- macOS arm64 is built manually on Codemagic M2; no push/PR trigger is configured, and the candidate package is unsigned/unnotarized.
- Fixed `v<version>` private GitHub Releases, when used for administrator storage, remain immutable by policy and are never overwritten.
- Moving to public distribution later is a separate trust-profile change and must introduce an appropriate public Windows signing service and Apple Developer ID application/installer signing plus notarization; do not silently reuse the internal-free contract.

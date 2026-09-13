# Internal-free software trust

The repository and device-control service remain private, but installer files are intentionally available without download authentication. `internal-free` describes code-signing limitations, not an access-control promise. Fixed software delivery is documented in [one-command-distribution.md](one-command-distribution.md).

## Windows

The normal handoff is the self-contained EXE, not a credential-bearing ZIP. Local builds do not promise public Authenticode trust or SmartScreen reputation. Existing administrator tooling may apply the fixed `CN=Team DevSpace Internal Publisher` signature before final acceptance, but an internal self-signed identity is not a publicly trusted publisher.

The stable installation script validates the complete EXE hash and size before execution. It never imports a certificate, changes the global PowerShell policy, supplies an Access Key, or bypasses a system warning. Administrators who deliberately manage an internal publisher certificate can retain their separate current-user trust procedure; it is not required or silently invoked by the public download flow. A PFX, password or private key must never enter the download directory or release asset.

## macOS

The two PKGs remain unsigned/unnotarized unless the existing protected Developer ID signing/notarization path is explicitly configured. Codemagic builds each target and runs actual system PKG installation, installed-payload and LaunchAgent checks. The x64 build and runtime tests use Rosetta on Apple Silicon, not physical Intel hardware.

Normal Gatekeeper and administrator confirmations remain. Where macOS permits it, a user who has verified the source may approve that specific downloaded package in System Settings → Privacy & Security. Never disable Gatekeeper globally or advertise zero-confirmation installation. CI installation does not prove employee-machine Gatekeeper approval or real employee Enrollment.

## Linux

The x64 offline archive requires glibc 2.34+ and runs as the employee's ordinary user, never through sudo. It reuses existing systemd user or no-systemd lifecycle support. Software installation does not bind a device. Run `~/.local/bin/team-devspace setup` afterward to enter the Access Key privately and select a project; `access-key change` replaces it without reinstalling.

The stable CLI resolves `active-path`. Upgrades retain identity and pause intent; uninstall removes owned application/startup files but retains employee state and projects. A user-service linger setting remains an explicit administrator decision, never an automatic installer action.

## Release policy

One clean source commit and exact final-byte acceptance are required for every platform. Signing, where used, must precede that acceptance. Windows/Linux build on native local hosts; both Mac architectures use the existing manual Codemagic workflow. Software publication uploads all four targets, verifies checksums and public HTTPS reads, then switches one stable pointer. Historical versions cannot be overwritten.

GitHub Releases may remain private backup/archive storage; employees never need a GitHub token. Public Windows signing and Apple Developer ID/notarization remain future trust improvements, not reasons to add R2 authentication or administrator-generated download tickets.

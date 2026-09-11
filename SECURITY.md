# Security Policy

Team DevSpace connects a shared ChatGPT workspace application to authorized employee devices, so credential handling and remote-access failures are treated as security-sensitive issues.

## Supported versions

Only the current `0.2.x` release line is actively maintained. Older `0.1.x` builds should be upgraded before relying on security fixes.

## Reporting a vulnerability

Report suspected vulnerabilities privately to the repository owner or Team DevSpace administrator through the existing internal communication channel. Do not place vulnerability details, credentials, employee data, or exploitable reproduction steps in a broadly visible issue, chat, or document.

A useful report should include:

- the affected Team DevSpace version and operating system;
- the affected component, such as Gateway, Admin Web, installer, tray, Bridge, or DevSpace runtime;
- clear reproduction steps and the observed security impact;
- relevant logs with secrets, local project contents, personal paths, and employee data removed; and
- whether the issue appears to permit unauthorized device access, credential disclosure, privilege escalation, persistence, or isolation bypass.

## Credential exposure

Never include real Access Keys, `ADMIN_TOKEN`, `MASTER_KEY`, Cloudflare API tokens, Tunnel tokens, signing keys, certificates containing private keys, or passwords in a report.

If a credential may already have been exposed, disable or rotate that credential first when possible, then report the incident privately. Do not wait for a code fix before containing an active credential leak.

## Security boundaries

Team DevSpace is designed around these boundaries:

- employee devices expose no intentional public inbound port; remote access is carried through authenticated Cloudflare Tunnel connectivity;
- an Access Key is bound to one Device Binding and must not authorize another device without an administrator reset;
- administrator routes are expected to remain protected by Cloudflare Access and application-level authorization;
- local Allowed Roots define which project directories DevSpace may access;
- pause, revoke, reset, and failed-recovery paths should fail closed rather than silently restore remote access; and
- secrets must remain outside Git, release manifests, diagnostics, browser-visible administration responses, and normal logs.

A change that weakens any of these boundaries should be treated as security-sensitive even if normal functional tests still pass.

## Third-party vulnerabilities

Team DevSpace includes or depends on third-party software such as DevSpace, Node.js, cloudflared, and other packaged dependencies. Report an issue here when Team DevSpace's integration, configuration, packaging, or delayed dependency update creates the exposure. Vulnerabilities that exist solely in an upstream project should also be reported to that upstream project according to its security policy.

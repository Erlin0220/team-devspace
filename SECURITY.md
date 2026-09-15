# Security

## Reporting

Do not disclose a suspected vulnerability, credentials, exploit traces or
employee data in a public Issue. Use this repository's GitHub private
vulnerability reporting facility when it is enabled. Operators should use
their established private maintainer contact while it is unavailable. Do not
send secrets in ordinary chat or paste an unredacted diagnostic archive.

Private reporting must be enabled and its contact route tested before this
repository becomes Public. No response-time SLA is promised by this file.

## Trust boundaries

Access Keys authorize remote development, not merely a status dashboard.
The selected project directory constrains workspace/file tools; it is not a
shell sandbox. Commands run with the employee's operating-system permissions.
Protect that account and revoke credentials for lost or retired devices.

Gateway URLs, download URLs and update public keys are necessarily visible to
clients. Hiding them is not authentication. Key hashes, current device bindings
and MCP session ownership are checked independently of display caches.
Admin browser access requires a validated Cloudflare Access identity and CSRF
checks; CLI administration uses a separate secret. Avoid exposing alternate
`workers.dev` or preview routes that bypass the intended edge boundary.

Software download does not grant access to an employee computer. Installer
payloads contain no employee key or Cloudflare management token. The updater
verifies independent Ed25519 metadata and complete package size/hash before
handing off to the existing OS installer. Never replace the deployed trust key
without a compatible key-rotation plan, or silently downgrade clients.

## Resource-abuse controls

Reject malformed credentials before database/provider work. A syntactically
valid but unknown credential may still require a D1 read; code-level rejection
does not eliminate the cost of invoking a Worker. Use narrowly scoped WAF rules
and appropriate edge rate limiting, not secret URLs or a global office-IP ban.
The per-Key enrollment limiter protects Tunnel/DNS provisioning after identity
validation; it is not a global billing cap or a replacement for edge limits.

Anonymous update discovery remains available for recovery compatibility.
Coalescing, bounded success caches and brief negative caching reduce origin
and D1 work, not the number of HTTP requests an attacker can send. A stolen
valid Key requires revocation, not just a rate-limit adjustment.

## Supply chain and incidents

Keep source/profile/accepted bytes bound together, Actions SHA-pinned,
dependency/binary inputs locked, production secrets scoped and untrusted PRs
unprivileged. Public downloads also require third-party license compliance.
Do not turn off operating-system trust protections to suppress install prompts.

For suspected exposure, revoke/rotate affected credentials first; deleting a
file or rewriting Git is not revocation. Inspect history, tags, PR refs, logs,
artifacts, releases and clones before changing visibility. Coordinate history
cleanup and backups as a separate approved operation. Never automatically
rotate MASTER_KEY or update-signing keys during a source-cleanup task.

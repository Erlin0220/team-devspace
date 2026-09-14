# Team DevSpace 0.2.4

Candidate changes; publication requires fresh final-byte acceptance for all four targets.

- Desktop health keeps five-second local probes while caching successful remote display status for five minutes. Failed remote probes retry after thirty seconds. Manual checks, diagnostics and lifecycle operations remain fresh. The Control Center shows local and remote check timestamps separately. This is not an authorization cache: every MCP request still checks the Gateway's authoritative D1 state.
- Live Windows/Linux acceptance reuses two private test Access Keys per host/platform and resets bindings after each run. Existing file-lock infrastructure serializes pool use. Normal employee revocation records are retained; no revoked credential is resurrected or deleted.
- Publication retains complete local/server integrity checks and installer-side SHA-256 validation. Routine public HTTPS verification uses catalog/checksum identity, HEAD/ETag and bounded first/last ranges. Full independent public-download hashing is available with `--full-https-verify`; bounded probes do not claim to hash the complete public response.
- The website no longer advertises historical installers. After successful stable/script/homepage verification, the owned server publisher removes other release directories. Concurrent stable changes stop stale homepage publication and pruning. Old pinned download URLs will cease to work after pruning; installed clients are unchanged.

Not included: Worker log/routing configuration changes and automatic local old-artifact deletion. Tool safety checks blocked those edits during this task. No claim of production deployment or macOS/Linux acceptance is made by this document; use the exact artifact receipts and task verification record.

# Verification record

This file records evidence that has actually been produced. A checked item means the command or environment was exercised; implementation alone is not evidence.

## Automated local evidence

- [x] `npm run check`: syntax, upstream DevSpace version pin and whitespace checks.
- [x] `npm test`: gateway/device isolation, concurrent enrollment, revoke/reset, local OAuth, Allowed Roots and real upstream DevSpace MCP read/write/shell tests.
- [x] `npm run deploy -- --dry-run`: Worker bundle and bindings compile with pinned Wrangler.
- [x] `npm audit`: no known vulnerabilities in the current locked dependency graph.
- [x] `npm run package -- --prepare-only --reuse-dependencies`: Windows payload is assembled from pinned downloads; native SQLite and bundled Git/Bash are loaded and version-checked.
- [x] `npm run test:native`: packaged Windows runtime uses actual Task Scheduler user-session startup, authenticated MCP, stop/restart and cleanup.
- [x] `npm run test:installer`: an actual test-isolated NSIS build was exercised against a controlled loopback Enrollment endpoint with production startup deliberately disabled; the distribution transaction and native startup are verified separately so the test never claims a real Tunnel is online.
- [x] `npm run test:distribution`: fixed target/version metadata, component separation, exact size/SHA-256 and content-addressed offline layout are verified.
- [x] The actual Windows bootstrap installer is 88 KB class and contains no Node, DevSpace `node_modules`, cloudflared or Git Payload; those exist only as manifest-addressed artifacts.
- [x] Isolated NSIS smoke verifies offline acquisition, shared cache, A/B activation, repeated-install Enrollment preservation, Repair reacquisition, failed-repair active-version retention, rollback retention and uninstall preservation.
- [x] Gateway and static MCP assets compile as separate Workers; privacy-aware Workers Logs are enabled and scheduled cleanup has a deterministic reconciler test.

## External evidence still required before production handoff

- [ ] Cloudflare Worker + D1 deployed at the dedicated Team DevSpace hostname.
- [ ] Real remotely managed Tunnel provisioned automatically through Enrollment and connected from an employee device.
- [ ] Real HTTPS MCP call reaches the correct Windows device through Worker -> Tunnel -> local bridge -> official DevSpace.
- [ ] macOS arm64 package built natively and installed/tested.
- [ ] macOS x64 package built natively and installed/tested.
- [ ] Linux x64/arm64 payloads built and tested on native CI; Linux remains outside stable handoff until this evidence exists.
- [ ] Windows Authenticode and macOS Developer ID Installer/notarization/stapling gates exercised with production signing identities.
- [ ] All five native layouts aggregated, uploaded with immutable R2 semantics, and fully re-downloaded/verified through the R2 Custom Domain.
- [x] Product owner explicitly selected public R2 runtime artifacts; canonical release/deployment metadata and CI prevent an environment override.
- [ ] Two real Workspace users prove ChatGPT OAuth identity A/B routes to Device A/B, and the same two identities enroll their own devices; Access Key IAM is retained until then.
- [ ] Linked App Token is proven through wildcard per-device Access before considering removal of Device Secret / MASTER_KEY.
- [ ] Windows and macOS devices are online simultaneously and Access Key A cannot route to Device B (and vice versa).
- [ ] Device offline/reconnect, login-start recovery, revoke, reset and upgrade-preservation scenarios have been run against real infrastructure.
- [ ] The shared ChatGPT workspace **Team DevSpace** app is created against the dedicated `/mcp` endpoint and each employee's own Access Key is actually transmitted by the selected authentication mode.
- [ ] A real ChatGPT conversation invokes an official DevSpace tool on each target device; MCP SDK evidence is not substituted for this check.
- [ ] Existing personal `https://devspace.568920429.xyz/mcp` remains operational after Team deployment.

Cloudflare account credentials, employee Access Keys, device secrets, Owner Tokens and Tunnel Tokens must never be copied into this document, Git, Issues or test artifacts intended for sharing.

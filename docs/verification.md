# Verification record

This file records evidence that has actually been produced. A checked item means the command or environment was exercised; implementation alone is not evidence.

## Optimization verification: 0.1.1

- [x] Local `check`, 24 tests and unified Worker dry-run passed after the optimization. New tests cover canonical deployment versions, Admin/D1/assets readiness, recovery route ownership, public assets routing and targeted optional/native pruning.
- [x] Actual Windows NSIS transaction exercised the official PortableGit SFX with system Git/Bash deliberately absent from PATH, successful upgrade/repair, old-version and stale-cache collection, and corrupt-artifact rejection preserving the current installation.
- [x] Five-target 0.1.1 native build and installer transactions passed in Actions run `34360282017` at source commit `1e89f6e`: Windows x64, macOS arm64/x64 and Linux x64/arm64. Each target passed source contracts, 24 tests, dependency audit, native package build and its offline installation transaction. All five uploaded layouts were aggregated, size/SHA-256 checked, and administrator handoff archives assembled successfully. Signing/publication was not requested in this verification run.
- [x] Final Windows local build, actual Task Scheduler/MCP startup and actual NSIS install/upgrade/repair tests passed again at `1e89f6e`. The earlier optimization build measured 102,624,592 required payload bytes plus 58,960,208 bytes of original PortableGit SFX, approximately 161.6 MB total compressed payload. This is payload size, not installed disk usage.
- [x] Unified 0.1.1 production deployment passed in Actions run `34359451366` at commit `f5c383d`; Worker version `32a78dfb-99b8-40e2-9e81-76b5aa3dc81a`. Release, administrator/D1 and exact static asset content/CORS probes all passed. Independent public verification returned 0.1.1/1.0.8, matching JS bytes and HTTP 401 for unauthenticated MCP.
- [x] Initial Linux x64 native build plus actual offline installer transaction passed in run `34359446174`. Its macOS jobs exposed upstream node-pty 1.1.0's non-executable spawn-helper, rather than silently passing a require-only check; the build now corrects only that helper's executable metadata and retains the real spawn gate.
- [ ] Signed fixed-version GitHub Release. Actual `publish=true` attempt `34361370031` stopped in its pre-build credentials check: the two Windows signing secrets and six Apple signing/notarization secrets are absent from `production`. No native jobs were unnecessarily rebuilt by that attempt, and no GitHub Release was created. Build success does not close this signing gate.

## Earlier baseline local evidence

- [x] `npm run check`: syntax, upstream DevSpace version pin and whitespace checks.
- [x] `npm test`: gateway/device isolation, concurrent enrollment, revoke/reset, local OAuth, Allowed Roots and real upstream DevSpace MCP read/write/shell tests.
- [x] `npm run deploy -- --dry-run`: Worker bundle and bindings compile with pinned Wrangler.
- [x] `npm audit`: no known vulnerabilities in the current locked dependency graph.
- [x] `npm run package -- --prepare-only --reuse-dependencies`: Windows payload is assembled from pinned downloads; native SQLite and bundled Git/Bash are loaded and version-checked.
- [x] `npm run test:native`: packaged Windows runtime uses actual Task Scheduler user-session startup, authenticated MCP, stop/restart and cleanup.
- [x] `npm run test:installer`: an actual test-isolated NSIS build was exercised against a controlled loopback Enrollment endpoint with production startup deliberately disabled; the distribution transaction and native startup are verified separately so the test never claims a real Tunnel is online.
- [x] `npm run test:distribution`: fixed target/version metadata, component separation, exact size/SHA-256 and content-addressed offline layout are verified.
- [x] The actual Windows bootstrap installer is 88 KB class and contains no Node, DevSpace `node_modules`, cloudflared or Git Payload; those exist only as manifest-addressed artifacts.
- [x] The Windows production graph omits unused optional dependencies: the real bundle contains neither `node-pty` nor the 219 MB-class platform Claude executable. `node_modules` fell from 540,693,792 to 254,205,718 bytes and the compressed `devspace-runtime` artifact from 165,975,610 to 51,041,979 bytes; the required component archives total 102,670,830 bytes. These measurements predate 0.1.1's targeted Unix pruning and official PortableGit SFX packaging.
- [x] Isolated NSIS smoke verifies offline acquisition, shared cache, A/B activation, repeated-install Enrollment preservation, Repair reacquisition, failed-repair active-version retention, pre-commit recovery and uninstall preservation. In 0.1.1, successful activation now retires the old version instead of retaining an unusable manual-rollback slot.
- [x] Gateway and static MCP assets now compile as a single Worker with an Assets binding; privacy-aware Workers Logs are enabled and scheduled cleanup has a deterministic reconciler test.

## External evidence still required before production handoff

- [x] Baseline Cloudflare Worker + D1 deployment succeeded in GitHub Actions run `34356504598` at commit `9ee875c`; the 0.1.1 unified deployment is tracked separately above.
- [ ] Real remotely managed Tunnel provisioned automatically through Enrollment and connected from an employee device.
- [ ] Real HTTPS MCP call reaches the correct Windows device through Worker -> Tunnel -> local bridge -> official DevSpace.
- [x] macOS arm64/x64 PKGs built natively, expanded using actual `pkgutil`, and their embedded offline payloads installed/upgraded/repaired through the shipping bootstrap, including spaced paths and corrupt-artifact rejection. This does not claim a signed system Installer/Gatekeeper or logged-in LaunchAgent acceptance test.
- [x] Linux x64/arm64 actual offline archives built and installed/upgraded/repaired on native CI, with actual native PTY execution and installed SQLite/module checks.
- [ ] macOS logged-in LaunchAgent and Linux logged-in systemd user-session lifecycle acceptance on employee machines.
- [ ] Windows Authenticode and macOS Developer ID Installer/notarization/stapling gates exercised with production signing identities.
- [x] All five native layouts aggregated and SHA-256 verified, with administrator handoff archives successfully assembled in run `34360282017`.
- [ ] Signed handoff assets published once to a private fixed-version GitHub Release.
- [x] Product owner selected private GitHub Releases for administrator handoff; employee installers are offline-only and contain no GitHub credential or remote artifact origin.
- [ ] Two real Workspace users prove ChatGPT OAuth identity A/B routes to Device A/B, and the same two identities enroll their own devices; Access Key IAM is retained until then.
- [ ] Linked App Token is proven through wildcard per-device Access before considering removal of Device Secret / MASTER_KEY.
- [ ] Windows and macOS devices are online simultaneously and Access Key A cannot route to Device B (and vice versa).
- [ ] Device offline/reconnect, login-start recovery, revoke, reset and upgrade-preservation scenarios have been run against real infrastructure.
- [ ] The shared ChatGPT workspace **Team DevSpace** app is created against the dedicated `/mcp` endpoint and each employee's own Access Key is actually transmitted by the selected authentication mode.
- [ ] A real ChatGPT conversation invokes an official DevSpace tool on each target device; MCP SDK evidence is not substituted for this check.
- [ ] Existing personal `https://devspace.568920429.xyz/mcp` remains operational after Team deployment.

Cloudflare account credentials, employee Access Keys, device secrets, Owner Tokens and Tunnel Tokens must never be copied into this document, Git, Issues or test artifacts intended for sharing.

# Upgrade review and bounded implementation — 2026-09-14

## Baseline and scope

Reviewed the actual checkout at `0a01da9f40e3abd505b616c6a2e76a1c7e1f6488` (development release 0.2.5), not the immutable 0.2.4 payload. The user's separate changes to `client/control.css`, `client/control.html`, and `client/control.js` were not edited by this task. During verification, parallel changes also appeared in `client/desktop-controller.mjs` and `client/local-control.mjs`; these were preserved unchanged by this task. No release build, policy promotion, signing-key change, production D1 migration, or installer replacement is part of this pass.

The objective is reliable small-fleet upgrades without a second installer, daemon, job manager, or telemetry service. Previous discussion is input, not an implementation checklist.

## Evidence and decisions

| Area | Local finding / decision |
| --- | --- |
| Scheduling | A cache hit after restart scheduled another 6–7 hours instead of the stored nextCheckAt. Failure's one-hour retry was similarly delayed. Use one persisted deadline; cancel checks on exit, recover from clock rollback, and bound server Retry-After to a day. |
| Lock ownership | proper-lockfile 4.1.2 indexes ownership by the target path, not just lockfilePath. Check and apply previously used the same target. Separate identities while preserving the on-disk lock locations. Await the full device operation before releasing apply; test concurrent check, GC and handoff. |
| Deferred/prepared updates | Returned deferrals were discarded. Keep outcomes, retain the Mac authorization-ready state, and recheck busy conditions locally before another network/apply attempt. Remote MCP work already allowed preparation before drain; it did not require a new download subsystem. |
| Handoff result correlation | An unrelated result.json could satisfy the next attempt's completion check. Carry an attemptId into Windows/Linux helpers and accept only a matching result. A lost handoff response still retains the existing bounded guard; this is not a durable job manager. |
| Download storage | Installed-payload GC did not collect downloaded updater packages. Bounded canonical-file GC now shares the apply lock, pins the current/approved/handoff versions, and preserves unknown content and links. |
| Remote failure semantics | The Gateway translated every upstream 5xx to device_offline, hiding a deliberate update drain. Preserve only a narrowly marked, authenticated Bridge update response, with a fixed retry hint and a newly constructed error body. |
| Discovery trust/cost | Apply verified signatures but stable discovery read an unsigned catalog. Verify the signed stable alias and cache/coalesce reads for at most a minute. Fresh policy approvals still verify independently. Preserve only the documented pre-0.2.4 unsigned manual fallback. |
| Repair | Add explicit `update repair` through the existing signed-package and installer path. No automatic repair, downgrade, or fallback to unsigned/current-origin hashes. |
| Fleet visibility | Add an optional, finite update-result snapshot to existing version inventory and Admin. No new polling service or high-frequency D1 writes. A successful installer exit is not proof the new version is already running. |

## Why not implement every mature-product feature now?

**Keep user update preference separate from minimum support.** Tailscale and VS Code have explicitly managed OS/MDM policies; that does not mean this Access-Key-controlled gateway should silently reinterpret `auto` as permission to override a user's choice. A managed-install mode needs an explicit ownership and platform contract. Current auto remains an approved version, not remote code execution or a replacement for native Mac authorization.

**Do not make Internet/Gateway health the installer commit condition.** Offline operation and deliberate suspension are valid. Keeping an older slot is not by itself safe post-upgrade rollback: state format compatibility and the recovery trigger also need a contract. Retain existing transaction recovery rather than introducing speculative automatic rollback in this pass.

**Keep compatibility expansion explicit.** Sparkle's system/hardware/minimum-update eligibility is useful, but old Team DevSpace updaters do not enforce new optional metadata. A safe rollout must establish which clients understand the gate before relying on it. The current Control API version is retained; do not add a Tailscale-style capability counter without actual protocol transitions to encode.

**Do not claim key overlap solves compromise recovery.** Old-key loss and old-key compromise are different cases. An additional trusted key does not revoke an attacker-controlled old key. Keep the current independent Ed25519 root and explicit signing procedure; specify and rehearse rotation before changing trust roots. Do not add an incomplete imitation of TUF.

**Native signatures remain valuable but need real credentials and platform acceptance.** Reuse the existing signing/notarization hooks when configured. No certificate purchases, signing identity changes, trust-store modifications or new Mac CI builds were authorized here.

**Defer delta/Range-resume, maintenance calendars, percentage rings, per-platform promotion and independent updater recovery.** Complete signed packages and the fixed installer recovery path remain simpler. Range delivery support alone is not a complete resumable-client contract; byte identity, invalid partials, concurrent readers and final full hashing need their own tests. Larger release orchestration and an updater daemon add more ownership than the present fleet needs.

**Policy audit and richer fleet events are follow-ups, not prerequisites to this repair.** The new snapshot is deliberately not a realtime event pipeline. A later append-only policy audit should bind the verified Access actor and mutation atomically, not copy bearer credentials into logs. Critical-update labels/deadline UX should be introduced with clear platform behavior rather than hardcoding arbitrary escalation intervals.

## Primary sources consulted

These sources support the design comparisons, not the local verification results. Upstream main/development URLs are moving references, inspected for this review; version-specific claims are not inferred from old snippets.

- Tailscale client updater selection, platform ownership and same/newer-version handling: https://github.com/tailscale/tailscale/blob/main/clientupdate/clientupdate.go
- Tailscale update behavior and native managed-policy authority: https://tailscale.com/docs/features/client/update and https://tailscale.com/docs/features/tailscale-system-policies
- VS Code updater cancellation, scheduling, lifecycle veto and version-change tracking: https://github.com/microsoft/vscode/blob/main/src/vs/platform/update/electron-main/abstractUpdateService.ts ; enterprise policy semantics: https://code.visualstudio.com/docs/enterprise/updates
- GitHub Desktop download/restart and external recovery for launch failures: https://docs.github.com/en/desktop/installing-and-authenticating-to-github-desktop/updating-github-desktop
- Sparkle publishing, OS/hardware eligibility, critical updates and minimumUpdateVersion (requires sufficiently new Sparkle clients): https://sparkle-project.org/documentation/publishing/
- Chromium Updater timing, retry suppression, explicit same-version repair and native ownership: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/updater/functional_spec.md
- Edge notification-period behavior: https://learn.microsoft.com/deployedge/microsoft-edge-browser-policies/relaunchnotificationperiod
- TUF root rotation, thresholds and expiration: https://github.com/theupdateframework/specification/blob/master/tuf-spec.md

## Verification boundary

Tests use temporary signing keys and isolated state; production signing material is never used for synthetic packages. Real local MCP exercises the pinned upstream runtime, authenticated Bridge and work admission. Gateway tests use the actual workerd/D1 runtime with isolated provider responses. None of these substitute for a real cross-version employee EXE/PKG upgrade.

Execution receipts are under ignored `build/update-review-*.tap` and `build/update-review-*.log`. Record the final counts and any platform limitations with the delivery report. Existing employee identity, project root and suspend intent must be checked using the installed CLI, never the development checkout's CLI that would report development version 0.2.5.

### Executed results

- Final Windows updater/report/Gateway/Admin focused suite: **49 passed, 0 failed, 0 skipped**, `build/update-review-final-focused.tap`.
- Larger Windows regression: **159 tests, 155 passed, 1 failed, 3 skipped**, `build/update-review-final.tap`. The remaining failure is `test/desktop-ux.test.mjs:29`: the parallel controller edit now deliberately emits a completion notice, while the pre-existing assertion still requires `undefined`. This task did not overwrite that controller or weaken its test. It is an integration follow-up, not a fully green workspace claim.
- Actual local upstream DevSpace/MCP, authentication, file read/write, shell and busy-work/drain checks passed in the focused 38-test run and the larger regression. Production ChatGPT was not invoked.
- Final WSL Ubuntu 22.04 / Node 22.23.0 suite: **16 passed, 0 failed, 1 Windows-only skip**, `build/update-review-linux-final.tap`. This includes a real independent Linux installer process using a harmless temporary archive, successful bootstrap invocation and the correlated attemptId result. It is not full Linux employee-package acceptance.
- Windows native one-shot task used the already-installed no-console launcher and harmless `whoami.exe` with intentionally invalid installer arguments, not the real employee installer. Correlated nonzero exit, result version, absent installation directory, and task self-removal passed. No binaries were compiled. Receipt: `build/update-review-windows-handoff.log`.
- `npm run check` passed, including release pins, dependency policy, syntax and diff whitespace. No dependencies or release/config pins were changed.
- Installed Windows CLI reports **0.2.4**, the original device ID, project `C:\project\test`, and **suspended** local/remote intent. The employee state file hash was unchanged across the read-only status inspection.
- At **2026-09-14T14:48:08.996Z (23:48 Tokyo)**, production read-back returned **stable=0.2.4, auto=0.2.4, minimumSupported=null, enforceAfter=null, revision=1**. This differs from the earlier handoff's auto=null/revision=0. This task made no production policy writes and did not revert the observed setting. Gateway health remains 0.2.4; signed metadata verifies and still names release source `0e6a89deba0a619a5dd8131a10d8042d4f63ea5f`. Receipt: `build/update-review-production-current.json`.

Real Windows cross-version upgrade with the new payload and real macOS PKG/user-authorization acceptance remain release-time work. Mac preparation/withdrawal behavior has code/test coverage only; no Codemagic run or physical Mac was used. The new D1 migration is a local source change only and must precede the corresponding Gateway deployment through the existing deploy flow. No commit, push, release build or production deployment was performed.

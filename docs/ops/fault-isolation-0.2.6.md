# Fault isolation review: 0.2.6
## Boundary decisions
| Lifecycle boundary | Degrade independently | Remain fail-closed |
| --- | --- | --- |
| Desktop / Tray / browser | WebUI bind, browser launch, progress/render subscribers, status projections | Private capability, origin binding, OS single-instance ownership |
| Runtime / Bridge / Tunnel | Logging sinks and background update checks | Binding/secret checks, upstream/Bridge readiness, persisted pause intent |
| Gateway / admin | Conservative startup inventory failure, optional presentation | Employee/admin authorization, minimum-version admission, D1 binding transitions, signed catalogs |
| Update / cache | Discovery cache recovery, final handoff phase display, obsolete temporary-file cleanup | Initial install guard, authoritative policy recheck, signature/size/hash, installation drain and ownership |
| Installer / exit / rollback | Continue independent cleanup attempts, defer old payload and diagnostics cleanup | No replacement after partial stop; retain unresolved candidate ownership and payload |
## Reproduced faults and regressions
The first seven new fault-injection tests failed against the starting checkout. Regression coverage uses executable behavior, not only source-text assertions:
- Throwing synchronous/asynchronous UI subscribers and progress observers no longer fail successful enrollment, resume, or project-root changes: client.test and desktop-control.test.
- HTTP teardown completes after application cleanup rejects: fault-isolation.test.
- The real Windows GUI launcher runs with blocked stdout/stderr paths while retaining its Job Object: windows-launcher.test.
- Standalone log open/write faults drop output, retain bounded retry, and do not stop the worker; untrusted owner metadata still fails closed: fault-isolation.test.
- A D1 trigger rejects version writes without breaking enrollment/resume; unknown versions still fail an enforced floor and failed downgrade reporting is fenced: gateway.test.
- Control credentials remain bound to their origin even if the endpoint cache cannot be written: desktop-control.test.
- Corrupted discovery cache recovers without resetting automatic-update preference; a post-handoff phase write failure retains the durable duplicate-install guard: updates.test.
- Native cleanup continues after component failure and never starts replacements; Windows rollback tests execute the actual helper in PowerShell 5 without touching employee processes: fault-isolation.test and windows-bootstrap.test.
- macOS shell tests cover unavailable log paths and exactly-once exec; reopening an intact installation uses start, not startup reinstallation: fault-isolation.test and macos-startup.test.
## Evidence and publication
Use the final clean Git commit, full test logs, exact entrypoint hashes and platform acceptance receipts. Unit tests, configured workflows and source review do not prove system Installer behavior. Windows employee-install acceptance, WSL native/systemd and standalone tests, and both Codemagic PKG transactions remain separate gates. Accepted bytes must not be rebuilt for publication. Keep Rosetta and manual employee/Gatekeeper limitations explicit.
The baseline Windows shell failures came from PATH selecting the WSL launcher as bash. Validation selects installed Git Bash first; no application behavior was changed to hide those failures. Future-version fixtures now derive from the release version instead of silently turning upgrade tests into same-version checks.
## Primary references
- OWASP Logging Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- Azure Bulkhead pattern: https://learn.microsoft.com/en-us/azure/architecture/patterns/bulkhead
- Windows Job Objects: https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects
- POSIX Shell Command Language: https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html
- Node.js HTTP teardown: https://nodejs.org/api/http.html#servercloseallconnections
These references guide the boundaries. Injected faults and native acceptance determine whether this implementation actually meets them.

Final review also reproduced an incorrectly escaped Windows installation-prefix comparison. The fallback now uses the platform separator, treats failed CIM queries as unknown ownership rather than empty results, and pins a .NET Process handle before validating and terminating an owned executable. A failed cleanup still prevents candidate deletion and replacement activation. PowerShell 5 regression fixtures cover owned, foreign and unavailable-query cases.

Native handle semantics were cross-checked against the Microsoft .NET Framework reference source: https://github.com/microsoft/referencesource/blob/main/System/services/monitoring/system/diagnosticts/Process.cs

## Final continuation review
- WSL regression exposed an OS-dependent fixture assumption in three port/capability migration tests: Linux `listen(0)` can allocate below the allowed high fallback range. Fixtures now reserve a free port inside 49152-65535 explicitly; production port validation and cross-origin capability rotation remain unchanged.
- Native macOS acceptance caught a real gap in Tray-only degradation: a missing Tray LaunchAgent stayed headless on reopening. Ordinary reopen now attempts the existing Tray-scoped startup installer once, retries only Tray, and reports degradation only if that repair also fails. Runtime/Tunnel are never recycled by this auxiliary repair. Candidate `d854065` was not published; all final platform receipts must follow the correction.
- Publication cleanup previously removed fixed 0.2.3/0.2.4 upgrade fixtures because they were not referenced by rollout policy. The 0.2.3 public archive returned HTTP 404. Restore its exact original accepted files from retained staging after checking the pinned four hashes and original checksum list, without activating it; retain fixture versions independently of stable/auto/minimum so cold CI caches remain usable.
- A full regression run exposed a scheduling-dependent test bug in concurrent administrator issuance: the second caller may validly GET the already-confirmed key before its idempotent POST. The fixture now records HTTP methods and asserts both issuance writes use the exact returned credential hash and leave exactly one server key; it no longer dereferences a GET body. No production authorization behavior was relaxed.
- Ordinary CLI/application reopening could report failure only because the Tray job was unavailable, causing the macOS app wrapper to enter bootstrap and recycle healthy core jobs. Reopening now explicitly permits a reported Tray-only degradation; installer activation, restart cleanup and every core component remain strict. The executable fault regression failed before the fix.
- Project-root rollback previously restarted the original runtime even when the candidate could not be stopped, or original configuration/state restoration failed. Two executable regressions failed before the fix. Rollback now leaves unresolved owners and their current facts intact, and permits restart only after confirmed stop and complete restoration.
- Windows desktop Enrollment previously let a missing/unwritable Tray login entry block Runtime/Tunnel startup after binding had already committed. A fault-injection regression reproduced this boundary crossing. Core startup now finishes independently; Tray registration remains retryable through installer repair, returns `startup: partial`, and the existing Control Center displays the warning. Required core startup failures still reject.

## Agent skills

### Issue tracker

Issues and specs are tracked in this repository's GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default Matt Pocock triage label vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Use the single-context domain documentation layout. See `docs/agents/domain.md`.

## Team DevSpace durable decisions

### Release acceptance freeze (2026-09-15)

- D1 remote statement parsing rejects semicolons inside SQL comments even when local SQLite accepts them. Keep migration comments free of statement delimiters; `test/migrations.test.mjs` guards the verified production failure.
- Disposable macOS upgrade baselines must remove the newer test-owned app bundle and PKG receipt after uninstalling runtime files. Otherwise Apple Installer can retain the newer bundle when installing an older PKG, invalidating cross-version evidence. Never apply this fixture cleanup to an employee Mac.

- New publication requires real cross-version installer acceptance and matching native CPU evidence. Historical Rosetta receipts retain their original limitations and do not become Intel evidence after a workflow change. Retained 0.2.3/0.2.4 hashes in `scripts/upgrade-baselines.mjs` are test fixtures, never automatic downgrade targets.
- The source-available preparation targets native GitHub Windows/Linux/macOS ARM64/Intel candidate builds, not external artifact handoff. Current account billing blocks hosted acceptance, so local/Codemagic fallback is retained until the replacement proves all gates; do not call it migrated or delete it prematurely. A build-only candidate is not a publishable release.
- Capture the D1 Time Travel bookmark and compare redacted pre/post-migration binding summaries before switching the Worker. An unexpected lifecycle/identity change stops deployment before Worker upload; reconcile rather than bypass this guard.

These are long-lived product and architecture constraints that are easy to miss when reading one source file. Current code, tests, release metadata, and real runtime behavior remain authoritative when they conflict with this section.

### Thin architecture

- Original source uses the unmodified PolyForm Shield 1.0.0 text; third-party licenses/notices remain unchanged. Follow Issue -> branch -> PR -> CI/review -> merge; do not routinely commit directly to main. Solo approval count is zero, not an impossible self-approval requirement.
- Production profile/resource identities live outside source. Root release.config.json is a sample; operator builds explicitly select scripts/release-profile.mjs inputs and embed the existing public trust key. Never inject config by modifying tracked files, silently regenerate trust keys, or promote sample artifacts.
- Publication readiness includes remote refs, metadata/logs/artifacts and actual GitHub protections. Local Codex checkpoint refs must not be pushed. Source cleanup does not authorize Public visibility, remote history rewriting, deployment or version-policy changes. See docs/public-readiness.md.

- Keep Team DevSpace thin: reuse the existing DevSpace runtime, OS facilities, Cloudflare, Caddy, and current installers before adding a new framework or parallel state machine.
- The native tray is a presentation frontend. Runtime state, lifecycle operations, progress, recovery, and settings behavior belong to the shared controller/client layer.
- Keep one local settings/control surface. Do not create Windows/macOS-specific business state or duplicate settings implementations.
- Keep `@waishnav/devspace` pinned and upstream whenever practical; adapt locally only for a demonstrated gap.

### Distribution and Enrollment

- Software distribution and authorization are separate. Employees share one fixed download site and platform installer; installation does not require an Access Key. Enrollment happens afterward, and an Access Key can be changed without reinstalling.
- Do not return to per-user download links, temporary download tickets, gated R2 distribution, or GitHub login as an employee installation dependency.
- Versioned public releases are immutable. Promotion aliases may move, but an already published version must not change bytes in place.
- Publish the exact final artifacts that passed acceptance. Do not rebuild after acceptance and treat the rebuilt bytes as equivalent.
- One Access Key binds one Device at a time. Admin Reset releases that binding for reuse. Normal upgrade/repair must preserve a healthy Device identity and binding rather than re-enrolling it.

### Update strategy

The update controller is a thin control layer over the existing installers. Verify current code before assuming every policy below is already implemented. See `docs/updates.md` for the implemented policy contract, signing-key ownership, OS handoff and first-rollout limitations.

- First updater rollout is not retroactive: older clients require one manual covering installation before they can discover future updates. Keep auto/minimum unset until the new release is accepted and canary use is observed.
- macOS retains native PKG authorization; automatic preparation is not an unattended privileged installation. Windows hands off through the existing GUI launcher in a disposable user task, and Linux uses a transient user service or an independent installer process, never a new daemon.

- Use client pull rather than a separate push channel. Offline or sleeping clients discover update policy on their next check; do not add dedicated real-time update infrastructure without a demonstrated need.
- Separate **check** from **apply**. Tray/Settings/CLI may discover and request an update, while the existing installer/bootstrap remains the single owner of payload activation and rollback.
- Keep three policy concepts: `stable` is the newest accepted manual release, `auto` is the release approved for automatic rollout after observation, and `minimum supported` is the oldest release still allowed to use remote access, optionally with a grace period.
- Normal promotion flows `stable -> auto -> minimum supported`. Moving a channel backward stops further rollout; it must not silently downgrade installed clients unless an explicit downgrade design is added.
- A new `stable` release should be observed on real/canary machines before promotion to `auto`; security or compatibility emergencies may shorten that delay.
- Administrator forced update is a **minimum-supported-version policy**, not a second installation mechanism. During grace, notify and allow voluntary upgrade; after grace, an unsupported client may lose new remote-work access while local settings, diagnostics, and update recovery remain available.
- Avoid interrupting active work for routine updates. Prefer applying when the current operation is complete or the client is idle unless an explicit emergency policy requires stronger blocking.
- Check on application startup and at a low background cadence with jitter, plus an explicit manual check. Do not attach update checks or D1 writes to the frequent local desktop status refresh loop.
- The updater should resolve the immutable package for its platform, verify its expected identity, and then hand off to the existing installation path. Do not build another updater-owned activation/rollback state machine.
- Preserve Device identity, Access Key/binding, Current Project Root, and the user's desired remote-access pause state across upgrades.
- Before unattended automatic installation is broadly enabled, use independently signed update metadata verified by a client-embedded public key. HTTPS plus a package hash served by the same download origin is not an independent trust boundary.
- Once automatic rollout exists, retain the releases referenced by `stable`, `auto`, `minimumSupported`, and at least one recent known-good predecessor. Do not immediately prune every previous server release after promotion.
- Also retain every immutable version referenced by `UPGRADE_BASELINES`, independently of rollout policy. Native acceptance must work with a cold cache; never regenerate old package bytes or fabricate their acceptance evidence to repair a pruned fixture.
- Keep fleet policy small until scale justifies more: no percentage rollout, department cohorts, per-device pins, maintenance calendars, or update queue service by default.
- Fleet inventory reuses enrollment/resume and low-frequency update checks, not a new heartbeat. Reports describe observed version/attempt outcomes, not real-time health or proof of migration; an installer exit code alone does not establish the running version. A changed version/platform must not inherit an older report.
- Check and apply use distinct locks. Persist failure backoff for the running version, cancel in-flight checks on exit, and reject unresolved installer attempts before network/download work. Record the actual apply target rather than a stale cached channel value.
- Preserve the current client policy contract when changing Admin controls. Removing a minimum support requirement must be explicit, including when pausing automatic promotion would clear it; see `docs/updates.md` for the existing ordering constraint and safe pause alternative.

### Desktop and lifecycle invariants

- Local WebUI listens on loopback only. `53682` is the preferred first port, not a fatal global dependency: persist the selected port, reuse it across normal restarts/upgrades, wait briefly for an old owner to exit, then migrate to a browser-safe high port if it remains occupied. Rotate the local Control Center capability on such a port migration; a page that keeps polling the abandoned port must not retain a credential accepted by the new endpoint. Control Center startup/port/browser failures must not terminate Tray, Runtime, Bridge, or Tunnel. Keep its capability private and deliver it only by URL fragment; never expose an unauthenticated token endpoint.
- Fault isolation follows dependency criticality: optional presentation, diagnostics, audit/history, cache cleanup, inventory reporting, and browser-opening failures degrade their own surface and remain retryable; authorization, identity, signed-update integrity, installer ownership, and required Runtime/Bridge/Tunnel dependencies stay fail-closed. Do not let an auxiliary failure stop or roll back an otherwise healthy core service.
- `desiredRemoteAccess` is user intent. Suspend/pause survives app restart, connection restart, repair, and software upgrade; opening Team DevSpace is never implicit consent to resume remote access.
- Each Device has one **Current Project Root**. A selected directory is the actual operation root; do not create a nested `team-devspace` directory or maintain competing root lists.
- Long operations must acknowledge immediately with busy/progress feedback and converge to the real runtime state when complete. Prior reports of project changes, pause/resume, Access Key replacement, or restart appearing unresponsive were feedback/state-projection problems, not a reason to duplicate the operation itself.
- Completed operations must clear stale activity such as an old "checking status" message. UI state is a projection of controller/runtime facts, not an independent business state machine.
- Exit and launch are normal desktop lifecycle actions. The user must have a natural shortcut/menu entrypoint to reopen Team DevSpace, and reopening must preserve the saved remote-access intent.
- Keep diagnostics and repair grouped in the shared troubleshooting surface rather than promoting them into parallel top-level workflows.

### Installer and platform safety

- Never overwrite or clean a non-empty installation/distribution directory unless Team DevSpace can prove it owns that directory. Use ownership/path markers and bounded migration rules; unknown directories fail safely.
- Windows remains a current-user product. Keep ordinary launches and installer helpers visually quiet and avoid adding administrator requirements without a concrete platform need.
- Windows and Unix/macOS keep their existing versioned-candidate plus active-pointer/slot model. Validate the candidate and preserve failure recovery before retiring the previous local payload.
- Local old-payload cleanup and server release retention solve different problems: a successful local upgrade may remove stale local payloads while the distribution server still retains known-good releases for rollout recovery.
- macOS Apple Silicon and Intel are supported release targets. Browser architecture detection is only a convenience and must fall back safely when hardware architecture cannot be determined; installer-side OS-native detection may be authoritative.

### Gateway and resource discipline

- Gateway is the authorization/control plane, not a duplicate software-distribution service. Keep release packages and immutable package metadata on the download origin rather than copying them into D1/Worker state.
- Local UI can refresh frequently, but external Gateway/D1/Cloudflare reads and writes should be cached, event-driven, or low-frequency where possible.
- Device lifecycle remains fail-closed. Update convenience must not weaken per-binding authorization, reset/revoke semantics, or MCP session isolation.
- Device display caching is not authorization caching: MCP requests continue to read current binding state from primary D1. Only fleet policy/stable discovery has a bounded cache; concurrent reads coalesce and invalidated reads cannot refill it later.
- Apply backward-compatible D1 migrations before switching to a Worker that reads the new schema. Verify cleanup indexes with query plans and rows read, not merely their existence; keep migrations out of review-only runs.
- The public Gateway uses one project-owned Cloudflare `http_request_firewall_custom` rule identified by ref `team-devspace-gateway-surface`. It is scoped exactly to the Gateway hostname, explicitly blocks retired `/v1/device/status`, and blocks paths outside the stable Team DevSpace namespaces before Worker execution. Never broaden it to the entire operator zone or `tds-*` device Tunnel hosts, never use IP/country lists as the primary boundary, and never adopt/delete unrelated WAF rules. New public namespaces must update this boundary deliberately before shipping clients that require them.

### Status API migration

When changing status routes, publishing a client, retiring legacy polling, or selecting a Gateway rollback, read the Expand/Migrate/Contract section in `docs/updates.md`.

- Expand: deploy a Gateway that authenticates and serves both legacy `/v1/device/status` and replacement `/v1/device/status-v2` before shipping clients that require v2. Both routes remain Worker-first during migration; an in-Worker rejection does not remove Worker request usage.
- Migrate: publish and verify actual installed clients, including the recovery plan for offline/legacy devices. Updating source, the release alias, or a low-frequency inventory row alone is not evidence that every client migrated.
- Contract: retire legacy polling in a separate approved change only after migration evidence and recovery paths exist. Preserve a v2-capable Gateway rollback after clients migrate; do not combine the first v2 client release with a static bypass/tombstone for the old endpoint.
- Contract was explicitly approved and applied on 2026-09-15. The operator's Cloudflare WAF blocks the Gateway's `/v1/device/status` in `http_request_firewall_custom` before Worker execution, and the Worker no longer routes the legacy endpoint. Do not reintroduce it as a compatibility fallback. 0.2.4 can recover through its updater; 0.2.3 and older use the documented manual covering install. Keep every Gateway rollback target v2-capable.

### Release verification

- Upgrade acceptance must exercise an existing installed and enrolled state, not only a clean install. Verify identity/binding/root/pause preservation and failed-activation recovery.
- Validate the final artifact employees actually receive: real Windows installer behavior; Linux systemd and non-systemd paths where relevant; both macOS architectures at packaging level and on real Macs when available.
- Treat install, upgrade, repair, uninstall, first launch, tray/menu entrypoints, and failure feedback as one product lifecycle. Packaging success alone is not a release-ready signal.

## Fault-isolation invariants (0.2.6)
- Progress/render subscribers, diagnostics sinks, recoverable discovery caches and conservative version-inventory writes must not own core lifecycle transactions. Handle synchronous throws and asynchronous rejections only at explicit optional boundaries; never globally suppress uncaught errors.
- Durable Control Center capability port affinity is authorization state, not an optional endpoint cache. A moved or ephemeral origin gets a different token. Normal same-origin upgrades preserve it; malformed credentials remain fail-closed.
- The initial durable updater handoff guard is mandatory. After OS handoff, a best-effort phase projection cannot release the drain, mark installation failed or permit a duplicate installer.
- Stop/remove attempts all independently owned components and then reports failures. A partial stop cannot authorize restart. Rollback retains a possibly running candidate until native ownership cleanup is confirmed; never delete its binaries or start the previous owner early.
- Project-root rollback follows the same ownership boundary: do not rewrite an unresolved running owner's facts, and never restart before both original configuration and state have been restored. Desktop Enrollment may report partial Tray startup after core startup succeeds; never downgrade a required core startup error to that warning.
- Ordinary reopening repairs a missing Tray startup entry through the existing installer scoped to `['tray']`, then retries Tray once. If auxiliary repair fails, keep healthy core jobs running and report the limitation; never use whole-product bootstrap just to restore Tray.
- Reopening a valid macOS installation uses the existing start/reuse path, not startup reinstallation. Optional log fallback happens before exec, never by retrying a worker that already executed. Keep launchd/Task Scheduler/standalone ownership checks strict.
- A failed inventory write may retain only a conservative lower/unknown version. A failed downgrade report fences the device before a stale higher version influences minimum-version admission. Explicit inventory endpoints continue reporting storage failures.

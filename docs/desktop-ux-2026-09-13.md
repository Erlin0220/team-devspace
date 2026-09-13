# Desktop UX follow-up, 2026-09-13

## Decisions and ownership

The controller remains the only owner of operation progress, observed health and lifecycle actions. Completion notices describe completed work, not an unfinished health probe. A manual check retires the preceding completion notice; persistent actionable errors are not silently erased. A late startup probe cannot overwrite a completed mutation or strand the checking indicator.

The native tray keeps status, device/project identity, pause/resume, Settings, a Diagnostics and Repair submenu, About and Exit. The submenu exposes Check, Restart, Repair, Logs and full diagnostics with the same availability rules as the controller. Neither native adapter implements connection operations. About and full diagnostics navigate sections of the existing protected loopback page, not additional windows with duplicate business state.

Windows Desktop and Start Menu now contain a normal Team DevSpace launcher with the existing product icon. Both target the stable no-console launcher and resolve the installed payload through active.json. Opening the app starts existing current-user jobs, does not reinstall startup entries and does not resume a paused connection. Exit stops the current session and tray without changing persisted remote-access intent or login startup. Repeated opens rely on the existing Task Scheduler and native single-instance policy. The obsolete Status shortcut is removed; Repair and Uninstall remain recovery/maintenance entries.

macOS retains the established lifecycle refresh when reopening an unchanged installation; it still skips payload extraction. A trial using only `start` was rejected by Codemagic build 30: postinstall clears the previous visibility marker, while an already-running tray does not issue a new acknowledgment, causing repeated installation to fall into the launch-help dialog. The unnecessary fast-path optimization was reverted instead of adding another state source or fabricating a visibility marker. AppKit renders the same one-level submenu and remains a thin frontend.

The Web page prioritizes connection and current project, keeps direct folder selection a single operation, and places manual paths, key replacement and deeper repair behind named disclosure controls. Setup expands the key form when required. Busy feedback is visible and finite; section navigation explicitly scrolls and focuses its destination. No new frontend framework, daemon, persisted state source or runtime dependency was introduced.

## Verification before release commit

- Full Node test suite completed without failures, including controller races, actual PowerShell parsing, shared menu authorization and local-control origin/capability protection. New tests cover completion notices, late probes and About routing.
- Windows candidate was built with the pinned npm and native toolchain. The packaged native tray, not a stale standalone development binary, passed all nine menu events, submenu dispatch, single-instance and protocol checks.
- Platform acceptance exercised the original employee EXE through upgrade, repeated installation, Repair, uninstall and restoration; installed payload hashes, original identity/project/access intent and startup ownership were checked. This candidate evidence is marked sourceDirty and must not be presented as clean-commit release evidence.
- Actual employee tray: Exit removed the tray; Desktop relaunch restored a healthy connection. Pausing, exiting and reopening three times through Start Menu retained the pause and one tray instance. Real Diagnostics submenu correctly disabled Restart/Repair while paused. Check and About were invoked through native menu controls, and remote access was restored afterward.
- Actual installed Web page in the default browser: a real Restart showed progress and then completion/connected state, with no stale checking message after multiple polls. Windows UI Automation was used because that default browser is not the isolated Playwright profile.
- Actual installed folder-picker helper: cancel, confirm, cancel and abort all returned the expected result. Each dialog was visible, owned, above its caller and observed in the foreground, without disabling the foreign caller.
- Layout was visually inspected in a real browser. The broader fixture browser script remains a repeatable regression test, but its bulk execution was blocked by the current browser tool security check; it is not counted as a completed browser acceptance run.

## Release evidence and limits

Final platform reports bind acceptance to the commit and installer SHA-256. Rebuild and rerun acceptance from the clean release commit. Codemagic must compile both macOS architectures and run its existing system PKG/LaunchAgent/native UI checks before their artifacts can be published.

Automated GUI invocation is not human usability acceptance. Transient console flashes, Windows login/reboot behavior, employee Mac Gatekeeper dialogs, physical Intel hardware and all supported display/accessibility configurations are not established by smoke tests. macOS remains unsigned/unnotarized under the existing internal-free distribution policy. Windows internal signing requires the existing fixed publisher credentials; never generate a replacement identity merely to make a release green.

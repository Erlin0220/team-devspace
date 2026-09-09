# Use native user-session lifecycle managers

Team DevSpace uses each operating system's supported user-session lifecycle manager instead of shipping another supervisor:

- Windows uses Task Scheduler with `InteractiveToken` and `LeastPrivilege`. A small GUI-subsystem launcher creates a Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, redirects logs and owns the component process tree without a persistent PowerShell or `cmd.exe` process.
- macOS uses per-user LaunchAgents. The menu-bar app is an `LSUIElement` application and runtime processes remain owned by `launchd`.
- Linux uses systemd user services with native restart policy and journaling-compatible process ownership.

NSIS and macOS Installer remain packaging/bootstrap layers only. They verify immutable offline artifacts, stage a candidate, stop the active version, configure the candidate and commit one active pointer. Enrollment and project data stay in the user's private state directory outside the replaceable payload. Before activation, a failed candidate removes its partial startup entries and restores the prior startup entries using the retained local state; restoration does not contact the Gateway.

We deliberately do not add WinSW, a Windows Service, a privileged daemon, Electron, or another cross-platform supervisor. Those options duplicate native lifecycle management, increase privilege and maintenance surface, and do not fit a product that must run as the logged-in employee with access to that employee's projects and desktop tray. The native mechanisms are documented by Microsoft ([Task Scheduler schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/task-scheduler-schema), [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)), Apple ([Creating Launch Daemons and Agents](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)) and systemd ([systemd.service](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml)).

Platform scripts are intentionally thin adapters around those managers. Installer progress uses the MUI2 install-files progress handle rather than a dialog control ID, and failure messages distinguish successful restoration from cleanup/restoration failure.

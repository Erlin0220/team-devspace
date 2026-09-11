# Linux without systemd

Team DevSpace uses the same Linux x64 offline archive on a normal systemd host and on a user-owned Linux cloud computer without systemd. There is no Grok-specific client, platform flag, new service API, npm dependency or alternate Enrollment store.

## Lifecycle selection and ownership

A successful `systemctl --user show-environment` selects the existing systemd user units. Standalone is selected only when `systemctl` cannot be executed because it is absent and neither `/usr/bin/systemctl` nor `/bin/systemctl` exists. A present but broken user manager, permission error, timeout or hidden PATH entry is an actionable failure, not permission to start a second manager.

Standalone starts one detached Node keeper for Runtime (DevSpace + Bridge) and one for cloudflared. It reuses the existing `installServices` / `serviceAction` boundary and the existing per-device operation lock. Runtime and Tunnel remain independently controllable. Nonzero exits/signals use bounded backoff and stop after five consecutive rapid failures; `repair` explicitly recovers a stopped keeper. A normal exit is not restarted. There is no daemon supervising the keepers themselves.

Each keeper uses the already-shipped `proper-lockfile` heartbeat plus disposable metadata under `/tmp/team-devspace-<uid>/<canonical-home-and-pid-namespace-hash>`. PID ownership includes UID, process start time, boot ID, namespace and the keeper's launch nonce. Cleanup also tracks the nonce inherited by worker descendants, including PTYs/children that create their own session. It never uses host-wide `pkill` or assumes an existing PID is owned. A fresh unresolved lock fails closed; stale locks and dead-owner metadata can be repaired. The location is stable across shells with different `XDG_RUNTIME_DIR` values.

`state.json` remains the remote-access policy source. A paused installation cannot be restarted by `start`, `repair`, a stale caller or a retrying keeper. Resume continues to bring up local services behind the suspended Gateway before reopening remote access. If a host later gains systemd, `start` refuses to mix managers; explicit `repair`/startup installation removes the previous standalone owner before installing systemd units.

## Install on a persistent cloud-computer filesystem

Use a private employee Access Key for this machine, not an administrator credential or another machine's identity. Obtain the current Linux archive and its SHA-256 through the existing private distribution channel. Verify the checksum before extracting it. The example assumes the supplied archive and employee credential file are already on the cloud computer; replace the credential filename with its actual private path.

```sh
umask 077
D=/workspace/.team-devspace
mkdir -p "$D/media" /workspace/repos
# Verify the supplied SHA-256 before this extraction.
tar -xzf Team-DevSpace-0.2.1-linux-x64-offline.tar.gz -C "$D/media"
TEAM_DEVSPACE_HOME="$D/state" TEAM_DEVSPACE_CLI_DIR="$D/bin" \
  sh "$D/media/install.sh" --root "$D/distribution" --offline "$D/media"
"$D/distribution/bin/team-devspace" setup \
  --credential-file /workspace/employee-key.json --root /workspace/repos
"$D/distribution/bin/team-devspace" status
```

Here the installer's `--root` is the replaceable **distribution directory**, while CLI setup's `--root` is the Device's single **Current Project Root**. Keep state outside distribution because distribution uninstall removes replaceable software. The stable CLI retains the custom state location through a small `state-home` installation locator; the installer likewise retains the CLI link directory for upgrades/uninstall from a fresh shell. These locators contain paths, not another copy of device state or credentials. Changing an existing distribution's retained directories is rejected rather than silently orphaning its original state or command.

The offline archive already contains the pinned Node, cloudflared and native modules. The destination needs no compiler, package-manager install or `xz`. Existing systemd Linux default paths are unchanged. Shell tools still execute with the employee user's permissions: Current Project Root is a file-tool boundary, **not a shell sandbox**. Same-user cloud agents can access the same user's files and credentials.

## Operations and recovery boundaries

Use the stable CLI for `status`, `diagnostics`, `logs [--follow]`, `start`, `stop`, `restart`, `suspend`, `resume`, `repair`, `project-root show|set` and `uninstall`. Standalone logs live in the existing private `state/logs` directory, with bounded per-component output/error files and redacted diagnostics. There is no journald dependency. `uninstall` at the CLI stops/removes startup but retains Enrollment and projects, as on the other platforms. The offline installer `--mode uninstall --root "$D/distribution"` also removes its software directory and its owned stable command link; it does not remove the separate state/repositories.

Closing the local desktop client or terminal is different from recreating the remote machine. Standalone works while that cloud computer is running; it is **not an OS boot hook or a guarantee that a provider keeps a VM awake**. After a full container/VM recreation, invoke the persistent stable CLI's `repair` through an independently available cloud-computer terminal or a host-provided startup hook. Repair respects an existing pause and does not automatically resume it. Do not infer that files or processes survive every provider update from a successful desktop-client-close test.

Stopping/suspending the service used by an MCP connection may disconnect that very connection. Recovery must have an out-of-band path, such as the cloud computer's terminal. No Gateway wakeup webhook, paid routine, or new external recovery service is introduced.

## Repeatable acceptance

After building the Linux archive, run `npm run test:standalone` **as the ordinary user in a real no-systemd Linux environment**. It extracts the actual archive and uses its installer, pinned Node/native modules, CLI, Runtime and Bridge. Only the Tunnel and remote control plane are explicit deterministic fixtures; the test report never calls them real Cloudflare or real ChatGPT.

For the existing local Ubuntu 22.04 WSL test host, a disposable mount/PID namespace provides the absent-systemd case without removing systemctl from the host:

```powershell
npm run acceptance:linux:wsl
wsl.exe -d Ubuntu-22.04 -u root -- /bin/sh `
  /home/clin/team-devspace-linux/scripts/linux-no-systemd.sh `
  clin /home/clin/team-devspace-linux /opt/node-v22.23.0-linux-x64/bin/node
```

The second command is an optional developer test harness, not a runtime installation step. Root creates only private mount/PID namespaces; all application tests run as the specified non-root user. The helper requires a usr-merged test host and working `unshare`, overlayfs and `setpriv`. The host systemd binary and services are untouched. A normal no-systemd cloud computer needs none of these test-harness tools.

The standalone smoke covers authenticated MCP read/write/shell, fresh-shell state lookup, concurrent start, worker and keeper crashes, orphan/PTY cleanup, stale PID/lock refusal and recovery, bounded crash loops, pause/repair invariants, resume, scoped Current Project Root restart, upgrade retention, corrupt artifacts, failed-activation rollback, logs/follow termination, permissions and scoped uninstall. The normal WSL native gate additionally tests live standalone-to-systemd ownership transfer.

Real cloud acceptance is separate: install the unmodified final archive with a disposable real device Key; check ready and remote MCP tools; close the local desktop client and repeat; crash each owned worker; verify suspend rejects remote requests and resume recovers; uninstall and revoke the Key. SDK-originated MCP calls must remain labelled `realChatGPT: false` until a real ChatGPT conversation invokes the connected app. Never edit the user's existing personal DevSpace connector to conduct this test.

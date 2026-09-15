import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { access, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { join, delimiter, resolve } from 'node:path';
import { installRoot, privateDirectory, stateHome } from './state.mjs';
import { linuxServiceManager } from './linux-lifecycle.mjs';

const exec = promisify(execFile);
export const COMPONENTS = ['runtime', 'tunnel'];
// A function invocation can fail its redirections before exec. Once exec succeeds,
// the shell is replaced: runtime errors are never retried as logging failures.
export const MAC_DIAGNOSTIC_LAUNCH = 'umask 077; run() { exec "$@"; }; run "$@" >>"$TEAM_DEVSPACE_STDOUT" 2>>"$TEAM_DEVSPACE_STDERR" || run "$@" >/dev/null 2>&1';
export const STARTUP_COMPONENTS = process.platform === 'win32' || process.platform === 'darwin'
  ? [...COMPONENTS, 'tray'] : COMPONENTS;
export const enabledStartupComponents = state => state.remoteAccess === 'suspended'
  ? STARTUP_COMPONENTS.filter(component => component === 'tray') : STARTUP_COMPONENTS;
export const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const quoted = value => `"${String(value).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
const systemdQuoted = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;

export async function executablePaths(root = installRoot) {
  const node = process.platform === 'win32' ? join(root, 'runtime', 'node.exe') : join(root, 'runtime', 'bin', 'node');
  const cloudflared = join(root, 'bin', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  try { await access(node); } catch { return { node: process.execPath, cloudflared }; }
  return { node, cloudflared };
}

export function componentArguments(component, home, state, root = installRoot) {
  if (component === 'tunnel') return ['--no-autoupdate', 'tunnel', '--metrics', `127.0.0.1:${state.ports.metrics}`,
    '--loglevel', 'warn', 'run', '--token-file', join(home, 'tunnel.token')];
  return [join(root, 'client', 'cli.mjs'), 'run', component, '--home', home];
}

function localOwnerId(state) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state?.ownerToken ?? '')) throw new Error('Invalid local lifecycle owner');
  return createHash('sha256').update(state.ownerToken).digest('hex').slice(0, 16);
}

export function serviceLabel(state, component, platform = process.platform) {
  if (!STARTUP_COMPONENTS.includes(component)) throw new Error('Unknown component');
  if (platform === 'linux') return `team-devspace-${component}`;
  if (platform === 'darwin') return `com.teamdevspace.${component}`;
  if (platform === 'win32') return `com.teamdevspace.${localOwnerId(state)}.${component}`;
  throw new Error('Unsupported runtime platform');
}

function legacyServiceLabel(state, component) {
  return `com.teamdevspace.${state.deviceId.replaceAll('-', '')}.${component}`;
}

export function windowsTaskNames(output) {
  return String(output).split(/\r?\n/).map(line => /^"([^"]+)"/.exec(line)?.[1]?.replace(/^\\/, ''))
    .filter(name => /^com\.teamdevspace\.(?:[a-f0-9]{16}|[a-f0-9]{32})\.(?:runtime|tunnel|tray)$/i.test(name ?? ''));
}

async function windowsOwnedLifecycleLabels(sid, home, components = STARTUP_COMPONENTS) {
  const listing = await native('schtasks.exe', ['/Query', '/FO', 'CSV', '/NH'], true);
  if (!listing) return [];
  const labels = [];
  const expectedHome = `"TEAM_DEVSPACE_HOME=${home}"`.toLowerCase();
  for (const label of windowsTaskNames(listing.stdout)) {
    if (!components.some(component => label.endsWith(`.${component}`))) continue;
    const task = await native('schtasks.exe', ['/Query', '/TN', label, '/XML'], true);
    if (task && new RegExp(`<UserId>\\s*${sid.replaceAll('-', '\\-')}\\s*</UserId>`, 'i').test(task.stdout) &&
        task.stdout.toLowerCase().includes(expectedHome)) labels.push(label);
  }
  return labels;
}

async function macOwnedLegacyLabels(home, components = STARTUP_COMPONENTS) {
  const directory = join(homedir(), 'Library', 'LaunchAgents');
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const expectedHome = `<key>TEAM_DEVSPACE_HOME</key><string>${xml(home)}</string>`;
  const labels = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^((?:com\.teamdevspace\.)[a-f0-9]{32}\.(runtime|tunnel|tray))\.plist$/i.exec(entry.name);
    if (!match || !components.includes(match[2])) continue;
    const text = await readFile(join(directory, entry.name), 'utf8').catch(() => '');
    if (text.includes(expectedHome)) labels.push(match[1]);
  }
  return labels;
}

async function linuxOwnedLegacyUnits(home, components = COMPONENTS) {
  const directory = systemdUserDirectory();
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const expectedHome = `Environment=${systemdQuoted(`TEAM_DEVSPACE_HOME=${home}`)}`;
  const units = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = /^((?:com\.teamdevspace\.)[a-f0-9]{32}\.(runtime|tunnel))\.service$/i.exec(entry.name);
    if (!match || !components.includes(match[2])) continue;
    const text = await readFile(join(directory, entry.name), 'utf8').catch(() => '');
    if (text.includes(expectedHome)) units.push(entry.name);
  }
  return units;
}

export function launchAgentXml(state, component, home, paths, root = installRoot) {
  const program = component === 'tunnel' ? paths.cloudflared : paths.node;
  const label = serviceLabel(state, component, 'darwin');
  const path = [process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin', '/opt/homebrew/bin', '/usr/local/bin', join(root, 'runtime', 'bin'), join(root, 'bin')].join(delimiter);
  const uiEnvironment = component === 'tray'
    ? `<key>TEAM_DEVSPACE_UI_READY_MARKER</key><string>${xml(join(home, '.ui-ready'))}</string>` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${['/bin/sh', '-c', MAC_DIAGNOSTIC_LAUNCH, 'team-devspace', program, ...componentArguments(component, home, state, root)].map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string><key>TEAM_DEVSPACE_HOME</key><string>${xml(home)}</string><key>NODE_OPTIONS</key><string></string>${uiEnvironment}<key>TEAM_DEVSPACE_STDOUT</key><string>${xml(join(home, "logs", component + ".log"))}</string><key>TEAM_DEVSPACE_STDERR</key><string>${xml(join(home, "logs", component + ".error.log"))}</string></dict>
<key>RunAtLoad</key><true/>${component === 'tray'
    ? '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>LimitLoadToSessionType</key><string>Aqua</string>'
    : '<key>KeepAlive</key><true/>'}<key>ThrottleInterval</key><integer>15</integer>
<key>ProcessType</key><string>${component === 'tray' ? 'Interactive' : 'Background'}</string>
</dict></plist>\n`;
}

export function windowsTaskXml(state, component, home, sid, root = installRoot) {
  if (!STARTUP_COMPONENTS.includes(component)) throw new Error('Unknown component');
  const launcher = join(root, 'platform', 'windows', 'tds-launcher.exe');
  const program = component === 'tunnel' ? join(root, 'bin', 'cloudflared.exe') : join(root, 'runtime', 'node.exe');
  const args = ['--cwd', root, '--stdout', join(home, 'logs', `${component}.log`),
    '--stderr', join(home, 'logs', `${component}.error.log`), '--env', `TEAM_DEVSPACE_HOME=${home}`,
    '--env', 'NODE_OPTIONS=', '--', program, ...componentArguments(component, home, state, root)];
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<RegistrationInfo><Description>Team DevSpace ${xml(component)}; runs only in this employee session.</Description><SecurityDescriptor>D:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;${xml(sid)})</SecurityDescriptor></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(sid)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Employee"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>10</Count></RestartOnFailure></Settings>
<Actions Context="Employee"><Exec><Command>${xml(launcher)}</Command><Arguments>${xml(args.map(quoted).join(' '))}</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions>
</Task>\n`;
}

// Fixed user-unit names are reused after reinstall and across test homes. A
// journal read must identify the current owner and invocation, not just its name.
export async function linuxJournalInvocation(home, component, { run = exec, read = readFile } = {}) {
  if (!COMPONENTS.includes(component)) return null;
  const unit = `${serviceLabel(null, component, 'linux')}.service`;
  const { stdout } = await run('systemctl', ['--user', 'show', unit, '--property=FragmentPath,InvocationID'],
    { timeout: 5000, maxBuffer: 64 * 1024 });
  const fragment = /^FragmentPath=(.+)$/m.exec(stdout)?.[1];
  const invocation = /^InvocationID=([a-f0-9]{32})$/m.exec(stdout)?.[1];
  if (!fragment || !invocation || /^0+$/.test(invocation)) return null;
  const unitText = await read(fragment, 'utf8');
  return unitText.includes(`Environment=${systemdQuoted(`TEAM_DEVSPACE_HOME=${home}`)}\n`) ? invocation : null;
}

export function systemdUserUnit(state, component, home, paths, root = installRoot) {
  const distributionRoot = resolve(process.env.TEAM_DEVSPACE_DISTRIBUTION_ROOT ?? join(root, '..', '..'));
  const activePath = join(distributionRoot, 'active-path');
  const path = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const command = component === 'tunnel'
    ? `active=$(sed -n '1p' "$TEAM_DEVSPACE_ACTIVE_PATH"); case "$active" in "$TEAM_DEVSPACE_DISTRIBUTION_ROOT"/versions/*) ;; *) echo 'Invalid Team DevSpace active path' >&2; exit 1 ;; esac; export PATH="$active/runtime/bin:$active/bin:$PATH"; cd "$active"; exec "$active/bin/cloudflared" --no-autoupdate tunnel --metrics "127.0.0.1:${state.ports.metrics}" --loglevel warn run --token-file "$TEAM_DEVSPACE_HOME/tunnel.token"`
    : `active=$(sed -n '1p' "$TEAM_DEVSPACE_ACTIVE_PATH"); case "$active" in "$TEAM_DEVSPACE_DISTRIBUTION_ROOT"/versions/*) ;; *) echo 'Invalid Team DevSpace active path' >&2; exit 1 ;; esac; export PATH="$active/runtime/bin:$active/bin:$PATH"; cd "$active"; exec "$active/runtime/bin/node" "$active/client/cli.mjs" run runtime --home "$TEAM_DEVSPACE_HOME"`;
  // ':' is the systemd executable prefix that disables Exec*= $variable expansion. The shell must
  // receive $active/$TEAM_DEVSPACE_* literally because it resolves active-path at process start.
  const arguments_ = `/bin/sh -c ${systemdQuoted(command)}`;
  return `[Unit]\nDescription=Team DevSpace ${component}\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n` +
    `[Service]\nType=simple\nExecStart=:${arguments_}\n` +
    `Environment=${systemdQuoted(`TEAM_DEVSPACE_HOME=${home}`)}\nEnvironment=${systemdQuoted(`TEAM_DEVSPACE_DISTRIBUTION_ROOT=${distributionRoot}`)}\n` +
    `Environment=${systemdQuoted(`TEAM_DEVSPACE_ACTIVE_PATH=${activePath}`)}\nEnvironment=${systemdQuoted('NODE_OPTIONS=')}\nEnvironment=${systemdQuoted(`PATH=${path}`)}\n` +
    `Restart=on-failure\nRestartSec=5\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n`;
}

export function systemdUserDirectory() {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user');
}

async function native(command, args, allowMissing = false) {
  const executable = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', command)
    : command === 'launchctl' ? '/bin/launchctl' : command;
  try { return await exec(executable, args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }); }
  catch (error) {
    if (allowMissing) return null;
    const detail = String(error.stderr ?? error.stdout ?? '').trim().replace(/\s+/g, ' ').slice(0, 240);
    throw new Error(`${command} ${args.join(' ')} failed (${error.code ?? 'unknown'})${detail ? `: ${detail}` : ''}. Check local startup permissions; no SYSTEM/root fallback is used.`);
  }
}

async function windowsSid() {
  const result = await native('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const sid = /S-1-5-[0-9-]+/.exec(result.stdout)?.[0];
  if (!sid) throw new Error('Cannot resolve current Windows user');
  return sid;
}

async function windowsTaskRegistered(label, runNative = native) {
  const listing = await runNative('schtasks.exe', ['/Query', '/FO', 'CSV', '/NH']);
  return windowsTaskNames(listing.stdout).some(name => name.toLowerCase() === label.toLowerCase());
}

export async function removeWindowsTask(label, { runNative = native, wait = sleep, attempts = 4 } = {}) {
  await runNative('schtasks.exe', ['/End', '/TN', label], true);
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await runNative('schtasks.exe', ['/Delete', '/TN', label, '/F']);
      return;
    } catch (error) {
      lastError = error;
      if (!await windowsTaskRegistered(label, runNative)) return;
      if (attempt + 1 < attempts) {
        await wait(150 * (attempt + 1));
        await runNative('schtasks.exe', ['/End', '/TN', label], true);
      }
    }
  }
  throw lastError;
}

export async function waitForMacJobsUnloaded(domain, labels, { runNative = native, wait = sleep, attempts = 100 } = {}) {
  const pending = [...new Set(labels)];
  for (let attempt = 0; attempt < attempts; attempt++) {
    const loaded = [];
    for (const label of pending) {
      if (await runNative('launchctl', ['print', `${domain}/${label}`], true)) loaded.push(label);
    }
    if (!loaded.length) return;
    pending.splice(0, pending.length, ...loaded);
    if (attempt + 1 < attempts) await wait(100);
  }
  throw new Error(`launchd still owns stopped Team DevSpace jobs: ${pending.join(', ')}`);
}

export async function installServices(state, home = stateHome(), root = installRoot, scope = STARTUP_COMPONENTS) {
  const pendingMacTrayOnly = process.platform === 'darwin' && scope.length === 1 && scope[0] === 'tray';
  if (!state.bindingId && !pendingMacTrayOnly) throw new Error('Enrollment is required before installing startup entries');
  if (scope.some(component => !STARTUP_COMPONENTS.includes(component))) throw new Error('Unknown startup component');
  const desired = enabledStartupComponents(state);
  const components = scope.filter(component => desired.includes(component));
  const disabled = scope.filter(component => !desired.includes(component));
  await privateDirectory(join(home, 'logs')).catch(() => {}); // Native launchers have a null diagnostics sink fallback.
  await privateDirectory(join(home, 'startup'));
  await access(join(root, 'client', 'cli.mjs'));
  const paths = await executablePaths(root);
  if (components.includes('tunnel')) await access(paths.cloudflared);
  if (process.platform === 'win32') {
    if (components.some(component => component !== 'tunnel')) await access(join(root, 'runtime', 'node.exe'));
    if (components.length) await access(join(root, 'platform', 'windows', 'tds-launcher.exe'));
    const sid = await windowsSid();
    if (components.includes('tray')) await access(join(root, 'platform', 'windows', 'team-devspace-tray.exe'));
    const currentLabels = new Set(scope.map(component => serviceLabel(state, component, 'win32')));
    for (const stale of await windowsOwnedLifecycleLabels(sid, home, scope)) {
      if (currentLabels.has(stale)) continue;
      await removeWindowsTask(stale);
    }
    if (disabled.length) await serviceAction('remove', state, home, disabled);
    for (const component of components) {
      const task = join(home, 'startup', `${component}.xml`);
      await writeFile(task, `\uFEFF${windowsTaskXml(state, component, home, sid, root)}`, 'utf16le');
      await native('schtasks.exe', ['/Create', '/TN', serviceLabel(state, component), '/XML', task, '/F']);
    }
  } else if (process.platform === 'darwin') {
    if (process.getuid() === 0) throw new Error('Install user startup as the employee, not root');
    const directory = join(homedir(), 'Library', 'LaunchAgents');
    await mkdir(directory, { recursive: true });
    if (components.some(component => component !== 'tunnel')) await access(join(root, 'runtime', 'bin', 'node'));
    if (components.includes('tray')) await access(join(root, 'platform', 'macos', 'Team DevSpace Tray.app', 'Contents', 'MacOS', 'TeamDevSpaceTray'));
    const domain = `gui/${process.getuid()}`;
    const legacyLabels = new Set([
      ...scope.map(component => legacyServiceLabel(state, component)),
      ...await macOwnedLegacyLabels(home, scope),
    ]);
    for (const legacy of legacyLabels) {
      await native('launchctl', ['bootout', `${domain}/${legacy}`], true);
      await rm(join(directory, `${legacy}.plist`), { force: true });
    }
    if (disabled.length) await serviceAction('remove', state, home, disabled);
    const reloaded = [];
    for (const component of components) {
      const label = serviceLabel(state, component);
      if (await native('launchctl', ['print', `${domain}/${label}`], true)) {
        await native('launchctl', ['bootout', `${domain}/${label}`], true);
        reloaded.push(component);
      }
    }
    if (reloaded.length) {
      await waitForMacJobsUnloaded(domain, reloaded.map(component => serviceLabel(state, component)));
      await waitForStopped(state, reloaded);
    }
    for (const component of components) {
      const label = serviceLabel(state, component);
      const target = join(directory, `${label}.plist`);
      // launchd keeps the loaded job definition even when its plist is overwritten.
      // Rewrite it only after the old stable job is fully gone.
      await writeFile(target, launchAgentXml(state, component, home, paths, root), { mode: 0o600 });
    }
  } else if (process.platform === 'linux') {
    if (process.getuid() === 0) throw new Error('Install user startup as the employee, not root');
    const { installStandalone, hasStandaloneStartup, standaloneAction } = await import('./standalone.mjs');
    if (await linuxServiceManager() === 'standalone') return installStandalone(state, home, root, scope);
    if (await hasStandaloneStartup(home, scope)) {
      await standaloneAction('remove', state, home, [...scope].reverse());
      await waitForStopped(state, scope);
    }
    const directory = systemdUserDirectory();
    await mkdir(directory, { recursive: true });
    if (scope.includes('runtime')) await access(join(root, 'runtime', 'bin', 'node'));
    if (scope.includes('tunnel')) await access(paths.cloudflared);
    const legacyUnits = new Set([
      ...scope.map(component => `${legacyServiceLabel(state, component)}.service`),
      ...await linuxOwnedLegacyUnits(home, scope),
    ]);
    for (const legacy of legacyUnits) {
      await native('systemctl', ['--user', 'disable', '--now', legacy], true);
      await rm(join(directory, legacy), { force: true });
    }
    for (const component of scope) {
      const unit = `${serviceLabel(state, component)}.service`;
      await writeFile(join(directory, unit), systemdUserUnit(state, component, home, paths, root), { mode: 0o600 });
    }
    await native('systemctl', ['--user', 'daemon-reload']);
    for (const component of scope) {
      const unit = `${serviceLabel(state, component)}.service`;
      if (desired.includes(component)) await native('systemctl', ['--user', 'enable', unit]);
      else await native('systemctl', ['--user', 'disable', '--now', unit], true);
    }
  } else throw new Error('Only Windows, macOS and Linux user-login startup are supported');
}

async function waitForStopped(state, components) {
  const ports = components.flatMap(component => component === 'runtime'
    ? [state.ports.devspace, state.ports.bridge] : component === 'tunnel' ? [state.ports.metrics] : []);
  if (ports.length === 0) return;
  const isOpen = port => new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(300, () => finish(true));
  });
  const deadline = Date.now() + 10000;
  do {
    if (!(await Promise.all(ports.map(isOpen))).some(Boolean)) return;
    await sleep(100);
  } while (Date.now() < deadline);
  throw new Error('An owned service port is still open after stop. Upgrade/uninstall was halted instead of replacing running binaries.');
}

export async function serviceAction(action, state, home = stateHome(), components = STARTUP_COMPONENTS,
  { runNative = native, allowTrayFailure = false,
    repairTray = () => installServices(state, home, undefined, ['tray']) } = {}) {
  if (!['start', 'stop', 'restart', 'enable', 'disable', 'remove'].includes(action)) throw new Error('Unknown service action');
  if (action === 'disable' && !['win32', 'linux'].includes(process.platform)) throw new Error('Disable without removing startup is unsupported on this platform');
  if (action === 'enable' && process.platform !== 'win32') throw new Error('Explicit startup enable is only required on Windows');
  if (action === 'restart') {
    await serviceAction('stop', state, home, components, { runNative });
    return serviceAction('start', state, home, components, { runNative });
  }
  if (components.some(component => !STARTUP_COMPONENTS.includes(component))) throw new Error('Unknown startup component');
  const ordered = ['stop', 'disable', 'remove'].includes(action) ? [...components].reverse() : components;
  if (process.platform === 'linux') {
    const { standaloneAction, hasStandaloneStartup } = await import('./standalone.mjs');
    if (await linuxServiceManager() === 'standalone') {
      await standaloneAction(action, state, home, ordered);
      if (['stop', 'disable', 'remove'].includes(action)) await waitForStopped(state, components);
      return;
    }
    if (await hasStandaloneStartup(home, components)) {
      if (action === 'start') throw new Error('Standalone startup exists on a systemd host. Run repair to transfer ownership before starting systemd jobs.');
      await standaloneAction(action, state, home, ordered);
    }
  }
  const windowsOwned = process.platform === 'win32' && action !== 'start'
    ? await windowsOwnedLifecycleLabels(await windowsSid(), home, components) : [];
  const macOwned = process.platform === 'darwin' && action !== 'start'
    ? await macOwnedLegacyLabels(home, components) : [];
  const linuxOwned = process.platform === 'linux' && action !== 'start'
    ? await linuxOwnedLegacyUnits(home, components) : [];
  const macDomain = process.platform === 'darwin' ? `gui/${process.getuid()}` : null;
  const macBootedOut = [];
  const failures = [];
  let warning;
  for (const component of ordered) {
    try {
      const label = serviceLabel(state, component);
      if (process.platform === 'win32') {
        if (action === 'start') await runNative('schtasks.exe', ['/Run', '/TN', label]);
        else {
          const labels = [...new Set([label, legacyServiceLabel(state, component),
            ...windowsOwned.filter(owned => owned.endsWith(`.${component}`))])];
          for (const ownedLabel of labels) {
            const existing = await runNative('schtasks.exe', ['/Query', '/TN', ownedLabel, '/XML'], true);
            if (existing) {
              if (action === 'remove') await removeWindowsTask(ownedLabel);
              else if (action === 'disable') {
                await runNative('schtasks.exe', ['/End', '/TN', ownedLabel]);
                await runNative('schtasks.exe', ['/Change', '/TN', ownedLabel, '/DISABLE']);
              } else if (action === 'enable') {
                await runNative('schtasks.exe', ['/Change', '/TN', ownedLabel, '/ENABLE']);
              } else await runNative('schtasks.exe', ['/End', '/TN', ownedLabel]);
            }
          }
        }
      } else if (process.platform === 'darwin') {
        const directory = join(homedir(), 'Library', 'LaunchAgents');
        const plist = join(directory, `${label}.plist`);
        if (action === 'start') {
          const existing = await runNative('launchctl', ['print', `${macDomain}/${label}`], true);
          if (!existing) await runNative('launchctl', ['bootstrap', macDomain, plist]);
          await runNative('launchctl', ['kickstart', `${macDomain}/${label}`]);
        } else {
          const labels = [...new Set([label, legacyServiceLabel(state, component),
            ...macOwned.filter(owned => owned.endsWith(`.${component}`))])];
          for (const ownedLabel of labels) {
            await runNative('launchctl', ['bootout', `${macDomain}/${ownedLabel}`], true);
            macBootedOut.push(ownedLabel);
            if (action === 'remove') await rm(join(directory, `${ownedLabel}.plist`), { force: true });
          }
        }
      } else if (process.platform === 'linux') {
        const unit = `${label}.service`;
        const directory = systemdUserDirectory();
        const unitFile = join(directory, unit);
        const ownedUnits = [...new Set([`${legacyServiceLabel(state, component)}.service`,
          ...linuxOwned.filter(owned => owned.endsWith(`.${component}.service`))])];
        if (action === 'start') await runNative('systemctl', ['--user', 'start', unit]);
        else if (action === 'disable') {
          await runNative('systemctl', ['--user', 'disable', '--now', unit], true);
          for (const owned of ownedUnits) await runNative('systemctl', ['--user', 'disable', '--now', owned], true);
        } else if (action === 'remove') {
          await runNative('systemctl', ['--user', 'disable', '--now', unit], true);
          for (const owned of ownedUnits) {
            await runNative('systemctl', ['--user', 'disable', '--now', owned], true);
            await rm(join(directory, owned), { force: true });
          }
          await rm(unitFile, { force: true });
        } else {
          await runNative('systemctl', ['--user', 'stop', unit], true);
          for (const owned of ownedUnits) await runNative('systemctl', ['--user', 'stop', owned], true);
        }
      } else throw new Error('Unsupported runtime platform');
    } catch (error) {
      // Ordinary reopening is not installer activation. A missing presentation
      // job must not trigger bootstrap and recycle otherwise healthy core jobs.
      if (action === 'start' && component === 'tray' && allowTrayFailure) {
        try {
          // Reuse the existing installer, scoped strictly to presentation. A
          // deleted login entry must recover on open, not stay headless forever.
          await repairTray();
          await serviceAction('start', state, home, ['tray'], { runNative });
        } catch {
          warning = '托盘暂未启动，核心连接未因此停止；可重新打开应用重试或通过安装器修复。';
        }
        continue;
      }
      if (!['stop', 'disable', 'remove'].includes(action)) throw error;
      failures.push(error); // Still stop the other independently owned components.
    }
  }
  try {
    if (process.platform === 'darwin' && macBootedOut.length) {
      await waitForMacJobsUnloaded(macDomain, macBootedOut);
    }
    if (process.platform === 'linux' && action === 'remove') await runNative('systemctl', ['--user', 'daemon-reload']);
    if (['stop', 'disable', 'remove'].includes(action)) await waitForStopped(state, components);
  } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, 'Owned service cleanup failed; no replacement was started');
  if (warning) return { warning };
}

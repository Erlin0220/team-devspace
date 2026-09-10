import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, delimiter, resolve } from 'node:path';
import { installRoot, privateDirectory, stateHome } from './state.mjs';

const exec = promisify(execFile);
export const COMPONENTS = ['runtime', 'tunnel'];
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

export function serviceLabel(state, component, platform = process.platform) {
  if (!STARTUP_COMPONENTS.includes(component)) throw new Error('Unknown component');
  if (platform === 'linux') return `team-devspace-${component}`;
  return `com.teamdevspace.${state.deviceId.replaceAll('-', '')}.${component}`;
}

export function launchAgentXml(state, component, home, paths, root = installRoot) {
  const program = component === 'tunnel' ? paths.cloudflared : paths.node;
  const label = serviceLabel(state, component);
  const path = [process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin', '/opt/homebrew/bin', '/usr/local/bin', join(root, 'runtime', 'bin'), join(root, 'bin')].join(delimiter);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array>${[program, ...componentArguments(component, home, state, root)].map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(root)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string><key>TEAM_DEVSPACE_HOME</key><string>${xml(home)}</string><key>NODE_OPTIONS</key><string></string></dict>
<key>RunAtLoad</key><true/>${component === 'tray'
    ? '<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>'
    : '<key>KeepAlive</key><true/>'}<key>ThrottleInterval</key><integer>15</integer>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(join(home, 'logs', `${component}.log`))}</string>
<key>StandardErrorPath</key><string>${xml(join(home, 'logs', `${component}.error.log`))}</string>
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
<RegistrationInfo><Description>Team DevSpace ${xml(component)}; runs only in this employee session.</Description></RegistrationInfo>
<Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(sid)}</UserId></LogonTrigger></Triggers>
<Principals><Principal id="Employee"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>10</Count></RestartOnFailure></Settings>
<Actions Context="Employee"><Exec><Command>${xml(launcher)}</Command><Arguments>${xml(args.map(quoted).join(' '))}</Arguments><WorkingDirectory>${xml(root)}</WorkingDirectory></Exec></Actions>
</Task>\n`;
}

export function systemdUserUnit(state, component, home, paths, root = installRoot) {
  const distributionRoot = resolve(process.env.TEAM_DEVSPACE_DISTRIBUTION_ROOT ?? join(root, '..', '..'));
  const activePath = join(distributionRoot, 'active-path');
  const path = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin';
  const command = component === 'tunnel'
    ? `active=$(sed -n '1p' "$TEAM_DEVSPACE_ACTIVE_PATH"); case "$active" in "$TEAM_DEVSPACE_DISTRIBUTION_ROOT"/versions/*) ;; *) echo 'Invalid Team DevSpace active path' >&2; exit 1 ;; esac; export PATH="$active/runtime/bin:$active/bin:$PATH"; exec "$active/bin/cloudflared" --no-autoupdate tunnel --metrics "127.0.0.1:${state.ports.metrics}" --loglevel warn run --token-file "$TEAM_DEVSPACE_HOME/tunnel.token"`
    : `active=$(sed -n '1p' "$TEAM_DEVSPACE_ACTIVE_PATH"); case "$active" in "$TEAM_DEVSPACE_DISTRIBUTION_ROOT"/versions/*) ;; *) echo 'Invalid Team DevSpace active path' >&2; exit 1 ;; esac; export PATH="$active/runtime/bin:$active/bin:$PATH"; exec "$active/runtime/bin/node" "$active/client/cli.mjs" run runtime --home "$TEAM_DEVSPACE_HOME"`;
  // ':' is the systemd executable prefix that disables Exec*= $variable expansion. The shell must
  // receive $active/$TEAM_DEVSPACE_* literally because it resolves active-path at process start.
  const arguments_ = `/bin/sh -c ${systemdQuoted(command)}`;
  return `[Unit]\nDescription=Team DevSpace ${component}\nStartLimitIntervalSec=60\nStartLimitBurst=5\n\n` +
    `[Service]\nType=simple\nWorkingDirectory=${systemdQuoted(home)}\nExecStart=:${arguments_}\n` +
    `Environment=${systemdQuoted(`TEAM_DEVSPACE_HOME=${home}`)}\nEnvironment=${systemdQuoted(`TEAM_DEVSPACE_DISTRIBUTION_ROOT=${distributionRoot}`)}\n` +
    `Environment=${systemdQuoted(`TEAM_DEVSPACE_ACTIVE_PATH=${activePath}`)}\nEnvironment=${systemdQuoted('NODE_OPTIONS=')}\nEnvironment=${systemdQuoted(`PATH=${path}`)}\n` +
    `Restart=on-failure\nRestartSec=5\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n`;
}

export function systemdUserDirectory() {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd', 'user');
}

function legacyLinuxServiceLabel(state, component) {
  return `com.teamdevspace.${state.deviceId.replaceAll('-', '')}.${component}`;
}

async function native(command, args, allowMissing = false) {
  const executable = process.platform === 'win32'
    ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', command)
    : command === 'launchctl' ? '/bin/launchctl' : command;
  try { return await exec(executable, args, { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 }); }
  catch (error) {
    if (allowMissing) return null;
    const detail = process.platform === 'win32' ? ''
      : String(error.stderr ?? error.stdout ?? '').trim().replace(/\s+/g, ' ').slice(0, 240);
    throw new Error(`${command} ${args.join(' ')} failed (${error.code ?? 'unknown'})${detail ? `: ${detail}` : ''}. Check local startup permissions; no SYSTEM/root fallback is used.`);
  }
}

async function windowsSid() {
  const result = await native('whoami.exe', ['/user', '/fo', 'csv', '/nh']);
  const sid = /S-1-5-[0-9-]+/.exec(result.stdout)?.[0];
  if (!sid) throw new Error('Cannot resolve current Windows user');
  return sid;
}

export async function installServices(state, home = stateHome(), root = installRoot, scope = STARTUP_COMPONENTS) {
  if (!state.bindingId) throw new Error('Enrollment is required before installing startup entries');
  if (scope.some(component => !STARTUP_COMPONENTS.includes(component))) throw new Error('Unknown startup component');
  const desired = enabledStartupComponents(state);
  const components = scope.filter(component => desired.includes(component));
  const disabled = scope.filter(component => !desired.includes(component));
  await privateDirectory(join(home, 'logs'));
  await privateDirectory(join(home, 'startup'));
  await access(join(root, 'client', 'cli.mjs'));
  const paths = await executablePaths(root);
  if (components.includes('tunnel')) await access(paths.cloudflared);
  if (process.platform === 'win32') {
    if (components.some(component => component !== 'tunnel')) await access(join(root, 'runtime', 'node.exe'));
    if (components.length) await access(join(root, 'platform', 'windows', 'tds-launcher.exe'));
    const sid = await windowsSid();
    if (components.includes('tray')) await access(join(root, 'platform', 'windows', 'team-devspace-tray.exe'));
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
    if (disabled.length) await serviceAction('remove', state, home, disabled);
    for (const component of components) {
      const label = serviceLabel(state, component);
      const target = join(directory, `${label}.plist`);
      await writeFile(target, launchAgentXml(state, component, home, paths, root), { mode: 0o600 });
    }
  } else if (process.platform === 'linux') {
    if (process.getuid() === 0) throw new Error('Install user startup as the employee, not root');
    await native('systemctl', ['--user', 'show-environment']);
    const directory = systemdUserDirectory();
    await mkdir(directory, { recursive: true });
    if (scope.includes('runtime')) await access(join(root, 'runtime', 'bin', 'node'));
    if (scope.includes('tunnel')) await access(paths.cloudflared);
    for (const component of scope) {
      const legacy = `${legacyLinuxServiceLabel(state, component)}.service`;
      await native('systemctl', ['--user', 'disable', '--now', legacy], true);
      await rm(join(directory, legacy), { force: true });
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

export async function serviceAction(action, state, home = stateHome(), components = STARTUP_COMPONENTS) {
  if (!['start', 'stop', 'restart', 'disable', 'remove'].includes(action)) throw new Error('Unknown service action');
  if (action === 'disable' && process.platform !== 'linux') throw new Error('Disable without removing startup is only supported on Linux');
  if (action === 'restart') {
    await serviceAction('stop', state, home, components);
    return serviceAction('start', state, home, components);
  }
  const ordered = ['stop', 'disable', 'remove'].includes(action) ? [...components].reverse() : components;
  for (const component of ordered) {
    const label = serviceLabel(state, component);
    if (process.platform === 'win32') {
      if (action === 'start') await native('schtasks.exe', ['/Run', '/TN', label]);
      else {
        const existing = await native('schtasks.exe', ['/Query', '/TN', label, '/XML'], true);
        if (existing) {
          await native('schtasks.exe', ['/End', '/TN', label]);
          if (action === 'remove') await native('schtasks.exe', ['/Delete', '/TN', label, '/F']);
        }
      }
    } else if (process.platform === 'darwin') {
      const domain = `gui/${process.getuid()}`;
      const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
      if (action === 'start') {
        const existing = await native('launchctl', ['print', `${domain}/${label}`], true);
        if (!existing) await native('launchctl', ['bootstrap', domain, plist]);
        await native('launchctl', ['kickstart', `${domain}/${label}`]);
      } else {
        await native('launchctl', ['bootout', `${domain}/${label}`], true);
        if (action === 'remove') await rm(plist, { force: true });
      }
    } else if (process.platform === 'linux') {
      const unit = `${label}.service`;
      const unitFile = join(systemdUserDirectory(), unit);
      const legacyUnit = `${legacyLinuxServiceLabel(state, component)}.service`;
      if (action === 'start') await native('systemctl', ['--user', 'start', unit]);
      else if (action === 'disable') {
        await native('systemctl', ['--user', 'disable', '--now', unit], true);
        await native('systemctl', ['--user', 'disable', '--now', legacyUnit], true);
      } else if (action === 'remove') {
        await native('systemctl', ['--user', 'disable', '--now', unit], true);
        await native('systemctl', ['--user', 'disable', '--now', legacyUnit], true);
        await rm(unitFile, { force: true });
        await rm(join(systemdUserDirectory(), legacyUnit), { force: true });
      } else {
        await native('systemctl', ['--user', 'stop', unit], true);
        await native('systemctl', ['--user', 'stop', legacyUnit], true);
      }
    } else throw new Error('Unsupported runtime platform');
  }
  if (process.platform === 'linux' && action === 'remove') await native('systemctl', ['--user', 'daemon-reload']);
  if (['stop', 'disable', 'remove'].includes(action)) await waitForStopped(state, components);
}

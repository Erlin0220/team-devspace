import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';

const { values } = parseArgs({ options: { bundle: { type: 'string' } } });
const bundle = resolve(values.bundle ?? `build/bundle-${process.platform}-${process.arch}`);
// Test the SDK shipped with the runtime; a build-only root npm install must not
// mask missing package dependencies or be required by a clean macOS builder.
const require = createRequire(join(bundle, 'package.json'));
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
if (process.platform === 'darwin') {
  for (const component of ['runtime', 'tunnel', 'tray']) {
    const label = `com.teamdevspace.${component}`;
    const plist = join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (await access(plist).then(() => true, () => false)) throw new Error(`Refusing to replace an existing LaunchAgent: ${plist}`);
    let loaded = false;
    try { execFileSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' }); loaded = true; } catch {}
    if (loaded) throw new Error(`Refusing to replace an existing loaded LaunchAgent: ${label}`);
  }
}
const stateModule = await import(pathToFileURL(join(bundle, 'client', 'state.mjs')));
const platform = await import(pathToFileURL(join(bundle, 'client', 'platform.mjs')));
const home = await mkdtemp(join(tmpdir(), 'team-devspace-native-'));
const project = join(home, 'project');
await mkdir(project);
await writeFile(join(project, 'proof.txt'), 'native-user-session-proof');
if (process.platform === 'linux') {
  const distributionRoot = join(home, 'distribution');
  const versions = join(distributionRoot, 'versions');
  const active = join(versions, 'active');
  await mkdir(versions, { recursive: true });
  await symlink(bundle, active, 'dir');
  await writeFile(join(distributionRoot, 'active-path'), `${active}\n`);
  process.env.TEAM_DEVSPACE_DISTRIBUTION_ROOT = distributionRoot;
  for (const component of platform.COMPONENTS) {
    const unit = join(platform.systemdUserDirectory(), `${platform.serviceLabel({ deviceId: 'test' }, component)}.service`);
    if (await access(unit).then(() => true, () => false)) {
      throw new Error(`Refusing to overwrite an existing Team DevSpace Linux user unit during native smoke: ${unit}`);
    }
  }
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function checkPort(port) {
  return new Promise(resolvePort => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePort(value);
    };
    socket.setTimeout(1000, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}
async function waitForPorts(expected) {
  const deadline = Date.now() + (expected ? 90000 : 30000);
  let active = [false, false];
  while (Date.now() < deadline) {
    active = await Promise.all([checkPort(state.ports.devspace), checkPort(state.ports.bridge)]);
    if (active.every(value => value === expected)) return;
    await sleep(250);
  }
  throw new Error(`Native runtime failed to become ${expected ? 'online' : 'offline'} (devspace=${active[0]}, bridge=${active[1]})`);
}
function encodedPowerShell(command) {
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ProgressPreference='SilentlyContinue';${command}`, 'utf16le').toString('base64')],
  { encoding: 'utf8', windowsHide: true });
}
function assertWindowsLauncherTree(homePath) {
  const escaped = homePath.replaceAll("'", "''");
  const output = encodedPowerShell(`Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | ` +
    'Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress');
  const parsed = output.trim() ? JSON.parse(output) : [];
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  const supervisors = processes.filter(process => /^(powershell|cmd)\.exe$/i.test(process.Name));
  const launchers = processes.filter(process => /^tds-launcher\.exe$/i.test(process.Name));
  assert.deepEqual(supervisors, [], 'Runtime must not retain PowerShell or cmd supervisors');
  assert.equal(launchers.length, 1, 'Runtime must have one no-console launcher');
  assert.ok(processes.some(process => /^node\.exe$/i.test(process.Name) &&
    Number(process.ParentProcessId) === Number(launchers[0].ProcessId)), 'Launcher must directly own the runtime Node process');
}
function windowsTaskExists(label) {
  try {
    execFileSync(join(process.env.SystemRoot, 'System32', 'schtasks.exe'), ['/Query', '/TN', label],
      { stdio: 'ignore', windowsHide: true });
    return true;
  } catch { return false; }
}
function windowsSid() {
  const output = execFileSync(join(process.env.SystemRoot, 'System32', 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'],
    { encoding: 'utf8', windowsHide: true });
  const sid = /S-1-5-[0-9-]+/.exec(output)?.[0];
  if (!sid) throw new Error('Cannot resolve Windows test user SID');
  return sid;
}
async function createWindowsFixtureTask(label, taskHome, state, component = 'runtime') {
  const file = join(home, `${label.replaceAll('.', '-')}.xml`);
  await writeFile(file, `\uFEFF${platform.windowsTaskXml(state, component, taskHome, windowsSid(), bundle)}`, 'utf16le');
  execFileSync(join(process.env.SystemRoot, 'System32', 'schtasks.exe'), ['/Create', '/TN', label, '/XML', file, '/F'],
    { stdio: 'ignore', windowsHide: true });
}
function removeWindowsFixtureTask(label) {
  if (!label) return;
  const schtasks = join(process.env.SystemRoot, 'System32', 'schtasks.exe');
  try { execFileSync(schtasks, ['/End', '/TN', label], { stdio: 'ignore', windowsHide: true }); } catch {}
  try { execFileSync(schtasks, ['/Delete', '/TN', label, '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
}
const state = {
  schema: 1, deviceId: randomUUID(), bindingId: randomUUID(), keyId: randomUUID(),
  accessKey: `tds_${stateModule.randomSecret()}`, deviceSecret: stateModule.randomSecret(), ownerToken: stateModule.randomSecret(),
  gateway: 'https://team-devspace-native.invalid', currentProjectRoot: project,
  ports: { devspace: await freePort(), bridge: await freePort(), metrics: await freePort() },
};
let installed = false;
let client;
let foreignWindowsTask;
let foreignLinuxUnit;
let linuxDiagnosticUnit;
try {
  await stateModule.secureStateDirectory(home);
  await stateModule.atomicJson(join(home, 'state.json'), state);
  await stateModule.writeUpstreamConfig(state, home);
  await writeFile(join(home, 'tunnel.token'), 'not-a-live-tunnel-credential', { mode: 0o600 });
  installed = true;
  if (process.platform === 'linux') {
    // Prove an explicit repair/install can transfer a live standalone owner to
    // native systemd without ever running both managers for the same home.
    const standalone = await import(pathToFileURL(join(bundle, 'client', 'standalone.mjs')));
    const distributionRoot = process.env.TEAM_DEVSPACE_DISTRIBUTION_ROOT;
    delete process.env.TEAM_DEVSPACE_DISTRIBUTION_ROOT;
    try {
      await standalone.installStandalone(state, home, bundle, ['runtime']);
      await standalone.standaloneAction('start', state, home, ['runtime']);
      await waitForPorts(true);
    } finally { process.env.TEAM_DEVSPACE_DISTRIBUTION_ROOT = distributionRoot; }
    await assert.rejects(platform.serviceAction('start', state, home, ['runtime']), /transfer ownership/);
    await platform.installServices(state, home);
    await waitForPorts(false);
    assert.equal(await standalone.hasStandaloneStartup(home), false);
    const directory = platform.systemdUserDirectory();
    const legacyDeviceId = randomUUID();
    const legacy = `com.teamdevspace.${legacyDeviceId.replaceAll('-', '')}.runtime.service`;
    linuxDiagnosticUnit = legacy;
    const legacyPath = join(directory, legacy);
    const foreignDeviceId = randomUUID();
    foreignLinuxUnit = `com.teamdevspace.${foreignDeviceId.replaceAll('-', '')}.runtime.service`;
    const foreignPath = join(directory, foreignLinuxUnit);
    const paths = { node: join(bundle, 'runtime/bin/node'), cloudflared: join(bundle, 'bin/cloudflared') };
    await mkdir(directory, { recursive: true });
    await writeFile(legacyPath, platform.systemdUserUnit(state, 'runtime', home, paths, bundle), { mode: 0o600 });
    await writeFile(foreignPath, platform.systemdUserUnit(state, 'runtime', join(home, 'foreign-state'), paths, bundle), { mode: 0o600 });
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'start', legacy], { stdio: 'inherit' });
    await waitForPorts(true);
    await platform.serviceAction('stop', state, home, ['runtime']);
    await waitForPorts(false);
    execFileSync('systemctl', ['--user', 'start', legacy], { stdio: 'inherit' });
    await waitForPorts(true);
    await platform.installServices(state, home);
    linuxDiagnosticUnit = platform.serviceLabel(state, 'runtime');
    await waitForPorts(false);
    assert.equal(await access(legacyPath).then(() => true, () => false), false,
      'Fixed Linux startup migration must retire an unknown old device-specific unit owned by this state home');
    assert.equal(await access(foreignPath).then(() => true, () => false), true,
      'Linux lifecycle migration must not touch an isolated Team DevSpace state home');
    execFileSync('systemctl', ['--user', 'disable', '--now', foreignLinuxUnit], { stdio: 'ignore' });
    await rm(foreignPath, { force: true });
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    foreignLinuxUnit = undefined;
  } else if (process.platform === 'win32') {
    const legacyTask = `com.teamdevspace.${state.deviceId.replaceAll('-', '')}.runtime`;
    const foreignState = { ...state, ownerToken: stateModule.randomSecret() };
    foreignWindowsTask = platform.serviceLabel(foreignState, 'runtime', 'win32');
    const foreignHome = join(home, 'foreign-state');
    await createWindowsFixtureTask(legacyTask, home, state);
    await createWindowsFixtureTask(foreignWindowsTask, foreignHome, foreignState);
    assert.equal(windowsTaskExists(legacyTask), true);
    assert.equal(windowsTaskExists(foreignWindowsTask), true);
    await platform.installServices(state, home);
    assert.equal(windowsTaskExists(legacyTask), false,
      'Windows lifecycle migration must retire stale tasks owned by the same state home');
    assert.equal(windowsTaskExists(foreignWindowsTask), true,
      'Windows lifecycle migration must not touch an isolated Team DevSpace state home');
    removeWindowsFixtureTask(foreignWindowsTask);
    foreignWindowsTask = undefined;
  } else {
    await platform.installServices(state, home);
  }
  // Stopping freshly installed but idle startup entries must be safe. Upgrade
  // performs this before replacing any active payload.
  await platform.serviceAction('stop', state, home);
  const suspendedState = { ...state, remoteAccess: 'suspended' };
  await platform.installServices(suspendedState, home);
  if (process.platform === 'win32') {
    assert.equal(windowsTaskExists(platform.serviceLabel(state, 'runtime')), false);
    assert.equal(windowsTaskExists(platform.serviceLabel(state, 'tunnel')), false);
    assert.equal(windowsTaskExists(platform.serviceLabel(state, 'tray')), true);
  } else if (process.platform === 'linux') {
    for (const component of platform.COMPONENTS) {
      await access(join(platform.systemdUserDirectory(), `${platform.serviceLabel(state, component)}.service`));
    }
  }
  await platform.installServices({ ...state, remoteAccess: 'active' }, home);
  // Native process supervision is real. No tunnel is started and no private files are exposed.
  await platform.serviceAction('start', state, home, ['runtime']);
  await waitForPorts(true);
  if (process.platform === 'win32') assertWindowsLauncherTree(home);
  client = new Client({ name: 'team-devspace-native-smoke', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${state.ports.bridge}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${state.deviceSecret}`, 'X-Team-Binding-Id': state.bindingId } },
  }));
  const opened = await client.callTool({ name: 'open_workspace', arguments: { path: project, mode: 'checkout' } });
  assert.ok(!opened.isError, 'Packaged DevSpace could not open the smoke-test directory');
  const data = opened.structuredContent ?? opened.content.filter(item => item.type === 'text').map(item => {
    try { return JSON.parse(item.text); } catch { return null; }
  }).find(item => item?.workspaceId);
  const workspaceId = data.workspaceId ?? data.result?.workspaceId;
  const read = await client.callTool({ name: 'read', arguments: { workspaceId, path: 'proof.txt' } });
  assert.ok(JSON.stringify(read).includes('native-user-session-proof'));
  const shellCommand = process.platform === 'win32'
    ? 'printf "native-shell-proof\\n"; git --version; printf "bash:%s\\n" "$BASH_VERSION"'
    : 'printf "native-shell-proof\\n"; printf "bash:%s\\n" "$BASH_VERSION"';
  const shell = await client.callTool({ name: 'bash', arguments: { workspaceId, command: shellCommand, timeout: 10 } });
  const shellOutput = JSON.stringify(shell);
  assert.ok(!shell.isError && shellOutput.includes('native-shell-proof') && shellOutput.includes('bash:'));
  if (process.platform === 'win32') assert.ok(/git version \d+\.\d+/.test(shellOutput), 'Native runtime did not provide a working Git executable');
  await client.close(); client = null;
  await platform.serviceAction('stop', state, home, ['runtime']);
  await waitForPorts(false);
  await platform.serviceAction('start', state, home, ['runtime']);
  await waitForPorts(true);
  assert.equal((await stateModule.loadState(home)).bindingId, state.bindingId);
  await platform.serviceAction('remove', state, home);
  await waitForPorts(false);
  await platform.serviceAction('remove', state, home); // repeated uninstall must be safe
  installed = false;
  console.log(JSON.stringify({ passed: true, platform: process.platform, architecture: process.arch,
    actualNativeStartup: true, packagedRuntime: true, authenticatedMcp: true,
    stopRestartCleanup: true, ...(process.platform === 'linux' ? { legacyUnitMigration: true, standaloneOwnershipTransfer: true } : {}),
    ...(process.platform === 'win32' ? { noConsoleSupervisor: true, scopedStaleTaskMigration: true } : {}),
    realCloudflare: false, realChatGPT: false }));
} catch (error) {
  for (const component of ['runtime']) {
    for (const suffix of ['.log', '.error.log']) {
      try { console.error(`${component}${suffix}: ${(await readFile(join(home, 'logs', `${component}${suffix}`), 'utf8')).slice(-3000)}`); } catch {}
    }
    if (process.platform === 'win32') {
      try { console.error(execFileSync(join(process.env.SystemRoot, 'System32', 'schtasks.exe'), ['/Query', '/TN', platform.serviceLabel(state, component), '/V', '/FO', 'LIST'], {encoding:'utf8',windowsHide:true})); } catch {}
    } else if (process.platform === 'linux') {
      try {
        console.error(execFileSync('systemctl', ['--user', '--no-pager', '--full', 'status', platform.serviceLabel(state, component)],
          { encoding: 'utf8' }));
      } catch (diagnostic) {
        console.error(`systemctl diagnostic: ${diagnostic.stdout ?? ''}${diagnostic.stderr ?? ''}`);
      }
      if (linuxDiagnosticUnit) {
        try {
          console.error(execFileSync('systemctl', ['--user', '--no-pager', '--full', 'status', linuxDiagnosticUnit], { encoding: 'utf8' }));
        } catch (diagnostic) {
          console.error(`exact systemctl diagnostic (${linuxDiagnosticUnit}): ${diagnostic.stdout ?? ''}${diagnostic.stderr ?? ''}`);
        }
        try {
          console.error(execFileSync('systemctl', ['--user', 'show', linuxDiagnosticUnit,
            '--property=ActiveState,SubState,MainPID,ExecMainCode,ExecMainStatus,NRestarts'], { encoding: 'utf8' }));
        } catch (diagnostic) {
          console.error(`systemctl show diagnostic (${linuxDiagnosticUnit}): ${diagnostic.stdout ?? ''}${diagnostic.stderr ?? ''}`);
        }
        try {
          console.error(execFileSync('journalctl', ['--user', '--no-pager', '-u', linuxDiagnosticUnit, '-n', '120'], { encoding: 'utf8' }));
        } catch (diagnostic) {
          console.error(`exact journal diagnostic (${linuxDiagnosticUnit}): ${diagnostic.stdout ?? ''}${diagnostic.stderr ?? ''}`);
        }
      }
      try {
        console.error(execFileSync('journalctl', ['--user', '--no-pager', '-n', '80'], { encoding: 'utf8' }));
      } catch (diagnostic) {
        console.error(`journalctl diagnostic: ${diagnostic.stdout ?? ''}${diagnostic.stderr ?? ''}`);
      }
    } else if (process.platform === 'darwin') {
      const label = platform.serviceLabel(state, component);
      try { console.error(execFileSync('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8' })); } catch (diagnostic) {
        console.error(`launchctl diagnostic failed: ${diagnostic.message}`);
      }
      for (const port of [state.ports.devspace, state.ports.bridge]) {
        try { console.error(execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })); }
        catch { console.error(`No TCP listener reported by lsof on port ${port}`); }
      }
    }
  }
  throw error;
} finally {
  await client?.close().catch(() => {});
  removeWindowsFixtureTask(foreignWindowsTask);
  if (process.platform === 'linux' && foreignLinuxUnit) {
    try { execFileSync('systemctl', ['--user', 'disable', '--now', foreignLinuxUnit], { stdio: 'ignore' }); } catch {}
    await rm(join(platform.systemdUserDirectory(), foreignLinuxUnit), { force: true }).catch(() => {});
    try { execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' }); } catch {}
  }
  if (installed) await platform.serviceAction('remove', state, home).catch(() => {});
  await rm(home, { recursive: true, force: true });
}

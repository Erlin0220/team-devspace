import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import release from './release-profile.mjs';
import { serviceLabel, STARTUP_COMPONENTS } from '../client/platform.mjs';
import { redactDiagnostic } from '../client/control.mjs';
import { compareVersions } from '../client/update-policy.mjs';
import { downloadUpgradeBaseline } from './upgrade-baselines.mjs';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, installer: { type: 'string' } } });
assert.equal(process.platform, 'win32', 'Employee installation acceptance is Windows-only');
assert.equal(values.live, true, 'Explicit --live is required: this uninstalls and restores the current employee application');
assert.ok(!process.env.TEAM_DEVSPACE_HOME, 'Do not redirect employee state for this acceptance');
const exec = promisify(execFile);
const distribution = join(process.env.LOCALAPPDATA, 'TDS');
const home = join(process.env.LOCALAPPDATA, 'TeamDevSpace');
const stateFile = join(home, 'state.json');
const installer = resolve(values.installer ?? `release/offline/${release.version}/win32-x64/Team-DevSpace-${release.version}-windows-x64-setup.exe`);
const readJson = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const exists = async path => {
  try { await access(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const before = await readJson(stateFile);
assert.ok(before.bindingId && before.accessKey && before.ownerToken, 'An existing enrolled employee installation is required');
const activeBefore = await readJson(join(distribution, 'active.json'));
const installedVersion = (await readJson(join(activeBefore.path, 'release.config.json'))).version;
assert.ok(compareVersions(installedVersion, release.version) <= 0, 'Acceptance must not downgrade a newer employee release');
assert.ok(resolve(activeBefore.path).toLowerCase().startsWith(`${resolve(distribution, 'v').toLowerCase()}\\`),
  'Only the default, already installed employee distribution is supported');
await access(installer);
const identity = state => [state.deviceId, state.ownerToken, state.deviceSecret, state.bindingId, state.keyId, state.accessKey, state.currentProjectRoot];
const checkIdentity = async () => assert.ok(identity(await readJson(stateFile)).every((value, index) => value === identity(before)[index]),
  'Employee identity, credentials or project changed');
const tasks = STARTUP_COMPONENTS.map(component => serviceLabel(before, component, 'win32'));
const checks = [];
let currentRoot, restoreRequired = false;
const pass = check => { checks.push(check); console.log(JSON.stringify({ check, passed: true })); };
const system32 = join(process.env.SystemRoot, 'System32');
const ps = join(system32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
async function run(file, args) {
  return exec(file, args, { windowsHide: true, timeout: 240000, maxBuffer: 4 * 1024 * 1024 });
}
async function powershell(script) {
  return (await run(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')])).stdout.trim();
}
async function cli(...args) {
  return JSON.parse((await run(join(currentRoot, 'runtime', 'node.exe'), [join(currentRoot, 'client', 'cli.mjs'), ...args])).stdout);
}
async function waitFor(probe, message, timeout = 90000) {
  const deadline = Date.now() + timeout;
  do { if (await probe()) return; await sleep(500); } while (Date.now() < deadline);
  throw new Error(message);
}
async function verifyPolicy() {
  await waitFor(async () => {
    const status = await cli('status');
    return before.remoteAccess === 'suspended'
      ? status.desiredRemoteAccess === 'suspended' && !status.devspace && !status.bridge && !status.tunnel
      : status.ready;
  }, 'Installed services did not restore the original remote-access policy');
}
async function install() {
  restoreRequired = true;
  await run(installer, ['/S']);
  currentRoot = (await readJson(join(distribution, 'active.json'))).path;
  await checkIdentity();
  await run(process.execPath, ['scripts/verify-release.mjs', '--target', 'win32-x64', '--installed', currentRoot]);
  await verifyPolicy();
  restoreRequired = false;
}
async function desktopShortcut() {
  const desktop = await powershell("[Environment]::GetFolderPath('Desktop')");
  return join(desktop, 'Team DevSpace.lnk');
}
async function assertUninstalled() {
  // Windows uses v/, not the Unix versions/ directory. Wait for NSIS self-cleanup too.
  await waitFor(async () => !(await exists(join(distribution, 'active.json'))) && !(await exists(join(distribution, 'v'))),
    'Uninstall left its active pointer or Windows payload tree', 120000);
  const root = distribution.replaceAll("'", "''");
  const processes = await powershell(`$ErrorActionPreference='Stop';$root='${root}\\';@((Get-CimInstance Win32_Process) | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root,[StringComparison]::OrdinalIgnoreCase) }).Count`);
  assert.equal(Number(processes), 0, 'Uninstall left a process executing from the employee distribution');
  for (const task of tasks) {
    const present = await powershell(`$ErrorActionPreference='Stop';@((Get-ScheduledTask) | Where-Object { $_.TaskName -eq '${task}' }).Count`);
    assert.equal(Number(present), 0, 'Uninstall left an employee startup task');
  }
  const registry = await powershell("$ErrorActionPreference='Stop';[int]((Test-Path 'HKCU:\\Software\\TeamDevSpace') -or (Test-Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TeamDevSpace'))");
  assert.equal(Number(registry), 0, 'Uninstall left product or uninstall registration');
  assert.equal(await exists(join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Team DevSpace')), false,
    'Uninstall left its Start Menu shortcuts');
  assert.equal(await exists(await desktopShortcut()), false, 'Uninstall left the desktop launcher');
  await checkIdentity();
  assert.equal(await exists(before.currentProjectRoot), true, 'Uninstall removed the employee project');
}
try {
  if (installedVersion === release.version) {
    // A retry after a failed later lifecycle check still needs a real older
    // baseline; never turn a same-version reinstall into upgrade evidence.
    const baseline = await downloadUpgradeBaseline('0.2.4', 'win32-x64');
    restoreRequired = true;
    await run(baseline, ['/S']);
    currentRoot = (await readJson(join(distribution, 'active.json'))).path;
    assert.equal((await readJson(join(currentRoot, 'release.config.json'))).version, '0.2.4');
    await checkIdentity();
    await verifyPolicy();
  }
  await install(); pass('unmodified final EXE upgrades the actual employee installation and verifies installed payload');
  assert.equal(await exists(await desktopShortcut()), true, 'Desktop restart entry is absent');
  assert.equal(await exists(join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Team DevSpace', 'Team DevSpace.lnk')), true);
  pass('normal Desktop and Start Menu launchers are installed');
  await install(); pass('repeated final EXE installation preserves binding, project and pause policy');
  await cli('repair'); await verifyPolicy(); pass('installed Repair restores native startup without replacing the binding');
  const diagnostic = JSON.stringify(await cli('diagnostics'));
  for (const secret of [before.accessKey, before.ownerToken, before.deviceSecret]) assert.ok(!diagnostic.includes(secret), 'Diagnostics exposed an employee credential');
  pass('installed diagnostics redact employee credentials');
  restoreRequired = true;
  await run(join(distribution, 'Uninstall.exe'), ['/S']);
  await assertUninstalled(); pass('unmodified uninstall removes Windows payload, processes, tasks, registry and shortcuts but preserves identity and project');
  await install(); pass('unmodified final EXE restores the same employee binding and original remote-access policy');
  console.log(JSON.stringify({ passed: true, checks, actualEmployeeInstallation: true, unmodifiedFinalExe: true,
    employeeIdentityRetained: true, ownedResidueChecked: true, guiActionsVerified: false }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, checks, error: redactDiagnostic(error.message) }));
  process.exitCode = 1;
} finally {
  if (restoreRequired) {
    try { await install(); console.log(JSON.stringify({ employeeInstallationRestored: true })); }
    catch (error) { console.error(`Employee installation restoration failed: ${redactDiagnostic(error.message)}`); process.exitCode = 1; }
  }
}

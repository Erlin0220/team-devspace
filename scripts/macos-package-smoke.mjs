import assert from 'node:assert/strict';
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { run } from './build-utils.mjs';
import release from './release-profile.mjs';
import { downloadUpgradeBaseline, UPGRADE_BASELINES } from './upgrade-baselines.mjs';

// This test installs the actual package-owned paths. Never run it on an employee
// Mac, or disguise a developer workstation as CI to bypass this boundary.
if (process.platform !== 'darwin' || process.getuid() === 0 ||
    process.env.CI !== 'true' || !(process.env.CM_BUILD_ID ||
      (process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_OS === 'macOS'))) {
  throw new Error('System PKG acceptance requires a disposable, non-root Codemagic or GitHub macOS session');
}
const app = '/Applications/Team DevSpace.app';
const command = '/usr/local/bin/team-devspace';
const home = join(homedir(), 'Library', 'Application Support', 'TeamDevSpace');
const distribution = join(home, 'distribution');
const resources = join(app, 'Contents', 'Resources');
const bootstrap = join(resources, 'bootstrap.sh');
const manifest = join(resources, 'release-manifest.json');
const receipt = 'com.teamdevspace.installer';
const domain = `gui/${process.getuid()}`;
const labels = ['runtime', 'tunnel', 'tray'].map(component => `com.teamdevspace.${component}`);
const exists = path => lstat(path).then(() => true, error => {
  if (error.code === 'ENOENT') return false;
  throw error;
});
const loaded = label => run('/bin/launchctl', ['print', `${domain}/${label}`], { capture: true }).then(() => true, () => false);
for (const path of [app, command, home, ...labels.map(label => join(homedir(), 'Library/LaunchAgents', `${label}.plist`))]) {
  assert.equal(await exists(path), false, `Refusing to overwrite an existing installation: ${path}`);
}
for (const label of labels) assert.equal(await loaded(label), false, `An existing job is loaded: ${label}`);
assert.equal(await run('/usr/sbin/pkgutil', ['--pkg-info', receipt], { capture: true }).then(() => true, () => false), false,
  'An existing package receipt must not be overwritten');
await run('/usr/bin/sudo', ['-n', '/usr/bin/true']);
await run('/bin/launchctl', ['print', domain], { capture: true });
const target = `darwin-${process.arch}`;
const pkg = resolve('release/offline', release.version, target, `Team-DevSpace-${release.version}-macos-${process.arch}.pkg`);
await access(pkg);
const work = await mkdtemp(join(tmpdir(), 'tds-macos-package-'));
const project = join(work, 'project');
await mkdir(project);
await writeFile(join(project, 'keep.txt'), 'employee project must survive');
const environment = { NODE_OPTIONS: '', TEAM_DEVSPACE_HOME: home };
const active = async () => (await readFile(join(distribution, 'active-path'), 'utf8')).trim();
const install = (installer = pkg) => run('/usr/bin/sudo', ['-n', '/usr/sbin/installer', '-pkg', installer, '-target', '/'], { timeout: 240000 });
const screenshots = [];
async function captureVisibleUI(name) {
  // Capture the real installed app, not a recreated design. Screen-recording
  // permission can be unavailable in CI; report that separately from app failure.
  const directory = resolve('build/macos-review');
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${process.arch}-${name}.png`);
  try {
    await run('/usr/sbin/screencapture', ['-x', file], { capture: true, timeout: 10000 });
    await access(file); screenshots.push(file);
  } catch { console.warn(`Native UI screenshot unavailable: ${name}; visual approval remains manual.`); }
}
async function lockPid(path) {
  const value = (await readFile(path, 'utf8').catch(() => '')).trim();
  return /^[1-9][0-9]*$/.test(value) ? Number(value) : null;
}
function signal(pid, name) {
  if (!pid || pid === process.pid) return;
  try { process.kill(pid, name); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}
async function cancelPostinstallFirstRun() {
  const ready = join(home, '.ui-ready');
  assert.equal(await exists(ready), true, 'PKG postinstall did not auto-open a visible first-run UI');
  const roots = [...new Set((await Promise.all([
    lockPid(join(home, 'app-launch.lock', 'pid')),
    lockPid(join(distribution, 'install.lock', 'pid')),
  ])).filter(Boolean))];
  assert.ok(roots.length, 'Visible first-run UI did not retain an owned setup process');
  const table = (await run('/bin/ps', ['-axo', 'pid=,ppid='], { capture: true })).stdout
    .trim().split(/\n+/).map(line => line.trim().split(/\s+/).map(Number))
    .filter(([pid, ppid]) => Number.isInteger(pid) && Number.isInteger(ppid));
  const owned = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of table) {
      if (owned.has(ppid) && !owned.has(pid)) { owned.add(pid); changed = true; }
    }
  }
  // End the disposable first-run transaction as one process tree. The real
  // postinstall/visible-UI path has already been proven; later checks seed an
  // isolated suspended device instead of submitting a fake Access Key to it.
  for (const pid of owned) signal(pid, 'SIGTERM');
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const live = [...owned].filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
    if (!live.length) break;
    await sleep(100);
  }
  for (const pid of owned) signal(pid, 'SIGKILL');
  await sleep(250);
}
async function openAndWait() {
  // Postinstall can see the existing tray before the transactional upgrade
  // releases app-launch.lock. Never delete its ready marker and then ask a
  // concurrent launcher to recreate it: that launcher correctly exits while
  // the first owner is still running, leaving an artificial missing marker.
  const previousDeadline = Date.now() + 120000;
  while (await exists(join(home, 'app-launch.lock'))) {
    const owner = await lockPid(join(home, 'app-launch.lock', 'pid'));
    if (owner) {
      try { process.kill(owner, 0); }
      catch (error) { if (error.code === 'ESRCH') break; throw error; }
    }
    if (Date.now() >= previousDeadline) throw new Error('Previous native app launch did not finish');
    await sleep(250);
  }
  await rm(join(home, '.ui-ready'), { force: true });
  await run('/usr/bin/open', [app]);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await exists(join(home, '.ui-ready')) && !await exists(join(home, 'app-launch.lock')) &&
        await loaded('com.teamdevspace.tray')) return;
    await sleep(250);
  }
  throw new Error('Installed app did not finish startup with a visible menu-bar UI');
}
async function removePackageFiles() {
  // Preflight proved all three paths absent; only this disposable test owns them.
  await run('/usr/bin/sudo', ['-n', '/bin/rm', '-rf', app, command]);
  await run('/usr/bin/sudo', ['-n', '/usr/sbin/pkgutil', '--forget', receipt]);
}
let attemptedInstall = false;
let removed = false;
try {
  attemptedInstall = true;
  await install();
  await access(command);
  await run('/usr/sbin/pkgutil', ['--pkg-info', receipt]);
  await run('/usr/bin/plutil', ['-lint', join(app, 'Contents', 'Info.plist')]);
  await captureVisibleUI('first-run');
  await cancelPostinstallFirstRun();
  await run('/bin/sh', [bootstrap, '--root', distribution, '--manifest', manifest, '--setup', 'none'],
    { env: environment, timeout: 240000 });
  let first = await active();
  assert.ok(first.startsWith(`${distribution}/versions/`));
  await run(process.execPath, ['scripts/verify-release.mjs', '--target', target, '--installed', first]);
  // Reuse the existing runtime/MCP lifecycle test, now against the installed
  // payload instead of the build tree. It starts no real Cloudflare tunnel.
  await run(process.execPath, ['scripts/native-smoke.mjs', '--bundle', first], { timeout: 240000 });
  const stateModule = await import(pathToFileURL(join(first, 'client/state.mjs')));
  const state = { schema: 1, deviceId: randomUUID(), bindingId: randomUUID(), keyId: randomUUID(),
    accessKey: `tds_${stateModule.randomSecret()}`, deviceSecret: stateModule.randomSecret(),
    ownerToken: stateModule.randomSecret(), gateway: 'https://package-smoke.invalid',
    hostname: 'package-smoke.invalid', endpoint: 'https://package-smoke.invalid/mcp',
    currentProjectRoot: project, remoteAccess: 'suspended',
    ports: { devspace: 47670, bridge: 47770, metrics: 47870 } };
  await stateModule.atomicJson(join(home, 'state.json'), state);
  await stateModule.atomicText(join(home, 'tunnel.token'), 'not-a-live-tunnel-credential');
  await stateModule.writeUpstreamConfig(state, home);
  await openAndWait();
  await captureVisibleUI('paused-menu-bar');
  await run(command, ['project-root', 'show'], { env: environment });
  const identityFields = ['deviceId', 'keyId', 'bindingId', 'accessKey', 'deviceSecret', 'ownerToken',
    'currentProjectRoot', 'remoteAccess'];
  const verifyIdentity = async () => {
    const actual = JSON.parse(await readFile(join(home, 'state.json'), 'utf8'));
    for (const key of identityFields) assert.equal(actual[key], state[key], `Upgrade changed ${key}`);
    assert.equal(await readFile(join(project, 'keep.txt'), 'utf8'), 'employee project must survive');
  };
  for (const version of Object.keys(UPGRADE_BASELINES)) {
    const baseline = await downloadUpgradeBaseline(version, target);
    // The disposable runner owns these paths. Remove current binaries using
    // the real uninstall path; retain enrolled state for the older real PKG.
    await run('/bin/sh', [bootstrap, '--mode', 'uninstall', '--root', distribution], { env: environment });
    // Apple Installer does not replace a newer version-checked application
    // bundle with an older one. Remove our owned app and receipt as well so
    // this really establishes the old baseline, not a disguised current app.
    await removePackageFiles();
    await install(baseline);
    await openAndWait();
    assert.equal(JSON.parse(await readFile(join(await active(), 'release.config.json'), 'utf8')).version, version);
    await verifyIdentity();
    await install();
    await openAndWait();
    await verifyIdentity();
    await run(process.execPath, ['scripts/verify-release.mjs', '--target', target, '--installed', await active()]);
    console.log(JSON.stringify({ nativeUpgrade: true, target, from: version, to: release.version,
      baselineSha256: UPGRADE_BASELINES[version][target], seededEnrollment: true }));
  }
  first = await active();
  await install();
  await openAndWait();
  assert.equal(await active(), first, 'Reopening the same release must not unnecessarily unpack it');
  assert.equal((JSON.parse(await readFile(join(home, 'state.json'), 'utf8'))).bindingId, state.bindingId);
  await rm(join(first, 'client/cli.mjs'));
  await openAndWait();
  const repaired = await active();
  assert.notEqual(repaired, first, 'Damaged installed CLI must be repaired by the actual app launcher');
  assert.equal(await exists(first), false, 'Successful repair must retire the broken version');
  const retained = JSON.parse(await readFile(join(home, 'state.json'), 'utf8'));
  assert.equal(retained.bindingId, state.bindingId);
  assert.equal(retained.remoteAccess, 'suspended', 'Repair must never unpause remote access');
  await run('/bin/sh', [bootstrap, '--mode', 'uninstall', '--root', distribution], { env: environment });
  for (const label of labels) {
    assert.equal(await loaded(label), false, `Uninstall left ${label} running`);
    assert.equal(await exists(join(homedir(), 'Library/LaunchAgents', `${label}.plist`)), false);
  }
  assert.equal(await exists(join(distribution, 'versions')), false);
  assert.equal((JSON.parse(await readFile(join(home, 'state.json'), 'utf8'))).bindingId, state.bindingId);
  assert.equal(await readFile(join(project, 'keep.txt'), 'utf8'), 'employee project must survive');
  // Reinstall from the final PKG after uninstall, then exercise the native
  // fallback without a working CLI. Normal uninstall above remains covered.
  await install();
  await openAndWait();
  const reinstalled = await active();
  await rm(join(reinstalled, 'client/cli.mjs'));
  await run('/bin/sh', [bootstrap, '--mode', 'uninstall', '--root', distribution], { env: environment });
  for (const label of labels) {
    assert.equal(await loaded(label), false, `Damaged-client uninstall left ${label} running`);
    assert.equal(await exists(join(homedir(), 'Library/LaunchAgents', `${label}.plist`)), false);
  }
  assert.equal(await exists(join(distribution, 'versions')), false);
  assert.equal((JSON.parse(await readFile(join(home, 'state.json'), 'utf8'))).bindingId, state.bindingId);
  assert.equal(await readFile(join(project, 'keep.txt'), 'utf8'), 'employee project must survive',
    'Damaged-client uninstall must preserve the original employee project content');
  await removePackageFiles();
  removed = true;
  for (const path of [app, command]) assert.equal(await exists(path), false);
  console.log(JSON.stringify({ passed: true, target, actualSystemPackage: true, installedNativeRuntime: true,
    installedPayloadVerified: true, firstRunInterruptedAndRecovered: true, liveEnrollment: false,
    nativeLaunchAgent: true, visibleMenuBar: true, postinstallAutoOpen: true,
    repeatInstall: true, damagedCliRepair: true, retainedEnrollmentAndPause: true,
    uninstallPreservesProjects: true, reinstallAfterUninstall: true, damagedClientUninstall: true, screenshots,
    limitations: ['First-run UI visibility and interrupted-setup recovery are tested; Enrollment uses seeded isolated state, not a live employee Access Key.',
      'Administrator authorization dialogs are not automated because Codemagic uses passwordless sudo.',
      'Unsigned package Gatekeeper approval and real employee login remain manual acceptance.'] }));
} catch (error) {
  for (const log of [join(home, 'logs/setup.log'), join(home, 'logs/tray.error.log'), '/var/log/team-devspace-install.log']) {
    console.error(`${log}: ${(await readFile(log, 'utf8').catch(() => 'unavailable')).slice(-6000)}`);
  }
  throw error;
} finally {
  // Fail cleanup instead of producing a green acceptance with an orphaned job.
  for (const label of labels) {
    if (await loaded(label)) await run('/bin/launchctl', ['bootout', `${domain}/${label}`], { capture: true });
    await rm(join(homedir(), 'Library/LaunchAgents', `${label}.plist`), { force: true });
  }
  if (attemptedInstall && !removed) {
    await run('/usr/bin/sudo', ['-n', '/bin/rm', '-rf', app, command]);
    if (await run('/usr/sbin/pkgutil', ['--pkg-info', receipt], { capture: true }).then(() => true, () => false)) await removePackageFiles();
  }
  await rm(home, { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
}

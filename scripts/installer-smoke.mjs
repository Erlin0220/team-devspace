import assert from 'node:assert/strict';
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { atomicJson, randomSecret, readJson, secureStateDirectory } from '../client/state.mjs';
import { serviceLabel, windowsTaskNames } from '../client/platform.mjs';
import { run } from './build-utils.mjs';
import release from '../release.config.json' with { type: 'json' };

if (process.platform !== 'win32') throw new Error('This smoke test exercises the actual Windows NSIS bootstrapper');
const { values } = parseArgs({ options: { installer: { type: 'string' }, direct: { type: 'boolean' } } });
if (values.direct && process.env.CI !== 'true') throw new Error('--direct is reserved for an isolated CI runner; local acceptance rebuilds isolated registry/start-menu identities');
const sourceInstaller = resolve(values.installer ?? `release/offline/${release.version}/win32-x64/Team-DevSpace-${release.version}-windows-x64-setup.exe`);
await access(sourceInstaller);
const sourceLayout = dirname(sourceInstaller);
const manifest = await readJson(join(sourceLayout, 'manifest.json'));
const payloadBytes = manifest.components.reduce((total, component) => total + component.size, 0);
assert.ok((await stat(sourceInstaller)).size > payloadBytes * 0.9, 'Windows installer must physically contain its complete offline payload');
const exists = async path => access(path).then(() => true, () => false);
const suffix = randomUUID().slice(0, 8);
const tempRoot = resolve(process.env.TEMP ?? '.');
const localAppDataRoot = resolve(process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.');
const work = join(tempRoot, `tds-i-${suffix}`);
const releaseRoot = join(work, 'release');
const layout = join(releaseRoot, 'offline', release.version, 'win32-x64');
const home = join(work, 'state');
const install = join(localAppDataRoot, `T${suffix.slice(0, 4)}`);
const smokeGuard = join(tempRoot, 'team-devspace-installer-smoke.lock');
const smokeMarker = join(work, '.team-devspace-installer-smoke.json');
const project = join(work, 'project');
await secureStateDirectory(work);
await mkdir(project);
let installer = sourceInstaller;
if (!values.direct) {
  await mkdir(dirname(layout), { recursive: true });
  await cp(dirname(sourceInstaller), layout, { recursive: true });
  const compilerRoot = resolve('build/nsis');
  const compilerDirectory = (await readdir(compilerRoot, { withFileTypes: true })).find(entry => entry.isDirectory() && entry.name.startsWith('nsis-'));
  if (!compilerDirectory) throw new Error('Build the Windows package before running installer smoke');
  // Local acceptance uses production installer sources but isolated registry/start-menu identities,
  // so it cannot disturb an employee installation already present on the workstation.
  installer = join(releaseRoot, `Team-DevSpace-smoke-${suffix}.exe`);
  await run(join(compilerRoot, compilerDirectory.name, 'makensis.exe'), ['/V2', '/NOCD',
    `/DBOOTSTRAP=${resolve('platform/windows/bootstrap.ps1')}`, `/DMANIFEST=${join(layout, 'manifest.json')}`,
    `/DOFFLINE_OBJECTS=${join(layout, 'objects')}`, `/DPLATFORM_DIR=${resolve('platform/windows')}`, `/DAPP_VERSION=${release.version}`,
    `/DAPP_VERSION_NUM=${release.version.split('-')[0]}.0`, `/DDEVSPACE_VERSION=${release.devspaceVersion}`, `/DOUTPUT=${installer}`,
    `/DPRODUCT_KEY=Software\\TeamDevSpaceSmoke\\${suffix}`,
    `/DUNINSTALL_KEY=Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TeamDevSpaceSmoke-${suffix}`,
    `/DSTART_MENU_FOLDER=Team DevSpace Smoke ${suffix}`, resolve('platform/windows/installer.nsi')], { timeout: 60000 });
  await rm(join(layout, 'objects'), { recursive: true, force: true });
}
const key = `tds_${randomSecret()}`;
const bindingId = randomUUID();
const keyId = randomUUID();
let enrollmentCalls = 0;
let enrollmentUnavailable = true;
const server = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const value = JSON.parse(body);
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/v1/enroll') {
    enrollmentCalls++;
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    if (enrollmentUnavailable) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: 'temporary_failure' }));
      return;
    }
    response.end(JSON.stringify({ keyId, bindingId, deviceId: value.deviceId, devspaceVersion: release.devspaceVersion,
      controlApiVersion: release.controlApiVersion, state: 'suspended',
      hostname: 'not-a-real-tunnel.invalid', tunnelToken: 'not-a-valid-cloudflare-token',
      endpoint: `http://127.0.0.1:${server.address().port}/mcp` }));
  } else if (request.url === '/v1/device/status') {
    response.end(JSON.stringify({ state: 'active', bindingId, deviceId: value.deviceId }));
  } else { response.statusCode = 404; response.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
// Force the clean-employee-machine path: no system Git/Bash on PATH. The real
// installer must verify, extract and execute the official optional Git SFX.
const env = { ...process.env, TEAM_DEVSPACE_HOME: home, NODE_OPTIONS: '',
  PATH: [process.env.SystemRoot, join(process.env.SystemRoot, 'System32'),
    join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0')].join(';') };
function killProcessTree(pid) {
  if (!pid) return;
  try {
    execFileSync(join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'],
      { stdio: 'ignore', windowsHide: true });
  } catch {}
}
async function execute(file, args, timeout = 240000, environment = env) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env: environment, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => {
      killProcessTree(child.pid);
      reject(new Error('Installer smoke-test command timed out'));
    }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}
async function taskCommand(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(join(process.env.SystemRoot, 'System32', 'schtasks.exe'), args,
      { env, windowsHide: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', code => resolve(code));
  });
}
function discoverTaskNamesForHome(targetHome) {
  const schtasks = join(process.env.SystemRoot, 'System32', 'schtasks.exe');
  let listing = '';
  try { listing = execFileSync(schtasks, ['/Query', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }); }
  catch { return []; }
  const expectedHome = `TEAM_DEVSPACE_HOME=${targetHome}`.toLowerCase();
  return windowsTaskNames(listing).filter(name => {
    try {
      const task = execFileSync(schtasks, ['/Query', '/TN', name, '/XML'], { encoding: 'utf8', windowsHide: true });
      return task.toLowerCase().includes(expectedHome);
    } catch { return false; }
  });
}
async function testTaskNames(targetHome = home) {
  const names = new Set(discoverTaskNamesForHome(targetHome));
  try {
    const state = await readJson(join(targetHome, 'state.json'));
    for (const component of ['runtime', 'tunnel', 'tray']) names.add(serviceLabel(state, component, 'win32'));
  } catch {}
  return [...names];
}
async function cleanupTestTasks(targetHome = home) {
  for (const name of await testTaskNames(targetHome)) {
    await taskCommand(['/End', '/TN', name]).catch(() => {});
    await taskCommand(['/Delete', '/TN', name, '/F']).catch(() => {});
  }
}
async function assertNoTestTasks(targetHome = home) {
  for (const name of await testTaskNames(targetHome)) {
    assert.notEqual(await taskCommand(['/Query', '/TN', name]), 0, `Installer smoke left startup task behind: ${name}`);
  }
}
function installProcesses(rootPath = install) {
  const root = rootPath.replaceAll("'", "''");
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = `$root='${root}';$names=@('tds-launcher.exe','node.exe','cloudflared.exe','team-devspace-tray.exe');` +
    '$items=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {' +
    '$path=[string]$_.ExecutablePath;$path -and ($names -contains ([string]$_.Name).ToLowerInvariant()) -and ' +
    '$path.StartsWith(([IO.Path]::GetFullPath($root).TrimEnd("\\")+"\\"),[StringComparison]::OrdinalIgnoreCase)' +
    '} | Select-Object Name,ProcessId,ParentProcessId,ExecutablePath);ConvertTo-Json -InputObject $items -Compress';
  const output = execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true }).trim();
  return output ? JSON.parse(output) : [];
}
function cleanupInstallProcesses(rootPath = install) {
  const processes = installProcesses(rootPath);
  if (!processes.length) return;
  const powershell = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `Stop-Process -Id ${processes.map(process => Number(process.ProcessId)).join(',')} -Force -ErrorAction SilentlyContinue`],
  { stdio: 'ignore', windowsHide: true });
}
async function acquireSmokeGuard() {
  try {
    await writeFile(smokeGuard, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      { flag: 'wx', mode: 0o600 });
    return;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let active = false;
  try {
    const prior = JSON.parse(await readFile(smokeGuard, 'utf8'));
    if (Number.isInteger(prior.pid) && prior.pid > 0) {
      try { process.kill(prior.pid, 0); active = true; } catch {}
    }
  } catch {}
  if (active) throw new Error('Another Windows installer acceptance is still running');
  await rm(smokeGuard, { force: true });
  await writeFile(smokeGuard, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    { flag: 'wx', mode: 0o600 });
}
function validatedSmokeScope(entry) {
  const match = /^tds-i-([a-f0-9]{8})$/i.exec(entry.name);
  if (!entry.isDirectory() || !match) return null;
  const candidateWork = join(tempRoot, entry.name);
  const candidateHome = join(candidateWork, 'state');
  const candidateInstall = join(localAppDataRoot, `T${match[1].slice(0, 4)}`);
  return { suffix: match[1], work: candidateWork, home: candidateHome, install: candidateInstall,
    marker: join(candidateWork, '.team-devspace-installer-smoke.json') };
}
async function cleanupSmokeScope(scope) {
  const marker = await readJson(scope.marker, null).catch(() => null);
  if (marker?.schema !== 1 || marker.suffix !== scope.suffix) return false;
  await cleanupTestTasks(scope.home);
  const uninstaller = join(scope.install, 'Uninstall.exe');
  if (await exists(uninstaller)) {
    const cleanupEnv = { ...process.env, TEAM_DEVSPACE_HOME: scope.home, NODE_OPTIONS: '' };
    await execute(uninstaller, ['/S', `_?=${scope.install}`], 60000, cleanupEnv).catch(() => {});
  }
  cleanupInstallProcesses(scope.install);
  await cleanupTestTasks(scope.home);
  const reg = join(process.env.SystemRoot, 'System32', 'reg.exe');
  for (const keyPath of [
    `HKCU\\Software\\TeamDevSpaceSmoke\\${scope.suffix}`,
    `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TeamDevSpaceSmoke-${scope.suffix}`,
  ]) {
    try { execFileSync(reg, ['delete', keyPath, '/f'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  if (process.env.APPDATA) await rm(join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs',
    `Team DevSpace Smoke ${scope.suffix}`), { recursive: true, force: true });
  await rm(scope.work, { recursive: true, force: true });
  await rm(scope.install, { recursive: true, force: true });
  return true;
}
async function recoverStaleSmokeScopes() {
  const entries = await readdir(tempRoot, { withFileTypes: true });
  for (const entry of entries) {
    const scope = validatedSmokeScope(entry);
    if (!scope || scope.work === work) continue;
    await cleanupSmokeScope(scope);
  }
}
async function installAttempt() {
  const requestFile = join(work, 'setup-request.json');
  await atomicJson(requestFile, { gateway: `http://127.0.0.1:${server.address().port}`,
    accessKey: key, currentProjectRoot: project });
  env.TEAM_DEVSPACE_SETUP_REQUEST_FILE = requestFile;
  const code = await execute(installer, ['/S', `/D=${install}`]);
  delete env.TEAM_DEVSPACE_SETUP_REQUEST_FILE;
  const diagnostic = await readFile(join(install, 'bootstrap-error.log'), 'utf8').catch(async () =>
    readFile(join(install, 'bootstrap-launch-error.log'), 'utf8').catch(() => 'No bootstrap diagnostic was written'));
  assert.equal(code, 0, diagnostic);
  assert.equal(await exists(requestFile), false, 'Temporary credential input must be consumed');
  return readJson(join(home, 'state.json'));
}
async function repair() {
  return execute(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(install, 'command.ps1'), 'repair',
  ]);
}

await acquireSmokeGuard();
await atomicJson(smokeMarker, { schema: 1, suffix });
await recoverStaleSmokeScopes();

let canUninstall = false;
let primaryFailure = null;
let successReport;
try {
  const pending = await installAttempt();
  canUninstall = true;
  assert.equal(enrollmentCalls, 1, 'First-run connection setup must make one Enrollment attempt');
  assert.equal(pending.bindingId, undefined, 'A temporary Gateway failure must leave retryable pending device state');
  const pendingActive = await readJson(join(install, 'active.json'));
  assert.equal(await exists(pendingActive.path), true, 'Local application must remain active when Enrollment is unavailable');
  assert.equal(await exists(join(install, 'onboarding-error.log')), true, 'Post-install connection failure must be diagnosed separately');
  assert.equal(await exists(join(install, 'cache')), false, 'The self-contained installer must not create a persistent payload cache');

  enrollmentUnavailable = false;
  assert.equal(await repair(), 0, 'Pending Enrollment must resume through the product Repair path without reinstalling payloads');
  const enrolled = await readJson(join(home, 'state.json'));
  assert.equal(enrolled.deviceId, pending.deviceId, 'Enrollment repair must reuse the pending local identity');
  assert.equal(enrolled.bindingId, bindingId);
  assert.equal(enrollmentCalls, 2);
  const firstActive = await readJson(join(install, 'active.json'));
  await run(process.execPath, ['scripts/verify-release.mjs', '--target', 'win32-x64', '--installed', firstActive.path]);
  assert.equal(firstActive.path, pendingActive.path, 'Enrollment recovery must not reinstall or switch the local application payload');
  const upstream = await readJson(join(firstActive.path, 'node_modules', '@waishnav', 'devspace', 'package.json'));
  assert.equal(upstream.version, release.devspaceVersion);
  assert.equal(await exists(join(firstActive.path, 'git', 'cmd', 'git.exe')), true);
  assert.equal(await exists(join(firstActive.path, 'git', 'bin', 'bash.exe')), true);

  await writeFile(join(firstActive.path, 'obsolete-upgrade-fixture.txt'), 'must disappear from the next immutable version');
  const enrollmentCallsBeforeUpgrade = enrollmentCalls;
  const upgraded = await installAttempt();
  assert.equal(enrollmentCalls, enrollmentCallsBeforeUpgrade, 'An enrolled device upgrade must not call /v1/enroll again');
  for (const name of ['deviceId', 'deviceSecret', 'ownerToken', 'accessKey', 'bindingId']) assert.equal(upgraded[name], enrolled[name]);
  assert.equal(upgraded.currentProjectRoot, enrolled.currentProjectRoot);
  const secondActive = await readJson(join(install, 'active.json'));
  assert.notEqual(secondActive.path, firstActive.path);
  assert.equal(await exists(join(secondActive.path, 'obsolete-upgrade-fixture.txt')), false);
  assert.equal(await exists(firstActive.path), false, 'Successful local activation must retire the old extracted version');

  assert.equal(await repair(), 0, 'Repair connection must recreate local startup from retained Enrollment state');
  assert.equal(enrollmentCalls, enrollmentCallsBeforeUpgrade, 'Healthy Enrollment repair must remain local-only');
  assert.equal((await readJson(join(install, 'active.json'))).path, secondActive.path, 'Connection repair must not reinstall application payloads');

  await rm(join(home, 'tunnel.token'));
  assert.equal(await repair(), 0, 'Missing Tunnel credential must be recovered through the existing device Enrollment');
  assert.equal(enrollmentCalls, enrollmentCallsBeforeUpgrade + 1, 'Credential recovery must make exactly one idempotent Enrollment request');
  const enrollmentCallsAfterCredentialRepair = enrollmentCalls;

  await rm(join(secondActive.path, 'bin', 'cloudflared.exe'));
  const repaired = await installAttempt();
  assert.equal(repaired.bindingId, bindingId);
  assert.equal(enrollmentCalls, enrollmentCallsAfterCredentialRepair, 'Re-running the installer for file repair must reuse healthy Enrollment');
  const repairedActive = await readJson(join(install, 'active.json'));
  assert.notEqual(repairedActive.path, secondActive.path);
  assert.equal(await exists(join(repairedActive.path, 'bin', 'cloudflared.exe')), true, 'Re-running the self-contained installer repairs local program files');
  assert.equal((await readdir(join(install, 'v'), { withFileTypes: true })).filter(entry => entry.isDirectory()).length, 1,
    'Keep only the current extracted version after a successful activation');
  assert.equal(repairedActive.previous, null);
  assert.equal(await exists(join(install, 'cache')), false);

  await rm(join(repairedActive.path, 'client', 'cli.mjs'));
  const uninstallStarted = Date.now();
  const uninstallCode = await execute(join(install, 'Uninstall.exe'), ['/S', `_?=${install}`], 60000);
  assert.equal(uninstallCode, 0, await readFile(join(install, 'bootstrap-error.log'), 'utf8').catch(() => `Uninstall.exe exited ${uninstallCode} without bootstrap-error.log`));
  const uninstallMs = Date.now() - uninstallStarted;
  canUninstall = false;
  await assertNoTestTasks();
  assert.deepEqual(installProcesses(), [], 'Successful uninstall must return only after every test-owned process has exited');
  assert.equal(await exists(join(install, 'v')), false);
  assert.equal((await readJson(join(home, 'state.json'))).bindingId, bindingId);
  assert.equal(await exists(project), true);
  successReport = { passed: true, actualInstaller: true, selfContainedInstaller: true,
    directFinalInstaller: Boolean(values.direct), installSurvivesEnrollmentFailure: true,
    pendingEnrollmentRepairReusesIdentity: true, upgradeSkipsEnrollment: true,
    healthyRepairIsLocalOnly: true, missingTunnelCredentialIsRecoverable: true,
    rerunInstallerRepairsPayload: true, noPersistentPayloadCache: true,
    officialGitFallbackExecuted: true, retiredVersionsCollected: true, damagedClientUninstallFallback: true,
    uninstallPreservesProjects: true, zeroResidue: true, uninstallMs };
} catch (error) {
  primaryFailure = error;
  throw error;
} finally {
  const cleanupErrors = [];
  if (canUninstall || await exists(join(install, 'Uninstall.exe'))) {
    await execute(join(install, 'Uninstall.exe'), ['/S', `_?=${install}`], 60000).catch(error => cleanupErrors.push(error));
  }
  await cleanupTestTasks().catch(error => cleanupErrors.push(error));
  try { cleanupInstallProcesses(); } catch (error) { cleanupErrors.push(error); }
  await new Promise(resolve => server.close(resolve));
  await rm(work, { recursive: true, force: true }).catch(error => cleanupErrors.push(error));
  await rm(install, { recursive: true, force: true }).catch(error => cleanupErrors.push(error));
  await rm(smokeGuard, { force: true }).catch(error => cleanupErrors.push(error));
  if (await exists(work)) cleanupErrors.push(new Error(`Installer smoke left state/work directory behind: ${work}`));
  if (await exists(install)) cleanupErrors.push(new Error(`Installer smoke left installation directory behind: ${install}`));
  if (cleanupErrors.length) {
    const message = cleanupErrors.map(error => error.message).join('; ');
    if (primaryFailure) console.error(`[installer-smoke cleanup] ${message}`);
    else throw new AggregateError(cleanupErrors, `Installer smoke cleanup failed: ${message}`);
  }
}
console.log(JSON.stringify(successReport));

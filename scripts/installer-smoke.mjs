import assert from 'node:assert/strict';
import { access, cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { atomicJson, randomSecret, readJson, secureStateDirectory } from '../client/state.mjs';
import { run } from './build-utils.mjs';
import release from '../release.config.json' with { type: 'json' };

if (process.platform !== 'win32') throw new Error('This smoke test exercises the actual Windows NSIS bootstrapper');
const { values } = parseArgs({ options: { installer: { type: 'string' } } });
const sourceInstaller = resolve(values.installer ?? `release/offline/${release.version}/win32-x64/Team-DevSpace-${release.version}-windows-x64-setup.exe`);
await access(sourceInstaller);
const sourceLayout = dirname(sourceInstaller);
const manifest = await readJson(join(sourceLayout, 'manifest.json'));
const payloadBytes = manifest.components.reduce((total, component) => total + component.size, 0);
assert.ok((await stat(sourceInstaller)).size > payloadBytes * 0.9, 'Windows installer must physically contain its complete offline payload');
const exists = async path => access(path).then(() => true, () => false);
const suffix = randomUUID().slice(0, 8);
const work = resolve(process.env.TEMP ?? '.', `tds-i-${suffix}`);
const releaseRoot = join(work, 'release');
const layout = join(releaseRoot, 'offline', release.version, 'win32-x64');
const home = join(work, 'state');
const install = resolve(process.env.LOCALAPPDATA ?? process.env.TEMP ?? '.', `T${suffix.slice(0, 4)}`);
const project = join(work, 'project');
await secureStateDirectory(work);
await mkdir(project);
await mkdir(dirname(layout), { recursive: true });
await cp(dirname(sourceInstaller), layout, { recursive: true });
const compilerRoot = resolve('build/nsis');
const compilerDirectory = (await readdir(compilerRoot, { withFileTypes: true })).find(entry => entry.isDirectory() && entry.name.startsWith('nsis-'));
if (!compilerDirectory) throw new Error('Build the Windows package before running installer smoke');
// Match the developer release tree: the convenient root EXE must find its complete nested offline layout.
const installer = join(releaseRoot, `Team-DevSpace-smoke-${suffix}.exe`);
await run(join(compilerRoot, compilerDirectory.name, 'makensis.exe'), ['/V2', '/NOCD',
  `/DBOOTSTRAP=${resolve('platform/windows/bootstrap.ps1')}`, `/DMANIFEST=${join(layout, 'manifest.json')}`,
  `/DOFFLINE_OBJECTS=${join(layout, 'objects')}`, `/DPLATFORM_DIR=${resolve('platform/windows')}`, `/DAPP_VERSION=${release.version}`,
  `/DAPP_VERSION_NUM=${release.version.split('-')[0]}.0`, `/DDEVSPACE_VERSION=${release.devspaceVersion}`, `/DOUTPUT=${installer}`,
  `/DPRODUCT_KEY=Software\\TeamDevSpaceSmoke\\${suffix}`,
  `/DUNINSTALL_KEY=Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TeamDevSpaceSmoke-${suffix}`,
  `/DSTART_MENU_FOLDER=Team DevSpace Smoke ${suffix}`, resolve('platform/windows/installer.nsi')], { timeout: 60000 });
await rm(join(layout, 'objects'), { recursive: true, force: true });
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
      state: 'suspended',
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
async function execute(file, args, timeout = 240000) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true, stdio: 'inherit' });
    const timer = setTimeout(() => { child.kill(); reject(new Error('Installer smoke-test command timed out')); }, timeout);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve(code); });
  });
}
async function installAttempt() {
  const requestFile = join(work, 'setup-request.json');
  await atomicJson(requestFile, { gateway: `http://127.0.0.1:${server.address().port}`, accessKey: key, roots: [project] });
  env.TEAM_DEVSPACE_SETUP_REQUEST_FILE = requestFile;
  const code = await execute(installer, ['/S', `/D=${install}`]);
  delete env.TEAM_DEVSPACE_SETUP_REQUEST_FILE;
  assert.equal(code, 0, await readFile(join(install, 'bootstrap-error.log'), 'utf8').catch(() => 'No bootstrap diagnostic was written'));
  assert.equal(await exists(requestFile), false, 'Temporary credential input must be consumed');
  return readJson(join(home, 'state.json'));
}
async function repair() {
  return execute(join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(install, 'command.ps1'), 'repair',
  ]);
}

let canUninstall = false;
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
  const enrolled = await installAttempt();
  assert.equal(enrolled.deviceId, pending.deviceId, 'Enrollment retry must reuse the pending local identity');
  assert.equal(enrolled.bindingId, bindingId);
  assert.equal(enrollmentCalls, 2);
  const firstActive = await readJson(join(install, 'active.json'));
  const upstream = await readJson(join(firstActive.path, 'node_modules', '@waishnav', 'devspace', 'package.json'));
  assert.equal(upstream.version, release.devspaceVersion);
  assert.equal(await exists(join(firstActive.path, 'git', 'cmd', 'git.exe')), true);
  assert.equal(await exists(join(firstActive.path, 'git', 'bin', 'bash.exe')), true);

  await writeFile(join(firstActive.path, 'obsolete-upgrade-fixture.txt'), 'must disappear from the next immutable version');
  const enrollmentCallsBeforeUpgrade = enrollmentCalls;
  const upgraded = await installAttempt();
  assert.equal(enrollmentCalls, enrollmentCallsBeforeUpgrade, 'An enrolled device upgrade must not call /v1/enroll again');
  for (const name of ['deviceId', 'deviceSecret', 'ownerToken', 'accessKey', 'bindingId']) assert.equal(upgraded[name], enrolled[name]);
  assert.deepEqual(upgraded.roots, enrolled.roots);
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

  assert.equal(await execute(join(install, 'Uninstall.exe'), ['/S', `_?=${install}`], 60000), 0);
  canUninstall = false;
  assert.equal(await exists(join(install, 'v')), false);
  assert.equal((await readJson(join(home, 'state.json'))).bindingId, bindingId);
  assert.equal(await exists(project), true);
  console.log(JSON.stringify({ passed: true, actualInstaller: true, selfContainedInstaller: true,
    installSurvivesEnrollmentFailure: true, enrollmentRetryReusesIdentity: true, upgradeSkipsEnrollment: true,
    healthyRepairIsLocalOnly: true, missingTunnelCredentialIsRecoverable: true,
    rerunInstallerRepairsPayload: true, noPersistentPayloadCache: true,
    officialGitFallbackExecuted: true, retiredVersionsCollected: true, uninstallPreservesProjects: true }));
} finally {
  if (canUninstall || await exists(join(install, 'Uninstall.exe'))) {
    await execute(join(install, 'Uninstall.exe'), ['/S', `_?=${install}`], 60000).catch(() => {});
  }
  await new Promise(resolve => server.close(resolve));
  await rm(work, { recursive: true, force: true });
  await rm(install, { recursive: true, force: true });
}

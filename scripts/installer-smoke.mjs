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
assert.ok((await stat(sourceInstaller)).size < 5 * 1024 * 1024, 'Default installer must not physically contain the runtime Payload');
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
  `/DPLATFORM_DIR=${resolve('platform/windows')}`, `/DAPP_VERSION=${release.version}`,
  `/DAPP_VERSION_NUM=${release.version.split('-')[0]}.0`, `/DDEVSPACE_VERSION=${release.devspaceVersion}`, `/DOUTPUT=${installer}`,
  `/DPRODUCT_KEY=Software\\TeamDevSpaceSmoke\\${suffix}`,
  `/DUNINSTALL_KEY=Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TeamDevSpaceSmoke-${suffix}`,
  `/DSTART_MENU_FOLDER=Team DevSpace Smoke ${suffix}`, resolve('platform/windows/installer.nsi')], { timeout: 60000 });
const manifest = await readJson(join(layout, 'manifest.json'));
const key = `tds_${randomSecret()}`;
const bindingId = randomUUID();
const keyId = randomUUID();
const server = http.createServer(async (request, response) => {
  let body = '';
  for await (const chunk of request) body += chunk;
  const value = JSON.parse(body);
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/v1/enroll') {
    assert.equal(request.headers.authorization, `Bearer ${key}`);
    response.end(JSON.stringify({ keyId, bindingId, deviceId: value.deviceId, devspaceVersion: release.devspaceVersion,
      hostname: 'not-a-real-tunnel.invalid', tunnelToken: 'not-a-valid-cloudflare-token',
      endpoint: `http://127.0.0.1:${server.address().port}/mcp` }));
  } else if (request.url === '/v1/device/status') {
    response.end(JSON.stringify({ state: 'active', bindingId, deviceId: value.deviceId }));
  } else { response.statusCode = 404; response.end('{}'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
// Force the clean-employee-machine path: no system Git/Bash on PATH. The real
// installer must verify, extract and execute the official optional Git SFX.
const env = { ...process.env, TEAM_DEVSPACE_HOME: home, TEAM_DEVSPACE_SETUP_NO_STARTUP: '1', NODE_OPTIONS: '',
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
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(install, 'bootstrap.ps1'),
    '-Mode', 'Repair', '-InstallPath', install, '-ManifestPath', join(install, 'release-manifest.json'),
    '-OfflineRoot', layout, '-NoStartup',
  ]);
}

let canUninstall = false;
try {
  const first = await installAttempt();
  canUninstall = true;
  assert.equal(first.bindingId, bindingId);
  const firstActive = await readJson(join(install, 'active.json'));
  const upstream = await readJson(join(firstActive.path, 'node_modules', '@waishnav', 'devspace', 'package.json'));
  assert.equal(upstream.version, release.devspaceVersion);
  const cachedHashes = new Set(await readdir(join(install, 'cache', 'sha256')));
  for (const component of manifest.components.filter(component => component.required)) {
    assert.equal(cachedHashes.has(component.sha256), true, `Required component was not cached: ${component.name}`);
  }
  assert.equal(cachedHashes.size, manifest.components.length, 'A clean machine must cache the Git SFX too');
  assert.equal(await exists(join(firstActive.path, 'git', 'cmd', 'git.exe')), true);
  assert.equal(await exists(join(firstActive.path, 'git', 'bin', 'bash.exe')), true);
  const staleHash = '0'.repeat(64);
  await mkdir(join(install, 'cache', 'sha256', staleHash));
  await writeFile(join(install, 'cache', 'sha256', staleHash, 'old-artifact'), 'stale');

  await writeFile(join(firstActive.path, 'obsolete-upgrade-fixture.txt'), 'must disappear from the next immutable version');
  const second = await installAttempt();
  for (const name of ['deviceId', 'deviceSecret', 'ownerToken', 'accessKey', 'bindingId']) assert.equal(second[name], first[name]);
  assert.deepEqual(second.roots, first.roots);
  const secondActive = await readJson(join(install, 'active.json'));
  assert.notEqual(secondActive.path, firstActive.path);
  assert.equal(await exists(join(secondActive.path, 'obsolete-upgrade-fixture.txt')), false);
  assert.equal(await exists(firstActive.path), false, 'Successful activation must retire the old extracted version');
  assert.equal(await exists(join(install, 'cache', 'sha256', staleHash)), false, 'Unreferenced cache must be collected');

  await rm(join(secondActive.path, 'bin', 'cloudflared.exe'));
  assert.equal(await repair(), 0, 'Repair must reacquire a complete version through the shared cache/artifact path');
  const repairedActive = await readJson(join(install, 'active.json'));
  assert.notEqual(repairedActive.path, secondActive.path);
  assert.equal(await exists(join(repairedActive.path, 'bin', 'cloudflared.exe')), true);
  assert.equal((await readdir(join(install, 'v'), { withFileTypes: true })).filter(entry => entry.isDirectory()).length, 1,
    'Keep only the current extracted version after a successful activation');
  assert.equal(repairedActive.previous, null);

  const nodeComponent = manifest.components.find(component => component.name === 'node');
  await rm(join(install, 'cache', 'sha256', nodeComponent.sha256), { recursive: true, force: true });
  await writeFile(join(layout, ...nodeComponent.path.split('/')), 'corrupted-offline-artifact');
  assert.notEqual(await repair(), 0, 'A corrupt artifact must fail before activation');
  assert.equal((await readJson(join(install, 'active.json'))).path, repairedActive.path);
  assert.equal(await exists(join(repairedActive.path, 'runtime', 'node.exe')), true, 'Failed repair must retain the current usable version');

  assert.equal(await execute(join(install, 'Uninstall.exe'), ['/S', `_?=${install}`], 60000), 0);
  canUninstall = false;
  assert.equal(await exists(join(install, 'v')), false);
  assert.equal((await readJson(join(home, 'state.json'))).bindingId, bindingId);
  assert.equal(await exists(project), true);
  console.log(JSON.stringify({ passed: true, actualInstaller: true, lightweightBootstrapper: true,
    offlineLayout: true, verifiedCache: true, repairReacquiresPayload: true, failedRepairRetainsActive: true,
    upgradePreservesEnrollment: true, officialGitFallbackExecuted: true, retiredVersionsCollected: true,
    cacheGarbageCollected: true, uninstallPreservesProjects: true }));
} finally {
  if (canUninstall || await exists(join(install, 'Uninstall.exe'))) {
    await execute(join(install, 'Uninstall.exe'), ['/S', `_?=${install}`], 60000).catch(() => {});
  }
  await new Promise(resolve => server.close(resolve));
  await rm(work, { recursive: true, force: true });
  await rm(install, { recursive: true, force: true });
}

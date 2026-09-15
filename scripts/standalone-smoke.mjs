import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { linuxServiceManager } from '../client/linux-lifecycle.mjs';
import { processIdentity, isSameProcess, standaloneDirectory } from '../client/standalone.mjs';
import { run } from './build-utils.mjs';
import release from './release-profile.mjs';

const { values } = parseArgs({ options: { archive: { type: 'string' } } });
assert.equal(process.platform, 'linux');
assert.notEqual(process.getuid(), 0, 'Run the acceptance as a normal Linux user');
assert.equal(await linuxServiceManager(), 'standalone', 'Use a real no-systemd environment (or the isolated mount/PID namespace helper)');
const work = await mkdtemp(join(tmpdir(), 'tds standalone acceptance '));
const media = join(work, 'media');
const distribution = join(work, 'distribution');
const home = join(work, 'persistent state');
const project = join(work, 'repository');
const extra = join(work, 'another repository');
const cliDirectory = join(work, 'bin');
const stableCli = join(distribution, 'bin', 'team-devspace');
const manifestPath = join(media, 'release-manifest.json');
const archive = resolve(values.archive ?? `release/Team-DevSpace-${release.version}-linux-x64-offline.tar.gz`);
const env = { ...process.env, TEAM_DEVSPACE_HOME: home, TEAM_DEVSPACE_CLI_DIR: cliDirectory,
  TEAM_DEVSPACE_DISTRIBUTION_ROOT: distribution, NODE_OPTIONS: '' };
let enrolled = 0;
let binding;
let remoteAccess = 'active';
let runtimeDirectory;
let client;
let primaryFailure;
let detachedWorker;
const server = http.createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
  let result;
  if (req.url === '/v1/enroll') {
    enrolled++;
    binding ??= { deviceId: body.deviceId, keyId: randomUUID(), bindingId: randomUUID(), hostname: 'fixture.invalid',
      tunnelToken: 'fixture-only-not-a-cloudflare-token', endpoint: `http://127.0.0.1:${server.address().port}/mcp`,
      devspaceVersion: release.devspaceVersion, controlApiVersion: release.controlApiVersion, state: remoteAccess };
    result = binding;
  } else if (req.url === '/v1/device/status-v2') result = { state: remoteAccess, bindingId: binding.bindingId };
  else if (req.url === '/v1/device/suspend') { remoteAccess = 'suspended'; result = { state: remoteAccess }; }
  else if (req.url === '/v1/device/resume') { remoteAccess = 'active'; result = { state: remoteAccess }; }
  else { res.writeHead(404); res.end('{}'); return; }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(result));
});
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
const exists = path => access(path).then(() => true, () => false);
const readState = () => readFile(join(home, 'state.json'), 'utf8').then(JSON.parse);
const active = () => readFile(join(distribution, 'active-path'), 'utf8').then(value => value.trim());
const record = component => readFile(join(runtimeDirectory, `${component}.json`), 'utf8').then(JSON.parse);
const cli = (...args) => run(stableCli, args, { env, capture: true, timeout: 120000 });
const status = async () => JSON.parse((await cli('status')).stdout);
async function waitFor(probe, message, timeout = 30000) {
  const until = Date.now() + timeout;
  do { if (await probe()) return; await sleep(200); } while (Date.now() < until);
  throw new Error(message);
}
async function install(setup = false) {
  const args = [join(media, 'install.sh'), '--root', distribution, '--offline', media];
  if (setup) {
    const request = join(work, 'request.json');
    await writeFile(request, JSON.stringify({ gateway: `http://127.0.0.1:${server.address().port}`,
      currentProjectRoot: project, accessKey: `tds_${'a'.repeat(43)}` }), { mode: 0o600 });
    args.push('--setup', 'existing', '--request-file', request);
  }
  return run('/bin/sh', args, { env, capture: true, timeout: 180000 });
}

// Only the Tunnel is a deterministic fixture. All installer, CLI, Node, native
// modules, DevSpace, Bridge, signals and process ownership are actual release code.
async function replaceArtifact(name, files) {
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const component = manifest.components.find(item => item.name === name);
  const packed = join(work, `${name}-fixture.tar.gz`);
  await run('tar', ['-czf', packed, '-C', files, '.']);
  const bytes = await readFile(packed);
  component.sha256 = createHash('sha256').update(bytes).digest('hex');
  component.size = bytes.length;
  component.path = `objects/sha256/${component.sha256}/${name}.tar.gz`;
  const target = join(media, component.path);
  await mkdir(join(media, 'objects', 'sha256', component.sha256), { recursive: true });
  await cp(packed, target);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

try {
  await Promise.all([media, project, extra].map(path => mkdir(path)));
  await run('tar', ['-xzf', archive, '-C', media]);
  const fixture = join(work, 'tunnel fixture');
  await mkdir(join(fixture, 'bin'), { recursive: true });
  const tunnel = join(fixture, 'bin', 'cloudflared');
  await writeFile(tunnel, '#!/bin/sh\nHERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$HERE/../runtime/bin/node" "$HERE/tunnel-fixture.mjs" "$@"\n', { mode: 0o755 });
  await chmod(tunnel, 0o755);
  await writeFile(join(fixture, 'bin', 'tunnel-fixture.mjs'), `import http from 'node:http'; import {existsSync} from 'node:fs';
if (process.argv.includes('--version')) { console.log('cloudflared version ${release.cloudflaredVersion}'); }
else if (existsSync(new URL('./fail-worker', import.meta.url))) process.exit(2);
else {
  const address = process.argv[process.argv.indexOf('--metrics') + 1];
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('fixture-ready'); });
  server.listen(Number(address.split(':').pop()), '127.0.0.1');
  process.on('SIGTERM', () => server.close());
}
`);
  await replaceArtifact('cloudflared', fixture);
  await writeFile(join(project, 'proof.txt'), 'standalone-native-proof');
  await install(true);
  runtimeDirectory = await standaloneDirectory(home);
  assert.equal((await status()).ready, true);
  assert.equal(enrolled, 1);
  console.log('PASS install / Enrollment / native Runtime+Bridge / fixture Tunnel');

  // A new shell with no installer environment still resolves the retained home.
  const freshEnv = { ...process.env, TEAM_DEVSPACE_HOME: '', TEAM_DEVSPACE_DISTRIBUTION_ROOT: '', NODE_OPTIONS: '' };
  const fresh = await run(stableCli, ['project-root', 'show'], { env: freshEnv, capture: true });
  assert.ok(fresh.stdout.includes(project));
  const stable = await readState();
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${stable.ports.bridge}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${stable.deviceSecret}`, 'X-Team-Binding-Id': stable.bindingId } },
  });
  client = new Client({ name: 'standalone-acceptance', version: '1' });
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'open_workspace'));
  const opened = await client.callTool({ name: 'open_workspace', arguments: { path: project, mode: 'checkout' } });
  const data = opened.structuredContent ?? opened.content.map(item => { try { return JSON.parse(item.text); } catch { return null; } }).find(item => item?.workspaceId || item?.result?.workspaceId);
  const workspaceId = data.workspaceId ?? data.result?.workspaceId;
  const read = await client.callTool({ name: 'read', arguments: { workspaceId, path: 'proof.txt' } });
  assert.ok(JSON.stringify(read).includes('standalone-native-proof'));
  const written = await client.callTool({ name: 'write', arguments: { workspaceId, path: 'written.txt', content: 'standalone-write-proof' } });
  assert.ok(!written.isError);
  const shell = await client.callTool({ name: 'bash', arguments: { workspaceId, command: 'printf standalone-shell-proof', timeout: 10 } });
  assert.ok(!shell.isError && JSON.stringify(shell).includes('standalone-shell-proof'));
  const detachedScript = join(project, 'detached-child.mjs');
  const detachedPid = join(project, 'detached.pid');
  await writeFile(detachedScript, `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true,stdio:'ignore'});
writeFileSync(process.argv[2], String(child.pid)); child.unref();\n`);
  const detached = await client.callTool({ name: 'bash', arguments: { workspaceId,
    command: `node ${JSON.stringify(detachedScript)} ${JSON.stringify(detachedPid)}`, timeout: 10 } });
  assert.ok(!detached.isError);
  detachedWorker = await processIdentity(Number(await readFile(detachedPid, 'utf8')));
  assert.ok(await isSameProcess(detachedWorker));
  assert.equal(detachedWorker.session, detachedWorker.pid, 'fixture must really leave the runtime session');
  await client.close(); client = null;
  console.log('PASS authenticated MCP tools/list / open_workspace / read / write / bash');

  const initial = await record('runtime');
  await Promise.all([cli('start'), cli('start'), cli('start')]);
  assert.equal((await record('runtime')).owner.pid, initial.owner.pid);
  for (const component of ['runtime', 'tunnel']) {
    const before = await record(component);
    process.kill(before.child.pid, 'SIGKILL');
    await waitFor(async () => {
      const after = await record(component);
      return after.child && after.child.pid !== before.child.pid && await isSameProcess(after.child) && (await status()).ready;
    }, `${component} did not recover after SIGKILL`);
    assert.equal((await record(component)).owner.pid, before.owner.pid);
    if (component === 'runtime') assert.equal(await isSameProcess(detachedWorker), false, 'runtime crash must also clean detached/PTY-style descendants');
  }
  console.log('PASS repeated/concurrent start and crash recovery of both workers');
  const failureFlag = join(await active(), 'bin', 'fail-worker');
  await writeFile(failureFlag, 'deliberate persistent worker failure');
  process.kill((await record('tunnel')).child.pid, 'SIGKILL');
  await waitFor(async () => (await record('tunnel')).finished, 'persistent failures must stop at the restart limit', 35000);
  assert.ok((await readFile(join(home, 'logs', 'tunnel.error.log'), 'utf8')).includes('restart limit reached'));
  assert.equal((await status()).ready, false);
  await rm(failureFlag);
  await cli('repair');
  assert.equal((await status()).ready, true);
  console.log('PASS bounded crash-loop backoff and explicit repair recovery');

  const orphan = await record('runtime');
  process.kill(orphan.owner.pid, 'SIGKILL');
  await cli('repair');
  assert.equal(await isSameProcess(orphan.child), false, 'repair must stop an orphan before replacing its keeper');
  assert.equal((await status()).ready, true);
  assert.equal(enrolled, 1);
  await cli('stop');
  const fake = { home, component: 'runtime', nonce: randomUUID(), owner: await processIdentity(process.pid), child: null };
  await writeFile(join(runtimeDirectory, 'runtime.json'), JSON.stringify(fake), { mode: 0o600 });
  await assert.rejects(cli('start'), /unrelated process/);
  assert.ok(await isSameProcess(fake.owner));
  fake.owner.start = '0';
  await writeFile(join(runtimeDirectory, 'runtime.json'), JSON.stringify(fake), { mode: 0o600 });
  await cli('start');
  assert.ok(await isSameProcess(await processIdentity(process.pid)), 'a reused PID must never signal the test runner');
  await cli('stop');
  await mkdir(join(runtimeDirectory, 'runtime.lock'));
  await assert.rejects(cli('start'), /acquiring ownership/);
  const old = new Date(Date.now() - 60000);
  await utimes(join(runtimeDirectory, 'runtime.lock'), old, old);
  await cli('start');
  console.log('PASS keeper crash/orphan repair, stale PID and fresh/stale lock handling');

  await cli('suspend');
  await cli('start');
  await cli('repair');
  await sleep(1500);
  assert.equal((await status()).localReady, false);
  assert.equal((await readState()).remoteAccess, 'suspended');
  await cli('project-root', 'set', extra);
  assert.equal((await status()).localReady, false);
  assert.equal((await readState()).currentProjectRoot, extra);
  await cli('resume');
  assert.equal((await status()).ready, true);
  const tunnelBefore = await record('tunnel');
  const runtimeBefore = await record('runtime');
  await cli('project-root', 'set', project);
  assert.equal((await record('tunnel')).child.pid, tunnelBefore.child.pid, 'project changes must not restart the tunnel');
  assert.notEqual((await record('runtime')).child.pid, runtimeBefore.child.pid);
  await cli('restart');
  assert.equal((await status()).ready, true);
  console.log('PASS fail-closed suspend/start/repair, resume, project-root scope and restart');

  const firstActive = await active();
  await install();
  const upgraded = await active();
  assert.notEqual(upgraded, firstActive);
  assert.equal(await exists(firstActive), false);
  assert.equal((await readState()).deviceId, stable.deviceId);
  assert.equal((await readState()).bindingId, stable.bindingId);
  assert.equal(enrolled, 1);
  assert.equal((await status()).ready, true);
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const node = manifest.components.find(item => item.name === 'node');
  await rm(join(distribution, 'cache', 'sha256', node.sha256), { recursive: true, force: true });
  const originalNode = await readFile(join(media, node.path));
  await writeFile(join(media, node.path), 'corrupt node');
  await assert.rejects(install(), /Artifact verification failed: node/);
  assert.equal(await active(), upgraded);
  assert.equal((await status()).ready, true);
  await writeFile(join(media, node.path), originalNode);
  assert.equal((await readdir(join(distribution, 'staging'))).length, 0);
  assert.equal(await exists(join(distribution, 'install.lock')), false);

  // Pass integrity/native-module validation, then deliberately fail runtime
  // activation. This proves rollback, not only pre-extraction hash rejection.
  const badApp = join(work, 'bad app');
  await mkdir(badApp);
  const app = manifest.components.find(item => item.name === 'app');
  await run('tar', ['-xzf', join(media, app.path), '-C', badApp]);
  const runtimeFile = join(badApp, 'client', 'runtime.mjs');
  const runtimeSource = await readFile(runtimeFile, 'utf8');
  assert.ok(runtimeSource.includes('  const state = await loadState(home);'));
  await writeFile(runtimeFile, runtimeSource.replace('  const state = await loadState(home);',
    "  throw new Error('activation-fixture-failure');\n  const state = await loadState(home);"));
  await replaceArtifact('app', badApp);
  await assert.rejects(install(), /startup activation failed|previous startup state was restored/);
  assert.equal(await active(), upgraded);
  assert.equal((await status()).ready, true);
  assert.equal((await readdir(join(distribution, 'versions'))).length, 1);
  console.log('PASS upgrade identity retention, corrupt artifact rejection and failed activation rollback');

  const diagnostics = JSON.parse((await cli('diagnostics')).stdout);
  assert.equal(diagnostics.lifecycle, 'standalone');
  assert.ok(diagnostics.recentErrors.length > 0);
  const logs = (await cli('logs')).stdout;
  assert.ok(logs.includes('standalone'));
  const following = spawn(stableCli, ['logs', '--follow'], { env, stdio: 'ignore' });
  const followingExit = new Promise((done, reject) => { following.once('error', reject); following.once('exit', done); });
  let tailIdentity;
  await waitFor(async () => {
    const children = await readFile(`/proc/${following.pid}/task/${following.pid}/children`, 'utf8').catch(() => '');
    const pid = Number(children.trim().split(/\s+/)[0]);
    tailIdentity = await processIdentity(pid);
    return Boolean(tailIdentity);
  }, 'logs --follow did not start tail');
  following.kill('SIGTERM');
  await followingExit;
  assert.equal(await isSameProcess(tailIdentity), false, 'ending log follow must not orphan tail');
  assert.equal((await stat(home)).mode & 0o777, 0o700);
  assert.equal((await stat(join(home, 'state.json'))).mode & 0o777, 0o600);
  const currentOwners = await Promise.all(['runtime', 'tunnel'].map(record));
  await cli('uninstall');
  await cli('uninstall');
  for (const owned of currentOwners) {
    assert.equal(await isSameProcess(owned.owner), false);
    assert.equal(await isSameProcess(owned.child), false);
  }
  assert.equal(await exists(runtimeDirectory), false);
  assert.equal(await exists(join(project, 'written.txt')), true);
  assert.equal(await exists(join(home, 'state.json')), true);
  await run('/bin/sh', [join(media, 'install.sh'), '--root', distribution, '--mode', 'uninstall'],
    { env: { ...freshEnv, TEAM_DEVSPACE_CLI_DIR: '' }, capture: true });
  assert.equal(await exists(distribution), false);
  assert.equal(await exists(join(cliDirectory, 'team-devspace')), false);
  console.log(JSON.stringify({ passed: true, realNoSystemd: true, nativeRuntime: true, authenticatedMcp: true,
    singleInstance: true, crashRecovery: true, orphanRepair: true, stalePidSafe: true, pausePreserved: true,
    upgrade: true, failedActivationRollback: true, statePathRetained: true, zeroResidue: true,
    realCloudflare: false, realChatGPT: false, tunnel: 'deterministic fixture' }));
} catch (error) {
  primaryFailure = error;
  for (const component of ['runtime', 'tunnel']) {
    console.error(await readFile(join(home, 'logs', `${component}.error.log`), 'utf8').then(text => text.slice(-4000), () => ''));
  }
  throw error;
} finally {
  await client?.close().catch(() => {});
  let cleanupFailure;
  if (await exists(stableCli) && await exists(join(home, 'state.json'))) {
    await cli('uninstall').catch(error => { cleanupFailure = error; });
  }
  await new Promise(resolveClose => server.close(resolveClose));
  if (cleanupFailure) {
    throw new AggregateError([primaryFailure, cleanupFailure].filter(Boolean), `Cleanup failed; retained diagnostics and state at ${work}`);
  }
  await rm(work, { recursive: true, force: true });
}

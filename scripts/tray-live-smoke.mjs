import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stateHome } from '../client/state.mjs';
import release from './release-profile.mjs';
import { run } from './build-utils.mjs';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { withDeviceOperation } from '../client/operation.mjs';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { administrator, createAccessKey } from '../client/admin.mjs';
import { control } from '../client/http.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Explicit opt-in: reuse two host/platform-scoped test keys in the live Gateway.
// Reset removes their Tunnel/DNS/binding without accumulating revoked rows.
// The existing file lock prevents concurrent tests from resetting each other.
const { values } = parseArgs({ options: { live: { type: 'boolean' }, 'runtime-root': { type: 'string' }, output: { type: 'string' } } });
if (!['win32', 'linux'].includes(process.platform) || !values.live) {
  throw new Error('Run on Windows/Linux with --live to exercise an isolated real Gateway/Tunnel lifecycle');
}
const output = values.output ? resolve(values.output) : null;
if (output) { await mkdir(dirname(output), { recursive: true }); await rm(output, { force: true }); }
if (process.env.TEAM_DEVSPACE_HOME) throw new Error('Do not redirect employee state before the live acceptance preflight');
if (process.platform === 'linux') {
  if (values['runtime-root']) throw new Error('Linux live acceptance installs the final archive, not a substituted runtime root');
  const exec = promisify(execFile);
  await exec('systemctl', ['--user', 'show-environment']);
  for (const component of ['runtime', 'tunnel']) {
    const { stdout } = await exec('systemctl', ['--user', 'show', `team-devspace-${component}.service`, '--property=LoadState', '--value']);
    assert.equal(stdout.trim(), 'not-found', 'Refusing to replace an existing Linux employee service');
  }
}
const employeeStatePath = join(stateHome(), 'state.json');
const employeeFingerprint = () => readFile(employeeStatePath)
  .then(value => createHash('sha256').update(value).digest('hex'), error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
const employeeBefore = await employeeFingerprint();
const config = await administrator();
await withDeviceOperation(join(config.directory, 'live-tests', `${process.platform}-${process.arch}`), async () => {
const home = await mkdtemp(join(tmpdir(), 'tds-tray-live-'));
const project = join(home, 'project');
await mkdir(project);
let root, linuxBootstrap;
const distribution = join(home, 'distribution');
const installEnv = { TEAM_DEVSPACE_HOME: home, TEAM_DEVSPACE_CLI_DIR: join(home, 'cli'), NODE_OPTIONS: '' };
try {
  if (process.platform === 'linux') {
    const media = join(home, 'media');
    await mkdir(media);
    await run('/bin/tar', ['-xzf', resolve(`release/offline/${release.version}/linux-${process.arch}/Team-DevSpace-${release.version}-linux-${process.arch}-offline.tar.gz`), '-C', media]);
    linuxBootstrap = join(media, 'install.sh');
    await run('/bin/sh', [linuxBootstrap, '--root', distribution, '--manifest', join(media, 'release-manifest.json'), '--offline', media, '--setup', 'none'], { env: installEnv, timeout: 240000 });
    root = (await readFile(join(distribution, 'active-path'), 'utf8')).trim();
    await run(process.execPath, ['scripts/verify-release.mjs', '--target', `linux-${process.arch}`, '--installed', root]);
  } else {
    root = values['runtime-root'] ? resolve(values['runtime-root'])
      : resolve(JSON.parse(await readFile(join(process.env.LOCALAPPDATA, 'TDS', 'active.json'), 'utf8')).path);
  }
} catch (error) {
  await rm(home, { recursive: true, force: true });
  throw error;
}
const moduleAt = path => import(pathToFileURL(join(root, path)).href);
const setup = await moduleAt('client/setup.mjs');
const lifecycle = await moduleAt('client/platform.mjs');
const actions = await moduleAt('client/control.mjs');
const stateApi = await moduleAt('client/state.mjs');
const suffix = createHash('sha256').update(`${hostname()}:${process.platform}:${process.arch}`).digest('hex').slice(0, 12);
const keys = [];
const checks = [];
let state;
let client;
let cleanupFailed = false, completed = false, failure;
const runtimeManifestSha256 = await readFile(join(root, 'install-manifest.json'))
  .then(bytes => createHash('sha256').update(bytes).digest('hex'), error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
async function ready() {
  const deadline = Date.now() + 90000;
  do {
    const status = await setup.deviceStatus(home);
    if (status.ready) return status;
    await sleep(1000);
  } while (Date.now() < deadline);
  throw new Error(`Test device did not become ready: ${JSON.stringify(await setup.deviceStatus(home))}`);
}
function passed(name) { checks.push(name); console.log(JSON.stringify({ check: name, passed: true })); }
async function remoteMcp(key) {
  const deadline = Date.now() + 90000;
  do {
    client = new Client({ name: 'team-devspace-tray-live-acceptance', version: '1.0.0' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', config.gateway), {
        requestInit: { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) },
      }));
      const tools = await client.listTools();
      assert.ok(tools.tools.some(tool => tool.name === 'open_workspace'));
      const opened = await client.callTool({ name: 'open_workspace', arguments: { path: project, mode: 'checkout' } });
      assert.ok(!opened.isError, 'Live MCP must open the isolated project');
      const data = opened.structuredContent ?? opened.content.filter(item => item.type === 'text')
        .map(item => { try { return JSON.parse(item.text); } catch { return null; } })
        .find(item => item?.workspaceId || item?.result?.workspaceId);
      const workspaceId = data?.workspaceId ?? data?.result?.workspaceId;
      assert.ok(workspaceId, 'Live MCP must return a workspace identity');
      const written = await client.callTool({ name: 'write', arguments: { workspaceId,
        path: 'live-proof.txt', content: 'live-cloudflare-write-proof' } });
      assert.ok(!written.isError, 'Live MCP must write inside the isolated project');
      const read = await client.callTool({ name: 'read', arguments: { workspaceId, path: 'live-proof.txt' } });
      assert.ok(!read.isError && JSON.stringify(read).includes('live-cloudflare-write-proof'));
      const shell = await client.callTool({ name: 'bash', arguments: { workspaceId,
        command: 'printf live-cloudflare-shell-proof', timeout: 10 } });
      assert.ok(!shell.isError && JSON.stringify(shell).includes('live-cloudflare-shell-proof'));
      await client.close(); client = null;
      return;
    } catch (error) {
      await client.close().catch(() => {}); client = null;
      if (!/device_offline|device_not_ready/.test(error.message) || Date.now() >= deadline) throw error;
      // A newly provisioned tunnel's DNS/configuration can lag its local /ready.
      await sleep(2000);
    }
  } while (true);
}
try {
  for (const letter of ['a', 'b']) {
    const key = await createAccessKey(config, `tray-e2e-${process.platform}-${suffix}-${letter}`);
    keys.push(key);
    if (key.state !== 'issued') {
      const reset = await control(config.gateway, `/v1/admin/keys/${key.id}/reset`, config.adminToken, { body: {} });
      assert.equal(reset.cleanup, 'complete');
      assert.equal(reset.state, 'issued');
    }
  }
  await setup.configureDevice({ gateway: config.gateway, accessKey: keys[0].accessKey,
    currentProjectRoot: project }, { home, startup: false });
  state = await stateApi.loadState(home);
  await lifecycle.installServices(state, home, root, lifecycle.COMPONENTS);
  await lifecycle.serviceAction('start', state, home, lifecycle.COMPONENTS);
  await ready(); passed('isolated real runtime + cloudflared + Gateway ready');
  await actions.suspendRemoteAccess(home);
  let status = await setup.deviceStatus(home);
  assert.equal(status.gateway, 'suspended');
  assert.equal(status.devspace || status.bridge || status.tunnel, false);
  passed('suspend stops local services and closes Gateway');
  await actions.resumeRemoteAccess(home);
  await ready(); passed('resume restarts paused runtime and restores remote access');
  await remoteMcp(keys[0].accessKey); passed('authenticated MCP through real Cloudflare Tunnel');
  await actions.restartTeamDevSpace(home); await ready(); passed('restart');
  await setup.repairDevice(home, { preserveTray: true }); await ready(); passed('repair');
  const identity = await stateApi.loadState(home);
  let previousBinding = identity.bindingId;
  // Reuse the same two isolated keys to exercise repeated native stop/start and
  // binding transitions, not merely one fortunate connection attempt.
  for (const [index, key] of [keys[1], keys[0], keys[1]].entries()) {
    await setup.replaceAccessKey(key.accessKey, home); await ready();
    const replaced = await stateApi.loadState(home);
    assert.equal(replaced.deviceId, identity.deviceId);
    assert.equal(replaced.ownerToken, identity.ownerToken);
    assert.equal(replaced.currentProjectRoot, identity.currentProjectRoot);
    assert.equal(replaced.accessKey, key.accessKey);
    assert.notEqual(replaced.bindingId, previousBinding);
    previousBinding = replaced.bindingId;
    await remoteMcp(key.accessKey); passed(`replace Access Key round ${index + 1} retains identity/project root and reconnects`);
  }
  assert.equal((await control(config.gateway, '/v1/enrollment/preflight', keys[0].accessKey, { body: {} })).available, true);
  passed('old Key binding released');
  await actions.stopTeamDevSpace(home);
  status = await setup.deviceStatus(home);
  assert.equal(status.devspace || status.bridge || status.tunnel, false);
  passed('exit stops all connection services');
  assert.equal(await employeeFingerprint(), employeeBefore, 'Employee enrollment state changed during an isolated test');
  completed = true;
} catch (error) {
  failure = { error: actions.redactDiagnostic(error.message), code: error.code, status: error.status };
  console.error(JSON.stringify({ passed: false, completedChecks: checks, ...failure }));
  // Capture the product's bounded, redacted diagnostics before the isolated
  // scope is cleaned up. Readiness booleans alone cannot explain a crashed worker.
  const diagnostics = await actions.diagnosticReport(home).catch(failure => ({ error: actions.redactDiagnostic(failure.message) }));
  console.error(JSON.stringify({ diagnostics }));
  const text = await readFile(join(home, 'logs', 'runtime.log'), 'utf8').catch(() => '');
  console.error(text.split(/\r?\n/).filter(line => /"event":"(?:paused|listening)"/.test(line)).slice(-6).join('\n'));
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  const current = await stateApi.loadState(home).catch(() => state);
  if (current) await lifecycle.serviceAction('remove', current, home, lifecycle.COMPONENTS).catch(error => {
    console.error(`Test-only native startup cleanup: ${actions.redactDiagnostic(error.message)}`); cleanupFailed = true; process.exitCode = 1;
  });
  for (const key of keys) {
    try {
      const reset = await control(config.gateway, `/v1/admin/keys/${key.id}/reset`, config.adminToken, { body: {}, timeout: 30000 });
      assert.equal(reset.cleanup, 'complete');
      assert.equal(reset.state, 'issued');
      assert.equal(reset.bindingId, null);
    }
    catch (error) { console.error(`Test-only key cleanup failed (${key.id}): ${error.code ?? 'unknown'}`); cleanupFailed = true; process.exitCode = 1; }
  }
  if (await employeeFingerprint() !== employeeBefore) {
    console.error('Employee state fingerprint changed during verification; inspect before any further operation');
    cleanupFailed = true; process.exitCode = 1;
  }
  if (linuxBootstrap) {
    await run('/bin/sh', [linuxBootstrap, '--mode', 'uninstall', '--root', distribution], { env: installEnv, timeout: 120000 }).catch(error => {
      console.error(`Test-only Linux uninstall: ${actions.redactDiagnostic(error.message)}`); cleanupFailed = true; process.exitCode = 1;
    });
  }
  // Keep a failed cleanup scope available for repair rather than deleting binaries
  // beneath an owned process or losing the credentials needed to finish reset.
  if (!cleanupFailed) await rm(home, { recursive: true, force: true });
  const employeeStateUntouched = await employeeFingerprint() === employeeBefore;
  const report = { passed: completed && !cleanupFailed && employeeStateUntouched, checks,
    target: `${process.platform}-${process.arch}`, realGateway: true, realCloudflare: true,
    finalLinuxArchiveInstalled: process.platform === 'linux', candidateRuntime: Boolean(values['runtime-root']),
    runtimeManifestSha256, cleanupCompleted: !cleanupFailed,
    testKeys: keys.length, reusableTestKeys: true, employeeStateUntouched, ...(failure ? { failure } : {}) };
  if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
});

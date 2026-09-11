import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { administrator, createAccessKey } from '../client/admin.mjs';
import { control } from '../client/http.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Explicitly opt in: this creates and revokes two test-only keys in the live
// Gateway. Employee credentials/state/tasks are never modified by this test.
const { values } = parseArgs({ options: { live: { type: 'boolean' }, 'runtime-root': { type: 'string' } } });
if (process.platform !== 'win32' || !values.live) {
  throw new Error('Run on Windows with --live to exercise an isolated real Gateway/Tunnel lifecycle');
}
const employeeStatePath = join(process.env.LOCALAPPDATA, 'TeamDevSpace', 'state.json');
const employeeFingerprint = () => readFile(employeeStatePath)
  .then(value => createHash('sha256').update(value).digest('hex'));
const employeeBefore = await employeeFingerprint();
const root = values['runtime-root'] ? resolve(values['runtime-root'])
  : resolve(JSON.parse(await readFile(join(process.env.LOCALAPPDATA, 'TDS', 'active.json'), 'utf8')).path);
const moduleAt = path => import(pathToFileURL(join(root, path)).href);
const setup = await moduleAt('client/setup.mjs');
const lifecycle = await moduleAt('client/platform.mjs');
const actions = await moduleAt('client/control.mjs');
const stateApi = await moduleAt('client/state.mjs');
const config = await administrator();
const home = await mkdtemp(join(tmpdir(), 'tds-tray-live-'));
const project = join(home, 'project');
await mkdir(project);
const suffix = randomUUID().slice(0, 8);
const keys = [];
const checks = [];
let state;
let client;
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
  for (const letter of ['a', 'b']) keys.push(await createAccessKey(config, `tray-live-${suffix}-${letter}`));
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
  await setup.replaceAccessKey(keys[1].accessKey, home); await ready();
  const replaced = await stateApi.loadState(home);
  assert.equal(replaced.deviceId, identity.deviceId);
  assert.equal(replaced.ownerToken, identity.ownerToken);
  assert.equal(replaced.currentProjectRoot, identity.currentProjectRoot);
  assert.equal(replaced.accessKey, keys[1].accessKey);
  assert.notEqual(replaced.bindingId, identity.bindingId);
  await remoteMcp(keys[1].accessKey); passed('replace Access Key retains identity/project root and reconnects with new key');
  assert.equal((await control(config.gateway, '/v1/enrollment/preflight', keys[0].accessKey, { body: {} })).available, true);
  passed('old Key binding released');
  await actions.stopTeamDevSpace(home);
  status = await setup.deviceStatus(home);
  assert.equal(status.devspace || status.bridge || status.tunnel, false);
  passed('exit stops all connection services');
  assert.equal(await employeeFingerprint(), employeeBefore, 'Employee enrollment state changed during an isolated test');
  console.log(JSON.stringify({ passed: true, checks, realGateway: true, realCloudflare: true,
    candidateRuntime: Boolean(values['runtime-root']), employeeStateUntouched: true }));
} catch (error) {
  console.error(JSON.stringify({ passed: false, completedChecks: checks, error: error.message }));
  const text = await readFile(join(home, 'logs', 'runtime.log'), 'utf8').catch(() => '');
  console.error(text.split(/\r?\n/).filter(line => /"event":"(?:paused|listening)"/.test(line)).slice(-6).join('\n'));
  process.exitCode = 1;
} finally {
  await client?.close().catch(() => {});
  const current = await stateApi.loadState(home).catch(() => state);
  if (current) await lifecycle.serviceAction('remove', current, home, lifecycle.COMPONENTS).catch(error => {
    console.error(`Test-only native startup cleanup: ${error.message}`); process.exitCode = 1;
  });
  for (const key of keys) {
    try { await control(config.gateway, `/v1/admin/keys/${key.id}/revoke`, config.adminToken, { body: {}, timeout: 30000 }); }
    catch (error) { console.error(`Test-only key cleanup failed (${key.id}): ${error.code ?? 'unknown'}`); process.exitCode = 1; }
  }
  if (await employeeFingerprint() !== employeeBefore) {
    console.error('Employee state fingerprint changed during verification; inspect before any further operation');
    process.exitCode = 1;
  }
  await rm(home, { recursive: true, force: true });
}

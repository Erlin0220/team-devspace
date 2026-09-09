import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { values } = parseArgs({ options: { bundle: { type: 'string' } } });
const bundle = resolve(values.bundle ?? `build/bundle-${process.platform}-${process.arch}`);
const stateModule = await import(pathToFileURL(join(bundle, 'client', 'state.mjs')));
const platform = await import(pathToFileURL(join(bundle, 'client', 'platform.mjs')));
const { loopbackRequest } = await import(pathToFileURL(join(bundle, 'client', 'http.mjs')));
const home = await mkdtemp(join(tmpdir(), 'team-devspace-native-'));
const project = join(home, 'project');
await mkdir(project);
await writeFile(join(project, 'proof.txt'), 'native-user-session-proof');
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function checkPort(port) {
  try { await loopbackRequest(port, '/healthz', { timeout: 500 }); return true; } catch { return false; }
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
const state = {
  schema: 1, deviceId: randomUUID(), bindingId: randomUUID(), keyId: randomUUID(),
  accessKey: `tds_${stateModule.randomSecret()}`, deviceSecret: stateModule.randomSecret(), ownerToken: stateModule.randomSecret(),
  gateway: 'https://team-devspace-native.invalid', roots: [project],
  ports: { devspace: await freePort(), bridge: await freePort(), metrics: await freePort() },
};
let installed = false;
let client;
try {
  await stateModule.secureStateDirectory(home);
  await stateModule.atomicJson(join(home, 'state.json'), state);
  await stateModule.writeUpstreamConfig(state, home);
  await writeFile(join(home, 'tunnel.token'), 'not-a-live-tunnel-credential', { mode: 0o600 });
  await platform.installServices(state, home);
  installed = true;
  // Native process supervision is real. No tunnel is started and no private files are exposed.
  await platform.serviceAction('start', state, home, ['runtime']);
  await waitForPorts(true);
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
    stopRestartCleanup: true, realCloudflare: false, realChatGPT: false }));
} catch (error) {
  for (const component of ['runtime']) {
    for (const suffix of ['.log', '.error.log']) {
      try { console.error(`${component}${suffix}: ${(await readFile(join(home, 'logs', `${component}${suffix}`), 'utf8')).slice(-3000)}`); } catch {}
    }
    if (process.platform === 'win32') {
      try { console.error(execFileSync(join(process.env.SystemRoot, 'System32', 'schtasks.exe'), ['/Query', '/TN', platform.serviceLabel(state, component), '/V', '/FO', 'LIST'], {encoding:'utf8',windowsHide:true})); } catch {}
    }
  }
  throw error;
} finally {
  await client?.close().catch(() => {});
  if (installed) await platform.serviceAction('remove', state, home).catch(() => {});
  await rm(home, { recursive: true, force: true });
}

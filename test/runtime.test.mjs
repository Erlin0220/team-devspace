import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { randomSecret, atomicJson } from '../client/state.mjs';
import { startUpstream, startBridge, closeService } from '../client/runtime.mjs';
import { LocalOAuth } from '../client/oauth.mjs';

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function resultObject(result) {
  if (result.structuredContent) return result.structuredContent;
  for (const part of result.content ?? []) {
    if (part.type !== 'text') continue;
    try { return JSON.parse(part.text); } catch {}
  }
  throw new Error('No structured tool result');
}

test('unmodified DevSpace: local OAuth, real MCP read/write/shell, roots and bridge protection', { timeout: 120000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'team-devspace-runtime-'));
  const root = join(home, 'project');
  await mkdir(root);
  await writeFile(join(root, 'readme.txt'), 'runtime proof');
  await writeFile(join(home, 'outside.txt'), 'must not be readable through file tools');
  const ports = { devspace: await freePort(), bridge: await freePort(), metrics: await freePort() };
  const state = { schema: 1, deviceId: randomUUID(), bindingId: randomUUID(), keyId: randomUUID(),
    deviceSecret: randomSecret(), ownerToken: randomSecret(), gateway: 'https://team.example.test', currentProjectRoot: root, ports };
  let upstream;
  let bridge;
  let client;
  t.after(async () => {
    await client?.close().catch(() => {});
    if (bridge) await closeService(bridge);
    if (upstream) await closeService(upstream);
    await rm(home, { recursive: true, force: true });
  });
  upstream = await startUpstream(state, home);
  bridge = await startBridge(state, home);
  const endpoint = `http://127.0.0.1:${ports.bridge}`;
  assert.equal((await fetch(`${endpoint}/mcp`)).status, 401);
  const headers = { Authorization: `Bearer ${state.deviceSecret}`, 'X-Team-Binding-Id': state.bindingId };
  assert.equal((await fetch(`${endpoint}/mcp`, { headers: { ...headers, 'X-Team-Binding-Id': randomUUID() } })).status, 403);
  assert.equal((await fetch(`${endpoint}/authorize`, { headers })).status, 404);
  const health = await fetch(`${endpoint}/healthz`, { headers }).then(res => res.json());
  assert.equal(health.deviceId, state.deviceId);

  const auth = new LocalOAuth(state, home);
  const first = await auth.token();
  assert.ok(first.length > 20);
  assert.notEqual(first, state.ownerToken);
  assert.equal(await new LocalOAuth(state, home).token(), first);
  const saved = JSON.parse(await readFile(join(home, 'local-oauth.json'), 'utf8'));
  await atomicJson(join(home, 'local-oauth.json'), { ...saved, expiresAt: 0 });
  assert.notEqual(await new LocalOAuth(state, home).token(), first, 'refresh must issue a new access token');

  client = new Client({ name: 'team-devspace-runtime-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), { requestInit: { headers } }));
  const tools = await client.listTools();
  for (const name of ['open_workspace', 'read', 'write', 'edit', 'bash']) {
    assert.ok(tools.tools.some(tool => tool.name === name), `Missing upstream tool ${name}`);
  }
  const openWorkspaceTool = tools.tools.find(tool => tool.name === 'open_workspace');
  assert.equal(openWorkspaceTool?._meta?.ui, undefined, 'Team DevSpace must not attach the workspace widget');
  const resources = await client.listResources();
  assert.ok(resources.resources.some(resource => resource.uri === 'ui://devspace/workspace-app.html'));
  const widget = await client.readResource({ uri: 'ui://devspace/workspace-app.html' });
  const widgetHtml = widget.contents.find(content => content.uri === 'ui://devspace/workspace-app.html')?.text;
  assert.ok(widgetHtml?.includes('https://team.example.test/mcp-app-assets/'), 'Widget assets must use the public Team gateway');
  assert.ok(!widgetHtml?.includes('127.0.0.1'), 'Widget HTML must not expose a local employee origin');
  const accidentalChild = join(root, 'team-devspace');
  const callerLocalPath = process.platform === 'win32' ? 'Z:\\caller\\different-project' : '/caller/different-project';
  const opened = await client.callTool({ name: 'open_workspace', arguments: { path: callerLocalPath, mode: 'checkout' } });
  assert.ok(!opened.isError, JSON.stringify(opened));
  const openedData = resultObject(opened);
  const workspaceId = openedData.workspaceId ?? openedData.result?.workspaceId;
  const openedRoot = openedData.root ?? openedData.result?.root;
  assert.ok(workspaceId, JSON.stringify(openedData));
  assert.equal(openedRoot, root, 'The Device current project must be authoritative; caller paths are never mapped or selected');
  await assert.rejects(access(accidentalChild), { code: 'ENOENT' });
  const read = await client.callTool({ name: 'read', arguments: { workspaceId, path: 'readme.txt' } });
  assert.ok(JSON.stringify(read).includes('runtime proof'));
  const denied = await client.callTool({ name: 'read', arguments: { workspaceId, path: join(home, 'outside.txt') } });
  assert.equal(denied.isError, true);
  const written = await client.callTool({ name: 'write', arguments: { workspaceId, path: 'created.txt', content: 'written through the authenticated MCP path' } });
  assert.ok(!written.isError);
  assert.equal(await readFile(join(root, 'created.txt'), 'utf8'), 'written through the authenticated MCP path');
  const shell = await client.callTool({ name: 'bash', arguments: { workspaceId, command: 'printf team-devspace-shell-ok', timeout: 10 } });
  assert.ok(!shell.isError && JSON.stringify(shell).includes('team-devspace-shell-ok'), JSON.stringify(shell));
  assert.equal((await fetch(`${endpoint}/update-drain`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${endpoint}/update-drain`, { method: 'GET' })).status, 401);
  assert.equal((await fetch(`${endpoint}/update-drain`, { method: 'GET', headers })).status, 200);
  assert.ok((await client.listTools()).tools.length, 'A readiness probe must not reserve the drain');
  assert.equal((await fetch(`${endpoint}/update-drain`, { method: 'GET', headers: { ...headers, 'X-Team-Update-Mode': 'automatic' } })).status, 409);
  assert.equal((await fetch(`${endpoint}/update-drain`, { method: 'POST', headers: { ...headers, 'X-Team-Update-Mode': 'automatic' } })).status, 409);
  const working = client.callTool({ name: 'bash', arguments: { workspaceId, command: 'sleep 2; printf completed-before-update', timeout: 10 } });
  await sleep(250);
  assert.equal((await fetch(`${endpoint}/update-drain`, { method: 'POST', headers })).status, 409);
  assert.ok(JSON.stringify(await working).includes('completed-before-update'));
  assert.equal((await fetch(`${endpoint}/update-drain`, { method: 'POST', headers })).status, 200);
  const deniedDuringUpdate = await fetch(`${endpoint}/mcp`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'initialize' }) });
  assert.equal(deniedDuringUpdate.status, 503);
  assert.equal(deniedDuringUpdate.headers.get('X-Team-Update-State'), 'installing');
  assert.equal(deniedDuringUpdate.headers.get('Retry-After'), '30');
  assert.equal((await deniedDuringUpdate.json()).error.message, 'client_update_in_progress');
  assert.equal((await fetch(`${endpoint}/update-drain`, { method: 'DELETE', headers })).status, 200);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === 'open_workspace'));
});

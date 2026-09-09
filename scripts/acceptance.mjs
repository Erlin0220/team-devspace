import assert from 'node:assert/strict';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { readJson, normalizeGateway, atomicJson } from '../client/state.mjs';
import { control } from '../client/http.mjs';
import { administrator } from '../client/admin.mjs';

const { values } = parseArgs({ options: {
  device: { type: 'string', multiple: true }, phase: { type: 'string', default: 'online' },
  'admin-config': { type: 'string' }, output: { type: 'string' },
} });
if (!values.device?.length) throw new Error('Use --device <private acceptance-device.json> (twice for online isolation verification)');
const devices = await Promise.all(values.device.map(path => readJson(resolve(path))));
for (const device of devices) {
  device.gateway = normalizeGateway(device.gateway);
  if (new URL(device.gateway).protocol !== 'https:' || !device.accessKey?.startsWith('tds_') ||
      !device.deviceId || !device.bindingId || !device.root || !device.expectedMarker ||
      !device.outsidePath || !device.outsideMarker) throw new Error('Invalid real-device acceptance descriptor');
}
if (new Set(devices.map(device => device.deviceId)).size !== devices.length) throw new Error('Use different enrolled Devices');
if (new Set(devices.map(device => device.gateway)).size !== 1) throw new Error('Devices must use the same gateway');
const results = [];
const clients = [];
function objectResult(result) {
  if (result.isError) throw new Error('MCP tool reported an error');
  if (result.structuredContent) return result.structuredContent;
  return result.content?.filter(item => item.type === 'text').map(item => {
    try { return JSON.parse(item.text); } catch { return null; }
  }).find(item => item?.workspaceId);
}
async function connect(device) {
  const transport = new StreamableHTTPClientTransport(new URL(`${device.gateway}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${device.accessKey}` } },
  });
  const client = new Client({ name: 'team-devspace-acceptance', version: '1.0.0' });
  clients.push(client);
  await client.connect(transport);
  return { client, transport };
}
try {
  if (values.phase === 'online' || values.phase === 'reconnected' || values.phase === 'upgraded') {
    if (devices.length !== 2) throw new Error('Online isolation acceptance requires exactly two Device descriptors');
    assert.equal(new Set(devices.map(device => device.platform)).size, 2, 'Final acceptance requires Windows and macOS, not two processes on the same OS');
    assert.ok(devices.some(device => device.platform === 'win32') && devices.some(device => device.platform === 'darwin'));
    const connected = await Promise.all(devices.map(connect));
    await Promise.all(devices.map(async (device, index) => {
      const { client } = connected[index];
      const listed = await client.listTools();
      assert.ok(listed.tools.some(tool => tool.name === 'read'));
      const opened = objectResult(await client.callTool({ name: 'open_workspace', arguments: { path: device.root, mode: 'checkout' } }));
      const workspaceId = opened.workspaceId ?? opened.result?.workspaceId;
      assert.ok(workspaceId);
      const marker = await client.callTool({ name: 'read', arguments: { workspaceId, path: device.markerPath } });
      assert.ok(!marker.isError && JSON.stringify(marker).includes(device.expectedMarker), 'Response came from the wrong Device or fixture');
      assert.ok(!JSON.stringify(marker).includes(devices[1 - index].expectedMarker), 'Cross-device marker leakage');
      const denied = await client.callTool({ name: 'read', arguments: { workspaceId, path: device.outsidePath } });
      assert.equal(denied.isError, true, 'File-tool access to the known existing outside-root fixture must be rejected');
      assert.ok(!JSON.stringify(denied).includes(device.outsideMarker), 'Outside-root content leaked');
      assert.ok(!/ENOENT|no such file/i.test(JSON.stringify(denied)), 'A missing file is not evidence of directory-boundary enforcement');
      results.push({ deviceId: device.deviceId, platform: device.platform, markerMatches: true, fileRootBoundary: true });
    }));
    for (let index = 0; index < 2; index++) {
      const session = connected[index].transport.sessionId;
      assert.ok(session?.startsWith(`${devices[index].bindingId}.`), 'Missing binding-qualified MCP session');
      const other = devices[1 - index];
      const response = await fetch(`${other.gateway}/mcp`, {
        headers: { Authorization: `Bearer ${other.accessKey}`, 'mcp-session-id': session, Accept: 'text/event-stream' },
        redirect: 'error', signal: AbortSignal.timeout(15000),
      });
      await response.body?.cancel();
      assert.equal(response.status, 404, 'Another employee credential must not reuse this Device session');
    }
    const invalid = await fetch(`${devices[0].gateway}/mcp`, {
      headers: { Authorization: `Bearer tds_${'x'.repeat(43)}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    await invalid.body?.cancel();
    assert.equal(invalid.status, 401);
  } else if (values.phase === 'offline') {
    const device = devices[0];
    const response = await fetch(`${device.gateway}/mcp`, {
      headers: { Authorization: `Bearer ${device.accessKey}` }, redirect: 'error', signal: AbortSignal.timeout(30000),
    });
    await response.body?.cancel();
    assert.equal(response.status, 503, 'The deliberately stopped target must be unavailable, not rerouted');
    results.push({ deviceId: device.deviceId, offlineReturns503: true });
  } else if (values.phase === 'revoke') {
    if (!values['admin-config'] || devices.length !== 1) throw new Error('Revocation is destructive: provide exactly one disposable Device and --admin-config');
    const device = devices[0];
    const admin = await administrator(values['admin-config']);
    assert.equal(admin.gateway, device.gateway);
    await connect(device); // Prove an already connected key is disabled, not only a fresh request.
    const revoked = await control(admin.gateway, `/v1/admin/keys/${device.keyId}/revoke`, admin.adminToken, { body: {} });
    assert.equal(revoked.cleanup, 'complete');
    const response = await fetch(`${device.gateway}/mcp`, {
      headers: { Authorization: `Bearer ${device.accessKey}` }, redirect: 'error', signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    assert.equal(response.status, 401);
    results.push({ deviceId: device.deviceId, revoked: true, connectivityCleanup: true });
  } else throw new Error('Use phase online, offline, reconnected, upgraded, or revoke');
  const report = { passed: true, phase: values.phase, evidenceScope: 'real-remote-mcp-client',
    realChatGPT: false, requiresSeparateChatGPTEvidence: true,
    installerUpgradeVerified: false, results, timestamp: new Date().toISOString() };
  if (values.output) await atomicJson(resolve(values.output), report);
  console.log(JSON.stringify(report, null, 2));
} finally { await Promise.all(clients.map(client => client.close().catch(() => {}))); }

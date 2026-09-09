import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { reconcileCleanup, requestOperation } from '../gateway/index.mjs';

const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const adminToken = secret();
  const tunnels = new Map();
  const records = new Map();
  const forwarded = [];
  const apiTrace = [];
  const switches = { offline: false, cleanupFailure: false, configureFailure: false };
  const envelope = (result, status = 200) => Response.json({ success: status < 400, result, errors: [] }, { status });
  const mf = new Miniflare({
    modules: true, scriptPath: resolve('gateway/index.mjs'), compatibilityDate: '2026-06-01',
    d1Databases: { DB: 'team-devspace-test' }, log: new Log(LogLevel.ERROR),
    serviceBindings: { ASSETS: async request => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/mcp-app-assets/test.js') {
        return new Response('export const fixture = true;', { headers: { 'Content-Type': 'text/javascript' } });
      }
      if (pathname === '/admin/assets/admin.js') {
        return new Response('export const admin = true;', { headers: { 'Content-Type': 'text/javascript' } });
      }
      return new Response('Not found', { status: 404 });
    } },
    bindings: { ADMIN_TOKEN: adminToken, MASTER_KEY: secret(), CF_API_TOKEN: secret(),
      CF_ACCOUNT_ID: 'a'.repeat(32), CF_ZONE_ID: 'b'.repeat(32), DEVICE_DOMAIN: 'example.test',
      PUBLIC_ORIGIN: 'https://team.example.test', RELEASE_VERSION: '0.1.0', DEVSPACE_VERSION: '1.0.8' },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname !== 'api.cloudflare.com') {
        if (switches.offline) return new Response('tunnel offline', { status: 530 });
        const tunnel = [...tunnels.values()].find(item => item.config?.ingress[0]?.hostname === url.hostname);
        if (!tunnel) return new Response('not found', { status: 530 });
        const body = request.method === 'POST' ? await request.text() : '';
        forwarded.push({ host: url.hostname, authorization: request.headers.get('Authorization'),
          bindingId: request.headers.get('X-Team-Binding-Id'), session: request.headers.get('mcp-session-id'), body });
        return Response.json({ jsonrpc: '2.0', id: 1, result: { origin: url.hostname } },
          { headers: { 'mcp-session-id': 'upstream-session', 'set-cookie': 'must-not-leak=1' } });
      }
      const path = url.pathname.replace('/client/v4', '');
      apiTrace.push(`${request.method} ${path}`);
      const body = ['POST', 'PUT', 'PATCH'].includes(request.method) ? await request.json() : null;
      if (path.endsWith('/cfd_tunnel')) {
        if (request.method === 'GET') return envelope([...tunnels.values()].filter(item => item.name === url.searchParams.get('name')));
        if ([...tunnels.values()].some(item => item.name === body.name)) return envelope(null, 409);
        const tunnel = { id: randomUUID(), name: body.name, config: null };
        tunnels.set(tunnel.id, tunnel);
        return envelope(tunnel);
      }
      const tunnelMatch = /\/cfd_tunnel\/([^/]+)(?:\/(.+))?$/.exec(path);
      if (tunnelMatch) {
        const [, id, operation] = tunnelMatch;
        const tunnel = tunnels.get(id);
        if (!tunnel) return envelope(null, 404);
        if (request.method === 'GET' && !operation) return envelope(tunnel);
        if (request.method === 'PATCH' && !operation) {
          assert.equal(Buffer.from(body.tunnel_secret, 'base64').length, 32);
          tunnel.retired = true;
          return envelope(tunnel);
        }
        if (operation === 'token') return envelope(`test-tunnel-token-${id}`);
        if (switches.cleanupFailure && (request.method === 'DELETE' || body?.config?.ingress[0]?.service === 'http_status:410')) return envelope(null, 503);
        if (operation === 'configurations') {
          if (switches.configureFailure) return envelope(null, 503);
          tunnel.config = body.config;
          return envelope({ config: body.config });
        }
        if (operation === 'connections' && request.method === 'DELETE') {
          assert.equal(tunnel.retired, true, 'Rotate a tunnel token before disconnecting its connectors');
          return envelope({});
        }
        if (!operation && request.method === 'DELETE') { tunnels.delete(id); return envelope({}); }
      }
      if (path.endsWith('/dns_records')) {
        if (request.method === 'GET') return envelope([...records.values()].filter(item => item.name === url.searchParams.get('name')));
        const record = { ...body, id: randomUUID() };
        records.set(record.id, record);
        return envelope(record);
      }
      const dns = /\/dns_records\/([^/]+)$/.exec(path);
      if (dns && request.method === 'DELETE') { records.delete(dns[1]); return envelope({}); }
      throw new Error(`Unexpected test network operation: ${request.method} ${path}`);
    },
  });
  t.after(() => mf.dispose());
  const db = await mf.getD1Database('DB');
  for (const migration of (await readdir('migrations')).filter(name => name.endsWith('.sql')).sort()) {
    await db.exec((await readFile(`migrations/${migration}`, 'utf8')).replaceAll('\n', ' '));
  }
  async function request(path, token, body, extra = {}) {
    return mf.dispatchFetch(`https://team.example.test${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...extra.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...extra,
    });
  }
  async function issue(label) {
    const accessKey = `tds_${secret()}`;
    const id = randomUUID();
    const response = await request('/v1/admin/keys', adminToken, { id, label, keyHash: hash(accessKey) });
    assert.equal(response.status, 201);
    return { id, accessKey };
  }
  function device() { return { deviceId: randomUUID(), deviceSecret: secret(), bridgePort: 47671 }; }
  return { mf, db, request, issue, device, adminToken, tunnels, records, forwarded, apiTrace, switches };
}

test('one Worker serves health and public assets with consistent headers without weakening control routes', async t => {
  const f = await fixture(t);
  const health = await f.mf.dispatchFetch('https://team.example.test/health');
  assert.equal(health.status, 200);
  assert.ok(health.headers.get('X-Request-Id'));
  assert.equal(health.headers.get('X-Team-Release'), '0.1.0');
  const asset = await f.mf.dispatchFetch('https://team.example.test/mcp-app-assets/test.js?v=1');
  assert.equal(await asset.text(), 'export const fixture = true;');
  assert.equal(asset.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(asset.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
  assert.equal(asset.headers.get('X-Team-Release'), '0.1.0');
  assert.ok(asset.headers.get('X-Request-Id'));
  for (const [method, status] of [['HEAD', 200], ['OPTIONS', 204], ['POST', 405]]) {
    const response = await f.mf.dispatchFetch('https://team.example.test/mcp-app-assets/test.js', { method });
    assert.equal(response.status, status);
    if (method === 'HEAD') assert.equal(await response.text(), '');
  }
  assert.equal((await f.mf.dispatchFetch('https://team.example.test/mcp?key=secret')).status, 400);
  assert.equal((await f.mf.dispatchFetch('https://team.example.test/v1/admin/keys')).status, 401);
  assert.equal(requestOperation('POST', `/v1/admin/keys/${randomUUID()}/revoke`), 'admin_revoke');
  assert.equal(requestOperation('POST', '/private-user-content'), 'not_found');
});

test('gateway authorizes real D1 bindings, isolates devices and namespaces MCP sessions', async t => {
  const f = await fixture(t);
  const a = await f.issue('Employee A');
  const b = await f.issue('Employee B');
  const da = f.device(); const db = f.device();
  const enrollmentA = await f.request('/v1/enroll', a.accessKey, da).then(res => res.json());
  const enrollmentB = await f.request('/v1/enroll', b.accessKey, db).then(res => res.json());
  assert.ok(enrollmentA.tunnelToken, JSON.stringify({ enrollmentA, apiTrace: f.apiTrace }));
  assert.notEqual(enrollmentA.hostname, enrollmentB.hostname);
  assert.equal(f.tunnels.size, 2);
  assert.equal((await f.request('/v1/enroll', a.accessKey, { ...da, deviceSecret: secret() })).status, 409);
  assert.equal((await f.request('/v1/enroll', a.accessKey, f.device())).status, 409);
  const [ra, rb] = await Promise.all([
    f.request('/mcp', a.accessKey, { jsonrpc: '2.0', id: 1, method: 'initialize', deviceId: db.deviceId }),
    f.request('/mcp', b.accessKey, { jsonrpc: '2.0', id: 2, method: 'initialize' }),
  ]);
  assert.equal(ra.status, 200); assert.equal(rb.status, 200);
  assert.equal((await ra.json()).result.origin, enrollmentA.hostname);
  assert.equal((await rb.json()).result.origin, enrollmentB.hostname);
  assert.equal(ra.headers.get('set-cookie'), null);
  const sessionA = ra.headers.get('mcp-session-id');
  assert.equal(sessionA, `${enrollmentA.bindingId}.upstream-session`);
  assert.equal(f.forwarded.find(item => item.host === enrollmentA.hostname).authorization, `Bearer ${da.deviceSecret}`);
  assert.ok(f.forwarded.every(item => !item.authorization.includes(a.accessKey) && !item.authorization.includes(b.accessKey)));
  const foreign = await f.mf.dispatchFetch('https://team.example.test/mcp', {
    headers: { Authorization: `Bearer ${b.accessKey}`, 'mcp-session-id': sessionA },
  });
  assert.equal(foreign.status, 404);
  const valid = await f.mf.dispatchFetch('https://team.example.test/mcp', {
    headers: { Authorization: `Bearer ${a.accessKey}`, 'mcp-session-id': sessionA },
  });
  assert.equal(valid.status, 200);
  assert.equal(f.forwarded.at(-1).session, 'upstream-session');
  const stored = await f.db.prepare('SELECT * FROM access_keys WHERE id = ?').bind(a.id).first();
  assert.equal(stored.key_hash, hash(a.accessKey));
  assert.ok(!JSON.stringify(stored).includes(a.accessKey));
  assert.ok(!JSON.stringify(stored).includes(da.deviceSecret));
});

test('Device suspend is fail-closed before local stop and resume waits for the existing Tunnel health', async t => {
  const f = await fixture(t);
  const key = await f.issue('Suspend Device');
  const device = f.device();
  const enrollment = await f.request('/v1/enroll', key.accessKey, device).then(response => response.json());
  const identity = { keyId: key.id, bindingId: enrollment.bindingId };
  for (let attempt = 0; attempt < 2; attempt++) {
    const suspended = await f.request('/v1/device/suspend', device.deviceSecret, identity);
    assert.equal(suspended.status, 200);
    assert.equal((await suspended.json()).state, 'suspended');
  }
  const denied = await f.request('/mcp', key.accessKey, { jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.message, 'remote_access_suspended');
  const status = await f.request('/v1/device/status', device.deviceSecret, identity);
  assert.equal((await status.json()).state, 'suspended');
  assert.equal((await f.request('/v1/device/resume', secret(), identity)).status, 403);
  for (let attempt = 0; attempt < 2; attempt++) {
    const resumed = await f.request('/v1/device/resume', device.deviceSecret, identity);
    assert.equal(resumed.status, 200);
    assert.equal((await resumed.json()).state, 'active');
  }
  assert.equal((await f.request('/mcp', key.accessKey, { jsonrpc: '2.0', id: 2, method: 'initialize' })).status, 200);
});

test('Admin Web is Access-gated and its assets stay inside /admin/assets/*', async t => {
  const f = await fixture(t);
  assert.equal((await f.mf.dispatchFetch('https://team.example.test/admin')).status, 403);
  const access = { 'Cf-Access-Authenticated-User-Email': 'admin@example.test',
    'Cf-Access-Jwt-Assertion': 'signed-access-assertion' };
  const page = await f.mf.dispatchFetch('https://team.example.test/admin', { headers: access });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('Team DevSpace Admin'));
  const asset = await f.mf.dispatchFetch('https://team.example.test/admin/assets/admin.js', { headers: access });
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'export const admin = true;');
  assert.equal((await f.mf.dispatchFetch('https://team.example.test/admin.js', { headers: access })).status, 404);
});

test('simultaneous enrollment binds a key once; repeat setup is idempotent', async t => {
  const f = await fixture(t);
  const key = await f.issue('Concurrent');
  const a = f.device(); const b = f.device();
  const responses = await Promise.all([f.request('/v1/enroll', key.accessKey, a), f.request('/v1/enroll', key.accessKey, b)]);
  assert.deepEqual(responses.map(res => res.status).sort(), [200, 409]);
  const index = responses.findIndex(res => res.status === 200);
  const winner = index === 0 ? a : b;
  const result = await responses[index].json();
  const retried = await f.request('/v1/enroll', key.accessKey, winner).then(res => res.json());
  assert.equal(retried.bindingId, result.bindingId);
  assert.equal(retried.tunnelToken, result.tunnelToken);
  assert.equal(f.tunnels.size, 1); assert.equal(f.records.size, 1);
});

test('partial Cloudflare provisioning can be repaired without a duplicate tunnel', async t => {
  const f = await fixture(t);
  const key = await f.issue('Repair'); const device = f.device();
  f.switches.configureFailure = true;
  assert.equal((await f.request('/v1/enroll', key.accessKey, device)).status, 503);
  assert.equal((await f.request('/mcp', key.accessKey)).status, 503);
  f.switches.configureFailure = false;
  assert.equal((await f.request('/v1/enroll', key.accessKey, device)).status, 200);
  assert.equal(f.tunnels.size, 1);
});

test('offline is explicit; revoke fails closed even when cloud cleanup fails and retry finishes it', async t => {
  const f = await fixture(t);
  const key = await f.issue('Revoke'); const device = f.device();
  const binding = await f.request('/v1/enroll', key.accessKey, device).then(res => res.json());
  f.switches.offline = true;
  const offline = await f.request('/mcp', key.accessKey);
  assert.equal(offline.status, 503);
  assert.equal((await offline.json()).error.message, 'device_offline');
  f.switches.offline = false;
  f.switches.cleanupFailure = true;
  const failed = await f.request(`/v1/admin/keys/${key.id}/revoke`, f.adminToken, {});
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).cleanup, 'pending');
  assert.equal((await f.request('/mcp', key.accessKey)).status, 401);
  assert.equal((await f.request('/v1/device/status', device.deviceSecret, { keyId: key.id, bindingId: binding.bindingId })).status, 403);
  f.switches.cleanupFailure = false;
  assert.equal((await f.request(`/v1/admin/keys/${key.id}/revoke`, f.adminToken, {})).status, 200);
  assert.equal(f.tunnels.size, 0); assert.equal(f.records.size, 0);
  assert.equal((await f.request(`/v1/admin/keys/${key.id}/reset`, f.adminToken, {})).status, 409);
  const listed = await f.request('/v1/admin/keys', f.adminToken).then(res => res.json());
  assert.ok(!JSON.stringify(listed).includes(device.deviceSecret));
});

test('scheduled cleanup reconciles pending and stale provisioning without an administrator retry', async () => {
  const removed = [];
  const finished = [];
  const rows = [
    { id: 'pending', state: 'resetting', binding_id: 'binding-pending' },
    { id: 'stale', state: 'provisioning', binding_id: 'binding-stale' },
  ];
  const store = {
    cleanupCandidates: async () => rows,
    disable: async (id, operation) => ({ ...rows.find(row => row.id === id), state: 'resetting', operation }),
    finishCleanup: async (id, bindingId, operation) => { finished.push({ id, bindingId, operation }); return true; },
  };
  const cloud = { remove: async row => { removed.push(row.id); } };
  await reconcileCleanup({}, { store, cloud });
  assert.deepEqual(removed, ['pending', 'stale']);
  assert.deepEqual(finished.map(item => item.operation), ['reset', 'reset']);
});

test('reset invalidates the old Device Binding and session before a replacement enrolls', async t => {
  const f = await fixture(t);
  const key = await f.issue('Replacement');
  const old = await f.request('/v1/enroll', key.accessKey, f.device()).then(res => res.json());
  assert.equal((await f.request(`/v1/admin/keys/${key.id}/reset`, f.adminToken, {})).status, 200);
  const replacement = await f.request('/v1/enroll', key.accessKey, f.device()).then(res => res.json());
  assert.notEqual(replacement.bindingId, old.bindingId);
  assert.equal(f.tunnels.size, 1);
  const stale = await f.mf.dispatchFetch('https://team.example.test/mcp', {
    headers: { Authorization: `Bearer ${key.accessKey}`, 'mcp-session-id': `${old.bindingId}.upstream-session` },
  });
  assert.equal(stale.status, 404);
});

test('control routes reject invalid credentials and oversized/invalid enrollment', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/v1/admin/keys', secret())).status, 401);
  const key = await f.issue('Validation');
  assert.equal((await f.request('/v1/admin/keys', key.accessKey)).status, 401);
  assert.equal((await f.request('/v1/enroll', key.accessKey, { ...f.device(), bridgePort: 80 })).status, 400);
  assert.equal((await f.request('/v1/enroll', key.accessKey, { padding: 'x'.repeat(17000) })).status, 413);
  assert.equal((await f.request('/mcp?key=secret', key.accessKey)).status, 400);
  assert.equal((await f.mf.dispatchFetch('https://team.example.test/mcp')).status, 401);
});

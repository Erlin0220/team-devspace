import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { reconcileCleanup, requestOperation } from '../gateway/index.mjs';
import { KeyStore } from '../gateway/store.mjs';
import release from '../release.config.json' with { type: 'json' };
import { signUpdateFixture, updateTestCatalog, updateTestPublicKey } from './update-fixture.mjs';

const gatewayScript = (await build({ entryPoints: [resolve('gateway/index.mjs')], bundle: true,
  format: 'esm', platform: 'browser', write: false, sourcemap: false,
  // Inject an ephemeral key into the TEST bundle only; production has no key override API.
  plugins: [{ name: 'test-release-key', setup(builder) {
    builder.onLoad({ filter: /release\.config\.json$/ }, () => ({ loader: 'json', contents: JSON.stringify({ ...release,
      distribution: { ...release.distribution, updatePublicKey: updateTestPublicKey } }) }));
  } }] })).outputFiles[0].text;

const ACCESS_ISSUER = 'https://access.example.test';
const ACCESS_AUD = 'team-devspace-admin-test';
const { publicKey: accessPublicKey, privateKey: accessPrivateKey } = await generateKeyPair('RS256');
const ACCESS_JWK = { ...await exportJWK(accessPublicKey), kid: 'test-access-key', alg: 'RS256', use: 'sig' };

async function accessHeaders() {
  const token = await new SignJWT({ email: 'admin@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: ACCESS_JWK.kid })
    .setIssuer(ACCESS_ISSUER).setAudience(ACCESS_AUD).setIssuedAt().setExpirationTime('5m').sign(accessPrivateKey);
  return { 'Cf-Access-Jwt-Assertion': token };
}

const secret = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, { inventoryMigration = true } = {}) {
  const adminToken = secret();
  const tunnels = new Map();
  const records = new Map();
  const forwarded = [];
  const apiTrace = [];
  const metadataTrace = [];
  const switches = { offline: false, cleanupFailure: false, configureFailure: false };
  const envelope = (result, status = 200) => Response.json({ success: status < 400, result, errors: [] }, { status });
  const mf = new Miniflare({
    modules: true, script: gatewayScript, compatibilityDate: '2026-06-01',
    d1Databases: { DB: 'team-devspace-test' }, log: new Log(LogLevel.ERROR),
    serviceBindings: { ASSETS: async request => {
      const pathname = new URL(request.url).pathname;
      if (pathname === '/mcp-app-assets/test.js') {
        return new Response('export const fixture = true;', { headers: { 'Content-Type': 'text/javascript' } });
      }
      if (pathname === '/admin/admin.js') {
        return new Response('export const admin = true;', { headers: { 'Content-Type': 'text/javascript' } });
      }
      return new Response('Not found', { status: 404 });
    } },
    bindings: { ADMIN_TOKEN: adminToken, MASTER_KEY: secret(), CF_API_TOKEN: secret(),
      CF_ACCOUNT_ID: 'a'.repeat(32), CF_ZONE_ID: 'b'.repeat(32), DEVICE_DOMAIN: 'example.test',
      PUBLIC_ORIGIN: 'https://team.example.test', RELEASE_VERSION: '0.1.0', DEVSPACE_VERSION: '1.0.8', CONTROL_API_VERSION: '1',
      ACCESS_TEAM_DOMAIN: ACCESS_ISSUER, ACCESS_AUD },
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.origin === release.distribution.origin) {
        metadataTrace.push(url.pathname);
        if (url.pathname === '/update.json') {
          if (switches.missingStableSignature) return new Response('not found', { status: 404 });
          const signed = await signUpdateFixture(updateTestCatalog(switches.stableVersion ?? '0.2.5'));
          if (switches.holdStable && metadataTrace.filter(path => path === '/update.json').length === 1) {
            switches.holdStable.started(); await switches.holdStable.release;
          }
          if (switches.invalidStableSignature) signed.signature = 'a'.repeat(86);
          return Response.json(signed);
        }
        if (url.pathname === '/catalog.json') return Response.json(updateTestCatalog(switches.legacyStable ? '0.2.3' : '0.2.5'));
        if (url.pathname === '/releases.json') return Response.json({ schema: 1, versions: ['0.2.5', '0.2.4'] });
        const version = /^\/releases\/(0\.2\.[456])\/update\.json$/.exec(url.pathname)?.[1];
        if (!version || switches.unsignedUpdate) return new Response('not found', { status: 404 });
        const signed = await signUpdateFixture(updateTestCatalog(version));
        if (switches.invalidUpdateSignature) signed.signature = 'a'.repeat(86);
        return Response.json(signed);
      }
      if (url.origin === ACCESS_ISSUER && url.pathname === '/cdn-cgi/access/certs') return Response.json({ keys: [ACCESS_JWK] });
      if (url.hostname !== 'api.cloudflare.com') {
        if (switches.offline) return new Response('tunnel offline', { status: 530 });
        const tunnel = [...tunnels.values()].find(item => item.config?.ingress[0]?.hostname === url.hostname);
        if (!tunnel) return new Response('not found', { status: 530 });
        if (switches.updating) return new Response('untrusted diagnostic body', { status: 503,
          headers: { 'X-Team-Update-State': 'installing', 'Retry-After': '999999999', 'Set-Cookie': 'must-not-leak=1' } });
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
    if (!inventoryMigration && migration === '0005_update_inventory.sql') continue;
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
  return { mf, db, request, issue, device, adminToken, tunnels, records, forwarded, apiTrace, metadataTrace, switches, accessHeaders };
}

test('stable discovery verifies signatures, coalesces reads, and permits only legacy unsigned manual recovery', async t => {
  const f = await fixture(t);
  const responses = await Promise.all(Array.from({ length: 5 }, () => f.mf.dispatchFetch('https://team.example.test/v1/update-policy')));
  for (const response of responses) { assert.equal(response.status, 200); assert.equal((await response.json()).stable, '0.2.5'); }
  assert.equal(f.metadataTrace.filter(path => path === '/update.json').length, 1);
  assert.equal(f.metadataTrace.includes('/catalog.json'), false);
  const bad = await fixture(t);
  bad.switches.invalidStableSignature = true;
  assert.equal((await bad.mf.dispatchFetch('https://team.example.test/v1/update-policy')).status, 503);
  bad.switches.invalidStableSignature = false; bad.switches.missingStableSignature = true;
  assert.equal((await bad.mf.dispatchFetch('https://team.example.test/v1/update-policy')).status, 503);
  assert.equal(bad.metadataTrace.filter(path => path === '/update.json').length, 1,
    'A failing anonymous discovery must not hammer the metadata origin');
  const old = await fixture(t);
  old.switches.missingStableSignature = true; old.switches.legacyStable = true;
  const legacy = await old.mf.dispatchFetch('https://team.example.test/v1/update-policy');
  assert.equal(legacy.status, 200); assert.equal((await legacy.json()).stable, '0.2.3');
});

test('authenticated update drain is not misreported as offline and cannot leak upstream diagnostics', async t => {
  const f = await fixture(t), key = await f.issue('Updating device');
  await f.request('/v1/enroll', key.accessKey, f.device());
  f.switches.updating = true;
  const updating = await f.request('/mcp', key.accessKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.equal(updating.status, 503);
  assert.equal(updating.headers.get('Retry-After'), '30');
  assert.equal(updating.headers.has('Set-Cookie'), false);
  assert.equal(updating.headers.has('X-Team-Update-State'), false);
  const body = await updating.json(); assert.equal(body.error.message, 'client_update_in_progress');
  assert.equal(JSON.stringify(body).includes('untrusted'), false);
  f.switches.updating = false; f.switches.offline = true;
  const offline = await f.request('/mcp', key.accessKey, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal((await offline.json()).error.message, 'device_offline');
  assert.equal(offline.headers.has('Retry-After'), false);
});

test('a slow stable read cannot repopulate stale discovery after a fresh administrator approval', async t => {
  const f = await fixture(t); let started, release;
  const entered = new Promise(resolve => { started = resolve; });
  f.switches.holdStable = { started, release: new Promise(resolve => { release = resolve; }) };
  const oldRead = f.mf.dispatchFetch('https://team.example.test/v1/update-policy');
  await entered;
  try {
    f.switches.stableVersion = '0.2.6';
    const saved = await f.request('/v1/admin/update-policy', f.adminToken,
      { auto: '0.2.6', minimumSupported: null, enforceAfter: null, revision: 0 });
    assert.equal(saved.status, 200);
  } finally { release(); await oldRead; }
  const latest = await f.mf.dispatchFetch('https://team.example.test/v1/update-policy');
  assert.equal(latest.status, 200); const value = await latest.json();
  assert.equal(value.stable, '0.2.6'); assert.equal(value.auto, '0.2.6');
});

test('update inventory is additive, binding-scoped, privacy-bounded and deduplicates unchanged snapshots', async t => {
  const f = await fixture(t), key = await f.issue('Update inventory'), device = f.device();
  const binding = await f.request('/v1/enroll', key.accessKey, device).then(response => response.json());
  const body = { keyId: key.id, bindingId: binding.bindingId, version: '0.2.5', platform: 'win32-x64',
    updateReport: { targetVersion: '0.2.6', status: 'deferred', code: 'remote_work_active' } };
  assert.equal((await f.request('/v1/device/version', device.deviceSecret, body)).status, 200);
  const store = new KeyStore(f.db);
  assert.equal((await store.reportVersion(key.id, binding.bindingId, '0.2.5', 'win32-x64', body.updateReport)).meta.changes, 0);
  // Older clients and resume/enroll inventory calls do not erase new snapshot fields.
  await store.reportVersion(key.id, binding.bindingId, '0.2.5', 'win32-x64');
  const listed = await f.request('/v1/admin/keys', f.adminToken).then(response => response.json());
  assert.deepEqual(listed.keys[0].updateReport, body.updateReport);
  await store.reportVersion(key.id, binding.bindingId, '0.2.6', 'win32-x64');
  assert.equal((await store.byId(key.id)).update_report, null,
    'A new running version without a report must not inherit an older version outcome');
  assert.equal((await f.request('/v1/device/version', device.deviceSecret, { ...body,
    updateReport: { ...body.updateReport, logs: 'private log' } })).status, 400);
  assert.equal((await f.request('/v1/device/version', secret(), body)).status, 403);
  await f.request(`/v1/admin/keys/${key.id}/reset`, f.adminToken, {});
  assert.equal((await store.byId(key.id)).update_report, null);
  assert.equal((await f.request('/v1/device/version', device.deviceSecret, body)).status, 403);
});

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
  assert.equal(requestOperation('POST', '/v1/enrollment/preflight'), 'enrollment_preflight');
  assert.equal(requestOperation('POST', '/v1/device/release'), 'device_release');
  assert.equal(requestOperation('POST', '/private-user-content'), 'not_found');
});

test('Contract removes legacy status while status-v2 stays authenticated across pause, minimum support and rebinding', async t => {
  const f = await fixture(t), key = await f.issue('Status contract'), device = f.device();
  const binding = await f.request('/v1/enroll', key.accessKey, device).then(response => response.json());
  const identity = { keyId: key.id, bindingId: binding.bindingId };
  assert.equal(requestOperation('POST', '/v1/device/status'), 'not_found');
  assert.equal((await f.request('/v1/device/status', device.deviceSecret, identity)).status, 404);
  const route = '/v1/device/status-v2';
  const policy = { auto: '0.2.5', minimumSupported: '0.2.4',
    enforceAfter: new Date(Date.now() - 1000).toISOString(), revision: 0 };
  assert.equal((await f.request('/v1/admin/update-policy', f.adminToken, policy)).status, 200);
  assert.equal((await f.request('/mcp', key.accessKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 426);
  for (const state of ['active', 'suspended']) {
    if (state === 'suspended') await f.request('/v1/device/suspend', device.deviceSecret, identity);
    const response = await f.request(route, device.deviceSecret, identity);
    assert.equal(response.status, 200, route);
    assert.deepEqual(await response.json(), { state, deviceId: device.deviceId, bindingId: binding.bindingId });
    assert.equal((await f.request(route, secret(), identity)).status, 403);
    assert.equal((await f.request(route, device.deviceSecret, { ...identity, bindingId: randomUUID() })).status, 403);
  }
  await f.request(`/v1/admin/keys/${key.id}/reset`, f.adminToken, {});
  const replacementDevice = f.device();
  const replacement = await f.request('/v1/enroll', key.accessKey, replacementDevice).then(response => response.json());
  assert.equal((await f.request(route, device.deviceSecret, identity)).status, 403);
  assert.equal((await f.request(route, replacementDevice.deviceSecret,
    { keyId: key.id, bindingId: replacement.bindingId })).status, 200);
  await f.request(`/v1/admin/keys/${key.id}/revoke`, f.adminToken, {});
  assert.equal((await f.request(route, replacementDevice.deviceSecret,
    { keyId: key.id, bindingId: replacement.bindingId })).status, 403);
});

test('inventory schema expansion preserves an existing binding and legacy version writes', async t => {
  const f = await fixture(t, { inventoryMigration: false }), key = await f.issue('Existing binding'), device = f.device();
  const binding = await f.request('/v1/enroll', key.accessKey, device).then(response => response.json());
  const legacyWrite = () => f.db.prepare(`UPDATE access_keys SET client_version = ?, client_platform = ?,
    version_reported_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND binding_id = ?`)
    .bind('0.2.4', 'win32-x64', key.id, binding.bindingId).run();
  await legacyWrite();
  const before = await f.db.prepare('SELECT * FROM access_keys WHERE id = ?').bind(key.id).first();
  assert.equal(Object.hasOwn(before, 'update_report'), false);
  await f.db.exec((await readFile('migrations/0005_update_inventory.sql', 'utf8')).replaceAll('\n', ' '));
  const store = new KeyStore(f.db), after = await store.byId(key.id);
  assert.deepEqual(after, { ...before, update_report: null });
  assert.equal((await legacyWrite()).meta.changes, 1, 'An old Worker remains usable after the additive migration');
  assert.equal((await f.request('/mcp', key.accessKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 200);
  const updateReport = { targetVersion: '0.2.5', status: 'deferred', code: 'remote_work_active' };
  assert.equal((await f.request('/v1/device/version', device.deviceSecret, {
    keyId: key.id, bindingId: binding.bindingId, version: '0.2.4', platform: 'win32-x64', updateReport,
  })).status, 200);
  assert.equal((await store.byId(key.id)).binding_id, before.binding_id);
  assert.equal(f.tunnels.size, 1);
  const policy = await store.updatePolicy();
  assert.equal(policy.auto_version, null); assert.equal(policy.minimum_supported, null);
});

test('cleanup uses the partial indexes instead of scanning retained revoked history', async t => {
  const f = await fixture(t);
  await f.db.prepare(`WITH RECURSIVE history(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM history WHERE n<2000)
    INSERT INTO access_keys(id,label,key_hash,state) SELECT 'history-'||n,'history-'||n,'hash-'||n,'revoked' FROM history`).run();
  const queries = [];
  const store = new KeyStore({ prepare(sql) {
    return { bind(...values) { queries.push({ sql, values }); return f.db.prepare(sql).bind(...values); } };
  } });
  assert.deepEqual(await store.cleanupCandidates(), []);
  assert.equal(queries.length, 2);
  for (const { sql, values } of queries) {
    const index = sql.includes('cleanup_pending') ? 'idx_access_keys_cleanup_pending_updated_at'
      : 'idx_access_keys_provisioning_updated_at';
    const plan = await f.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...values).all();
    assert.ok(plan.results.some(row => row.detail.includes(index)), JSON.stringify(plan.results));
    const result = await f.db.prepare(sql).bind(...values).all();
    assert.equal(result.results.length, 0);
    assert.ok(result.meta.rows_read < 10, JSON.stringify(result.meta));
  }
});

test('revoked history can be deleted only after cleanup and deleting it releases the label', async t => {
  const f = await fixture(t);
  const key = await f.issue('Reusable label');
  assert.equal((await f.request(`/v1/admin/keys/${key.id}`, f.adminToken, undefined, { method: 'DELETE' })).status, 409);
  assert.equal((await f.request(`/v1/admin/keys/${key.id}/revoke`, f.adminToken, {})).status, 200);
  const archived = await f.request('/v1/admin/keys', f.adminToken).then(response => response.json());
  const archivedKey = archived.keys.find(item => item.id === key.id);
  assert.ok(archivedKey.createdAt);
  assert.ok(archivedKey.revokedAt);
  assert.ok(archivedKey.cleanupCompletedAt);
  assert.ok(new Date(archivedKey.createdAt) <= new Date(archivedKey.revokedAt));
  assert.ok(new Date(archivedKey.revokedAt) <= new Date(archivedKey.cleanupCompletedAt));
  const removed = await f.request(`/v1/admin/keys/${key.id}`, f.adminToken, undefined, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { deleted: key.id });
  assert.equal(await f.db.prepare('SELECT * FROM access_keys WHERE id = ?').bind(key.id).first(), null);
  const events = await f.db.prepare(`SELECT event, label FROM access_key_events
    WHERE key_id = ? ORDER BY id`).bind(key.id).all();
  assert.deepEqual(events.results.map(item => item.event), ['created', 'revoked', 'revoked_cleanup_completed', 'deleted']);
  assert.ok(events.results.every(item => item.label === 'Reusable label'));
  const resurrect = await f.request('/v1/admin/keys', f.adminToken, {
    id: key.id, label: 'Reusable label', keyHash: hash(key.accessKey),
  });
  assert.equal(resurrect.status, 409);
  assert.equal((await resurrect.json()).error, 'deleted_key_id_cannot_be_reused');
  const replacement = await f.issue('Reusable label');
  assert.notEqual(replacement.id, key.id);

  const a = await f.issue('Old A');
  const b = await f.issue('Old B');
  await f.request(`/v1/admin/keys/${a.id}/revoke`, f.adminToken, {});
  await f.request(`/v1/admin/keys/${b.id}/revoke`, f.adminToken, {});
  const purged = await f.request('/v1/admin/keys/revoked', f.adminToken, undefined, { method: 'DELETE' });
  assert.equal(purged.status, 200);
  assert.equal((await purged.json()).deleted, 2);
  const remaining = await f.request('/v1/admin/keys', f.adminToken).then(response => response.json());
  assert.equal(remaining.keys.some(item => ['Old A', 'Old B'].includes(item.label)), false);
  const deletedEvents = await f.db.prepare(`SELECT label FROM access_key_events
    WHERE event = 'deleted' AND label IN ('Old A', 'Old B') ORDER BY label`).all();
  assert.deepEqual(deletedEvents.results.map(item => item.label), ['Old A', 'Old B']);
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

test('Access Key preflight is side-effect free and a device can release only its own binding', async t => {
  const f = await fixture(t);
  const current = await f.issue('Current Device');
  const replacement = await f.issue('Replacement Device');
  const available = await f.request('/v1/enrollment/preflight', replacement.accessKey, {}).then(response => response.json());
  assert.deepEqual(available, { available: true });
  assert.equal(f.tunnels.size, 0, 'Preflight must not create a Tunnel or bind a device');

  const device = f.device();
  const enrollment = await f.request('/v1/enroll', current.accessKey, device).then(response => response.json());
  const identity = { keyId: current.id, bindingId: enrollment.bindingId };
  assert.deepEqual(await f.request('/v1/enrollment/preflight', current.accessKey, {}).then(response => response.json()),
    { available: false });
  assert.equal((await f.request('/v1/device/release', secret(), identity)).status, 403);

  f.switches.cleanupFailure = true;
  const pending = await f.request('/v1/device/release', device.deviceSecret, identity);
  assert.equal(pending.status, 503);
  assert.equal((await pending.json()).error, 'connectivity_cleanup_pending');
  assert.notEqual((await f.request('/mcp', current.accessKey)).status, 200,
    'Release must deny the old route before cloud cleanup completes');

  f.switches.cleanupFailure = false;
  const released = await f.request('/v1/device/release', device.deviceSecret, identity);
  assert.equal(released.status, 200);
  assert.equal((await released.json()).released, true);
  assert.equal(f.tunnels.size, 0);
  assert.equal(f.records.size, 0);
  assert.deepEqual(await f.request('/v1/enrollment/preflight', current.accessKey, {}).then(response => response.json()),
    { available: true });
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
  const status = await f.request('/v1/device/status-v2', device.deviceSecret, identity);
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
  const fake = await f.mf.dispatchFetch('https://team.example.test/admin', {
    headers: { 'Cf-Access-Jwt-Assertion': 'signed-access-assertion' },
  });
  assert.equal(fake.status, 403);
  const access = await f.accessHeaders();
  const page = await f.mf.dispatchFetch('https://team.example.test/admin', { headers: access });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('Team DevSpace 管理后台'));
  const asset = await f.mf.dispatchFetch('https://team.example.test/admin/assets/admin.js', { headers: access });
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('Content-Type'), 'text/javascript');
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
  assert.equal((await f.request('/v1/device/status-v2', device.deviceSecret, { keyId: key.id, bindingId: binding.bindingId })).status, 403);
  f.switches.cleanupFailure = false;
  assert.equal((await f.request(`/v1/admin/keys/${key.id}/revoke`, f.adminToken, {})).status, 200);
  assert.equal(f.tunnels.size, 0); assert.equal(f.records.size, 0);
  assert.equal((await f.request(`/v1/admin/keys/${key.id}/reset`, f.adminToken, {})).status, 409);
  const listed = await f.request('/v1/admin/keys', f.adminToken).then(res => res.json());
  assert.ok(!JSON.stringify(listed).includes(device.deviceSecret));
});

test('stale provisioning cleanup compares actual ISO timestamps in D1 and preserves recent bindings', async t => {
  const f = await fixture(t);
  const stale = await f.issue('Stale provisioning');
  const recent = await f.issue('Recent provisioning');
  for (const [key, age] of [[stale, '-20 minutes'], [recent, '-1 minute']]) {
    await f.db.prepare("UPDATE access_keys SET state = 'provisioning', binding_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) WHERE id = ?")
      .bind(randomUUID(), age, key.id).run();
  }
  const store = new KeyStore(f.db);
  assert.deepEqual((await store.cleanupCandidates()).map(row => row.id), [stale.id]);
  const removed = [];
  await reconcileCleanup({}, { store, cloud: { remove: async row => removed.push(row.id) } });
  assert.deepEqual(removed, [stale.id]);
  assert.equal((await store.byId(stale.id)).state, 'issued');
  assert.equal((await store.byId(recent.id)).state, 'provisioning');
});

test('cleanup cannot reset a binding that recovered or made progress after the stale scan', async t => {
  const f = await fixture(t);
  const active = await f.issue('Recovered during cleanup scan');
  const progressing = await f.issue('Retry during cleanup scan');
  for (const key of [active, progressing]) {
    await f.db.prepare("UPDATE access_keys SET state = 'provisioning', binding_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 minutes') WHERE id = ?")
      .bind(randomUUID(), key.id).run();
  }
  const store = new KeyStore(f.db);
  const snapshot = await store.cleanupCandidates();
  store.cleanupCandidates = async () => {
    await f.db.prepare("UPDATE access_keys SET state = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(active.id).run();
    await f.db.prepare("UPDATE access_keys SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").bind(progressing.id).run();
    return snapshot;
  };
  const removed = [];
  await reconcileCleanup({}, { store, cloud: { remove: async row => removed.push(row.id) } });
  assert.deepEqual(removed, [], 'A stale scan is not authority to disable a recovered/current binding');
  assert.equal((await store.byId(active.id)).state, 'active');
  assert.equal((await store.byId(progressing.id)).state, 'provisioning');
});

test('a stale device release cannot disable the replacement binding after an administrator reset', async t => {
  const f = await fixture(t);
  const key = await f.issue('Rebound device');
  const previous = await f.request('/v1/enroll', key.accessKey, f.device()).then(response => response.json());
  await f.request(`/v1/admin/keys/${key.id}/reset`, f.adminToken, {});
  const current = await f.request('/v1/enroll', key.accessKey, f.device()).then(response => response.json());
  const store = new KeyStore(f.db);
  const staleRelease = await store.disable(key.id, 'reset', previous.bindingId);
  assert.equal(staleRelease, null, 'Authorization for a previous binding must not mutate its replacement');
  const state = await store.byId(key.id);
  assert.equal(state.state, 'active');
  assert.equal(state.binding_id, current.bindingId);
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
    expireProvisioning: async row => ({ ...row, state: 'resetting' }),
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

test('update policy verifies signed releases, rejects stale edits, and separates publication from promotion', async t => {
  const f = await fixture(t);
  const original = await f.request('/v1/update-policy').then(res => res.json());
  assert.deepEqual(original, { schema: 1, stable: '0.2.5', auto: null, minimumSupported: null, enforceAfter: null, revision: 0 });
  const policy = { auto: '0.2.5', minimumSupported: '0.2.4', enforceAfter: new Date(Date.now() + 86400000).toISOString(), revision: 0 };
  assert.equal((await f.request('/v1/admin/update-policy', secret(), policy)).status, 401);
  assert.equal((await f.request('/v1/admin/update-policy', f.adminToken, { ...policy, auto: '0.2.6' })).status, 400);
  f.switches.unsignedUpdate = true;
  assert.equal((await f.request('/v1/admin/update-policy', f.adminToken, policy)).status, 409);
  f.switches.unsignedUpdate = false; f.switches.invalidUpdateSignature = true;
  assert.equal((await f.request('/v1/admin/update-policy', f.adminToken, policy)).status, 409);
  f.switches.invalidUpdateSignature = false;
  const approved = await f.request('/v1/admin/update-policy', f.adminToken, policy);
  assert.equal(approved.status, 200); assert.equal((await approved.json()).revision, 1);
  assert.equal((await f.request('/v1/admin/update-policy', f.adminToken, policy)).status, 409);
  const token = randomUUID();
  const claim = await f.request('/v1/admin/publication', f.adminToken, { action: 'begin', token });
  assert.equal(claim.status, 200); assert.equal((await claim.json()).policy.auto, '0.2.5');
  assert.equal((await f.request('/v1/admin/publication', f.adminToken, { action: 'begin', token: randomUUID() })).status, 409);
  assert.equal((await f.request('/v1/admin/update-policy', f.adminToken, { ...policy, revision: 1 })).status, 409);
  await f.request('/v1/admin/publication', f.adminToken, { action: 'end', token: randomUUID() });
  assert.equal((await f.request('/v1/admin/update-policy', f.adminToken, { ...policy, revision: 1 })).status, 409);
  await f.request('/v1/admin/publication', f.adminToken, { action: 'end', token });
  assert.equal((await f.request('/v1/admin/update-policy', f.adminToken, { ...policy, revision: 1 })).status, 200);
  const auth = await f.accessHeaders();
  const adminPolicy = await f.mf.dispatchFetch('https://team.example.test/admin/update-policy', { headers: auth });
  assert.equal(adminPolicy.status, 200);
  assert.deepEqual((await adminPolicy.json()).selectableVersions, ['0.2.5', '0.2.4']);
  assert.equal((await f.mf.dispatchFetch('https://team.example.test/admin/update-policy', { method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', Origin: 'https://attacker.test', 'Sec-Fetch-Site': 'cross-site' }, body: JSON.stringify({ ...policy, revision: 2 }) })).status, 403);
});

test('minimum support blocks only new unsupported work and retains version reporting and recovery routes', async t => {
  const f = await fixture(t);
  const key = await f.issue('Update-aware employee'); const device = f.device();
  const binding = await f.request('/v1/enroll', key.accessKey, device).then(res => res.json());
  const identity = { keyId: key.id, bindingId: binding.bindingId };
  const policy = { auto: '0.2.5', minimumSupported: '0.2.4', enforceAfter: new Date(Date.now() + 86400000).toISOString(), revision: 0 };
  assert.equal((await f.request('/v1/admin/update-policy', f.adminToken, policy)).status, 200);
  const first = await f.request('/mcp', key.accessKey, { jsonrpc: '2.0', id: 1, method: 'initialize' });
  assert.equal(first.status, 200); const session = first.headers.get('mcp-session-id');
  assert.equal((await f.request('/v1/admin/update-policy', f.adminToken, { ...policy, revision: 1,
    enforceAfter: new Date(Date.now() - 1000).toISOString() })).status, 200);
  const blocked = await f.request('/mcp', key.accessKey, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(blocked.status, 426); assert.equal((await blocked.json()).error.message, 'client_upgrade_required');
  assert.equal((await f.mf.dispatchFetch('https://team.example.test/mcp', { headers: {
    Authorization: `Bearer ${key.accessKey}`, 'mcp-session-id': session } })).status, 200);
  assert.equal((await f.request('/v1/device/status-v2', device.deviceSecret, identity)).status, 200);
  assert.equal((await f.request('/v1/device/version', key.accessKey, { ...identity, version: '0.2.5', platform: 'win32-x64' })).status, 401);
  assert.equal((await f.request('/v1/device/version', device.deviceSecret, { ...identity, version: 'bad', platform: 'win32-x64' })).status, 400);
  assert.equal((await f.request('/v1/device/version', device.deviceSecret, { ...identity, version: '0.2.5', platform: 'win32-x64' })).status, 200);
  const store = new KeyStore(f.db);
  assert.equal((await store.reportVersion(key.id, binding.bindingId, '0.2.5', 'win32-x64')).meta.changes, 0);
  assert.equal((await f.request('/mcp', key.accessKey, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status, 200);
  const listed = await f.request('/v1/admin/keys', f.adminToken).then(res => res.json());
  assert.equal(listed.keys[0].clientVersion, '0.2.5'); assert.equal(listed.keys[0].clientPlatform, 'win32-x64');
  assert.equal((await f.request('/v1/device/suspend', device.deviceSecret, identity)).status, 200);
  assert.equal((await f.request(`/v1/admin/keys/${key.id}/reset`, f.adminToken, {})).status, 200);
  assert.equal((await store.byId(key.id)).client_version, null);
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


test('optional startup inventory failure cannot undo enrollment or resume', async t => {
  const f = await fixture(t), key = await f.issue('Inventory isolation'), device = f.device();
  await f.db.prepare("CREATE TRIGGER fail_inventory BEFORE UPDATE OF version_reported_at ON access_keys BEGIN SELECT RAISE(ABORT, 'inventory unavailable'); END").run();
  const enrolled = await f.request('/v1/enroll', key.accessKey, { ...device, version: '0.2.6', platform: 'win32-x64' });
  assert.equal(enrolled.status, 200);
  const binding = await enrolled.json(), identity = { keyId: key.id, bindingId: binding.bindingId };
  assert.equal((await f.request('/v1/device/suspend', device.deviceSecret, identity)).status, 200);
  const resumed = await f.request('/v1/device/resume', device.deviceSecret, { ...identity, version: '0.2.6', platform: 'win32-x64' });
  assert.equal(resumed.status, 200); assert.equal((await resumed.json()).state, 'active');
  assert.equal((await f.request('/v1/device/version', device.deviceSecret, { ...identity, version: '0.2.6', platform: 'win32-x64' })).status, 503);
  const policy = await f.request('/v1/admin/update-policy', f.adminToken,
    { auto: '0.2.5', minimumSupported: '0.2.4', enforceAfter: new Date(Date.now() - 60000).toISOString(), revision: 0 });
  assert.equal(policy.status, 200);
  assert.equal((await f.request('/mcp', key.accessKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 426);
  await f.db.prepare('DROP TRIGGER fail_inventory').run();
  assert.equal((await f.request('/v1/device/version', device.deviceSecret, { ...identity, version: '0.2.6', platform: 'win32-x64' })).status, 200);
  assert.equal((await f.request('/mcp', key.accessKey, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).status, 200);
});

test('a failed lower-version inventory report cannot keep a stale higher-version admission', async t => {
  const f = await fixture(t), key = await f.issue('Downgrade guard'), device = f.device();
  const enrolled = await f.request('/v1/enroll', key.accessKey, { ...device, version: '0.2.6', platform: 'win32-x64' });
  const binding = await enrolled.json(), identity = { keyId: key.id, bindingId: binding.bindingId };
  await f.db.prepare("CREATE TRIGGER fail_inventory BEFORE UPDATE OF version_reported_at ON access_keys BEGIN SELECT RAISE(ABORT, 'inventory unavailable'); END").run();
  assert.equal((await f.request('/v1/device/resume', device.deviceSecret,
    { ...identity, version: '0.2.3', platform: 'win32-x64' })).status, 503);
  const status = await f.request('/v1/device/status-v2', device.deviceSecret, identity);
  assert.equal((await status.json()).state, 'suspended');
  assert.equal((await f.request('/mcp', key.accessKey, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 403);
});

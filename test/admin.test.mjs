import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AdminService } from '../gateway/admin-service.mjs';
import { adminWeb, escapeHtml, renderAdmin } from '../gateway/admin-web.mjs';
import { clearPendingCredential, createPendingCredential, credentialRequest,
  loadPendingCredential, savePendingCredential } from '../assets/admin/admin.js';

const id = '11111111-1111-4111-8111-111111111111';
const bindingId = '22222222-2222-4222-8222-222222222222';
const row = { id, label: 'Alice', state: 'active', device_id: 'device-id', binding_id: bindingId,
  cleanup_pending: 0, updated_at: '2026-09-10T00:00:00.000Z' };

test('Admin Service is the single issue/list/revoke/reset lifecycle owner', async () => {
  const trace = [];
  const store = {
    list: async () => [row],
    issue: async input => ({ ...row, ...input, state: 'issued', device_id: null, binding_id: null }),
    byId: async () => row,
    disable: async (_id, operation) => { trace.push(`disable:${operation}`); return { ...row, state: operation === 'revoke' ? 'revoked' : 'resetting' }; },
    finishCleanup: async (_id, _binding, operation) => { trace.push(`finish:${operation}`); return true; },
  };
  const cloud = { remove: async () => { trace.push('cloud:remove'); } };
  const service = new AdminService(store, cloud);
  assert.equal((await service.listKeys())[0].deviceId, 'device-id');
  assert.equal((await service.issueKey({ id, label: 'Alice', keyHash: 'a'.repeat(64) })).state, 'issued');
  assert.equal((await service.revokeKey(id)).cleanup, 'complete');
  assert.deepEqual(trace, ['disable:revoke', 'cloud:remove', 'finish:revoke']);
  trace.length = 0;
  assert.equal((await service.resetDevice(id)).cleanup, 'complete');
  assert.deepEqual(trace, ['disable:reset', 'cloud:remove', 'finish:reset']);

  const pending = new AdminService(store, { remove: async () => { throw new Error('offline'); } });
  assert.deepEqual(await pending.revokeKey(id), {
    key: { id, label: 'Alice', state: 'revoked', deviceId: 'device-id', bindingId,
      updatedAt: '2026-09-10T00:00:00.000Z', cleanupPending: false },
    cleanup: 'pending', error: 'connectivity_cleanup_pending', retryable: true,
  });
  const revoked = new AdminService({ ...store, disable: async () => null }, cloud);
  await assert.rejects(revoked.resetDevice(id), error => error.status === 409 && error.code === 'revoked_key_cannot_be_reset');
});

const ACCESS_ISSUER = 'https://admin-access.example.test';
const ACCESS_AUD = 'team-devspace-admin-unit';
const { publicKey: accessPublicKey, privateKey: accessPrivateKey } = await generateKeyPair('RS256');
const ACCESS_JWK = { ...await exportJWK(accessPublicKey), kid: 'admin-test-key', alg: 'RS256', use: 'sig' };

async function accessHeaders(extra = {}) {
  const token = await new SignJWT({ email: 'admin@example.test' })
    .setProtectedHeader({ alg: 'RS256', kid: ACCESS_JWK.kid })
    .setIssuer(ACCESS_ISSUER).setAudience(ACCESS_AUD).setIssuedAt().setExpirationTime('5m').sign(accessPrivateKey);
  return { 'Cf-Access-Jwt-Assertion': token, ...extra };
}

function accessEnv() {
  return { PUBLIC_ORIGIN: 'https://team.example.test', ACCESS_TEAM_DOMAIN: ACCESS_ISSUER, ACCESS_AUD,
    ASSETS: { fetch: async () => new Response('asset') } };
}

function stubAccessKeys(t) {
  const original = globalThis.fetch;
  globalThis.fetch = async input => new URL(input instanceof Request ? input.url : input).origin === ACCESS_ISSUER
    ? Response.json({ keys: [ACCESS_JWK] }) : original(input);
  t.after(() => { globalThis.fetch = original; });
}

function webService() {
  const calls = [];
  return { calls,
    service: {
      listKeys: async () => [{ ...row, label: '<img src=x onerror=alert(1)>', keyHash: 'secret-hash' }],
      issueKey: async input => { calls.push(['issue', input]); return { ...row, ...input, keyHash: undefined }; },
      revokeKey: async keyId => { calls.push(['revoke', keyId]); return { key: row, cleanup: 'complete' }; },
      resetDevice: async keyId => { calls.push(['reset', keyId]); return { key: row, cleanup: 'complete' }; },
    } };
}

test('Admin Web requires a valid Access JWT, escapes D1 fields, omits secrets and applies browser security headers', async t => {
  stubAccessKeys(t);
  const fixture = webService();
  const env = accessEnv();
  await assert.rejects(adminWeb(new Request('https://team.example.test/admin'), env, fixture.service),
    error => error.status === 403 && error.code === 'access_required');
  await assert.rejects(adminWeb(new Request('https://team.example.test/admin', {
    headers: { 'Cf-Access-Jwt-Assertion': 'signed-access-assertion' },
  }), env, fixture.service), error => error.status === 403 && error.code === 'access_required');
  const response = await adminWeb(new Request('https://team.example.test/admin', { headers: await accessHeaders() }), env, fixture.service);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('secret-hash') && !/ADMIN_TOKEN|MASTER_KEY|device_secret/i.test(html));
  assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(escapeHtml(`<&"' `), '&lt;&amp;&quot;&#39; ');
  const emptyAdmin = renderAdmin([]);
  assert.ok(emptyAdmin.includes('暂无访问密钥'));
  assert.ok(emptyAdmin.includes('<dialog id="create-dialog">'));
  assert.ok(emptyAdmin.includes('id="copy-key"'));
  assert.ok(emptyAdmin.includes('placeholder="例如：张三-Windows"'));
});

test('Admin Web accepts only same-origin hash-only POSTs and never performs lifecycle actions through GET', async t => {
  stubAccessKeys(t);
  const fixture = webService();
  const env = accessEnv();
  const mutationHeaders = await accessHeaders({ Origin: env.PUBLIC_ORIGIN, 'Sec-Fetch-Site': 'same-origin',
    'Content-Type': 'application/json' });
  const create = await adminWeb(new Request('https://team.example.test/admin/keys', {
    method: 'POST', headers: mutationHeaders, body: JSON.stringify({ id, label: 'Alice', keyHash: 'a'.repeat(64) }),
  }), env, fixture.service);
  assert.equal(create.status, 201);
  assert.deepEqual(fixture.calls[0], ['issue', { id, label: 'Alice', keyHash: 'a'.repeat(64) }]);
  await assert.rejects(adminWeb(new Request('https://team.example.test/admin/keys', {
    method: 'POST', headers: mutationHeaders,
    body: JSON.stringify({ id, label: 'Alice', keyHash: 'a'.repeat(64), accessKey: 'tds_plaintext' }),
  }), env, fixture.service), error => error.status === 400);
  await assert.rejects(adminWeb(new Request('https://team.example.test/admin/keys', {
    method: 'POST', headers: await accessHeaders({ Origin: 'https://evil.test', 'Sec-Fetch-Site': 'cross-site',
      'Content-Type': 'application/json' }), body: '{}',
  }), env, fixture.service), error => error.status === 403);
  await assert.rejects(adminWeb(new Request('https://team.example.test/admin/keys', {
    method: 'POST', headers: mutationHeaders,
    body: JSON.stringify({ id, label: 'x'.repeat(17000), keyHash: 'a'.repeat(64) }),
  }), env, fixture.service), error => error.status === 413 && error.code === 'body_too_large');
  await assert.rejects(adminWeb(new Request(`https://team.example.test/admin/keys/${id}/revoke`, {
    headers: await accessHeaders(),
  }), env, fixture.service), error => error.status === 404);
  const revoke = await adminWeb(new Request(`https://team.example.test/admin/keys/${id}/revoke`, {
    method: 'POST', headers: mutationHeaders, body: '{}',
  }), env, fixture.service);
  assert.equal(revoke.status, 200);
  assert.deepEqual(fixture.calls.at(-1), ['revoke', id]);
});

test('browser credential logic generates one hash-only retryable credential in session storage', async () => {
  const credential = await createPendingCredential('Alice', webcrypto);
  assert.match(credential.id, /^[a-f0-9-]{36}$/);
  assert.match(credential.accessKey, /^tds_[A-Za-z0-9_-]{43}$/);
  assert.equal(credential.keyHash, createHash('sha256').update(credential.accessKey).digest('hex'));
  assert.deepEqual(Object.keys(credentialRequest(credential)).sort(), ['id', 'keyHash', 'label']);
  assert.ok(!JSON.stringify(credentialRequest(credential)).includes(credential.accessKey));
  const values = new Map();
  const storage = { setItem: (key, value) => values.set(key, value), getItem: key => values.get(key) ?? null,
    removeItem: key => values.delete(key) };
  savePendingCredential(storage, credential);
  assert.deepEqual(loadPendingCredential(storage), credential);
  assert.deepEqual(credentialRequest(loadPendingCredential(storage)), credentialRequest(credential));
  clearPendingCredential(storage);
  assert.equal(loadPendingCredential(storage), null);
});

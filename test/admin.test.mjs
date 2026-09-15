import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AdminService } from '../gateway/admin-service.mjs';
import { adminWeb, escapeHtml, renderAdmin } from '../gateway/admin-web.mjs';
import { adminJson, clearPendingCredential, createPendingCredential, credentialRequest,
  loadPendingCredential, savePendingCredential, confirmMinimumPolicyChange } from '../assets/admin/admin.js';

const id = '11111111-1111-4111-8111-111111111111';
const bindingId = '22222222-2222-4222-8222-222222222222';
const row = { id, label: 'Alice', state: 'active', device_id: 'device-id', binding_id: bindingId,
  cleanup_pending: 0, created_at: '2026-09-01T00:00:00.000Z', updated_at: '2026-09-10T00:00:00.000Z' };

test('pausing promotion cannot silently remove an existing minimum support requirement', () => {
  const messages = [];
  assert.equal(confirmMinimumPolicyChange('0.2.4', null, message => { messages.push(message); return false; }), false);
  assert.match(messages[0], /解除最低支持版本限制/);
  assert.equal(confirmMinimumPolicyChange('0.2.4', null, () => true), true);
  assert.equal(confirmMinimumPolicyChange(null, null, () => assert.fail('No support policy is being changed')), true);
  assert.equal(confirmMinimumPolicyChange(null, '0.2.5', () => false), false);
});

test('Admin Service is the single issue/list/revoke/reset/delete lifecycle owner', async () => {
  const trace = [];
  const store = {
    list: async () => [row],
    listEvents: async () => [{ id: 1, keyId: id, label: 'Alice', event: 'created', occurredAt: row.created_at }],
    issue: async input => ({ ...row, ...input, state: 'issued', device_id: null, binding_id: null }),
    wasDeleted: async () => false,
    byId: async () => row,
    disable: async (_id, operation) => { trace.push(`disable:${operation}`); return { ...row, state: operation === 'revoke' ? 'revoked' : 'resetting' }; },
    finishCleanup: async (_id, _binding, operation) => { trace.push(`finish:${operation}`); return true; },
    deleteRevoked: async keyId => { trace.push(`delete:${keyId}`); return true; },
    deleteAllRevoked: async () => { trace.push('delete:all'); return 3; },
  };
  const cloud = { remove: async () => { trace.push('cloud:remove'); } };
  const service = new AdminService(store, cloud);
  assert.equal((await service.listKeys())[0].deviceId, 'device-id');
  assert.equal((await service.listKeyEvents())[0].event, 'created');
  assert.equal((await service.issueKey({ id, label: 'Alice', keyHash: 'a'.repeat(64) })).state, 'issued');
  assert.equal((await service.revokeKey(id)).cleanup, 'complete');
  assert.deepEqual(trace, ['disable:revoke', 'cloud:remove', 'finish:revoke']);
  trace.length = 0;
  assert.equal((await service.resetDevice(id)).cleanup, 'complete');
  assert.deepEqual(trace, ['disable:reset', 'cloud:remove', 'finish:reset']);

  const pending = new AdminService(store, { remove: async () => { throw new Error('offline'); } });
  assert.deepEqual(await pending.revokeKey(id), {
    key: { id, label: 'Alice', state: 'revoked', deviceId: 'device-id', bindingId,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-10T00:00:00.000Z', revokedAt: null,
      cleanupCompletedAt: null, cleanupPending: false,
      clientVersion: null, clientPlatform: null, versionReportedAt: null, updateReport: null },
    cleanup: 'pending', error: 'connectivity_cleanup_pending', retryable: true,
  });
  const revoked = new AdminService({ ...store, disable: async () => null }, cloud);
  await assert.rejects(revoked.resetDevice(id), error => error.status === 409 && error.code === 'revoked_key_cannot_be_reset');
  const archivedStore = { ...store, byId: async () => ({ ...row, state: 'revoked', cleanup_pending: 0 }) };
  const archived = new AdminService(archivedStore, cloud);
  assert.deepEqual(await archived.deleteRevokedKey(id), { deleted: id });
  assert.deepEqual(await archived.deleteAllRevokedKeys(), { deleted: 3 });
  assert.deepEqual(trace.slice(-2), [`delete:${id}`, 'delete:all']);
  const pendingDelete = new AdminService({ ...store, byId: async () => ({ ...row, state: 'revoked', cleanup_pending: 1 }) }, cloud);
  await assert.rejects(pendingDelete.deleteRevokedKey(id), error => error.status === 409 && error.code === 'revoked_key_not_ready_for_delete');
  const tombstoned = new AdminService({ ...store, issue: async () => null, wasDeleted: async () => true }, cloud);
  await assert.rejects(tombstoned.issueKey({ id, label: 'Alice', keyHash: 'a'.repeat(64) }),
    error => error.status === 409 && error.code === 'deleted_key_id_cannot_be_reused');
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
      listKeyEvents: async () => [{ id: 1, keyId: id, label: '<event>', event: 'deleted', occurredAt: row.updated_at }],
      issueKey: async input => { calls.push(['issue', input]); return { ...row, ...input, keyHash: undefined }; },
      revokeKey: async keyId => { calls.push(['revoke', keyId]); return { key: row, cleanup: 'complete' }; },
      resetDevice: async keyId => { calls.push(['reset', keyId]); return { key: row, cleanup: 'complete' }; },
      deleteRevokedKey: async keyId => { calls.push(['delete', keyId]); return { deleted: keyId }; },
      deleteAllRevokedKeys: async () => { calls.push(['purge']); return { deleted: 2 }; },
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
  assert.ok(html.includes('&lt;event&gt;'));
  assert.ok(!html.includes('secret-hash') && !/ADMIN_TOKEN|MASTER_KEY|device_secret/i.test(html));
  assert.match(response.headers.get('Content-Security-Policy'), /default-src 'none'/);
  assert.match(response.headers.get('Content-Security-Policy'), /img-src 'self' data:/);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(escapeHtml(`<&"' `), '&lt;&amp;&quot;&#39; ');
  const emptyAdmin = renderAdmin([]);
  assert.ok(emptyAdmin.includes('暂无访问密钥'));
  assert.ok(emptyAdmin.includes('<main class="container">'));
  assert.ok(emptyAdmin.includes('class="header-actions"'));
  assert.ok(emptyAdmin.includes('id="policy-edit"'));
  assert.ok(emptyAdmin.includes('<dialog id="policy-dialog"'));
  assert.ok(emptyAdmin.includes('id="policy-dialog-notice"'));
  assert.ok(emptyAdmin.includes('<select id="policy-auto">'));
  assert.ok(emptyAdmin.includes('<select id="policy-minimum">'));
  assert.ok(emptyAdmin.includes('<dialog id="create-dialog"'));
  assert.ok(emptyAdmin.includes('<dialog id="action-dialog"'));
  assert.ok(emptyAdmin.includes('id="copy-key"'));
  assert.ok(emptyAdmin.includes('placeholder="例如：张三-Windows"'));
  assert.ok(!emptyAdmin.includes('class="admin-shell"'));

  const lifecycleAdmin = renderAdmin([
    { id, label: 'Active', state: 'active', deviceId: 'device-active', bindingId, createdAt: row.created_at, updatedAt: row.updated_at, cleanupPending: false },
    { id: '33333333-3333-4333-8333-333333333333', label: 'Paused', state: 'suspended', deviceId: 'device-paused', bindingId, createdAt: row.created_at, updatedAt: row.updated_at, cleanupPending: false },
    { id: '44444444-4444-4444-8444-444444444444', label: 'Waiting', state: 'issued', deviceId: null, bindingId: null, createdAt: row.created_at, updatedAt: row.updated_at, cleanupPending: false },
    { id: '55555555-5555-4555-8555-555555555555', label: 'Revoked pending', state: 'revoked', deviceId: 'device-old', bindingId, createdAt: row.created_at, revokedAt: row.updated_at, updatedAt: row.updated_at, cleanupPending: true },
    { id: '66666666-6666-4666-8666-666666666666', label: 'Revoked archived', state: 'revoked', deviceId: 'device-old', bindingId, createdAt: row.created_at, revokedAt: '2026-09-09T00:00:00.000Z', cleanupCompletedAt: row.updated_at, updatedAt: row.updated_at, cleanupPending: false },
  ], [{ keyId: id, label: 'Active', event: 'created', occurredAt: row.created_at }]);
  assert.ok(lifecycleAdmin.includes('设备端已暂停'));
  assert.ok(lifecycleAdmin.includes('待绑定'));
  assert.ok(lifecycleAdmin.includes('已吊销 · 待清理'));
  assert.ok(lifecycleAdmin.includes('<summary>已吊销历史（1）</summary>'));
  assert.ok(lifecycleAdmin.includes('data-key-action="delete"'));
  assert.ok(lifecycleAdmin.includes('data-key-action="purge"'));
  assert.equal((lifecycleAdmin.match(/data-key-action="delete"/g) ?? []).length, 1,
    'Only cleanup-complete revoked rows are deletable');
  assert.ok(lifecycleAdmin.includes('<th>设备 ID</th>'));
  assert.ok(lifecycleAdmin.includes('<th>生命周期</th>'));
  assert.ok(lifecycleAdmin.includes('最近操作记录（1）'));
  assert.ok(lifecycleAdmin.includes('清理完成'));
  assert.ok(!lifecycleAdmin.includes('<th>清理状态</th>'));
});

test('Admin Web keeps key management available when optional audit history is unavailable', async t => {
  stubAccessKeys(t);
  const fixture = webService();
  fixture.service.listKeyEvents = async () => { throw new Error('synthetic audit outage'); };
  const originalWarn = console.warn; const warnings = []; console.warn = value => warnings.push(value);
  t.after(() => { console.warn = originalWarn; });
  const response = await adminWeb(new Request('https://team.example.test/admin', { headers: await accessHeaders() }), accessEnv(), fixture.service);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'), 'Core key rows remain available');
  assert.ok(html.includes('\u6700\u8fd1\u64cd\u4f5c\u8bb0\u5f55\u6682\u65f6\u4e0d\u53ef\u7528'));
  assert.ok(html.includes('\u8bbf\u95ee\u5bc6\u94a5\u4e0e\u8bbe\u5907\u7ba1\u7406\u4e0d\u53d7\u5f71\u54cd'));
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('synthetic audit outage'), 'Provider details are not copied into logs');
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
  const remove = await adminWeb(new Request(`https://team.example.test/admin/keys/${id}/delete`, {
    method: 'POST', headers: mutationHeaders, body: '{}',
  }), env, fixture.service);
  assert.equal(remove.status, 200);
  assert.deepEqual(fixture.calls.at(-1), ['delete', id]);
  const purge = await adminWeb(new Request('https://team.example.test/admin/keys/purge-revoked', {
    method: 'POST', headers: mutationHeaders, body: '{}',
  }), env, fixture.service);
  assert.equal(purge.status, 200);
  assert.deepEqual(await purge.json(), { deleted: 2 });
  assert.deepEqual(fixture.calls.at(-1), ['purge']);
});

test('Admin browser requests time out with an uncertain-result diagnostic instead of remaining busy forever', async t => {
  const keepAlive = setTimeout(() => {}, 1000);
  t.after(() => clearTimeout(keepAlive));
  await assert.rejects(adminJson('/admin/keys', { method: 'POST' }, {
    timeout: 20,
    request: async (_path, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  }), /请求超时，操作结果尚未确认/);
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
  savePendingCredential(storage, { ...credential, confirmed: true });
  assert.equal(loadPendingCredential(storage).confirmed, true, 'Acknowledgement must survive a page refresh');
  assert.deepEqual(credentialRequest(loadPendingCredential(storage)), credentialRequest(credential),
    'Browser acknowledgement is local metadata, never part of the server issuance request');
  clearPendingCredential(storage);
  assert.equal(loadPendingCredential(storage), null);
});

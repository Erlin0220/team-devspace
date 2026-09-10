import test from 'node:test';
import assert from 'node:assert/strict';
import { ACCESS_APP_NAME, ACCESS_POLICY_NAME, ensureAdminAccess, verifyAdminProtection } from '../scripts/access.mjs';

const accountId = 'a'.repeat(32);
const hostname = 'team.example.test';
const applicationId = '11111111-1111-4111-8111-111111111111';
const policyId = '22222222-2222-4222-8222-222222222222';
const emails = ['admin@example.test'];
const app = { id: applicationId, name: ACCESS_APP_NAME, type: 'self_hosted', aud: 'team-devspace-admin-aud',
  session_duration: '8h', app_launcher_visible: false,
  domain: `${hostname}/admin*`, destinations: [{ type: 'public', uri: `${hostname}/admin*` }] };
const policy = { id: policyId, name: ACCESS_POLICY_NAME, decision: 'allow', precedence: 1,
  include: [{ email: { email: emails[0] } }] };

function apiFixture({ applications = [], policies = [], fail, application = app } = {}) {
  const calls = [];
  const api = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (fail) throw new Error('cloudflare unavailable');
    if (path.endsWith(`/access/apps/${applicationId}`)) return application;
    if (path.includes('/access/apps?')) return applications;
    if (path.endsWith('/access/apps') && method === 'POST') return application;
    if (path.endsWith(`/${applicationId}/policies`) && method === 'GET') return policies;
    if (path.endsWith(`/${applicationId}/policies`) && method === 'POST') return { ...body, id: policyId };
    if (path.endsWith(`/policies/${policyId}`) && method === 'PUT') return { ...body, id: policyId };
    throw new Error(`Unexpected API call: ${method} ${path}`);
  };
  return { api, calls };
}

test('Access deployment creates and records only a new owned /admin* application before its allow policy', async () => {
  const fixture = apiFixture();
  let recorded;
  const result = await ensureAdminAccess({ api: fixture.api, accountId, hostname, administratorEmails: emails,
    applicationId: null, onApplicationCreated: async id => { recorded = id; } });
  assert.equal(recorded, applicationId);
  assert.equal(result.applicationId, applicationId);
  assert.equal(result.audience, app.aud);
  assert.deepEqual(fixture.calls.map(call => call.method), ['GET', 'POST', 'GET', 'POST']);
  assert.deepEqual(fixture.calls.at(-1).body.include, [{ email: { email: emails[0] } }]);
});

test('Access deployment reuses recorded ownership, repairs its policy, and rejects unknown resources', async () => {
  const correct = apiFixture({ policies: [policy] });
  await ensureAdminAccess({ api: correct.api, accountId, hostname, administratorEmails: emails, applicationId });
  assert.deepEqual(correct.calls.map(call => call.method), ['GET', 'GET']);

  const wrong = apiFixture({ policies: [{ ...policy, include: [{ email: { email: 'old@example.test' } }] }] });
  await ensureAdminAccess({ api: wrong.api, accountId, hostname, administratorEmails: emails, applicationId });
  assert.equal(wrong.calls.at(-1).method, 'PUT');

  const broadened = apiFixture({ policies: [{ ...policy,
    include: [{ email: { email: emails[0] } }, { everyone: {} }], precedence: 99 }] });
  await ensureAdminAccess({ api: broadened.api, accountId, hostname, administratorEmails: emails, applicationId });
  assert.equal(broadened.calls.at(-1).method, 'PUT');
  assert.deepEqual(broadened.calls.at(-1).body.include, [{ email: { email: emails[0] } }]);
  assert.equal(broadened.calls.at(-1).body.precedence, 1);

  await assert.rejects(ensureAdminAccess({ api: apiFixture({ applications: [app] }).api,
    accountId, hostname, administratorEmails: emails, applicationId: null }), /refusing to adopt/);
  await assert.rejects(ensureAdminAccess({ api: apiFixture({ application: { ...app, session_duration: '30d' } }).api,
    accountId, hostname, administratorEmails: emails, applicationId }), /no longer matches/);
  await assert.rejects(ensureAdminAccess({ api: apiFixture({ policies: [{ ...policy, id: 'other', name: 'Unknown' }] }).api,
    accountId, hostname, administratorEmails: emails, applicationId }), /unmanaged policy/);
  await assert.rejects(ensureAdminAccess({ api: apiFixture({ fail: true }).api,
    accountId, hostname, administratorEmails: emails, applicationId }), /cloudflare unavailable/);
});

test('post-deploy admin probe accepts only a challenge/deny and rejects exposed HTML', async () => {
  assert.equal(await verifyAdminProtection('https://team.example.test',
    async () => new Response('login', { status: 302 })), true);
  await assert.rejects(verifyAdminProtection('https://team.example.test',
    async () => new Response('Team DevSpace Admin', { status: 200 })), /not fail-closed/);
  await assert.rejects(verifyAdminProtection('https://team.example.test', async () => new Response(
    JSON.stringify({ error: 'request_rejected' }), { status: 403, headers: { 'X-Request-Id': 'worker-request' } })),
  /not fail-closed/);
});

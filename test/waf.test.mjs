import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureGatewayWaf, gatewayWafExpression, GATEWAY_WAF_REF, verifyGatewayWaf } from '../scripts/waf.mjs';

const zoneId = 'a'.repeat(32);
const rulesetId = 'b'.repeat(32);
const ruleId = 'c'.repeat(32);
const hostname = 'team.example.test';

function ownedRule(overrides = {}) {
  return { id: ruleId, action: 'block', expression: gatewayWafExpression(hostname),
    description: 'Restrict Team DevSpace gateway to owned namespaces', enabled: true,
    ref: GATEWAY_WAF_REF, ...overrides };
}

test('gateway WAF is host-scoped, blocks legacy status, and allows only stable product namespaces', () => {
  const expression = gatewayWafExpression(hostname);
  assert.match(expression, /http\.host eq "team\.example\.test"/);
  assert.match(expression, /\/v1\/device\/status/);
  for (const value of ['/mcp', '/health', '/robots.txt', '/admin', '/v1/enroll', '/v1/update-policy']) {
    assert.ok(expression.includes(`eq "${value}"`));
  }
  for (const value of ['/admin/', '/mcp-app-assets/', '/v1/enrollment/', '/v1/device/', '/v1/admin/', '/cdn-cgi/']) {
    assert.ok(expression.includes(`starts_with(http.request.uri.path, "${value}")`));
  }
  assert.equal(expression.includes('/.env'), false);
});

test('WAF deployment creates one owned entrypoint rule when the phase is absent', async () => {
  const calls = [];
  const api = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (method === 'GET') return null;
    return { id: rulesetId, rules: [{ ...body.rules[0], id: ruleId }] };
  };
  const result = await ensureGatewayWaf({ api, zoneId, hostname });
  assert.equal(result.ruleId, ruleId);
  assert.equal(calls[1].method, 'POST');
  assert.equal(calls[1].body.kind, 'zone');
  assert.equal(calls[1].body.rules[0].ref, GATEWAY_WAF_REF);
});

test('WAF deployment preserves unrelated rules and repairs only its stable ownership ref', async () => {
  const unrelated = { id: 'd'.repeat(32), ref: 'other-rule', action: 'block', expression: 'true', enabled: true };
  const calls = [];
  let current = { id: rulesetId, rules: [unrelated, ownedRule({ expression: 'false' })] };
  const api = async (path, method = 'GET', body) => {
    calls.push({ path, method, body });
    if (method === 'GET') return current;
    if (method === 'PATCH') {
      current = { ...current, rules: [unrelated, { ...body, id: ruleId }] };
      return current;
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  await ensureGatewayWaf({ api, zoneId, hostname });
  assert.deepEqual(calls.map(call => call.method), ['GET', 'PATCH']);
  assert.equal(current.rules[0], unrelated);
  assert.equal(current.rules[1].ref, GATEWAY_WAF_REF);
});

test('WAF deployment removes only the exact historical legacy-status rule after ownership is verified', async () => {
  const legacyId = 'f'.repeat(32);
  const unrelated = { id: 'd'.repeat(32), ref: 'other-rule', action: 'block', expression: 'true', enabled: true };
  const legacy = { id: legacyId, ref: legacyId, action: 'block', enabled: true,
    description: 'Retire legacy Team DevSpace device status endpoint',
    expression: `(http.host eq "${hostname}" and http.request.uri.path eq "/v1/device/status")` };
  const calls = [];
  let current = { id: rulesetId, rules: [unrelated, legacy, ownedRule()] };
  const api = async (path, method = 'GET') => {
    calls.push({ path, method });
    if (method === 'GET') return current;
    if (method === 'DELETE') {
      assert.ok(path.endsWith(`/${legacyId}`));
      current = { ...current, rules: [unrelated, ownedRule()] };
      return current;
    }
    throw new Error(`Unexpected ${method} ${path}`);
  };
  await ensureGatewayWaf({ api, zoneId, hostname });
  assert.deepEqual(calls.map(call => call.method), ['GET', 'DELETE']);
  assert.equal(current.rules[0], unrelated);
});

test('WAF deployment refuses ambiguous owned rules', async () => {
  const duplicate = { id: 'e'.repeat(32), ...ownedRule() };
  const api = async () => ({ id: rulesetId, rules: [ownedRule(), duplicate] });
  await assert.rejects(ensureGatewayWaf({ api, zoneId, hostname }), /Multiple Team DevSpace WAF rules/);
});

test('post-deploy WAF probe proves Edge termination while health and MCP still reach the Worker', async () => {
  const responses = new Map([
    ['/v1/device/status', new Response('blocked', { status: 403 })],
    ['/.team-devspace-waf-probe', new Response('blocked', { status: 403 })],
    ['/health', new Response('{}', { status: 200, headers: { 'X-Request-Id': 'health' } })],
    ['/mcp', new Response('{}', { status: 401, headers: { 'X-Request-Id': 'mcp' } })],
  ]);
  const fetcher = async input => responses.get(new URL(input).pathname);
  assert.equal(await verifyGatewayWaf('https://team.example.test', fetcher), true);
  responses.set('/health', new Response('blocked', { status: 403 }));
  await assert.rejects(verifyGatewayWaf('https://team.example.test', fetcher), /health namespace/);
});

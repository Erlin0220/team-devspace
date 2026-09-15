import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { logRequest, requestLogLevel } from '../gateway/observability.mjs';
import { Cloudflare } from '../gateway/cloudflare.mjs';

test('successful health/MCP/assets and public 404 scans stay out of persisted request logs', () => {
  for (const op of ['health', 'device_status', 'mcp', 'assets', 'admin_web_list', 'admin_list_keys']) {
    assert.equal(requestLogLevel(op, 200), null);
  }
  assert.equal(requestLogLevel('not_found', 404), null);
  assert.equal(requestLogLevel('not_found', 503), 'error');
});

test('lifecycle outcomes and errors retain severity without private inputs', () => {
  const lines = [];
  const logger = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, text => lines.push({ level, data: JSON.parse(text) })]));
  logRequest({ requestId: 'safe-id', operation: 'admin_revoke', status: 200, gatewayDurationMs: 12,
    authorization: 'secret', label: 'private', body: 'code' }, logger);
  logRequest({ requestId: 'safe-id', operation: 'mcp', status: 503, code: 'device_offline', gatewayDurationMs: 12 }, logger);
  logRequest({ requestId: 'safe-id', operation: 'mcp', status: 503, code: 'service_unavailable', gatewayDurationMs: 12 }, logger);
  assert.deepEqual(lines.map(line => line.level), ['info', 'warn', 'error']);
  assert.deepEqual(Object.keys(lines[0].data).sort(), ['event', 'gatewayDurationMs', 'operation', 'requestId', 'status']);
  assert.equal(requestLogLevel('enroll', 409), 'warn');
  assert.equal(requestLogLevel('mcp', 401), 'warn');
  assert.equal(requestLogLevel('admin_web_reset', 200), 'info');
});

test('provider failures expose numeric diagnostics without response messages or credentials', async t => {
  const logs = [];
  t.mock.method(console, 'error', line => logs.push(JSON.parse(line)));
  t.mock.method(globalThis, 'fetch', async () => Response.json({ success: false,
    errors: [{ code: 1000, message: 'private credential response' }, { code: 'private' }] }, { status: 503 }));
  const cloud = new Cloudflare({ CF_API_TOKEN: 'private-token', CF_ACCOUNT_ID: 'a'.repeat(32),
    CF_ZONE_ID: 'b'.repeat(32), DEVICE_DOMAIN: 'example.test' });
  await assert.rejects(cloud.api('/accounts/private-resource', { method: 'PUT', body: { secret: 'private' } }));
  assert.deepEqual(logs, [{ event: 'cloudflare_api_failed', method: 'PUT', status: 503, codes: [1000] }]);
  assert.ok(!JSON.stringify(logs).includes('private'));
});

test('observability retains unsampled diagnostic logs, not automatic invocation noise', async () => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  assert.equal(config.observability.logs.enabled, true);
  assert.equal(config.observability.logs.head_sampling_rate, 1);
  assert.equal(config.observability.logs.invocation_logs, false);
  assert.equal(config.observability.redact_query_string, true);
  // Contract keeps the supported authenticated control surface Worker-first.
  // The retired legacy status path is blocked separately at the Cloudflare edge.
  assert.deepEqual(config.assets.run_worker_first, ['/*', '!/mcp-app-assets/*']);
  const headers = await readFile('assets/_headers', 'utf8');
  assert.match(headers, /Access-Control-Allow-Origin: \*/);
  assert.match(headers, /Cross-Origin-Resource-Policy: cross-origin/);
  assert.match(headers, /max-age=31536000, immutable/);
});

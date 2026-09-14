import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { logRequest, requestLogLevel } from '../gateway/observability.mjs';

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

test('observability retains unsampled diagnostic logs, not automatic invocation noise', async () => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  assert.equal(config.observability.logs.enabled, true);
  assert.equal(config.observability.logs.head_sampling_rate, 1);
  assert.equal(config.observability.logs.invocation_logs, false);
  assert.equal(config.observability.redact_query_string, true);
  assert.deepEqual(config.assets.run_worker_first, ['/*', '!/mcp-app-assets/*']);
  const headers = await readFile('assets/_headers', 'utf8');
  assert.match(headers, /Access-Control-Allow-Origin: \*/);
  assert.match(headers, /Cross-Origin-Resource-Policy: cross-origin/);
  assert.match(headers, /max-age=31536000, immutable/);
});

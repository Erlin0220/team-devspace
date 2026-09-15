import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';

// Exercise the actual platform router and _headers, not a mocked ASSETS binding.
test('public MCP assets bypass the Worker while all control/admin routes remain protected', async t => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  const script = (await build({ entryPoints: ['gateway/index.mjs'], bundle: true, format: 'esm',
    platform: 'browser', write: false })).outputFiles[0].text;
  const patterns = config.assets.run_worker_first;
  const directory = await mkdtemp(join(tmpdir(), 'tds-static-routing-'));
  await mkdir(join(directory, 'mcp-app-assets', 'assets'), { recursive: true });
  await mkdir(join(directory, 'admin'));
  await writeFile(join(directory, '_headers'), await readFile('assets/_headers'));
  const content = 'export const asset = true;';
  await writeFile(join(directory, 'mcp-app-assets', 'assets', 'fixture-123.js'), content);
  await writeFile(join(directory, 'mcp-app-assets', 'workspace-app.html'), '<!doctype html><title>fixture</title>');
  await writeFile(join(directory, 'admin', 'admin.js'), '/* must require Access */');
  const mf = new Miniflare({ modules: true, script, compatibilityDate: config.compatibility_date,
    d1Databases: { DB: 'static-routing-test' }, log: new Log(LogLevel.ERROR),
    bindings: { RELEASE_VERSION: 'test', DEVSPACE_VERSION: '1.0.8', CONTROL_API_VERSION: '1',
      PUBLIC_ORIGIN: 'https://team.example.test', ADMIN_TOKEN: 'a'.repeat(43),
      ACCESS_TEAM_DOMAIN: 'https://access.example.test', ACCESS_AUD: 'test' },
    assets: { directory, binding: config.assets.binding,
      routerConfig: { has_user_worker: true, static_routing: {
        user_worker: patterns.filter(p => !p.startsWith('!')),
        asset_worker: patterns.filter(p => p.startsWith('!')).map(p => p.slice(1)),
      } }, assetConfig: { html_handling: config.assets.html_handling } },
  });
  t.after(async () => { await mf.dispose(); await rm(directory, { recursive: true, force: true }); });
  const name = 'fixture-123.js';
  const url = `https://team.example.test/mcp-app-assets/assets/${name}`;
  const response = await mf.dispatchFetch(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.has('X-Request-Id'), false);
  assert.equal(response.headers.has('X-Team-Release'), false);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'cross-origin');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(response.headers.get('Cache-Control'), /immutable/);
  assert.equal(await response.text(), content);
  const head = await mf.dispatchFetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await mf.dispatchFetch(url, { headers: { 'If-None-Match': head.headers.get('ETag') } })).status, 304);
  const html = await mf.dispatchFetch('https://team.example.test/mcp-app-assets/workspace-app.html', { redirect: 'manual' });
  assert.equal(html.status, 200, 'Public HTML does not add a redirect request');
  assert.equal(html.headers.has('X-Request-Id'), false);
  const legacyStatus = await mf.dispatchFetch('https://team.example.test/v1/device/status', { method: 'POST' });
  assert.equal(legacyStatus.status, 404, 'Legacy status is absent from the contracted Worker API');
  assert.ok(legacyStatus.headers.get('X-Request-Id'), 'Local Worker fallback remains observable; production blocks this path before Worker invocation');
  const currentStatus = await mf.dispatchFetch('https://team.example.test/v1/device/status-v2', { method: 'POST' });
  assert.equal(currentStatus.status, 401, 'Current status endpoint remains authenticated Worker traffic');
  assert.ok(currentStatus.headers.get('X-Request-Id'));

  for (const [path, status] of [['/mcp', 401], ['/v1/admin/keys', 401], ['/admin', 403], ['/admin/assets/admin.js', 403], ['/admin/admin.js', 403]]) {
    const denied = await mf.dispatchFetch(`https://team.example.test${path}`);
    assert.equal(denied.status, status, path);
    assert.ok(denied.headers.get('X-Request-Id'), path);
  }
  const health = await mf.dispatchFetch('https://team.example.test/health');
  assert.equal(health.status, 200);
  assert.ok(health.headers.get('X-Request-Id'));
});

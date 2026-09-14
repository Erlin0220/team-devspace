import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { healthMatches, probeDeployment, restoreDeployment, waitForReadiness } from '../scripts/deploy-checks.mjs';

const release = { version: '9.2.1', devspaceVersion: '2.3.4', controlApiVersion: 1 };
const content = 'export const asset = true;';
const assetHeaders = { 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin',
  'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=31536000, immutable' };
const asset = { path: '/mcp-app-assets/test.js', sha256: createHash('sha256').update(content).digest('hex') };
function fixture(overrides = {}) {
  const trace = [];
  return { trace, options: { gateway: 'https://team.example.test', release, adminToken: 'private-admin-token', asset,
    fetcher: async (url, options) => {
      trace.push({ url, options });
      const path = new URL(url).pathname;
      if (overrides[path]) return overrides[path]();
      if (path === '/health') return Response.json({ service: 'team-devspace', release: release.version,
        devspace: release.devspaceVersion, controlApi: release.controlApiVersion });
      if (path === '/v1/admin/keys') return Response.json({ keys: [] });
      return new Response(content, { headers: assetHeaders });
    } } };
}

test('deployment readiness follows both canonical versions, not a baked-in upstream pin', async () => {
  assert.equal(healthMatches({ service: 'team-devspace', release: release.version,
    devspace: release.devspaceVersion, controlApi: release.controlApiVersion }, release), true);
  assert.equal(healthMatches({ service: 'team-devspace', release: release.version,
    devspace: '1.0.8', controlApi: release.controlApiVersion }, release), false);
  assert.equal(healthMatches({ service: 'team-devspace', release: 'old',
    devspace: release.devspaceVersion, controlApi: release.controlApiVersion }, release), false);
  assert.equal(healthMatches({ service: 'team-devspace', release: release.version,
    devspace: release.devspaceVersion, controlApi: 0 }, release), false);
  const f = fixture();
  assert.deepEqual(await probeDeployment(f.options), { release: true, administrator: true, d1: true, assets: true });
  assert.equal(f.trace[1].options.headers.Authorization, 'Bearer private-admin-token');
  assert.equal(f.trace[0].options.headers, undefined);
  assert.equal(f.trace[2].options.headers, undefined);
  assert.ok(f.trace.every(request => request.options.redirect === 'error'));
});

test('green health alone cannot hide broken D1/admin or stale static assets', async () => {
  await assert.rejects(probeDeployment(fixture({ '/v1/admin/keys': () => new Response('unavailable', { status: 503 }) }).options), /admin_or_d1/);
  await assert.rejects(probeDeployment(fixture({ '/mcp-app-assets/test.js': () => new Response('stale', {
    headers: assetHeaders,
  }) }).options), /assets_failed/);
  let attempts = 0;
  const f = fixture({ '/health': () => ++attempts === 1 ? new Response('', { status: 503 })
    : Response.json({ service: 'team-devspace', release: release.version,
      devspace: release.devspaceVersion, controlApi: release.controlApiVersion }) });
  await waitForReadiness(f.options, { interval: 1, timeout: 1000 });
  assert.equal(attempts, 2);
});

test('deployment recovery restores the old route and version, never overwrites an unrelated route', async () => {
  const versions = [{ percentage: 100, version_id: 'previous-version' }];
  const oldRoutes = [{ id: 'route-id', pattern: 'team.example.test/mcp-app-assets/*', script: 'team-devspace-assets' }];
  for (const [existing, expectedFailures] of [[[], []], [oldRoutes, []], [[{ ...oldRoutes[0], script: 'other-service' }], ['asset_route_changed']]]) {
    const calls = [];
    const failures = await restoreDeployment({ deploymentsPath: '/deployments', routesPath: '/routes', oldRoutes,
      previousVersions: versions, uploadAttempted: true,
      api: async (path, method = 'GET', body) => { calls.push({ path, method, body }); return method === 'GET' ? existing : {}; } });
    assert.deepEqual(failures, expectedFailures);
    assert.equal(calls.filter(call => call.path === '/routes' && call.method === 'POST').length, existing.length ? 0 : 1);
    assert.deepEqual(calls.at(-1).body.versions, versions);
  }
  assert.deepEqual(await restoreDeployment({ api: async () => { throw new Error('unavailable'); }, deploymentsPath: '/deployments',
    routesPath: '/routes', oldRoutes, previousVersions: versions, uploadAttempted: true }), ['asset_route', 'worker_version']);
});

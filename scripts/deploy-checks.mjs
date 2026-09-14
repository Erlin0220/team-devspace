import { createHash } from 'node:crypto';

export function healthMatches(value, release) {
  return value?.service === 'team-devspace' && value.release === release.version &&
    value.devspace === release.devspaceVersion && value.controlApi === release.controlApiVersion;
}

// Read-only checks. These deliberately do not claim to prove Cloudflare write
// permissions, a connected employee Tunnel, or a successful ChatGPT tool call.
export async function probeDeployment({ gateway, release, adminToken, asset, fetcher = fetch }) {
  const get = (path, headers) => fetcher(`${gateway}${path}`, {
    headers, redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  const health = await get('/health');
  if (!health.ok || !healthMatches(await health.json(), release)) throw new Error('readiness_release_mismatch');
  const admin = await get('/v1/admin/keys', { Authorization: `Bearer ${adminToken}` });
  if (!admin.ok || !Array.isArray((await admin.json()).keys)) throw new Error('readiness_admin_or_d1_failed');
  if (asset) {
    const response = await get(asset.path);
    if (!response.ok || response.headers.get('Access-Control-Allow-Origin') !== '*' ||
        response.headers.get('Cross-Origin-Resource-Policy') !== 'cross-origin' ||
        response.headers.get('X-Content-Type-Options') !== 'nosniff' ||
        !/immutable/.test(response.headers.get('Cache-Control') ?? '') ||
        response.headers.has('X-Request-Id') ||
        createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex') !== asset.sha256) {
      throw new Error('readiness_assets_failed');
    }
  }
  return { release: true, administrator: true, d1: true, ...(asset ? { assets: true } : {}) };
}

// Restore only snapshotted project-owned routes. Re-read before restoring so an
// ambiguous DELETE timeout or another operator cannot cause a blind overwrite.
export async function restoreDeployment({ api, deploymentsPath, routesPath, oldRoutes, previousVersions, uploadAttempted }) {
  const failures = [];
  if (oldRoutes.length) {
    try {
      const current = await api(routesPath);
      for (const route of oldRoutes) {
        const existing = current.find(item => item.pattern === route.pattern);
        if (!existing) await api(routesPath, 'POST', { pattern: route.pattern, script: route.script });
        else if (existing.script !== route.script) failures.push('asset_route_changed');
      }
    } catch { failures.push('asset_route'); }
  }
  if (uploadAttempted && previousVersions?.length) {
    try {
      await api(deploymentsPath, 'POST', { strategy: 'percentage', versions: previousVersions,
        annotations: { 'workers/message': 'Recover previous release after failed deployment readiness' } });
    } catch { failures.push('worker_version'); }
  }
  return failures;
}

export async function waitForReadiness(options, { timeout = 90000, interval = 2000 } = {}) {
  const deadline = Date.now() + timeout;
  let failure;
  do {
    try { return await probeDeployment(options); }
    catch (error) { failure = error; }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, interval));
  } while (Date.now() < deadline);
  throw new Error(`Deployment readiness failed: ${failure?.message ?? 'unknown'}`);
}

import { equalSecret, seal, sha256, unseal } from './crypto.mjs';
import { KeyStore } from './store.mjs';
import { Cloudflare, CloudflareError } from './cloudflare.mjs';
import assets from './assets.mjs';
import { AdminService, AdminServiceError } from './admin-service.mjs';
import { adminWeb, adminWebError, AdminWebError } from './admin-web.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const MCP_LIMIT = 16 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function json(value, status = 200) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

function bearer(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(request.headers.get('Authorization') ?? '');
  if (!match) throw new HttpError(401, 'credential_required');
  return match[1];
}

async function smallJson(request) {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'json_required');
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'body_required');
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 16384) { await reader.cancel(); throw new HttpError(413, 'body_too_large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, 'invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, 'invalid_body');
  return value;
}

async function employeeKey(request, store) {
  const key = bearer(request);
  if (!/^tds_[A-Za-z0-9_-]{43}$/.test(key)) throw new HttpError(401, 'invalid_access_key');
  const row = await store.byHash(await sha256(key));
  if (!row || row.state === 'revoked') throw new HttpError(401, 'invalid_access_key');
  return row;
}

async function enrollmentPreflight(request, store) {
  const key = await employeeKey(request, store);
  await smallJson(request);
  return json({ available: key.state === 'issued' });
}

async function enroll(request, env, store) {
  const key = await employeeKey(request, store);
  const body = await smallJson(request);
  if (!UUID.test(body.deviceId ?? '') || !SECRET.test(body.deviceSecret ?? '') ||
      !Number.isInteger(body.bridgePort) || body.bridgePort < 1024 || body.bridgePort > 65535) {
    throw new HttpError(400, 'invalid_enrollment');
  }
  const deviceHash = await sha256(body.deviceSecret);
  let row = key;
  if (row.state === 'issued') {
    const bindingId = crypto.randomUUID();
    row = await store.bind(row.id, {
      deviceId: body.deviceId, deviceSecretHash: deviceHash,
      deviceSecretBox: await seal(body.deviceSecret, env.MASTER_KEY, bindingId),
      bindingId, bridgePort: body.bridgePort,
    });
  }
  // Knowing only the employee key cannot recover tunnel credentials from an existing binding.
  if (!row || !['provisioning', 'active', 'suspended'].includes(row.state) ||
      row.device_id !== body.deviceId || !equalSecret(row.device_secret_hash, deviceHash) ||
      row.bridge_port !== body.bridgePort) throw new HttpError(409, 'access_key_already_bound');

  const cloud = new Cloudflare(env);
  const tunnel = await cloud.ensureTunnel(row);
  if (!await store.saveTunnel(row.id, row.binding_id, tunnel.id, tunnel.hostname)) {
    await cloud.remove({ ...row, tunnel_id: tunnel.id, hostname: tunnel.hostname });
    throw new HttpError(409, 'enrollment_cancelled');
  }
  row = { ...row, tunnel_id: tunnel.id, hostname: tunnel.hostname };
  const configured = await cloud.configure(row);
  if (!await store.activate(row.id, row.binding_id, configured.dnsId)) {
    await cloud.remove({ ...row, dns_id: configured.dnsId });
    throw new HttpError(409, 'enrollment_cancelled');
  }
  const controlApiVersion = Number(env.CONTROL_API_VERSION);
  if (!Number.isInteger(controlApiVersion) || controlApiVersion < 1) throw new HttpError(503, 'release_not_configured');
  return json({ keyId: row.id, deviceId: row.device_id, bindingId: row.binding_id,
    hostname: row.hostname, tunnelToken: configured.tunnelToken,
    endpoint: `${publicOrigin(env)}/mcp`, devspaceVersion: env.DEVSPACE_VERSION, controlApiVersion,
    state: row.state === 'suspended' ? 'suspended' : 'active' });
}

function publicOrigin(env) {
  const url = new URL(env.PUBLIC_ORIGIN);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new HttpError(503, 'gateway_not_configured');
  }
  return url.origin;
}

async function deviceIdentity(request, store, allowedStates = ['active', 'suspended']) {
  const secret = bearer(request);
  const body = await smallJson(request);
  if (!UUID.test(body.keyId ?? '') || !UUID.test(body.bindingId ?? '')) throw new HttpError(400, 'invalid_device');
  const row = await store.byId(body.keyId);
  if (!row || !allowedStates.includes(row.state) || row.binding_id !== body.bindingId ||
      !equalSecret(row.device_secret_hash, await sha256(secret))) throw new HttpError(403, 'device_disabled');
  return { row, secret };
}

async function deviceStatus(request, store) {
  const { row } = await deviceIdentity(request, store);
  return json({ state: row.state, deviceId: row.device_id, bindingId: row.binding_id });
}

async function suspendDevice(request, store) {
  const { row } = await deviceIdentity(request, store);
  if (!await store.suspend(row.id, row.binding_id)) throw new HttpError(409, 'access_lifecycle_changed');
  return json({ state: 'suspended', deviceId: row.device_id, bindingId: row.binding_id });
}

async function releaseDevice(request, env, store) {
  let { row } = await deviceIdentity(request, store, ['active', 'suspended', 'resetting']);
  if (row.state !== 'resetting') {
    row = await store.disable(row.id, 'reset', row.binding_id);
    if (!row) throw new HttpError(409, 'access_lifecycle_changed');
  }
  try { await new Cloudflare(env).remove(row); }
  catch { throw new HttpError(503, 'connectivity_cleanup_pending'); }
  if (!await store.finishCleanup(row.id, row.binding_id, 'reset')) throw new HttpError(409, 'access_lifecycle_changed');
  return json({ released: true, keyId: row.id });
}

async function resumeDevice(request, store) {
  const { row, secret } = await deviceIdentity(request, store);
  if (row.state === 'suspended') {
    if (!row.hostname || !row.tunnel_id) throw new HttpError(503, 'device_not_ready');
    let health;
    try {
      health = await fetch(`https://${row.hostname}/healthz`, {
        headers: { Authorization: `Bearer ${secret}`, 'X-Team-Binding-Id': row.binding_id },
        redirect: 'manual', signal: AbortSignal.timeout(10000),
      });
    } catch { throw new HttpError(503, 'device_offline'); }
    if (health.status !== 200) {
      await health.body?.cancel();
      throw new HttpError(503, 'device_not_ready');
    }
    await health.body?.cancel();
  }
  if (!await store.resume(row.id, row.binding_id)) throw new HttpError(409, 'access_lifecycle_changed');
  return json({ state: 'active', deviceId: row.device_id, bindingId: row.binding_id });
}

async function admin(request, env, store, pathname) {
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32) throw new HttpError(503, 'admin_not_configured');
  if (!equalSecret(bearer(request), env.ADMIN_TOKEN)) throw new HttpError(401, 'invalid_admin_credential');
  const service = new AdminService(store, { remove: row => new Cloudflare(env).remove(row) });
  if (pathname === '/v1/admin/keys' && request.method === 'GET') return json({ keys: await service.listKeys() });
  if (pathname === '/v1/admin/keys' && request.method === 'POST') {
    const body = await smallJson(request);
    if (!UUID.test(body.id ?? '') || !HASH.test(body.keyHash ?? '') ||
        typeof body.label !== 'string' || !body.label.trim() || body.label.length > 100 || /[\x00-\x1f]/.test(body.label)) {
      throw new HttpError(400, 'invalid_key_request');
    }
    return json(await service.issueKey({ ...body, label: body.label.trim() }), 201);
  }
  const match = /^\/v1\/admin\/keys\/([a-f0-9-]+)\/(revoke|reset)$/.exec(pathname);
  if (!match || request.method !== 'POST' || !UUID.test(match[1])) throw new HttpError(404, 'not_found');
  const [, id, operation] = match;
  const result = operation === 'revoke' ? await service.revokeKey(id) : await service.resetDevice(id);
  return json({ ...result.key, cleanup: result.cleanup,
    ...(result.error ? { error: result.error, retryable: result.retryable } : {}) }, result.error ? 503 : 200);
}

function boundedBody(body) {
  if (!body) return null;
  let total = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > MCP_LIMIT) { controller.error(new Error('MCP request too large')); return; }
      controller.enqueue(chunk);
    },
  }));
}

async function proxyMcp(request, env, store) {
  if (!['GET', 'POST', 'DELETE'].includes(request.method)) throw new HttpError(405, 'method_not_allowed');
  const row = await employeeKey(request, store);
  if (row.state === 'suspended') throw new HttpError(403, 'remote_access_suspended');
  if (row.state !== 'active' || !row.hostname || !row.tunnel_id) throw new HttpError(503, 'device_not_ready');
  if (Number(request.headers.get('Content-Length') ?? 0) > MCP_LIMIT) throw new HttpError(413, 'body_too_large');
  const headers = new Headers();
  for (const name of ['accept', 'content-type', 'mcp-protocol-version', 'last-event-id']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const session = request.headers.get('mcp-session-id');
  if (session) {
    const prefix = `${row.binding_id}.`;
    if (!session.startsWith(prefix) || session.length > 512) throw new HttpError(404, 'mcp_session_invalid');
    headers.set('mcp-session-id', session.slice(prefix.length));
  }
  headers.set('Authorization', `Bearer ${await unseal(row.device_secret_box, env.MASTER_KEY, row.binding_id)}`);
  headers.set('X-Team-Binding-Id', row.binding_id);
  headers.set('Cache-Control', 'no-store');
  let upstream;
  try {
    upstream = await fetch(`https://${row.hostname}/mcp`, {
      method: request.method, headers, body: boundedBody(request.body), redirect: 'manual',
      signal: request.signal,
    });
  } catch { throw new HttpError(503, 'device_offline'); }
  if (upstream.status >= 500 || upstream.status === 530) {
    await upstream.body?.cancel();
    throw new HttpError(503, 'device_offline');
  }
  if (upstream.status >= 300 && upstream.status < 400) {
    await upstream.body?.cancel();
    throw new HttpError(502, 'unexpected_device_redirect');
  }
  if (upstream.status === 401 || upstream.status === 403) {
    await upstream.body?.cancel();
    throw new HttpError(502, 'device_authentication_failed');
  }
  const output = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  for (const name of ['content-type', 'mcp-protocol-version', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value) output.set(name, value);
  }
  const upstreamSession = upstream.headers.get('mcp-session-id');
  if (upstreamSession) output.set('mcp-session-id', `${row.binding_id}.${upstreamSession}`);
  return new Response(upstream.body, { status: upstream.status, headers: output });
}

export async function reconcileCleanup(env, dependencies = {}) {
  const store = dependencies.store ?? new KeyStore(env.DB);
  const cloud = dependencies.cloud ?? new Cloudflare(env);
  let completed = 0;
  for (let row of await store.cleanupCandidates()) {
    const operation = row.state === 'revoked' ? 'revoke' : 'reset';
    if (row.state === 'provisioning') row = await store.expireProvisioning(row);
    if (!row) continue;
    try {
      await cloud.remove(row);
      if (await store.finishCleanup(row.id, row.binding_id, operation)) completed++;
    } catch (error) {
      console.log(JSON.stringify({ event: 'cleanup_retry_failed', keyId: row.id,
        code: error instanceof CloudflareError ? error.code : 'cloudflare_unavailable' }));
    }
  }
  console.log(JSON.stringify({ event: 'cleanup_reconciled', completed }));
}

// Return only internal enum values. Never log dynamic paths, labels or IDs.
export function requestOperation(method, pathname) {
  if (pathname.startsWith('/admin/assets/')) return 'admin_web_asset';
  if ((pathname === '/admin' || pathname === '/admin/') && method === 'GET') return 'admin_web_list';
  if (pathname === '/admin/keys' && method === 'POST') return 'admin_web_issue';
  const webAction = /^\/admin\/keys\/([a-f0-9-]+)\/(revoke|reset)$/.exec(pathname);
  if (method === 'POST' && webAction && UUID.test(webAction[1])) return `admin_web_${webAction[2]}`;
  if (pathname.startsWith('/mcp-app-assets/')) return 'assets';
  if (pathname === '/health' && method === 'GET') return 'health';
  if (pathname === '/mcp') return 'mcp';
  if (pathname === '/v1/enrollment/preflight' && method === 'POST') return 'enrollment_preflight';
  if (pathname === '/v1/enroll' && method === 'POST') return 'enroll';
  if (pathname === '/v1/device/status' && method === 'POST') return 'device_status';
  if (pathname === '/v1/device/suspend' && method === 'POST') return 'device_suspend';
  if (pathname === '/v1/device/resume' && method === 'POST') return 'device_resume';
  if (pathname === '/v1/device/release' && method === 'POST') return 'device_release';
  if (pathname === '/v1/admin/keys' && method === 'GET') return 'admin_list_keys';
  if (pathname === '/v1/admin/keys' && method === 'POST') return 'admin_issue_key';
  const action = /^\/v1\/admin\/keys\/([a-f0-9-]+)\/(revoke|reset)$/.exec(pathname);
  if (method === 'POST' && action && UUID.test(action[1])) return `admin_${action[2]}`;
  return 'not_found';
}

export default {
  async fetch(request, env) {
    const started = Date.now();
    const pathname = new URL(request.url).pathname;
    const requestId = crypto.randomUUID();
    const operation = requestOperation(request.method, pathname);
    let response;
    let errorCode;
    try {
      // Static assets retain cache-busting query support. Control/MCP routes do
      // not accept credentials or other data in a query string.
      if (operation === 'assets') response = await assets.fetch(request, env);
      else {
        if (new URL(request.url).search) throw new HttpError(400, 'query_parameters_not_supported');
        if (operation === 'health') {
          const controlApiVersion = Number(env.CONTROL_API_VERSION);
          if (!env.RELEASE_VERSION || !env.DEVSPACE_VERSION || !Number.isInteger(controlApiVersion) || controlApiVersion < 1) {
            throw new HttpError(503, 'release_not_configured');
          }
          response = json({ service: 'team-devspace', release: env.RELEASE_VERSION,
            devspace: env.DEVSPACE_VERSION, controlApi: controlApiVersion });
        } else {
          const store = new KeyStore(env.DB);
          if (pathname === '/mcp') response = await proxyMcp(request, env, store);
          else if (operation === 'enrollment_preflight') response = await enrollmentPreflight(request, store);
          else if (operation === 'enroll') response = await enroll(request, env, store);
          else if (operation === 'device_status') response = await deviceStatus(request, store);
          else if (operation === 'device_suspend') response = await suspendDevice(request, store);
          else if (operation === 'device_resume') response = await resumeDevice(request, store);
          else if (operation === 'device_release') response = await releaseDevice(request, env, store);
          else if (pathname.startsWith('/v1/admin/')) response = await admin(request, env, store, pathname);
          else if (pathname.startsWith('/admin')) response = await adminWeb(request, env,
            new AdminService(store, { remove: row => new Cloudflare(env).remove(row) }));
          else throw new HttpError(404, 'not_found');
        }
      }
    } catch (error) {
      const status = error instanceof HttpError || error instanceof AdminServiceError || error instanceof AdminWebError
        ? error.status : 503;
      const code = error instanceof HttpError || error instanceof AdminServiceError ||
        error instanceof AdminWebError || error instanceof CloudflareError
        ? error.code : 'service_unavailable';
      errorCode = code;
      response = pathname.startsWith('/admin') ? adminWebError(error, requestId) : pathname === '/mcp'
        ? json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: code, data: { requestId } } }, status)
        : json({ error: code, requestId }, status);
      if (status === 401) response.headers.set('WWW-Authenticate', 'Bearer realm="Team DevSpace"');
    }
    response.headers.set('X-Request-Id', requestId);
    if (env.RELEASE_VERSION) response.headers.set('X-Team-Release', env.RELEASE_VERSION);
    if (!errorCode && response.status >= 400) {
      errorCode = response.status === 503 && ['admin_revoke', 'admin_reset'].includes(operation)
        ? 'connectivity_cleanup_pending' : 'request_rejected';
    }
    // Deliberately no URL query, headers, credentials, input, output, or exception text.
    console.log(JSON.stringify({ event: 'request', requestId, operation, status: response.status,
      ...(errorCode ? { code: errorCode } : {}), durationMs: Date.now() - started }));
    return response;
  },
  scheduled(controller, env, ctx) {
    ctx.waitUntil(reconcileCleanup(env));
  },
};

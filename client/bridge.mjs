import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { Transform } from 'node:stream';
import { LocalOAuth } from './oauth.mjs';

const REQUEST_LIMIT = 16 * 1024 * 1024;

function matchesSecret(value, expected) {
  const a = Buffer.from(value ?? '');
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function fail(res, status, message, headers = {}) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message } }));
}

function rewriteOpenWorkspaceMessage(message, state) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
  if (message.method !== 'tools/call' || message.params?.name !== 'open_workspace') return false;
  const arguments_ = message.params.arguments && typeof message.params.arguments === 'object' && !Array.isArray(message.params.arguments)
    ? { ...message.params.arguments }
    : {};
  const root = state.currentProjectRoot;
  if (typeof root !== 'string' || !root) return false;
  // open_workspace requires a path, but Team DevSpace has exactly one current
  // project on the connected Device. Treat the caller path as compatibility-only:
  // never map Windows paths to macOS/Linux or select among multiple roots.
  message.params = { ...message.params, arguments: { ...arguments_, path: root } };
  return true;
}

export function rewriteMcpRequestBody(body, state) {
  if (!body.length) return body;
  let payload;
  try { payload = JSON.parse(body.toString('utf8')); } catch { return body; }
  let changed = false;
  if (Array.isArray(payload)) {
    for (const message of payload) changed = rewriteOpenWorkspaceMessage(message, state) || changed;
  } else {
    changed = rewriteOpenWorkspaceMessage(payload, state);
  }
  return changed ? Buffer.from(JSON.stringify(payload)) : body;
}

export function createBridge(state, home) {
  const oauth = new LocalOAuth(state, home);
  let activeWork = 0, lastWorkAt = Date.now(), updateDrainUntil = 0;
  return http.createServer(async (req, res) => {
    if (!matchesSecret(req.headers.authorization, `Bearer ${state.deviceSecret}`)) {
      fail(res, 401, 'device_credential_required'); return;
    }
    if (req.headers['x-team-binding-id'] !== state.bindingId) {
      fail(res, 403, 'device_binding_mismatch'); return;
    }
    if (req.url === '/healthz' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ service: 'team-devspace-bridge', deviceId: state.deviceId, bindingId: state.bindingId }));
      return;
    }
    if (req.url === '/update-drain' && ['GET', 'POST', 'DELETE'].includes(req.method)) {
      req.resume();
      if (req.method === 'DELETE') updateDrainUntil = 0;
      else {
        const automatic = req.headers['x-team-update-mode'] === 'automatic';
        if (activeWork || (automatic && Date.now() - lastWorkAt < 10 * 60 * 1000)) { fail(res, 409, 'remote_work_active'); return; }
        // A bounded admission pause, not another installer/rollback state machine.
        // Failed handoffs release it; process restart or expiry also recovers it.
        if (req.method === 'POST') updateDrainUntil = Date.now() + 10 * 60 * 1000;
      }
      res.writeHead(200, { 'Cache-Control': 'no-store' }); res.end(); return;
    }
    if (req.url !== '/mcp' || !['GET', 'POST', 'DELETE'].includes(req.method)) {
      fail(res, 404, 'not_found'); return;
    }
    if (Number(req.headers['content-length'] ?? 0) > REQUEST_LIMIT) {
      fail(res, 413, 'body_too_large'); return;
    }
    if (req.method === 'POST') {
      if (Date.now() < updateDrainUntil) {
        fail(res, 503, 'client_update_in_progress', { 'X-Team-Update-State': 'installing', 'Retry-After': '30' }); return;
      }
      activeWork++; lastWorkAt = Date.now();
      res.once('close', () => { activeWork--; lastWorkAt = Date.now(); });
    }
    let token;
    try { token = await oauth.token(); } catch { fail(res, 503, 'local_devspace_unavailable'); return; }
    if (req.destroyed || res.destroyed) return;
    const headers = { Authorization: `Bearer ${token}` };
    for (const name of ['accept', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'last-event-id']) {
      if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
    }
    // Responses stay streamed. Requests are bounded; open_workspace is pinned to this Device's one current project.
    const upstream = http.request({ hostname: '127.0.0.1', port: state.ports.devspace,
      path: '/mcp', method: req.method, headers }, response => {
      const output = { 'Cache-Control': 'no-store' };
      for (const name of ['content-type', 'mcp-session-id', 'mcp-protocol-version', 'retry-after']) {
        if (typeof response.headers[name] === 'string') output[name] = response.headers[name];
      }
      res.writeHead(response.statusCode, output);
      response.on('error', () => res.destroy());
      response.pipe(res);
    });
    upstream.setTimeout(370000, () => upstream.destroy(new Error('Local MCP timeout')));
    upstream.on('error', () => fail(res, 503, 'local_devspace_unavailable'));
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    let bytes = 0;
    const chunks = [];
    const limit = new Transform({
      transform(chunk, encoding, callback) {
        bytes += chunk.length;
        if (bytes > REQUEST_LIMIT) { fail(res, 413, 'body_too_large'); upstream.destroy(); callback(new Error('Request too large')); }
        else { chunks.push(Buffer.from(chunk)); callback(); }
      },
      flush(callback) {
        try { callback(null, rewriteMcpRequestBody(Buffer.concat(chunks), state)); }
        catch (error) { callback(error); }
      },
    });
    limit.on('error', () => upstream.destroy());
    req.on('error', () => upstream.destroy());
    req.pipe(limit).pipe(upstream);
  });
}

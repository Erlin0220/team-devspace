import { createServer } from 'node:http';
import { randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { runWindowsDesktop } from './windows-desktop.mjs';
import { desktopErrorText } from './desktop.mjs';
import { atomicJson, randomSecret, readJson, secureStateDirectory, stateHome } from './state.mjs';

export const CONTROL_UI_PREFERRED_PORT = 53682;
const CONTROL_UI_FALLBACK_MIN = 49152;
const CONTROL_UI_FALLBACK_MAX = 65535;

const ASSETS = { '/': ['control.html', 'text/html; charset=utf-8'],
  '/diagnostics': ['control.html', 'text/html; charset=utf-8'],
  '/about': ['control.html', 'text/html; charset=utf-8'],
  '/updates': ['control.html', 'text/html; charset=utf-8'],
  '/control.js': ['control.js', 'text/javascript; charset=utf-8'],
  '/control.css': ['control.css', 'text/css; charset=utf-8'],
  '/devspace-logo-light.png': ['devspace-logo-light.png', 'image/png'] };
const ACTIONS = new Set(['check', 'suspend', 'resume', 'restart', 'repair', 'setup', 'switch-key',
  'project-root', 'choose-folder', 'logs', 'update-check', 'update-apply', 'update-auto']);
const badRequest = (message, status = 400) => Object.assign(new Error(message), { status });

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0, chunks = [], exceeded = false;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 8192) {
        chunks = [];
        if (!exceeded) { exceeded = true; reject(badRequest('请求内容过大', 413)); }
      } else chunks.push(chunk);
    });
    request.once('error', reject);
    request.once('end', () => {
      if (exceeded) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(badRequest('无效的 JSON 请求')); }
    });
  });
}

export async function openControlBrowser(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1') throw new Error('Invalid local Control Center URL');
  if (process.platform === 'win32') {
    await runWindowsDesktop('Start-Process -FilePath $env:TEAM_DEVSPACE_CONTROL_URL',
      { env: { TEAM_DEVSPACE_CONTROL_URL: url } });
  } else {
    await promisify(execFile)(process.platform === 'darwin' ? '/usr/bin/open' : 'xdg-open', [url],
      { timeout: 10000, maxBuffer: 16384 });
  }
}

// Exact bind primitive. Production chooses and persists a preferred endpoint separately.
export async function listenOnBrowserPort(server, port = CONTROL_UI_PREFERRED_PORT) {
  try {
    await new Promise((resolve, reject) => {
      const cleanup = () => { server.removeListener('error', failed); server.removeListener('listening', ready); };
      const failed = error => { cleanup(); reject(error); };
      const ready = () => { cleanup(); resolve(); };
      server.once('error', failed).once('listening', ready);
      server.listen(port, '127.0.0.1');
    });
  } catch (error) {
    if (['EADDRINUSE', 'EACCES'].includes(error.code)) {
      throw Object.assign(new Error(`本机控制中心端口 ${port} 无法使用；请关闭占用该端口的程序后重新启动 Team DevSpace。`, { cause: error }),
        { code: error.code, port });
    }
    throw error;
  }
}

function validControlPort(value) {
  return Number.isInteger(value) && value >= CONTROL_UI_FALLBACK_MIN && value <= CONTROL_UI_FALLBACK_MAX;
}

async function readControlEndpoint(path) {
  try {
    const value = await readJson(path, null);
    return value?.schema === 1 && validControlPort(value.port) ? value : null;
  } catch {
    return null;
  }
}

async function listenOnPersistentControlPort(server, home, {
  preferredPort = CONTROL_UI_PREFERRED_PORT, retryAttempts = 12, retryDelayMs = 250, legacyEndpointExpected = false, boundPort,
  chooseFallbackPort = () => randomInt(CONTROL_UI_FALLBACK_MIN, CONTROL_UI_FALLBACK_MAX + 1),
} = {}) {
  const previous = await readControlEndpoint(join(home, 'control-endpoint.json'));
  const requested = validControlPort(boundPort) ? boundPort : previous?.port ?? preferredPort;
  let lastError;
  for (let attempt = 0; attempt < retryAttempts; attempt++) {
    try {
      await listenOnBrowserPort(server, requested);
      return { port: server.address().port, migratedFrom: null };
    } catch (error) {
      if (error.code === 'EACCES') { lastError = error; break; }
      if (error.code !== 'EADDRINUSE') throw error;
      lastError = error;
      if (attempt + 1 < retryAttempts) await sleep(retryDelayMs);
    }
  }
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = chooseFallbackPort();
    if (!validControlPort(candidate) || candidate === requested) continue;
    try {
      await listenOnBrowserPort(server, candidate);
      const actual = server.address().port;
      return { port: actual, fallback: true, migratedFrom: validControlPort(boundPort) ? boundPort : previous?.port ?? (legacyEndpointExpected ? requested : null) };
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code)) throw error;
      lastError = error;
    }
  }
  throw Object.assign(new Error('Control Center could not find an available loopback port', { cause: lastError }),
    { code: lastError?.code ?? 'control_port_unavailable' });
}

function validCapabilityState(value) {
  return value?.schema === 1 && /^[A-Za-z0-9_-]{43}$/.test(value.token ?? '') &&
    (value.port === undefined || (Number.isInteger(value.port) && value.port > 0 && value.port <= 65535));
}
async function controlCapability(home) {
  await secureStateDirectory(home);
  const path = join(home, 'control-capability.json');
  const existing = await readJson(path, null);
  if (existing !== null) {
    if (validCapabilityState(existing)) return { token: existing.token, existing: true, port: existing.port };
    throw new Error('本机控制中心 capability 凭据无效；请从受信任的安装恢复本机状态。');
  }
  const token = randomSecret();
  if (await atomicJson(path, { schema: 1, token }, { createOnly: true })) return { token, existing: false };
  const winner = await readJson(path);
  if (validCapabilityState(winner)) return { token: winner.token, existing: true, port: winner.port };
  throw new Error('本机控制中心 capability 凭据无效；请从受信任的安装恢复本机状态。');
}

// A loopback UI in the existing desktop process, never a Gateway/bridge route.
// Its private capability survives a normal upgrade so the same already-open page
// can reconnect; the capability is only delivered in a URL fragment.
export async function startLocalControl(controller, { openBrowser = openControlBrowser, home = stateHome(),
  port, capability, preferredPort = CONTROL_UI_PREFERRED_PORT, portRetryAttempts, portRetryDelayMs, chooseFallbackPort } = {}) {
  const resolvedCapability = capability === undefined ? await controlCapability(home) : { token: capability, existing: true };
  let token = resolvedCapability.token;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid local Control Center capability');
  const instanceId = randomUUID();
  let authorization = Buffer.from(`Bearer ${token}`);
  const assets = new Map(await Promise.all(Object.entries(ASSETS).map(async ([path, [file, type]]) =>
    [path, { bytes: await readFile(new URL(file, import.meta.url)), type }])));
  let origin;
  const server = createServer(async (request, response) => {
    const send = (status, value, type = 'application/json; charset=utf-8') => {
      if (!response.writableEnded) response.writeHead(status, { 'Content-Type': type }).end(
        typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    };
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      if (request.headers.host !== new URL(origin).host ||
          (request.headers.origin && request.headers.origin !== origin) ||
          request.headers['sec-fetch-site'] === 'cross-site') throw badRequest('拒绝跨站访问', 403);
      if (request.method === 'GET' && request.url === '/favicon.ico') return send(204, '');
      const asset = assets.get(request.url);
      if (request.method === 'GET' && asset) return send(200, asset.bytes, asset.type);
      const supplied = Buffer.from(request.headers.authorization ?? '');
      if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
        throw badRequest('请从系统托盘重新打开控制中心', 401);
      }
      if (request.method === 'GET' && request.url === '/api/state') return send(200, { ...controller.snapshot(), controlInstance: instanceId });
      if (request.method === 'GET' && request.url === '/api/diagnostics') {
        return send(200, await controller.dispatch('diagnostics'));
      }
      const localUrl = new URL(request.url, origin);
      if (request.method === 'GET' && localUrl.pathname === '/api/release-notes') {
        if ([...localUrl.searchParams.keys()].some(key => key !== 'version') || localUrl.searchParams.getAll('version').length !== 1 ||
            !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(localUrl.searchParams.get('version') ?? '')) throw badRequest('更新版本无效');
        return send(200, await controller.dispatch('release-notes', { version: localUrl.searchParams.get('version') }));
      }
      if (request.method !== 'POST' || request.url !== '/api/action') throw badRequest('未找到此操作', 404);
      if (request.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
        throw badRequest('仅接受本地控制中心的 JSON 操作', 403);
      }
      const body = await readBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !ACTIONS.has(body.action) ||
          Object.keys(body).some(key => !['action', 'accessKey', 'projectRoot', 'enabled', 'version'].includes(key))) throw badRequest('未知控制操作');
      if (body.action === 'update-auto' && typeof body.enabled !== 'boolean') throw badRequest('更新偏好无效');
      if (['setup', 'switch-key'].includes(body.action) && !/^tds_[A-Za-z0-9_-]{43}$/.test(body.accessKey ?? '')) {
        throw badRequest('请输入管理员发放的完整 Access Key');
      }
      if (body.projectRoot !== undefined && (typeof body.projectRoot !== 'string' || body.projectRoot.length > 4096 || body.projectRoot.includes('\0'))) {
        throw badRequest('项目目录无效');
      }
      if (body.version !== undefined && (body.action !== 'update-apply' || !/^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(body.version))) {
        throw badRequest('更新版本无效');
      }
      if ((body.action === 'setup' || (body.action === 'project-root' && body.projectRoot !== undefined)) && !body.projectRoot?.trim()) throw badRequest('请输入项目目录');
      const result = await controller.dispatch(body.action, { accessKey: body.accessKey, projectRoot: body.projectRoot,
        enabled: body.enabled, confirmedVersion: body.version });
      // Return only allowlisted picker/update facts, never arbitrary operation or state objects.
      const updateOutcome = body.action === 'update-apply' ? {
        state: result?.cancelled ? 'cancelled' : result?.handedOff ? 'handed-off' : result?.deferred ? 'deferred' : 'unchanged',
        version: typeof result?.version === 'string' ? result.version : body.version,
      } : undefined;
      const updateCheck = body.action === 'update-check' ? {
        available: result?.available === true, required: result?.required === true,
        targetVersion: typeof result?.policy?.stable === 'string' ? result.policy.stable : undefined,
        error: typeof result?.error === 'string' ? result.error : null,
      } : undefined;
      send(200, { ok: true, ...(body.action === 'choose-folder' ? { projectRoot: result ?? null } : {}),
        ...(updateOutcome ? { updateOutcome } : {}), ...(updateCheck ? { updateCheck } : {}) });
    } catch (error) { send([400, 401, 403, 404, 409, 413].includes(error.status) ? error.status : 500, { error: desktopErrorText(error) }); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.destroy());
  let endpoint;
  try {
    endpoint = port === undefined
      ? await listenOnPersistentControlPort(server, home, { preferredPort, retryAttempts: portRetryAttempts,
        retryDelayMs: portRetryDelayMs, chooseFallbackPort, legacyEndpointExpected: resolvedCapability.existing, boundPort: resolvedCapability.port })
      : (await listenOnBrowserPort(server, port), { port: server.address().port, migratedFrom: null });
    if (capability === undefined && (port === 0 || endpoint.fallback || endpoint.migratedFrom ||
        (resolvedCapability.port !== undefined && resolvedCapability.port !== endpoint.port))) {
      token = randomSecret();
      authorization = Buffer.from(`Bearer ${token}`);
    }
    // Port affinity belongs to the credential, not the optional endpoint cache.
    // Cache write failure must never allow the same token to cross origins later.
    if (capability === undefined && (resolvedCapability.port !== endpoint.port || token !== resolvedCapability.token)) {
      await atomicJson(join(home, 'control-capability.json'), { schema: 1, token, port: endpoint.port });
    }
    endpoint.persisted = port === undefined
      ? await atomicJson(join(home, 'control-endpoint.json'), { schema: 1, port: endpoint.port }).then(() => true, () => false)
      : false;
  } catch (error) {
    if (server.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(() => resolve()));
    }
    throw error;
  }
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/#${token}`, port: endpoint.port, migratedFrom: endpoint.migratedFrom, endpointPersisted: endpoint.persisted,
    open: section => openBrowser(`${origin}/${['diagnostics', 'about', 'updates'].includes(section) ? section : ''}#${token}`),
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      // The owner settles controller transactions before closing this surface.
      // Do not leave desktop exit waiting on a stale browser/slow HTTP client.
      server.closeAllConnections();
    }),
  };
}

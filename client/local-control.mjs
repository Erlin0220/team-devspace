import { createServer } from 'node:http';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runWindowsDesktop } from './windows-desktop.mjs';
import { desktopErrorText } from './desktop.mjs';

const ASSETS = { '/': ['control.html', 'text/html; charset=utf-8'],
  '/control.js': ['control.js', 'text/javascript; charset=utf-8'],
  '/control.css': ['control.css', 'text/css; charset=utf-8'] };
const ACTIONS = new Set(['check', 'suspend', 'resume', 'restart', 'repair', 'setup', 'switch-key',
  'project-root', 'choose-folder', 'logs']);
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

// Use the dynamic/private range, outside Fetch's restricted ports. Some hosts
// configure a wider ephemeral range, so listen(0) can return a browser-blocked
// port. Bind directly and retry contention; do not probe then release a socket.
export async function listenOnBrowserPort(server, choosePort = () => randomInt(49152, 65536)) {
  for (let attempt = 0; attempt < 16; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => { server.removeListener('error', failed); server.removeListener('listening', ready); };
        const failed = error => { cleanup(); reject(error); };
        const ready = () => { cleanup(); resolve(); };
        server.once('error', failed).once('listening', ready);
        server.listen(choosePort(), '127.0.0.1');
      });
      return;
    } catch (error) {
      if (!['EADDRINUSE', 'EACCES'].includes(error.code) || attempt === 15) throw error;
    }
  }
}

// A lazy loopback UI in the existing desktop process, never a Gateway/bridge route.
// The per-process capability is delivered in a URL fragment (not an HTTP request).
export async function startLocalControl(controller, { openBrowser = openControlBrowser } = {}) {
  const token = randomBytes(32).toString('base64url');
  const authorization = Buffer.from(`Bearer ${token}`);
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
    response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
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
      if (request.method === 'GET' && request.url === '/api/state') return send(200, controller.snapshot());
      if (request.method === 'GET' && request.url === '/api/diagnostics') {
        return send(200, await controller.dispatch('diagnostics'));
      }
      if (request.method !== 'POST' || request.url !== '/api/action') throw badRequest('未找到此操作', 404);
      if (request.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) {
        throw badRequest('仅接受本地控制中心的 JSON 操作', 403);
      }
      const body = await readBody(request);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !ACTIONS.has(body.action) ||
          Object.keys(body).some(key => !['action', 'accessKey', 'projectRoot'].includes(key))) throw badRequest('未知控制操作');
      if (['setup', 'switch-key'].includes(body.action) && !/^tds_[A-Za-z0-9_-]{43}$/.test(body.accessKey ?? '')) {
        throw badRequest('请输入管理员发放的完整 Access Key');
      }
      if (body.projectRoot !== undefined && (typeof body.projectRoot !== 'string' || body.projectRoot.length > 4096 || body.projectRoot.includes('\0'))) {
        throw badRequest('项目目录无效');
      }
      if (['setup', 'project-root'].includes(body.action) && !body.projectRoot?.trim()) throw badRequest('请输入项目目录');
      const result = await controller.dispatch(body.action, { accessKey: body.accessKey, projectRoot: body.projectRoot });
      // Only a folder picker returns data. Never serialize arbitrary operation/state objects.
      send(200, { ok: true, ...(body.action === 'choose-folder' ? { projectRoot: result ?? null } : {}) });
    } catch (error) { send([400, 401, 403, 404, 409, 413].includes(error.status) ? error.status : 500, { error: desktopErrorText(error) }); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  server.on('clientError', (_error, socket) => socket.destroy());
  await listenOnBrowserPort(server);
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    url: `${origin}/#${token}`,
    open: () => openBrowser(`${origin}/#${token}`),
    close: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      // The owner settles controller transactions before closing this surface.
      // Do not leave desktop exit waiting on a stale browser/slow HTTP client.
      server.closeAllConnections();
    }),
  };
}

import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderAdmin } from '../gateway/admin-web.mjs';

// A loopback-only UI fixture for the installed Playwright MCP browser. It serves
// production HTML/assets, never credentials or a live administrative API.
const marker = resolve('build/admin-ui-fixture.json');
const command = process.argv[2] ?? 'start';
if (command === 'start') {
  await mkdir(dirname(marker), { recursive: true });
  try {
    const old = JSON.parse(await readFile(marker, 'utf8'));
    const response = await fetch(`${old.origin}/__fixture`, { signal: AbortSignal.timeout(1000) });
    if (response.ok && (await response.json()).nonce === old.nonce) {
      console.log(JSON.stringify({ origin: old.origin, reused: true }));
      process.exit(0);
    }
  } catch {}
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'serve'], {
    detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  const ready = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('UI fixture did not start')); }, 10000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`UI fixture exited ${code}`)); });
    child.once('message', value => { clearTimeout(timer); resolveReady(value); });
  });
  child.disconnect();
  child.unref();
  console.log(JSON.stringify(ready));
} else if (command === 'stop') {
  const info = JSON.parse(await readFile(marker, 'utf8'));
  const response = await fetch(`${info.origin}/__fixture/stop`, {
    method: 'POST', headers: { 'X-Fixture-Nonce': info.nonce }, signal: AbortSignal.timeout(2000),
  });
  if (!response.ok) throw new Error('Refused to stop an unrelated UI fixture');
  console.log(JSON.stringify({ stopped: true }));
} else if (command === 'serve') {
  const nonce = randomUUID();
  const assets = new Map([
    ['/admin/assets/admin.js', ['assets/admin/admin.js', 'text/javascript']],
    ['/admin/assets/admin.css', ['assets/admin/admin.css', 'text/css']],
    ['/admin/assets/pico.min.css', ['assets/admin/pico.min.css', 'text/css']],
  ]);
  const keys = [{ id: '12345678-1234-4234-8234-123456789abc', label: 'Browser acceptance fixture',
    state: 'active', deviceId: '12345678-1234-4234-8234-123456789def',
    bindingId: '12345678-1234-4234-8234-123456789fed', updatedAt: new Date().toISOString() }];
  let timer;
  const stop = () => {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close(async () => {
      const info = JSON.parse(await readFile(marker, 'utf8').catch(() => '{}'));
      if (info.nonce === nonce) await rm(marker, { force: true });
      process.exit(0);
    });
  };
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    try {
      if (request.url === '/__fixture') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ nonce }));
      } else if (request.url === '/__fixture/stop' && request.method === 'POST' && request.headers['x-fixture-nonce'] === nonce) {
        response.end('stopped');
        setImmediate(stop);
      } else if (request.url === '/admin' && request.method === 'GET') {
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(renderAdmin(keys));
      } else if (assets.has(request.url) && request.method === 'GET') {
        const [path, type] = assets.get(request.url);
        response.setHeader('Content-Type', `${type}; charset=utf-8`);
        response.end(await readFile(path));
      } else {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'fixture_api_requires_browser_route_mock' }));
      }
    } catch { response.writeHead(500); response.end('fixture_asset_unavailable'); }
  });
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(marker, JSON.stringify({ origin, nonce }), { mode: 0o600 });
  process.send?.({ origin });
  timer = setTimeout(stop, 20 * 60 * 1000);
  process.on('SIGTERM', stop);
} else throw new Error('Use start or stop');

import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest, createServer } from 'node:http';
import { createDesktopController } from '../client/desktop-controller.mjs';
import { startLocalControl, listenOnBrowserPort } from '../client/local-control.mjs';
import { diagnosticReport, stopTeamDevSpace } from '../client/control.mjs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const healthy = { ready: true, devspace: true, bridge: true, tunnel: true, gateway: 'active', remoteAccess: 'active', desiredRemoteAccess: 'active' };
const paused = { ready: false, devspace: false, bridge: false, tunnel: false, gateway: 'suspended', remoteAccess: 'suspended', desiredRemoteAccess: 'suspended' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(10); } assert.fail('Condition did not settle'); }

test('Control Center binds browser-safe ports and retries occupied ports without leaking listeners', async t => {
  const blocker = createServer(), server = createServer((_request, response) => response.end('reachable'));
  const listeningHandlers = server.listenerCount('listening'); // Node HTTP owns a connection-tracking listener.
  t.after(() => { blocker.close(); blocker.closeAllConnections(); server.close(); server.closeAllConnections(); });
  await listenOnBrowserPort(blocker);
  const occupied = blocker.address().port;
  assert.ok(occupied >= 49152 && occupied <= 65535, 'Do not inherit a host ephemeral range containing Fetch-blocked ports');
  let attempts = 0;
  await listenOnBrowserPort(server, () => 49152 + ((occupied - 49152 + attempts++) % 16384));
  assert.ok(attempts >= 2, 'The first candidate was actually occupied');
  assert.equal(server.address().address, '127.0.0.1');
  assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}`)).text(), 'reachable');
  assert.equal(server.listenerCount('error'), 0);
  assert.equal(server.listenerCount('listening'), listeningHandlers);
  const exhausted = createServer(); let rejected = 0;
  const originalHandlers = exhausted.listenerCount('error') + exhausted.listenerCount('listening');
  await assert.rejects(listenOnBrowserPort(exhausted, () => { rejected++; return occupied; }), { code: 'EADDRINUSE' });
  assert.equal(rejected, 16, 'Contention is bounded, never an infinite startup wait');
  assert.equal(exhausted.listenerCount('error') + exhausted.listenerCount('listening'), originalHandlers);
});

test('Control Center bounds stalled requests without retrying an uncertain mutation', async t => {
  const source = await readFile(new URL('../client/control.js', import.meta.url), 'utf8');
  const requestSource = source.slice(source.indexOf('async function request('), source.indexOf('\nfunction render('));
  const keepAlive = setTimeout(() => {}, 2000);
  t.after(() => clearTimeout(keepAlive));
  for (const body of [undefined, { action: 'restart' }]) {
    let calls = 0, deadline;
    const request = runInNewContext(`${requestSource}\nrequest`, {
      token: 'test-only-capability',
      AbortController,
      setTimeout: (callback, milliseconds) => { deadline = milliseconds; return setTimeout(callback, 20); },
      clearTimeout,
      fetch: async (_path, options) => {
        calls++;
        assert.ok(options.signal, 'A local HTTP request must have a finite deadline');
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
          () => reject(options.signal.reason), { once: true }));
      },
    });
    await assert.rejects(request(body ? '/api/action' : '/api/state', body),
      body ? /操作结果尚未确认/ : /读取状态超时/);
    assert.equal(calls, 1, 'Never retry a mutation automatically after an uncertain response');
    assert.equal(deadline, body ? 180000 : 10000);
  }
});

test('Control Center works without AbortSignal.timeout and releases completed request timers', async () => {
  const source = await readFile(new URL('../client/control.js', import.meta.url), 'utf8');
  const requestSource = source.slice(source.indexOf('async function request('), source.indexOf('\nfunction render('));
  const timers = new Set(); let calls = 0;
  const request = runInNewContext(`${requestSource}\nrequest`, {
    token: 'test-only-capability', AbortController, AbortSignal: {},
    setTimeout: (_callback, milliseconds) => { const timer = { milliseconds }; timers.add(timer); return timer; },
    clearTimeout: timer => timers.delete(timer),
    fetch: async (_path, options) => {
      calls++; assert.equal(options.signal.aborted, false);
      return { ok: true, json: async () => ({ ok: true }) };
    },
  });
  assert.equal((await request('/api/state')).ok, true);
  assert.equal((await request('/api/action', { action: 'check' })).ok, true);
  assert.equal(calls, 2);
  assert.equal(timers.size, 0, 'Completed requests must not retain their timeout callbacks');
});

test('local settings become available without waiting for a slow gateway probe', async t => {
  const controller = createDesktopController('unused', { operations: {
    localState: async () => ({ accessKeyMode: 'replace-key', currentProjectRoot: '/project' }),
    status: async () => new Promise(() => {}),
  } });
  t.after(() => controller.dispose()); controller.start();
  await until(() => controller.snapshot().projectRoot === '/project');
  assert.equal(controller.snapshot().switchKeyText, '更换 Access Key…');
  assert.equal(controller.snapshot().menu.find(item => item.action === 'settings').enabled, true);
});

test('a delayed startup read cannot overwrite settings changed by a completed operation', async t => {
  const first = deferred(); let reads = 0;
  const controller = createDesktopController('unused', { operations: {
    localState: async () => ++reads === 1 ? first.promise : { configured: true, accessKeyMode: 'replace-key', currentProjectRoot: '/new-project' },
    status: async () => null,
    setup: async () => ({ enrolled: true }),
  } });
  t.after(() => controller.dispose()); controller.start(); await delay(5);
  await controller.dispatch('setup');
  first.resolve({ configured: false, accessKeyMode: 'setup', currentProjectRoot: '/old-project' });
  await delay(5);
  assert.equal(controller.snapshot().projectRoot, '/new-project');
  assert.equal(controller.snapshot().accessKeyMode, 'replace-key');
});

test('stale health cannot overwrite a completed pause and duplicate mutations are rejected', async t => {
  const probe = deferred(), mutation = deferred(); let pausedCalls = 0;
  const controller = createDesktopController('unused', { operations: {
    status: () => probe.promise,
    suspend: async ({ onProgress }) => { pausedCalls++; onProgress('暂停进行中'); await mutation.promise; return paused; },
  } });
  t.after(() => controller.dispose()); controller.start(); await delay(5);
  const pending = controller.dispatch('suspend');
  assert.equal(controller.snapshot().busy, true); assert.equal(controller.snapshot().remoteEnabled, false);
  await assert.rejects(controller.dispatch('restart'), /未知控制操作/);
  await assert.rejects(controller.dispatch('suspend'), /已有操作/);
  mutation.resolve(); await pending; probe.resolve(healthy); await delay(5);
  assert.equal(pausedCalls, 1); assert.equal(controller.snapshot().status, 'suspended');
  assert.equal(controller.snapshot().remoteAction, 'resume');
});

test('Enrollment acknowledgements never replace real health and pending key recovery remains reachable', async t => {
  const controller = createDesktopController('unused', { operations: {
    setup: async () => ({ enrolled: true, ready: false, startup: 'installed' }),
    status: async () => healthy, localState: async () => ({ configured: true, accessKeyMode: 'replace-key' }),
  } });
  t.after(() => controller.dispose());
  await controller.dispatch('setup');
  assert.equal(controller.snapshot().status, 'ready');
  assert.equal(controller.snapshot().health.devspace, true);
});

test('manual checks share an in-flight probe while logs remain available', async t => {
  const probe = deferred(); let count = 0, logs = 0;
  const controller = createDesktopController('unused', { operations: {
    status: async () => { count++; return probe.promise; }, logs: async () => { logs++; },
  } });
  t.after(() => controller.dispose()); controller.start();
  const checks = Array.from({ length: 20 }, () => controller.dispatch('check'));
  await controller.dispatch('logs'); probe.resolve(healthy); await Promise.all(checks);
  assert.equal(count, 1); assert.equal(logs, 1);
});

test('exit cancels only a folder prompt and waits for an already-started binding transaction', async t => {
  const mutation = deferred(); const order = []; let promptAborted = false;
  const controller = createDesktopController('unused', { operations: {
    status: async () => healthy,
    'switch-key': async () => { order.push('binding-start'); await mutation.promise; order.push('binding-commit'); return healthy; },
    'choose-folder': ({ signal }) => new Promise(resolve => signal.addEventListener('abort', () => { promptAborted = true; resolve(null); }, { once: true })),
    exit: async () => { order.push('stop'); },
  } });
  t.after(() => controller.dispose());
  const work = controller.dispatch('switch-key'); const prompt = controller.dispatch('choose-folder'); await delay(5);
  const exiting = controller.dispatch('exit'); await delay(5);
  assert.equal(promptAborted, true); assert.deepEqual(order, ['binding-start']);
  mutation.resolve(); await Promise.all([prompt, work, exiting]);
  assert.deepEqual(order, ['binding-start', 'binding-commit', 'stop']);
});

test('one project action selects and commits once; cancelled or exit-cancelled selection never mutates', async t => {
  let selection = '/new-project', commits = 0, probes = 0;
  const prompt = deferred(); let waiting = false;
  const controller = createDesktopController('unused', { operations: {
    localState: async () => ({ currentProjectRoot: '/old-project', accessKeyMode: 'replace-key' }),
    status: async () => { probes++; return healthy; },
    'choose-folder': async ({ signal }) => {
      if (!waiting) return selection;
      signal.addEventListener('abort', () => prompt.resolve(null), { once: true });
      return prompt.promise;
    },
    'project-root': async ({ projectRoot }) => { assert.equal(projectRoot, '/new-project'); commits++; return healthy; },
    exit: async () => {},
  } });
  t.after(() => controller.dispose());
  await controller.dispatch('project-root');
  assert.equal(commits, 1);
  selection = null;
  const probesBeforeCancel = probes;
  assert.equal((await controller.dispatch('project-root')).cancelled, true);
  assert.equal(commits, 1);
  assert.equal(probes, probesBeforeCancel, 'Cancelling a native picker must not wait for a network health probe');
  assert.match(controller.snapshot().notice, /已取消/);
  waiting = true;
  const pending = controller.dispatch('project-root');
  await delay(5);
  assert.equal(controller.snapshot().busy, true);
  await assert.rejects(controller.dispatch('project-root'), { status: 409 });
  await controller.dispatch('exit');
  assert.equal((await pending).cancelled, true);
  assert.equal(commits, 1, 'Exiting while the picker is open must not commit a returned path');
});

test('failure retains actionable feedback and re-reads the persisted pause', async t => {
  const controller = createDesktopController('unused', { operations: {
    status: async () => ({ ...paused, gateway: 'unreachable' }),
    suspend: async () => { throw new Error('本机已暂停，服务端状态未确认'); },
    exit: async () => { throw new Error('Local service shutdown failed'); },
  } });
  t.after(() => controller.dispose());
  await assert.rejects(controller.dispatch('suspend'), /本机已暂停/);
  assert.equal(controller.snapshot().status, 'suspended'); assert.equal(controller.snapshot().remoteAction, 'suspend');
  assert.match(controller.snapshot().alert, /本机已暂停/);
  await controller.dispatch('check'); assert.match(controller.snapshot().alert, /本机已暂停/);
  await assert.rejects(controller.dispatch('exit'), /shutdown/);
  assert.equal(controller.snapshot().exitEnabled, true); assert.equal(controller.snapshot().exiting, false);
  assert.match(controller.snapshot().alert, /关闭 Team DevSpace失败/);
});

test('unconfigured desktop can exit but corrupt state is not silently accepted', async t => {
  const home = await mkdtemp(join(tmpdir(), 'tds-empty-desktop-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal((await stopTeamDevSpace(home)).configured, false);
  assert.equal((await diagnosticReport(home)).gatewayHealth, 'not-enrolled');
  await writeFile(join(home, 'state.json'), '{broken');
  await assert.rejects(stopTeamDevSpace(home), /Cannot read/);
  const report = await diagnosticReport(home);
  assert.equal(report.gatewayHealth, 'unknown');
  assert.equal(report.stateHealth, 'unreadable');
  assert.match(report.error, /Cannot read/);
});

test('loopback Control Center protects reads and writes against cross-origin, rebinding and missing capability', async t => {
  const calls = [];
  const controller = createDesktopController('unused', { operations: { status: async () => healthy,
    diagnostics: async () => ({ remoteAccess: 'active' }), logs: async () => calls.push('logs'),
    'choose-folder': async () => '/selected-project',
    'project-root': async ({ projectRoot }) => { calls.push(projectRoot); return healthy; } } });
  const ui = await startLocalControl(controller, { openBrowser: async () => {} });
  t.after(async () => { await ui.close(); await controller.dispose(); });
  const url = new URL(ui.url), base = url.origin, authorization = `Bearer ${url.hash.slice(1)}`;
  const api = (path, options = {}) => fetch(base + path, { ...options, headers: { Authorization: authorization, ...options.headers } });
  const html = await fetch(base);
  assert.match(html.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(html.headers.get('cache-control'), 'no-store');
  assert.ok(!(await html.text()).includes(url.hash.slice(1)));
  const logo = await fetch(base + '/devspace-logo-light.png');
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.ok((await logo.arrayBuffer()).byteLength > 0, 'The shared Control Center product logo is bundled with the client');
  assert.equal((await fetch(base + '/api/state')).status, 401);
  assert.equal((await api('/api/state', { headers: { Origin: 'https://evil.example' } })).status, 403);
  // Fetch normalizes Host; use a real raw HTTP request to exercise rebinding.
  const forgedHost = await new Promise((resolve, reject) => {
    const request = httpRequest(base + '/api/state', { headers: { Host: 'evil.example', Authorization: authorization } },
      response => { response.resume(); resolve(response.statusCode); });
    request.once('error', reject); request.end();
  });
  assert.equal(forgedHost, 403);
  assert.equal((await api('/api/state', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await api('/api/state')).status, 200);
  const post = (body, headers = {}) => api('/api/action', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post({ action: 'logs' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post({ action: 'exit' })).status, 400);
  assert.equal((await post({ action: 'logs', arbitraryCommand: 'bad' })).status, 400);
  assert.equal((await post({ action: 'logs', projectRoot: 'x'.repeat(9000) })).status, 413);
  assert.equal((await post({ action: 'switch-key', accessKey: 'tds_short' })).status, 400);
  assert.equal((await post({ action: 'logs' })).status, 200);
  assert.deepEqual(calls, ['logs']);
  assert.equal((await api('/api/diagnostics')).status, 200);
  assert.equal((await fetch(base + '/diagnostics')).status, 200);
  assert.equal((await post({ action: 'project-root', projectRoot: '' })).status, 400);
  assert.equal((await post({ action: 'project-root' })).status, 200);
  assert.deepEqual(calls, ['logs', '/selected-project'], 'A pathless authorized request performs selection and one actual change');
});
